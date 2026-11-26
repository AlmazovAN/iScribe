import type {TranscriptSegment} from '@yourdevice/engine';
import {decodeAudio,usesStreamedAudio,validateFile} from './audio';
import {inspectStreamedAudio,openStreamedAudio,type StreamedAudio} from './streamedAudio';
import {audioDuration} from './audioMetadata';
import {inspectDecodedPcm,AudioValidationError,type AudioInspectionReport} from './audioValidation';
import {JobStore} from './jobStore';
import {createJob,isRunning,audioWindows,absoluteSegments,recoverJob,type Job,type JobParams} from './jobs';
import {createFailureDiagnostic,consumePageExit} from './jobDiagnostics';
import {appendTrace,diagnosticReport,downloadDiagnosticJson,traceBackend,traceErrorKind,traceHeapBytes,type StreamStage,type TraceCode,type TracePhase,type TraceEvent} from './jobTrace';
import {checkpointProgress,checkpointLabel,currentWindowLabel,type AudioWindow} from './recognitionProgress';
import {MAX_ASR_WINDOW_ATTEMPTS,shouldRetryAsrWindow,preferWasmAfterFailure,reserveStreamRecovery,STREAM_SUBWINDOW_SAMPLES,DEFAULT_STREAM_ROTATE_WINDOWS} from './ml/recoveryPolicy';
import {DEFAULT_ASR_IDLE_MS,DEFAULT_STREAM_OPEN_IDLE_MS,DEFAULT_STREAM_DECODE_IDLE_MS,DEFAULT_STREAM_RESAMPLE_IDLE_MS,DEFAULT_STREAM_PCM_IDLE_MS,StreamDecodeStalledError,withActivityWatchdog} from './ml/activityWatchdog';
import {ModelManager,type EnginePhase,type WhisperId} from './ml/manager';
import {alignSpeakers} from './ml/speakers';
import {downloadTranscript,formatTranscript} from './formatTranscript';
import {addBenchmarkTiming,benchmarkNow,benchmarkReport,downloadBenchmarkJson,emptyBenchmark,recordWindowCommit,sampleMainThreadHeap,type JobBenchmark} from './benchmark';
import {browserEvidenceHints,createHardwareEvidence,downloadHardwareEvidence} from './hardwareAcceptance';
export type RunnerSnapshot={jobs:Job[];busy:boolean;ready:boolean;activeId:string|null;notice:string;backend:string;enginePhase:EnginePhase;operation:string;queueCount:number;speakerDownload:'idle'|'pending'|'loading'};
type StreamSession={audio:StreamedAudio;windows:number;rotations:number;closed:boolean};
type SplitPart={part:number;totalParts:number};
export class JobRunner{
 readonly manager:ModelManager;
 private store:JobStore;
 private state:RunnerSnapshot={jobs:[],busy:false,ready:false,activeId:null,notice:'',backend:'Не инициализировано',enginePhase:'idle',operation:'',queueCount:0,speakerDownload:'idle'};
 private listeners=new Set<()=>void>();
 private queue:string[]=[];
 private nextQueueOrder=0;
 private queueWrites:Promise<void>=Promise.resolve();
 private queueChanges=new Map<string,symbol>();
 private removing=new Set<string>();
 private cancelled=false;
 private abort:AbortController|null=null;
 private download:(text:string,name:string)=>void;
 private diagnosticDownload:typeof downloadDiagnosticJson;
 private benchmarkDownload:typeof downloadBenchmarkJson;
 private hardwareDownload:typeof downloadHardwareEvidence;
 private decode:typeof decodeAudio;
 private openStream:typeof openStreamedAudio;
 private initialization:Promise<void>|undefined;
 private lease:Promise<unknown>|undefined;
 private committedWindows=new Map<string,number>();
 private asrHeartbeat:(()=>void)|null=null;
 private readonly asrIdleMs:number;
 private readonly streamOpenIdleMs:number;
 private readonly streamDecodeIdleMs:number;
 private readonly streamResampleIdleMs:number;
 private readonly streamPcmIdleMs:number;
 private readonly streamRotateWindows:number;
 constructor(options:{store?:JobStore;manager?:ModelManager;decode?:typeof decodeAudio;openStream?:typeof openStreamedAudio;download?:typeof downloadTranscript;downloadDiagnostic?:typeof downloadDiagnosticJson;downloadBenchmark?:typeof downloadBenchmarkJson;downloadHardware?:typeof downloadHardwareEvidence;asrIdleMs?:number;streamOpenIdleMs?:number;streamDecodeIdleMs?:number;streamResampleIdleMs?:number;streamPcmIdleMs?:number;streamRotateWindows?:number}={}){
  this.store=options.store??new JobStore();this.manager=options.manager??new ModelManager();this.decode=options.decode??decodeAudio;this.download=options.download??downloadTranscript;this.diagnosticDownload=options.downloadDiagnostic??downloadDiagnosticJson;this.benchmarkDownload=options.downloadBenchmark??downloadBenchmarkJson;this.hardwareDownload=options.downloadHardware??downloadHardwareEvidence;
  this.openStream=options.openStream??openStreamedAudio;
  this.asrIdleMs=options.asrIdleMs??DEFAULT_ASR_IDLE_MS;
  this.streamOpenIdleMs=options.streamOpenIdleMs??DEFAULT_STREAM_OPEN_IDLE_MS;
  this.streamDecodeIdleMs=options.streamDecodeIdleMs??DEFAULT_STREAM_DECODE_IDLE_MS;
  this.streamResampleIdleMs=options.streamResampleIdleMs??DEFAULT_STREAM_RESAMPLE_IDLE_MS;
  this.streamPcmIdleMs=options.streamPcmIdleMs??DEFAULT_STREAM_PCM_IDLE_MS;
  this.streamRotateWindows=options.streamRotateWindows??DEFAULT_STREAM_ROTATE_WINDOWS;
  if(!Number.isSafeInteger(this.streamRotateWindows)||this.streamRotateWindows<1)throw new Error('Некорректный интервал ротации декодера.');
  this.manager.onLifecycleChange=event=>{
   this.set({enginePhase:event.phase,backend:event.backend??'Не инициализировано'});
  };
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
 private bench(id:string,update:(previous:JobBenchmark)=>JobBenchmark){
  const next=sampleMainThreadHeap(update(this.job(id).benchmark??emptyBenchmark()));
  this.patch(id,{benchmark:next});
 }
 exportBenchmark(id:string){
  const job=this.job(id);
  if(!job.benchmark?.runs)throw new Error('Измерения производительности ещё не выполнены.');
  const name='iscribe_benchmark_'+id.slice(0,8).replace(/[^a-z0-9]/gi,'')+'.json';
  this.benchmarkDownload(benchmarkReport(job),name);
 }
 async exportHardwareEvidence(id:string){
  await this.init();
  const job=this.job(id);
  if(this.state.activeId===id||isRunning(job.stage)||job.stage==='queued')
   throw new Error('Завершите текущий этап задания перед выгрузкой контрольного протокола.');
  // Read the durable checkpoint and source from IndexedDB rather than
  // trusting the live React snapshot. No source bytes or transcript leave.
  const [stored,source,hints]=await Promise.all([
   this.store.get(id,false),this.store.audio(id),browserEvidenceHints()
  ]);
  const report=createHardwareEvidence(job,stored,source,hints);
  this.hardwareDownload(report,'iscribe_hardware_evidence_'+id.slice(0,8)+'.json');
 }
 private async inspectPcm(id:string,pcm:Float32Array|StreamedAudio,signal?:AbortSignal,file?:File,session?:StreamSession):Promise<AudioInspectionReport>{
  this.traceEvent(id,'audio-check-start','audio',{pcmSamples:pcm.length});
  await this.persist(id);
  try{
   const started=benchmarkNow();
   const onProgress=(done:number,total:number)=>this.set({operation:`Проверка аудио: окно ${done}/${total}`});
   const report=pcm instanceof Float32Array
    ?await inspectDecodedPcm(pcm,{signal,onProgress})
    :await inspectStreamedAudio(pcm,signal,onProgress,async(window,index,total)=>{
      if(!session||!file)throw new Error('Отсутствует сессия проверки потокового аудио.');
      await this.rotateStreamIfNeeded(id,session,file,index,total,true);
      const {report}=await this.readCheckedStreamWindow(id,session.audio,window,index,total,true);
      session.windows++;return report;
     });
   this.bench(id,b=>addBenchmarkTiming(b,'pcmCheckMs',benchmarkNow()-started));
   this.patch(id,{audioCheck:{status:'passed',checkedAt:Date.now(),report}});
   this.traceEvent(id,'audio-check-pass','audio',{pcmSamples:report.pcmSamples,totalWindows:report.windowCount});
   await this.persist(id);
   return report;
  }catch(error){
   if(!this.cancelled){
    const problem=error instanceof AudioValidationError?error.message:'Проверка PCM не завершена. Повторите проверку или проверьте декодирование.';
    this.patch(id,{audioCheck:{status:'failed',checkedAt:Date.now(),problem}});
    this.traceEvent(id,'audio-check-error','audio',{errorKind:traceErrorKind(error)});
    try{await this.persist(id)}catch{/* Preserve the original failure and existing checkpoint. */}
   }
   throw error;
  }
 }
 async inspectAudio(id:string):Promise<void>{
  if(this.state.busy||this.queue.length)throw new Error('Дождитесь завершения текущей операции перед проверкой аудио.');
  this.job(id);
  this.cancelled=false;this.abort=new AbortController();
  this.set({busy:true,activeId:id,operation:'Проверка аудио'});
  try{
   await this.exclusive(async()=>{
    const file=await this.store.audio(id);
    if(!file)throw new Error('Исходное аудио недоступно в браузере.');
    this.traceEvent(id,'audio-start','audio');await this.persist(id);
    const started=Date.now();
    const pcm=await this.readAudio(file);
    const session=pcm instanceof Float32Array?undefined:this.newStreamSession(pcm);
    let completed=false;
    try{
     this.check();this.traceEvent(id,'audio-ready','audio',{elapsedMs:Date.now()-started,pcmSamples:pcm.length,decoderId:session?.audio.decoderId});
     await this.inspectPcm(id,pcm,this.abort!.signal,file,session);completed=true;
    }finally{if(session){this.closeStreamSession(id,session,completed?'finish':this.cancelled?'cancel':'error');await this.persist(id)}}
   });
   this.set({notice:'Аудио проверено без запуска Whisper. Результат отображён в строке файла.'});
  }catch(error){
   if(!this.cancelled&&this.job(id).audioCheck?.status!=='failed'){
    const problem=error instanceof AudioValidationError?error.message:'Не удалось декодировать или проверить аудиофайл.';
    this.patch(id,{audioCheck:{status:'failed',checkedAt:Date.now(),problem}});
    this.traceEvent(id,'audio-check-error','audio',{errorKind:traceErrorKind(error)});
    try{await this.persist(id)}catch{/* Browser storage may be unavailable. */}
   }
   this.set({notice:this.cancelled?'Проверка аудио отменена.':error instanceof AudioValidationError?error.message:'Проверка аудио не завершена. См. диагностику JSON.'});
  }finally{
   this.abort=null;this.set({busy:false,activeId:null,operation:''});
   this.continuePending();
  }
 }
 private traceEvent(id:string,code:TraceCode,phase:TracePhase,fields:Omit<TraceEvent,'at'|'phase'|'code'>={}){
  const job=this.job(id);
  this.patch(id,{trace:appendTrace(job.trace,{at:Date.now(),phase,code,...fields})});
 }
 init(){return this.initialization??=(async()=>{
  try{
   const disk=await this.store.list(false),exit=consumePageExit();
   const jobs=disk.map(j=>recoverJob(j,exit?.jobId===j.id?exit.event:null));
   // Only explicitly enqueued work is automatically restored; in-flight ASR
   // becomes interrupted but retains its position for one-click resume.
   const ordered=jobs.filter(j=>typeof j.queueOrder==='number'&&Number.isSafeInteger(j.queueOrder)&&j.queueOrder>0&&
    (j.stage==='queued'||j.stage==='interrupted'))
    .sort((a,b)=>a.queueOrder!-b.queueOrder!||a.id.localeCompare(b.id));
   this.queue=ordered.map(j=>j.id);
   this.nextQueueOrder=Math.max(0,...disk.map(j=>typeof j.queueOrder==='number'&&Number.isSafeInteger(j.queueOrder)?j.queueOrder:0));
   for(const job of disk)this.committedWindows.set(job.id,job.nextWindow);
   this.set({jobs,queueCount:this.queue.length});
   // Store the reconstructed stop diagnostic after reload, not in an unload handler.
   for(let i=0;i<jobs.length;i++)if(disk[i].stage!==jobs[i].stage){
    try{await this.store.save(jobs[i])}catch(error){this.set({notice:'Не удалось сохранить диагностику восстановления: '+message(error)})}
   }
  }catch(error){this.set({notice:'Не удалось открыть сохранённые задания: '+message(error)})}
  finally{this.set({ready:true})}
 })()}
 private async persist(id:string){
  try{const job={...this.job(id)};delete job.volatileSegments;await this.store.save(job);this.committedWindows.set(id,job.nextWindow)}catch(error){this.set({notice:'Не удалось сохранить результат в браузере. Скачайте доступный TXT. '+message(error)});throw new Error('Ошибка локального сохранения. Текст остаётся доступен в этой вкладке.')}
 }
 // Persist the text and nextWindow in ONE transaction, THEN publish progress.
 // If the transaction fails, keep the uncommitted text only in the open tab
 // for immediate export; it is never considered part of the durable checkpoint.
 private async commit(id:string,patch:Partial<Job>,volatileText?:TranscriptSegment[]){
  const durable:Job={...this.job(id),...patch,updated:Date.now()};
  delete durable.volatileSegments;
  try{await this.store.save(durable)}catch(error){
   if(volatileText)this.patch(id,{volatileSegments:volatileText});
   this.traceEvent(id,'checkpoint-error','checkpoint',{errorKind:'storage',committedWindows:this.job(id).nextWindow});
   this.set({notice:'Не удалось сохранить контрольную точку. Скачайте TXT до закрытия вкладки. '+message(error)});
   throw new Error('Ошибка локального сохранения. Номер сохранённого окна не изменён.');
  }
  this.committedWindows.set(id,durable.nextWindow);
  this.set({jobs:this.state.jobs.map(j=>j.id===id?durable:j)});
 }
 async add(files:File[],params:JobParams){
  await this.init();
  for(const file of files){
   try{
    validateFile(file);const job=createJob(file,params);await this.store.save(job,file);this.committedWindows.set(job.id,0);this.set({jobs:[...this.state.jobs,job]});
    if(typeof document!=='undefined')void audioDuration(file).then(async duration=>{if(!duration||!this.state.jobs.some(j=>j.id===job.id&&j.stage==='waiting'))return;this.patch(job.id,{duration});try{await this.persist(job.id)}catch{/* Notice is set by persist. */}});
   }catch(error){this.set({notice:`${file.name}: ${message(error)}`})}
  }
 }
 async remove(id:string){
  if(this.state.activeId===id||this.queue.includes(id)||this.removing.has(id))return;
  this.removing.add(id);
  try{
   await this.ensureQueueSaved();
   await this.store.remove(id);
   this.committedWindows.delete(id);
   this.set({jobs:this.state.jobs.filter(j=>j.id!==id)});
  }catch(error){this.set({notice:message(error)})}
  finally{this.removing.delete(id)}
 }
 enqueue(id:string,params?:JobParams){
  const job=this.job(id);
  if(this.state.activeId===id||this.removing.has(id))return;
  if(this.queue.includes(id)){this.resumeQueue();return}
  // Parameters are captured on the first start. Resume retains the original.
  if(job.stage==='waiting'&&params)this.patch(id,{params:{...params}});
  const order=++this.nextQueueOrder;
  this.queue.push(id);
  this.patch(id,{stage:'queued',status:'В очереди',error:undefined,queueOrder:order});
  this.set({queueCount:this.queue.length});
  this.saveQueueChange(id);
  void this.drain();
 }
 dequeue(id:string){
  const index=this.queue.indexOf(id);
  if(index<0||this.state.activeId===id)return;
  const job=this.job(id);
  this.queue.splice(index,1);
  // Keep the file and any checkpoints so the user can rejoin the queue later.
  const hasProgress=job.nextWindow>0||job.asrComplete||job.stage==='interrupted';
  this.patch(id,{queueOrder:undefined,stage:hasProgress?'interrupted':'waiting',status:'Убрано из очереди'});
  this.set({queueCount:this.queue.length});
  this.saveQueueChange(id);
 }
 resumeQueue(){if(this.state.ready&&!this.state.busy&&this.queue.length)void this.drain()}
 private continuePending(){
  if(this.queue.length||this.state.speakerDownload==='pending')void this.drain();
 }
 private async persistQueueChange(id:string,revision:symbol){
  await this.persist(id);
  if(this.queueChanges.get(id)===revision)this.queueChanges.delete(id);
 }
 private saveQueueChange(id:string){
  const revision=Symbol();
  this.queueChanges.set(id,revision);
  this.queueWrites=this.queueWrites.catch(()=>{}).then(()=>this.persistQueueChange(id,revision));
  void this.queueWrites.catch(()=>{});
 }
 private async ensureQueueSaved(){
  // Serialize retries with subsequent queue edits, including removals. Only clear
  // the exact revision that was written so a newer edit is never dropped.
  let pending:Promise<void>;
  do{
   pending=this.queueWrites;
   await pending.catch(()=>{});
   if(pending!==this.queueWrites)continue;
   if(!this.queueChanges.size)return;
   const changes=[...this.queueChanges];
   this.queueWrites=this.queueWrites.catch(()=>{}).then(async()=>{
    for(const [id,revision] of changes){
     if(this.queueChanges.get(id)===revision)await this.persistQueueChange(id,revision);
    }
   });
   await this.queueWrites;
  }while(pending!==this.queueWrites);
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
   await this.ensureQueueSaved();
   this.lease=this.exclusive(async()=>{
    while(this.queue.length||this.state.speakerDownload==='pending'){
     await this.ensureQueueSaved();
     if(this.state.speakerDownload==='pending'){
      await this.downloadSpeakers();
      continue;
     }
     const id=this.queue[0];
     if(!id)break;
     if(!this.state.jobs.some(j=>j.id===id&&j.queueOrder!==undefined)){
      this.queue.shift();this.set({queueCount:this.queue.length});continue;
     }
     this.cancelled=false;this.abort=new AbortController();this.set({activeId:id});
     const runStarted=benchmarkNow();
     try{
      await this.execute(id);
      this.bench(id,b=>addBenchmarkTiming(b,'runMs',benchmarkNow()-runStarted));
      await this.persist(id);
     }catch(error){
      this.bench(id,b=>({...addBenchmarkTiming(b,'runMs',benchmarkNow()-runStarted),failedRuns:b.failedRuns+1}));
      const job=this.job(id);
      const failure=createFailureDiagnostic(job,this.cancelled?'cancelled':'execution-error',message(error),job.backend??this.state.backend,this.committedWindows.get(id)??job.nextWindow);
      this.traceEvent(id,this.cancelled?'job-cancelled':'job-error','job',{errorKind:this.cancelled?'cancelled':traceErrorKind(error),committedWindows:job.nextWindow,backend:traceBackend(job.backend??this.state.backend)});
      this.patch(id,{stage:this.cancelled?'cancelled':job.asrComplete?'partial':'error',status:this.cancelled?'Отменено. Полученный текст сохранён.':job.asrComplete?'Текст готов. Разделение говорящих не завершено.':'Обработка прервана. Можно продолжить.',error:this.cancelled?undefined:message(error),percent:null,failure,queueOrder:undefined});
      try{await this.persist(id)}catch{/* Keep available text in memory and the storage error visible. */}
      if(!this.cancelled&&this.job(id).asrComplete){try{this.export(id,'plain');this.set({notice:'Разделение говорящих не завершено. Автоскачивание готового текста запрошено; ручные кнопки доступны.'})}catch{/* Manual exports remain available. */}}
     }finally{
      this.queue.shift();this.set({activeId:null,queueCount:this.queue.length});
     }
    }
   });await this.lease;
  }catch(error){
   // Do not drop persistent queue entries when another tab owns the Web Lock
   // or the browser cannot commit queue metadata. Retry from this checkpoint.
   if(this.state.speakerDownload==='pending')this.set({speakerDownload:'idle'});
   this.set({notice:'Запуск очереди отложен. Если причина в хранилище, очередь могла не сохраниться — не закрывайте страницу до устранения ошибки. '+message(error)});
  }finally{this.asrHeartbeat=null;this.set({busy:false,activeId:null,operation:'',queueCount:this.queue.length});this.abort=null;this.lease=undefined}
 }
 private readAudio(file:File){
  const signal=this.abort!.signal;
  return usesStreamedAudio(file.size)?this.openGuardedStream(file,signal):this.decode(file,signal);
 }
 // Every decoder opening owns a separate abort signal. A late resolution
 // after timeout/cancellation is disposed and cannot become the active decoder.
 private async openGuardedStream(file:File,parent:AbortSignal):Promise<StreamedAudio>{
  parent.throwIfAborted();
  const controller=new AbortController();
  const abort=()=>controller.abort();
  parent.addEventListener('abort',abort,{once:true});
  try{
   const audio=await withActivityWatchdog(async()=>{
    const opened=await this.openStream(file,controller.signal);
    if(controller.signal.aborted){opened.close();controller.signal.throwIfAborted()}
    return opened;
   },{
    timeoutMs:this.streamOpenIdleMs,pollMs:Math.min(1000,Math.max(5,this.streamOpenIdleMs/4)),
    signal:parent,onTimeout:abort,timeoutError:()=>new StreamDecodeStalledError('open')
   });
   if(parent.aborted){audio.close();parent.throwIfAborted()}
   let closed=false;
   return {...audio,close:()=>{
    if(closed)return;closed=true;
    parent.removeEventListener('abort',abort);
    try{audio.close()}finally{controller.abort()}
   }};
  }catch(error){parent.removeEventListener('abort',abort);controller.abort();throw error}
 }
 private check(){if(this.cancelled)throw new Error('Отменено.')}
 private async execute(id:string){
  const disk=await this.store.get(id);this.check();
  if(disk&&(disk.asrComplete||disk.nextWindow>this.job(id).nextWindow)){
   this.patch(id,{...disk,stage:'queued'});this.committedWindows.set(id,disk.nextWindow);
  }
  const resumed=this.job(id).nextWindow>0||this.job(id).asrComplete;
  this.bench(id,b=>({...b,runs:b.runs+1,resumedRuns:b.resumedRuns+(resumed?1:0)}));
  this.traceEvent(id,'job-start','job',{committedWindows:this.job(id).nextWindow});
  this.traceEvent(id,'audio-start','audio');
  this.patch(id,{stage:'preparing',status:'Подготовка аудио',percent:null,error:undefined,volatileSegments:undefined});await this.persist(id);this.check();
  const file=await this.store.audio(id);this.check();if(!file)throw new Error('Исходное аудио недоступно. Добавьте файл заново; сохранённый текст можно скачать.');
  const audioStarted=Date.now(),decodeStarted=benchmarkNow();
  const audio=await this.readAudio(file);
  const session=audio instanceof Float32Array?undefined:this.newStreamSession(audio);
  let completed=false;
  try{await this.executeAudio(id,audio,audioStarted,decodeStarted,file,session);completed=true}
  finally{if(session)this.closeStreamSession(id,session,completed?'finish':this.cancelled?'cancel':'error')}
 }
 private newStreamSession(audio:StreamedAudio):StreamSession{return {audio,windows:0,rotations:0,closed:false}}
 private closeStreamSession(id:string,session:StreamSession,reason:'rotation'|'recovery'|'finish'|'error'|'cancel'){
  if(session.closed)return;
  session.closed=true;
  const fields={decoderId:session.audio.decoderId,decoderWindows:session.windows,rotationCount:session.rotations,closeReason:reason,committedWindows:this.job(id).nextWindow,jsHeapBytes:traceHeapBytes()};
  try{session.audio.close()}
  catch(error){
   this.traceEvent(id,'stream-session-close-error','audio',{...fields,errorKind:traceErrorKind(error)});
   // Do not open another decoder after a disposal failure. On terminal
   // cleanup retain the original job error or successfully committed text.
   if(reason==='rotation'||reason==='recovery')throw error;
   return;
  }
  this.traceEvent(id,'stream-session-closed','audio',fields);
 }
 private async replaceStream(id:string,session:StreamSession,file:File,reason:'rotation'|'recovery'){
  const length=session.audio.length;
  this.closeStreamSession(id,session,reason);
  this.check();
  const opened=await this.openGuardedStream(file,this.abort!.signal);
  session.audio=opened;session.windows=0;session.closed=false;
  this.check();
  if(opened.length!==length)throw new Error('Длительность аудио изменилась после переоткрытия. Контрольная точка сохранена.');
 }
 private async rotateStreamIfNeeded(id:string,session:StreamSession,file:File,index:number,total:number,inspection=false){
  if(session.windows<this.streamRotateWindows)return;
  this.check();
  if(!inspection&&this.job(id).nextWindow!==index)throw new Error('Ротация разрешена только после сохранения предыдущего окна.');
  const fields={window:index+1,totalWindows:total,committedWindows:this.job(id).nextWindow};
  this.set({operation:(inspection?'Проверка аудио · ':'')+'Плановое обновление декодера'});
  const started=benchmarkNow();
  this.traceEvent(id,'stream-rotation-start','audio',{...fields,decoderId:session.audio.decoderId,decoderWindows:session.windows,rotationCount:session.rotations,jsHeapBytes:traceHeapBytes()});
  await this.persist(id);this.check();
  try{
   await this.replaceStream(id,session,file,'rotation');
   session.rotations++;
   this.traceEvent(id,'stream-rotation-ready','audio',{...fields,decoderId:session.audio.decoderId,decoderWindows:0,rotationCount:session.rotations,elapsedMs:benchmarkNow()-started,jsHeapBytes:traceHeapBytes()});
   await this.persist(id);this.check();
  }catch(error){
   this.traceEvent(id,'stream-rotation-error','audio',{...fields,streamStage:'open',errorKind:traceErrorKind(error),rotationCount:session.rotations,elapsedMs:benchmarkNow()-started});
   throw error;
  }
 }
 private async readCheckedStreamWindow(id:string,audio:StreamedAudio,window:AudioWindow,index:number,total:number,inspection=false,attempt=1,part?:SplitPart){
  const fields={window:index+1,totalWindows:total,startSample:window.start,endSample:window.end,decoderId:audio.decoderId,attempt,committedWindows:this.job(id).nextWindow,...(part?{strategy:'split' as const,...part}:{strategy:'whole' as const})};
  const operation=(label:string)=>this.set({operation:(inspection?'Проверка аудио · ':'')+label+' · окно '+(index+1)+'/'+total+(part?' · часть '+part.part+'/'+part.totalParts:'')});
  const signal=this.abort!.signal;
  const decodeStarted=benchmarkNow();
  let streamStage:StreamStage='decode',accepting=true;
  let pendingTrace:Promise<void>|undefined;
  operation('Декодирование');
  this.traceEvent(id,'stream-read-start','audio',{...fields,streamStage,jsHeapBytes:traceHeapBytes()});
  await this.persist(id);this.check();
  let pcm:Float32Array;
  try{
   pcm=await withActivityWatchdog((heartbeat,beginStage)=>audio.read(window,async event=>{
    if(!accepting||signal.aborted)return;
    const {code,...detail}=event;
    if(code==='stream-read-end'||code==='stream-resample-end')heartbeat();
    if(!accepting||signal.aborted)return;
    if(code==='stream-resample-start'){
     beginStage(this.streamResampleIdleMs);
     if(!accepting||signal.aborted)return;
     streamStage='resample';operation('Преобразование в PCM 16 кГц');
    }
    this.traceEvent(id,code,'audio',{...fields,...detail,jsHeapBytes:traceHeapBytes()});
    pendingTrace=this.persist(id);
    await pendingTrace;
   },heartbeat,part!==undefined),{
    timeoutMs:this.streamDecodeIdleMs,
    pollMs:Math.min(1000,Math.max(5,Math.min(this.streamDecodeIdleMs,this.streamResampleIdleMs)/4)),
    signal,onTimeout:()=>{accepting=false;audio.close()},
    timeoutError:()=>new StreamDecodeStalledError(streamStage)
   });
  }catch(error){
   accepting=false;
   // An already-started metadata transaction must settle before another
   // attempt can write a newer snapshot. Storage failure is not retryable.
   if(pendingTrace)await pendingTrace;
   this.traceEvent(id,'window-error','audio',{...fields,streamStage,elapsedMs:benchmarkNow()-decodeStarted,errorKind:traceErrorKind(error),jsHeapBytes:traceHeapBytes()});
   throw error;
  }finally{accepting=false}
  if(!inspection)this.bench(id,b=>addBenchmarkTiming(b,'decodeMs',benchmarkNow()-decodeStarted));
  if(!(pcm instanceof Float32Array)||pcm.length!==window.end-window.start){
   this.traceEvent(id,'window-error','audio',{...fields,streamStage:'decode',errorKind:'invalid-audio',pcmSamples:pcm?.length});
   throw new AudioValidationError(index+1,null,'invalid-window');
  }
  this.check();operation('Проверка PCM');
  this.traceEvent(id,'stream-pcm-check-start','audio',{...fields,streamStage:'pcm-check',pcmSamples:pcm.length});
  await this.persist(id);this.check();
  const validationStarted=benchmarkNow();
  let report:AudioInspectionReport;
  try{
   report=await withActivityWatchdog(heartbeat=>inspectDecodedPcm(pcm,{signal,onProgress:heartbeat}),{
    timeoutMs:this.streamPcmIdleMs,pollMs:Math.min(1000,Math.max(5,this.streamPcmIdleMs/4)),
    signal,onTimeout:()=>audio.close(),timeoutError:()=>new StreamDecodeStalledError('pcm-check')
   });
  }catch(error){
   this.traceEvent(id,'window-error','audio',{...fields,streamStage:'pcm-check',elapsedMs:benchmarkNow()-validationStarted,errorKind:traceErrorKind(error)});
   throw error;
  }
  if(!inspection)this.bench(id,b=>addBenchmarkTiming(b,'pcmCheckMs',benchmarkNow()-validationStarted));
  this.traceEvent(id,'stream-pcm-check-end','audio',{...fields,streamStage:'pcm-check',elapsedMs:benchmarkNow()-validationStarted,pcmSamples:pcm.length});
  return {pcm,report};
 }
 // Split is an alternative read strategy, not six ASR attempts. The original
 // window is committed only after all parts have passed validation and ASR.
 private async readSplitStreamWindow(id:string,audio:StreamedAudio,window:AudioWindow,index:number,total:number){
  const length=window.end-window.start;
  const totalParts=Math.ceil(length/STREAM_SUBWINDOW_SAMPLES);
  const fields={window:index+1,totalWindows:total,startSample:window.start,endSample:window.end,committedWindows:this.job(id).nextWindow,attempt:3,decoderId:audio.decoderId,strategy:'split' as const,totalParts};
  const pcm=new Float32Array(length);
  this.traceEvent(id,'stream-split-start','audio',fields);await this.persist(id);this.check();
  for(let part=1;part<=totalParts;part++){
   this.check();
   const start=window.start+(part-1)*STREAM_SUBWINDOW_SAMPLES,end=Math.min(start+STREAM_SUBWINDOW_SAMPLES,window.end);
   const subwindow={start,end,first:window.first&&part===1,last:window.last&&part===totalParts};
   const result=await this.readCheckedStreamWindow(id,audio,subwindow,index,total,false,3,{part,totalParts});
   this.check();pcm.set(result.pcm,start-window.start);
   this.traceEvent(id,'stream-split-part-ready','audio',{...fields,startSample:start,endSample:end,part,pcmSamples:result.pcm.length});
   await this.persist(id);
  }
  this.check();this.set({operation:'Проверка собранного PCM · окно '+(index+1)+'/'+total});
  const signal=this.abort!.signal;
  this.traceEvent(id,'stream-pcm-check-start','audio',{...fields,streamStage:'pcm-check',pcmSamples:pcm.length});
  await this.persist(id);this.check();
  const started=benchmarkNow();
  let report:AudioInspectionReport;
  try{
   report=await withActivityWatchdog(heartbeat=>inspectDecodedPcm(pcm,{signal,onProgress:heartbeat}),{
    timeoutMs:this.streamPcmIdleMs,pollMs:Math.min(1000,Math.max(5,this.streamPcmIdleMs/4)),signal,
    onTimeout:()=>audio.close(),timeoutError:()=>new StreamDecodeStalledError('pcm-check')
   });
  }catch(error){
   this.traceEvent(id,'window-error','audio',{...fields,streamStage:'pcm-check',errorKind:traceErrorKind(error)});
   throw error;
  }
  this.check();this.bench(id,b=>addBenchmarkTiming(b,'pcmCheckMs',benchmarkNow()-started));
  this.traceEvent(id,'stream-pcm-check-end','audio',{...fields,streamStage:'pcm-check',pcmSamples:pcm.length,elapsedMs:benchmarkNow()-started});
  this.traceEvent(id,'stream-split-ready','audio',{...fields,pcmSamples:pcm.length});
  await this.persist(id);this.check();
  return {pcm,report};
 }
 private async readRecoverableStreamWindow(id:string,session:StreamSession,file:File,window:AudioWindow,index:number,total:number){
  const fields={window:index+1,totalWindows:total,startSample:window.start,endSample:window.end,committedWindows:this.job(id).nextWindow};
  let attempt=1;
  for(;;){
   this.check();
   try{
    const result=attempt===3?await this.readSplitStreamWindow(id,session.audio,window,index,total):await this.readCheckedStreamWindow(id,session.audio,window,index,total,false,attempt);
    if(attempt>1)this.traceEvent(id,'stream-recovered','audio',{...fields,attempt,decoderId:session.audio.decoderId,strategy:attempt===3?'split':'whole',recoveryCount:this.job(id).streamRecovery?.totalRecoveries});
    return result;
   }catch(error){
    this.check();
    const budget=attempt===3?null:reserveStreamRecovery(error,index+1,this.job(id).streamRecovery);
    if(!budget){
     if(error instanceof StreamDecodeStalledError||attempt===3){
      this.traceEvent(id,'stream-recovery-stop','audio',{...fields,attempt,decoderId:session.audio.decoderId,strategy:attempt===3?'split':'whole',streamStage:error instanceof StreamDecodeStalledError?error.stage:undefined,errorKind:traceErrorKind(error),recoveryCount:this.job(id).streamRecovery?.totalRecoveries??0});
     }
     throw error;
    }
    const nextAttempt=budget.windowRecoveries+1;
    // Reserve durably before opening another decoder, even after a reload.
    this.patch(id,{streamRecovery:budget,status:'Восстановление декодера · окно '+(index+1)+'/'+total+' · попытка '+nextAttempt+'/3'});
    this.set({operation:nextAttempt===3?'Резервное декодирование частями':'Восстановление потокового декодера'});
    this.traceEvent(id,'stream-recovery-start','audio',{...fields,attempt:nextAttempt,decoderId:session.audio.decoderId,strategy:nextAttempt===3?'split':'whole',recoveryCount:budget.totalRecoveries,errorKind:traceErrorKind(error)});
    await this.persist(id);this.check();
    try{
     await this.replaceStream(id,session,file,'recovery');
     attempt=nextAttempt;
     this.traceEvent(id,'stream-reopen-ready','audio',{...fields,attempt,decoderId:session.audio.decoderId,strategy:attempt===3?'split':'whole',recoveryCount:budget.totalRecoveries});
     await this.persist(id);this.check();
    }catch(openError){
     this.traceEvent(id,'stream-recovery-stop','audio',{...fields,attempt:nextAttempt,streamStage:'open',errorKind:traceErrorKind(openError),recoveryCount:budget.totalRecoveries});
     throw openError;
    }
   }
  }
 }
 private async executeAudio(id:string,audio:Float32Array|StreamedAudio,audioStarted:number,decodeStarted:number,file:File,session?:StreamSession){
  const streamed=!(audio instanceof Float32Array);
  this.check();this.patch(id,{duration:audio.length/16000});
  this.bench(id,b=>addBenchmarkTiming(b,'decodeMs',benchmarkNow()-decodeStarted));
  this.traceEvent(id,'audio-ready','audio',{elapsedMs:Date.now()-audioStarted,pcmSamples:audio.length,decoderId:streamed?audio.decoderId:undefined});
  if(!streamed)await this.inspectPcm(id,audio,this.abort!.signal);this.check();
  this.set({operation:'Подготовка модели'});
  const params={...this.job(id).params};
  if(!this.job(id).asrComplete){
   const windows=audioWindows(audio.length,streamed);
   // A corrupted checkpoint must never masquerade as a completed transcript.
   const initial=checkpointProgress(windows,this.job(id).nextWindow);
   if(this.manager.active!==params.model){
    this.traceEvent(id,'model-start','model');await this.persist(id);
    const modelStarted=Date.now(),modelMeasured=benchmarkNow();
    let prepared:Awaited<ReturnType<ModelManager['prepare']>>;
    try{prepared=await this.manager.prepare(params.model)}finally{
     this.bench(id,b=>addBenchmarkTiming(b,'modelInitMs',benchmarkNow()-modelMeasured));
    }
    this.check();this.set({backend:prepared.backend});
    this.traceEvent(id,'model-ready','model',{elapsedMs:Date.now()-modelStarted,backend:traceBackend(prepared.backend)});
   }
   this.set({operation:'Распознавание'});
   this.patch(id,{stage:'recognizing',status:checkpointLabel(initial),percent:initial.percent,backend:this.manager.capabilities?.active??this.state.backend});
   for(let index=initial.completedWindows;index<windows.length;index++){
    this.check();const window=windows[index];
    if(session)await this.rotateStreamIfNeeded(id,session,file,index,windows.length);
    this.patch(id,{status:currentWindowLabel(windows,index)+' · сохранено '+index+' / '+windows.length+' окон · backend: '+(this.manager.capabilities?.active??this.state.backend),percent:checkpointProgress(windows,index).percent});
    // Retry only the current uncommitted window. Previous windows must not
    // be appended again, and checkpoints remain unchanged until commit().
    this.traceEvent(id,'window-start','asr',{window:index+1,totalWindows:windows.length,startSample:window.start,endSample:window.end,pcmSamples:window.end-window.start,committedWindows:this.job(id).nextWindow,backend:traceBackend(this.manager.capabilities?.active??this.state.backend)});
    const pcm=streamed?(await this.readRecoverableStreamWindow(id,session!,file,window,index,windows.length)).pcm:audio.subarray(window.start,window.end);
    this.set({operation:'Распознавание'});
    this.patch(id,{status:currentWindowLabel(windows,index)+' · сохранено '+index+' / '+windows.length+' окон · backend: '+(this.manager.capabilities?.active??this.state.backend)});
    let result:TranscriptSegment[]|undefined,successfulAttemptMs=0;
    for(let attempt=1;attempt<=MAX_ASR_WINDOW_ATTEMPTS;attempt++){
     this.check();
     this.traceEvent(id,'window-attempt','asr',{window:index+1,totalWindows:windows.length,attempt,backend:traceBackend(this.manager.capabilities?.active??this.state.backend)});
     // Save the in-flight window metadata before invoking the Worker.
     // A tab crash can then be diagnosed without claiming a committed result.
     await this.persist(id);
     const attemptBackend=this.manager.capabilities?.active??this.state.backend;
     const attemptStarted=Date.now(),attemptMeasured=benchmarkNow();
     try{
      try{
       result=await withActivityWatchdog(heartbeat=>{
        this.asrHeartbeat=heartbeat;
        return this.manager.transcribe(pcm.slice(),false,()=>{},params.language);
       },{
        timeoutMs:this.asrIdleMs,pollMs:Math.min(1000,Math.max(5,this.asrIdleMs/4)),signal:this.abort!.signal,
        onTimeout:()=>this.manager.cancel()
       });
      }finally{this.asrHeartbeat=null}
      this.check();this.patch(id,{error:undefined});
      successfulAttemptMs=benchmarkNow()-attemptMeasured;
      this.bench(id,b=>({...addBenchmarkTiming(b,'asrAttemptMs',successfulAttemptMs),attempts:b.attempts+1}));
      this.traceEvent(id,'window-result','asr',{window:index+1,totalWindows:windows.length,attempt,elapsedMs:Date.now()-attemptStarted,segmentCount:result.length,backend:traceBackend(this.manager.capabilities?.active??this.state.backend)});
      break;
     }catch(error){
      const elapsed=benchmarkNow()-attemptMeasured;
      this.bench(id,b=>({...addBenchmarkTiming(b,'asrAttemptMs',elapsed),attempts:b.attempts+1,failedAttempts:b.failedAttempts+1}));
      this.traceEvent(id,'window-error','asr',{window:index+1,totalWindows:windows.length,attempt,elapsedMs:Date.now()-attemptStarted,errorKind:traceErrorKind(error),backend:traceBackend(attemptBackend)});
      this.check();
      if(!shouldRetryAsrWindow(error,attempt))throw error;
      const next=attempt+1,wasmOnly=preferWasmAfterFailure(attemptBackend);
      this.traceEvent(id,'window-retry','asr',{window:index+1,totalWindows:windows.length,attempt:next,backend:traceBackend(attemptBackend)});
      this.patch(id,{status:`Ошибка окна ${index+1}/${windows.length} · восстановление Worker · попытка ${next}/${MAX_ASR_WINDOW_ATTEMPTS} · ${checkpointLabel(checkpointProgress(windows,index))}`,error:message(error)});
      // Throw on failed reinit instead of silently continuing on an unknown
      // backend. Explicit cancellation aborts before starting another window.
      const prepared=await this.manager.recover(params.model,wasmOnly);this.check();
      this.bench(id,b=>({...b,workerRecoveries:b.workerRecoveries+1}));
      this.set({backend:prepared.backend});
      this.patch(id,{backend:prepared.backend});
     }
    }
    if(!result)throw new Error('Окно не вернуло результат распознавания.');
    const segments=[...this.job(id).segments,...absoluteSegments(result,window)];
    const after=checkpointProgress(windows,index+1);
    if(streamed){
     this.set({operation:'Сохранение контрольной точки'});
     this.traceEvent(id,'checkpoint-start','checkpoint',{window:index+1,totalWindows:windows.length,committedWindows:this.job(id).nextWindow});
     await this.persist(id);this.check();
    }
    const checkpointStarted=benchmarkNow();
    await this.commit(id,{segments,nextWindow:index+1,percent:after.percent,status:checkpointLabel(after)},segments);
    if(session)session.windows++;
    const checkpointMs=benchmarkNow()-checkpointStarted;
    const uniqueAudioSeconds=(window.end-(index===0?window.start:windows[index-1].end))/16000;
    this.bench(id,b=>recordWindowCommit(b,index+1,successfulAttemptMs,checkpointMs,uniqueAudioSeconds));
    this.traceEvent(id,'checkpoint-committed','checkpoint',{window:index+1,totalWindows:windows.length,committedWindows:index+1,elapsedMs:checkpointMs});
    this.check();
   }
   if(!this.job(id).segments.some(s=>s.text.trim()))throw new Error('Распознанного текста нет. Проверьте запись.');
   await this.commit(id,{asrComplete:true,percent:100,status:'Текст готов и сохранён'});this.check();
  }
  if(params.diarize&&!streamed){
   this.set({operation:'Разделение говорящих'});
   this.traceEvent(id,'speaker-start','speaker');
   this.patch(id,{stage:'speakers',status:'Разделение говорящих. Текст уже доступен.',percent:null});await this.persist(id);this.check();
   const speakerStarted=Date.now();let turns:Awaited<ReturnType<ModelManager['diarize']>>;
   const speakerMeasured=benchmarkNow();
   try{turns=await this.manager.diarize(audio)}catch(error){this.traceEvent(id,'speaker-error','speaker',{elapsedMs:Date.now()-speakerStarted,errorKind:traceErrorKind(error)});throw error}
   this.check();
   this.bench(id,b=>addBenchmarkTiming(b,'speakerMs',benchmarkNow()-speakerMeasured));
   this.traceEvent(id,'speaker-result','speaker',{elapsedMs:Date.now()-speakerStarted,segmentCount:turns.length});
   const segments=this.job(id).segments;
   const aligned=alignSpeakers(segments,turns),speakerSegments=aligned.segments;
   const stats=aligned.stats;
   // Mapping diagnostics are numeric, contain no audio, speaker identifiers,
   // transcript text or source filename. ASR checkpoints remain untouched.
   this.traceEvent(id,'speaker-alignment','speaker',{segmentCount:stats.segments,unlabeled:stats.unlabeled,ambiguous:stats.ambiguous,uncovered:stats.uncovered,boundaryMatches:stats.boundaryMatches});
   this.patch(id,{speakerSegments,diagnostics:stats,stage:stats.unlabeled?'partial':'done',status:stats.unlabeled?`Текст готов · без спикера: ${stats.unlabeled} из ${stats.segments}`:'Текст и спикеры готовы',percent:100});
  }else this.patch(id,{stage:'done',status:streamed&&params.diarize?'Текст готов · потоковый режим без спикеров':'Текст готов',percent:100});
  if(this.job(id).stage==='done')this.patch(id,{failure:undefined});
  this.traceEvent(id,'job-complete','job',{committedWindows:this.job(id).nextWindow});
  // Closing the FIFO slot is part of the successful terminal job commit.
  this.patch(id,{queueOrder:undefined});
  await this.persist(id);this.check();
  this.set({operation:'Формирование TXT'});
  // Browser download APIs cannot reliably report a blocked download.
  try{this.export(id,params.diarize&&!streamed?'speakers':'plain');this.set({notice:'Автоскачивание TXT запрошено. Если файл не появился, используйте кнопки справа от записи.'})}catch(error){this.set({notice:'Используйте ручное скачивание TXT. '+message(error)})}
 }
 cancel(){if(!this.state.busy)return;const audioCheck=this.state.operation.startsWith('Проверка аудио');this.cancelled=true;this.abort?.abort();if(!audioCheck)this.manager.cancel();if(!audioCheck)this.set({backend:'Не инициализировано'})}
 async prepare(model:WhisperId,wasmOnly=false){
  if(this.state.busy)return;this.set({busy:true,operation:'Подготовка модели'});this.cancelled=false;
  try{await this.exclusive(async()=>{const prepared=await this.manager.prepare(model,{wasmOnly});this.set({backend:prepared.backend})})}catch(error){this.set({notice:message(error)})}
  finally{this.set({busy:false,operation:''});this.continuePending()}
 }
 async preloadSpeakers(){
  if(this.state.speakerDownload!=='idle')return;
  this.set({speakerDownload:'pending'});
  if(!this.state.busy)await this.drain();
 }
 private async downloadSpeakers(){
  this.cancelled=false;
  this.set({speakerDownload:'loading',operation:'Загрузка моделей говорящих'});
  try{
   const cached=await this.manager.speakersCached();
   if(!this.cancelled&&!(cached.segmentation&&cached.embedding)){
    await this.manager.preloadSpeakers();
    this.set({backend:'Не инициализировано'});
   }
  }catch(error){if(!this.cancelled)this.set({notice:message(error)})}
  finally{this.set({speakerDownload:'idle',operation:''})}
 }
 exportDiagnostics(id:string){
  const job=this.job(id);
  this.diagnosticDownload(diagnosticReport(job),'iscribe_diagnostics_'+job.id.slice(0,8)+'.json');
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
