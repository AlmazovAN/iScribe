// Count only time spent in the foreground: background tabs suspend timers and
// may freeze legitimate inference, so elapsed wall-clock time is not proof
// that a worker is stuck. Heartbeats must represent actual model progress.
export const DEFAULT_ASR_IDLE_MS=5*60*1000;
export const DEFAULT_STREAM_DECODE_IDLE_MS=2*60*1000;
export const DEFAULT_STREAM_RESAMPLE_IDLE_MS=2*60*1000;
export const DEFAULT_STREAM_PCM_IDLE_MS=30*1000;
export const DEFAULT_STREAM_OPEN_IDLE_MS=2*60*1000;
export type StreamWatchdogStage='open'|'decode'|'resample'|'pcm-check';
export const MAX_ASR_WINDOW_SAMPLES=30*16000;
export class WorkerStalledError extends Error{
 readonly code='worker-failed';
 constructor(){super('ASR Worker не отвечает слишком долго при активной вкладке. Попытка восстановить текущее окно.');this.name='WorkerStalledError'}
}
export class WorkerDisposalError extends Error{
 readonly code='worker-disposal-failed';
 constructor(){super('Не подтверждено завершение старого Worker. Автоматический повтор остановлен.');this.name='WorkerDisposalError'}
}
export class StreamDecodeStalledError extends Error{
 readonly code='stream-decode-stalled';
 constructor(readonly stage:StreamWatchdogStage='decode'){
  const label=stage==='open'?'Открытие потокового декодера':stage==='decode'?'Потоковый декодер аудио':stage==='resample'?'Ресэмплинг аудио':'Проверка PCM';
  super(label+' не отвечает. Сохранённые окна не затронуты; продолжите задание с последней контрольной точки.');this.name='StreamDecodeStalledError';
 }
}
type Visibility=Pick<Document,'visibilityState'|'addEventListener'|'removeEventListener'>;
export interface WatchdogOptions{
 timeoutMs?:number;
 pollMs?:number;
 signal?:AbortSignal;
 visibility?:Visibility|null;
 onTimeout:()=>void;
 timeoutError?:()=>Error;
}
export function withActivityWatchdog<T>(work:(heartbeat:()=>void,beginStage:(timeoutMs:number)=>void)=>Promise<T>,options:WatchdogOptions):Promise<T>{
 let timeoutMs=options.timeoutMs??DEFAULT_ASR_IDLE_MS;
 const pollMs=options.pollMs??1000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isFinite(pollMs)||pollMs<=0)
  return Promise.reject(new Error('Некорректные настройки watchdog.'));
 const visible=options.visibility===undefined?(typeof document==='undefined'?null:document):options.visibility;
 return new Promise<T>((resolve,reject)=>{
  let finished=false,active=visible?.visibilityState!=='hidden',last=Date.now(),idleMs=0;
  const timer:{id?:ReturnType<typeof setInterval>}={};
  const cleanup=()=>{
   if(timer.id!==undefined)clearInterval(timer.id);
   visible?.removeEventListener('visibilitychange',onVisibility);
   options.signal?.removeEventListener('abort',onAbort);
  };
  const settle=(error:unknown,value?:T)=>{
   if(finished)return;finished=true;cleanup();
   if(error!==undefined)reject(error);else resolve(value as T);
  };
  const tick=()=>{
   if(finished)return;
   const now=Date.now();
   if(active)idleMs+=Math.max(0,now-last);
   last=now;
   if(active&&idleMs>=timeoutMs){
    // Terminate the old worker BEFORE the caller retries. Any late result
    // from the disposed EngineClient cannot be treated as a checkpoint.
    try{options.onTimeout()}catch{settle(new WorkerDisposalError());return}
    settle(options.timeoutError?.()??new WorkerStalledError());
   }
  };
  const onVisibility=()=>{
   tick();
   active=visible?.visibilityState!=='hidden';
   last=Date.now();
  };
  const heartbeat=()=>{if(finished)return;tick();idleMs=0;last=Date.now()};
  // A stage transition is real progress, with its own idle budget. Charge
  // the previous stage first; a transition must not revive a timed-out task.
  const beginStage=(limit:number)=>{
   if(finished)return;
   if(!Number.isFinite(limit)||limit<=0)throw new Error('Некорректный тайм-аут стадии.');
   tick();if(finished)return;
   timeoutMs=limit;idleMs=0;last=Date.now();
  };
  const onAbort=()=>settle(new Error('Отменено.'));
  if(options.signal?.aborted){onAbort();return}
  visible?.addEventListener('visibilitychange',onVisibility);
  options.signal?.addEventListener('abort',onAbort,{once:true});
  timer.id=setInterval(tick,pollMs);
  Promise.resolve().then(()=>finished?undefined:work(heartbeat,beginStage)).then(value=>settle(undefined,value as T),error=>settle(error));
 });
}
