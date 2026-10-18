import type {TranscriptSegment} from '@yourdevice/engine';
import {decodeAudio,validateFile} from './audio';
import {audioDuration} from './audioMetadata';
import {JobStore} from './jobStore';
import {createJob,audioWindows,absoluteSegments,type Job,type JobParams} from './jobs';
import {checkpointProgress,checkpointLabel,currentWindowLabel} from './recognitionProgress';
import {MAX_ASR_WINDOW_ATTEMPTS,shouldRetryAsrWindow,preferWasmAfterFailure} from './ml/recoveryPolicy';
import {DEFAULT_ASR_IDLE_MS,withActivityWatchdog} from './ml/activityWatchdog';
import {ModelManager,type WhisperId} from './ml/manager';
import {mapSpeakers} from './ml/speakers';
import {downloadTranscript,formatTranscript} from './formatTranscript';
export type RunnerSnapshot={jobs:Job[];busy:boolean;ready:boolean;activeId:string|null;notice:string;backend:string;operation:string};
export class JobRunner{
 readonly manager:ModelManager;
 private store:JobStore;
 private state:RunnerSnapshot={jobs:[],busy:false,ready:false,activeId:null,notice:'',backend:'Не инициализировано',operation:''};
 private listeners=new Set<()=>void>();
 private queue:string[]=[];
 private cancelled=false;
 private abort:AbortController|null=null;
 private download:(text:string,name:string)=>void;
 private decode:typeof decodeAudio;
 private initialization:Promise<void>|undefined;
 private lease:Promise<unknown>|undefined;
 private asrHeartbeat:(()=>void)|null=null;
 private readonly asrIdleMs:number;
 constructor(options:{store?:JobStore;manager?:ModelManager;decode?:typeof decodeAudio;download?:typeof downloadTranscript;asrIdleMs?:number}={}){
  this.store=options.store??new JobStore();this.manager=options.manager??new ModelManager();this.decode=options.decode??decodeAudio;this.download=options.download??downloadTranscript;
  this.asrIdleMs=options.asrIdleMs??DEFAULT_ASR_IDLE_MS;
  this.manager.onProgress=(status,percent)=>{
   if(this.cancelled)return;
   const id=this.state.activeId;
   if(!id){this.set({operation:status});return}
   // Engine callbacks report progress INSIDE a 30s window. Never replace the
   // persisted whole-recording checkpoint or its percent with this value.
   if(this.job(id).stage==='recognizing'){this.asrHeartbeat?.();return}
   this.patch(id,{status,percent:this.job(id).stage==='speakers'?percent:null});
  };
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}};
 snapshot=()=>this.state;
 private set(patch:Partial<RunnerSnapshot>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn())}
 private patch(id:string,patch:Partial<Job>){this.set({jobs:this.state.jobs.map(j=>j.id===id?{...j,...patch,updated:Date.now()}:j)})}
 private job(id:string){const job=this.state.jobs.find(j=>j.id===id);if(!job)throw new Error('Задание не найдено.');return job}
 init(){return this.initialization??=(async()=>{try{this.set({jobs:await this.store.list()})}catch(error){this.set({notice:'Не удалось открыть сохранённые задания: '+message(error)})}finally{this.set({ready:true})}})()}
 private async persist(id:string){
  try{await this.store.save(this.job(id))}catch(error){this.set({notice:'Не удалось сохранить результат в браузере. Скачайте доступный TXT. '+message(error)});throw new Error('Ошибка локального сохранения. Текст остаётся доступен в этой вкладке.')}
 }
 // Persist the text and nextWindow in ONE transaction, THEN publish progress.
 // If the transaction fails, keep the uncommitted text only in the open tab
 // for immediate export; it is never considered part of the durable checkpoint.
 private async commit(id:string,patch:Partial<Job>,volatileText?:TranscriptSegment[]){
  const durable:Job={...this.job(id),...patch,updated:Date.now()};
  delete durable.volatileSegments;
  try{await this.store.save(durable)}catch(error){
   if(volatileText)this.patch(id,{volatileSegments:volatileText});
   this.set({notice:'Не удалось сохранить контрольную точку. Скачайте TXT до закрытия вкладки. '+message(error)});
   throw new Error('Ошибка локального сохранения. Номер сохранённого окна не изменён.');
  }
  this.set({jobs:this.state.jobs.map(j=>j.id===id?durable:j)});
 }
 async add(files:File[],params:JobParams){
  await this.init();
  for(const file of files){
   try{
    validateFile(file);const job=createJob(file,params);await this.store.save(job,file);this.set({jobs:[...this.state.jobs,job]});
    if(typeof document!=='undefined')void audioDuration(file).then(async duration=>{if(!duration||!this.state.jobs.some(j=>j.id===job.id&&j.stage==='waiting'))return;this.patch(job.id,{duration});try{await this.persist(job.id)}catch{/* Notice is set by persist. */}});
   }catch(error){this.set({notice:`${file.name}: ${message(error)}`})}
  }
 }
 async remove(id:string){
  if(this.state.activeId===id||this.queue.includes(id))return;
  try{await this.store.remove(id);this.set({jobs:this.state.jobs.filter(j=>j.id!==id)})}catch(error){this.set({notice:message(error)})}
 }
 enqueue(id:string,params?:JobParams){
  const job=this.job(id);if(this.state.activeId===id||this.queue.includes(id))return;
  // Parameters are captured on the first start. Resume retains the original.
  if(job.stage==='waiting'&&params)this.patch(id,{params:{...params}});
  this.patch(id,{stage:'queued',status:'В очереди',error:undefined});this.queue.push(id);void this.drain();
 }
 private async exclusive(task:()=>Promise<void>){
  // Web Locks prevents two tabs from running heavy models and overwriting the
  // same checkpoint. When unavailable, refuse concurrent recovery guarantees.
  if(typeof navigator!=='undefined'&&navigator.locks){
   await navigator.locks.request('iscribe-processing-v1',{ifAvailable:true},async lock=>{
    if(!lock)throw new Error('Обработка уже идёт в другой вкладке iScribe. Дождитесь завершения и обновите эту страницу.');
    await task();
   });
  }else await task();
 }
 private async drain(){
  if(this.state.busy)return;
  this.set({busy:true});
  try{
   this.lease=this.exclusive(async()=>{
    while(this.queue.length){
     const id=this.queue.shift()!;this.cancelled=false;this.abort=new AbortController();this.set({activeId:id});
     try{await this.execute(id)}catch(error){
      const job=this.job(id);this.patch(id,{stage:this.cancelled?'cancelled':job.asrComplete?'partial':'error',status:this.cancelled?'Отменено. Полученный текст сохранён.':job.asrComplete?'Текст готов. Разделение говорящих не завершено.':'Обработка прервана. Можно продолжить.',error:this.cancelled?undefined:message(error),percent:null});
      try{await this.persist(id)}catch{/* Keep available text in memory and the storage error visible. */}
      if(!this.cancelled&&this.job(id).asrComplete){try{this.export(id,'plain');this.set({notice:'Разделение говорящих не завершено. Автоскачивание готового текста запрошено; ручные кнопки доступны.'})}catch{/* Manual exports remain available. */}}
     }
    }
   });await this.lease;
  }catch(error){
   this.set({notice:message(error)});
   for(const id of this.queue)this.patch(id,{stage:'interrupted',status:'Запуск отложен: другая вкладка занята.'});this.queue=[];
  }finally{this.asrHeartbeat=null;this.set({busy:false,activeId:null,operation:''});this.abort=null;this.lease=undefined}
 }
 private check(){if(this.cancelled)throw new Error('Отменено.')}
 private async execute(id:string){
  const disk=(await this.store.list()).find(j=>j.id===id);this.check();
  if(disk&&(disk.asrComplete||disk.nextWindow>this.job(id).nextWindow))this.patch(id,{...disk,stage:'queued'});
  this.patch(id,{stage:'preparing',status:'Подготовка аудио',percent:null,error:undefined,volatileSegments:undefined});await this.persist(id);this.check();
  const file=await this.store.audio(id);this.check();if(!file)throw new Error('Исходное аудио недоступно. Добавьте файл заново; сохранённый текст можно скачать.');
  const audio=await this.decode(file,this.abort!.signal);this.check();this.patch(id,{duration:audio.length/16000});
  const params={...this.job(id).params};
  if(!this.job(id).asrComplete){
   const windows=audioWindows(audio.length);
   // A corrupted checkpoint must never masquerade as a completed transcript.
   const initial=checkpointProgress(windows,this.job(id).nextWindow);
   if(this.manager.active!==params.model){const prepared=await this.manager.prepare(params.model);this.check();this.set({backend:prepared.backend})}
   this.patch(id,{stage:'recognizing',status:checkpointLabel(initial),percent:initial.percent});
   for(let index=initial.completedWindows;index<windows.length;index++){
    this.check();const window=windows[index];
    this.patch(id,{status:currentWindowLabel(windows,index),percent:checkpointProgress(windows,index).percent});
    // Retry only the current uncommitted window. Previous windows must not
    // be appended again, and checkpoints remain unchanged until commit().
    let result:TranscriptSegment[]|undefined;
    for(let attempt=1;attempt<=MAX_ASR_WINDOW_ATTEMPTS;attempt++){
     this.check();
     try{
      try{
       result=await withActivityWatchdog(heartbeat=>{
        this.asrHeartbeat=heartbeat;
        return this.manager.transcribe(audio.slice(window.start,window.end),false,()=>{},params.language);
       },{
        timeoutMs:this.asrIdleMs,pollMs:Math.min(1000,Math.max(5,this.asrIdleMs/4)),signal:this.abort!.signal,
        onTimeout:()=>this.manager.cancel()
       });
      }finally{this.asrHeartbeat=null}
      this.check();break;
     }catch(error){
      this.check();
      if(!shouldRetryAsrWindow(error,attempt))throw error;
      const next=attempt+1,wasmOnly=preferWasmAfterFailure(this.state.backend);
      this.patch(id,{status:`Ошибка окна ${index+1}/${windows.length} · восстановление Worker · попытка ${next}/${MAX_ASR_WINDOW_ATTEMPTS} · ${checkpointLabel(checkpointProgress(windows,index))}`});
      // Throw on failed reinit instead of silently continuing on an unknown
      // backend. Explicit cancellation aborts before starting another window.
      const prepared=await this.manager.recover(params.model,wasmOnly);this.check();
      this.set({backend:prepared.backend});
     }
    }
    if(!result)throw new Error('Окно не вернуло результат распознавания.');
    const segments=[...this.job(id).segments,...absoluteSegments(result,window)];
    const after=checkpointProgress(windows,index+1);
    await this.commit(id,{segments,nextWindow:index+1,percent:after.percent,status:checkpointLabel(after)},segments);
    this.check();
   }
   if(!this.job(id).segments.some(s=>s.text.trim()))throw new Error('Распознанного текста нет. Проверьте запись.');
   await this.commit(id,{asrComplete:true,percent:100,status:'Текст готов и сохранён'});this.check();
  }
  if(params.diarize){
   this.patch(id,{stage:'speakers',status:'Разделение говорящих. Текст уже доступен.',percent:null});await this.persist(id);this.check();
   const turns=await this.manager.diarize(audio);this.check();
   const segments=this.job(id).segments,speakerSegments=mapSpeakers(segments,turns);
   const unlabeled=speakerSegments.filter(s=>s.text.trim()&&!s.speaker).length;
   this.patch(id,{speakerSegments,diagnostics:{turns:turns.length,unlabeled,segments:segments.length,zeroDuration:segments.filter(s=>s.start===s.end).length},stage:unlabeled?'partial':'done',status:unlabeled?`Текст готов · без спикера: ${unlabeled} из ${segments.length}`:'Текст и спикеры готовы',percent:100});
  }else this.patch(id,{stage:'done',status:'Текст готов',percent:100});
  await this.persist(id);this.check();
  this.set({operation:'Формирование TXT'});
  // Browser download APIs cannot reliably report a blocked download.
  try{this.export(id,params.diarize?'speakers':'plain');this.set({notice:'Автоскачивание TXT запрошено. Если файл не появился, используйте кнопки справа от записи.'})}catch(error){this.set({notice:'Используйте ручное скачивание TXT. '+message(error)})}
 }
 cancel(){if(!this.state.busy)return;this.cancelled=true;this.abort?.abort();this.manager.cancel();this.set({backend:'Не инициализировано'})}
 async prepare(model:WhisperId){
  if(this.state.busy)return;this.set({busy:true,operation:'Подготовка модели'});this.cancelled=false;
  try{await this.exclusive(async()=>{const prepared=await this.manager.prepare(model);this.set({backend:prepared.backend})})}catch(error){this.set({notice:message(error)})}
  finally{this.set({busy:false,operation:''});if(this.queue.length)void this.drain()}
 }
 async preloadSpeakers(){
  if(this.state.busy)return;this.set({busy:true,operation:'Загрузка моделей говорящих'});this.cancelled=false;
  try{await this.exclusive(async()=>{await this.manager.preloadSpeakers();this.set({backend:'Не инициализировано'})})}catch(error){this.set({notice:message(error)})}
  finally{this.set({busy:false,operation:''});if(this.queue.length)void this.drain()}
 }
 export(id:string,variant:'plain'|'time'|'speakers'){
  const job=this.job(id);const segments:TranscriptSegment[]=variant==='speakers'?(job.speakerSegments??job.volatileSegments??job.segments):(job.volatileSegments??job.segments);
  const text=formatTranscript(segments,{timestamps:variant!=='plain',diarize:variant==='speakers'});
  const suffix=variant==='plain'?'text':variant==='time'?'time':'time_speakers';
  const partial=!job.asrComplete||(variant==='speakers'&&job.stage!=='done');
  this.download(text,job.name.replace(/\.[^.]+$/,'')+'_'+suffix+(partial?'_partial':'')+'.txt');
 }
}
function message(error:unknown){return error instanceof Error?error.message:String(error)}
