// Count only time spent in the foreground: background tabs suspend timers and
// may freeze legitimate inference, so elapsed wall-clock time is not proof
// that a worker is stuck. Heartbeats must represent actual model progress.
export const DEFAULT_ASR_IDLE_MS=5*60*1000;
export const MAX_ASR_WINDOW_SAMPLES=30*16000;
export class WorkerStalledError extends Error{
 readonly code='worker-failed';
 constructor(){super('ASR Worker не отвечает слишком долго при активной вкладке. Попытка восстановить текущее окно.');this.name='WorkerStalledError'}
}
type Visibility=Pick<Document,'visibilityState'|'addEventListener'|'removeEventListener'>;
export interface WatchdogOptions{
 timeoutMs?:number;
 pollMs?:number;
 signal?:AbortSignal;
 visibility?:Visibility|null;
 onTimeout:()=>void;
}
export function withActivityWatchdog<T>(work:(heartbeat:()=>void)=>Promise<T>,options:WatchdogOptions):Promise<T>{
 const timeoutMs=options.timeoutMs??DEFAULT_ASR_IDLE_MS;
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
    try{options.onTimeout()}catch{/* Still fail the current attempt. */}
    settle(new WorkerStalledError());
   }
  };
  const onVisibility=()=>{
   tick();
   active=visible?.visibilityState!=='hidden';
   last=Date.now();
  };
  const heartbeat=()=>{if(finished)return;tick();idleMs=0;last=Date.now()};
  const onAbort=()=>settle(new Error('Отменено.'));
  if(options.signal?.aborted){onAbort();return}
  visible?.addEventListener('visibilitychange',onVisibility);
  options.signal?.addEventListener('abort',onAbort,{once:true});
  timer.id=setInterval(tick,pollMs);
  Promise.resolve().then(()=>finished?undefined:work(heartbeat)).then(value=>settle(undefined,value as T),error=>settle(error));
 });
}
