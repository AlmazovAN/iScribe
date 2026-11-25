import type {TranscriptSegment} from '@yourdevice/engine';
import {decodeAudio,validateFile,isLargeMp3} from './audio';
import {inspectMp3Frames,Mp3WindowReader} from './streamingMp3';
import {audioDuration} from './audioMetadata';
import {inspectDecodedPcm,AudioValidationError,type AudioInspectionReport} from './audioValidation';
import {JobStore} from './jobStore';
import {createJob,isRunning,audioWindows,absoluteSegments,recoverJob,type Job,type JobParams} from './jobs';
import {createFailureDiagnostic,consumePageExit} from './jobDiagnostics';
import {appendTrace,diagnosticReport,downloadDiagnosticJson,traceBackend,traceErrorKind,type TraceCode,type TracePhase,type TraceEvent} from './jobTrace';
import {checkpointProgress,checkpointLabel,currentWindowLabel} from './recognitionProgress';
import {MAX_ASR_WINDOW_ATTEMPTS,shouldRetryAsrWindow,preferWasmAfterFailure} from './ml/recoveryPolicy';
import {DEFAULT_ASR_IDLE_MS,withActivityWatchdog} from './ml/activityWatchdog';
import {ModelManager,type EnginePhase,type WhisperId} from './ml/manager';
import {alignSpeakers} from './ml/speakers';
import {downloadTranscript,formatTranscript} from './formatTranscript';
import {addBenchmarkTiming,benchmarkNow,benchmarkReport,downloadBenchmarkJson,emptyBenchmark,recordWindowCommit,sampleMainThreadHeap,type JobBenchmark} from './benchmark';
import {browserEvidenceHints,createHardwareEvidence,downloadHardwareEvidence} from './hardwareAcceptance';
export type RunnerSnapshot={jobs:Job[];busy:boolean;ready:boolean;activeId:string|null;notice:string;backend:string;enginePhase:EnginePhase;operation:string;queueCount:number};
export class JobRunner{
 readonly manager:ModelManager;
 private store:JobStore;
 private state:RunnerSnapshot={jobs:[],busy:false,ready:false,activeId:null,notice:'',backend:'Не инициализировано',enginePhase:'idle',operation:'',queueCount:0};
 private listeners=new Set<()=>void>();
 private queue:string[]=[];
 private nextQueueOrder=0;
 private queueWrites:Promise<void>=Promise.resolve();
 private cancelled=false;
 private abort:AbortController|null=null;
 private download:(text:string,name:string)=>void;
 private diagnosticDownload:typeof downloadDiagnosticJson;
 private benchmarkDownload:typeof downloadBenchmarkJson;
 private hardwareDownload:typeof downloadHardwareEvidence;
 private decode:typeof decodeAudio;
 private initialization:Promise<void>|undefined;
 private lease:Promise<unknown>|undefined;
 private committedWindows=new Map<string,number>();
 private asrHeartbeat:(()=>void)|null=null;
 private readonly asrIdleMs:number;
 constructor(options:{store?:JobStore;manager?:ModelManager;decode?:typeof decodeAudio;download?:typeof downloadTranscript;downloadDiagnostic?:typeof downloadDiagnosticJson;downloadBenchmark?:typeof downloadBenchmarkJson;downloadHardware?:typeof downloadHardwareEvidence;asrIdleMs?:number}={}){
  this.store=options.store??new JobStore();this.manager=options.manager??new ModelManager();this.decode=options.decode??decodeAudio;this.download=options.download??downloadTranscript;this.diagnosticDownload=options.downloadDiagnostic??downloadDiagnosticJson;this.benchmarkDownload=options.downloadBenchmark??downloadBenchmarkJson;this.hardwareDownload=options.downloadHardware??downloadHardwareEvidence;
  this.asrIdleMs=options.asrIdleMs??DEFAULT_ASR_IDLE_MS;
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
 private async inspectPcm(id:string,pcm:Float32Array,signal?:AbortSignal):Promise<AudioInspectionReport>{
  this.traceEvent(id,'audio-check-start','audio',{pcmSamples:pcm.length});
  await this.persist(id);
  try{
   const started=benchmarkNow();
   const report=await inspectDecodedPcm(pcm,{signal,onProgress:(done,total)=>this.set({operation:`Проверка аудио: окно ${done}/${total}`})});
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
    if(isLargeMp3(file))throw new Error('Для MP3 свыше 128 МБ отдельная полная проверка PCM недоступна. Каждое окно проверяется перед распознаванием.');
    const pcm=await this.decode(file,this.abort!.signal);
    this.check();this.traceEvent(id,'audio-ready','audio',{elapsedMs:Date.now()-started,pcmSamples:pcm.length});
    await this.inspectPcm(id,pcm,this.abort!.signal);
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
   if(this.queue.length)void this.drain();
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
  if(this.state.activeId===id||this.queue.includes(id))return;
  try{await this.store.remove(id);this.committedWindows.delete(id);this.set({jobs:this.state.jobs.filter(j=>j.id!==id)})}catch(error){this.set({notice:message(error)})}
 }
 enqueue(id:string,params?:JobParams){
  const job=this.job(id);if(this.state.activeId===id)return;
  if(this.queue.includes(id)){this.resumeQueue();return}
  // Parameters are captured on the first start. Resume retains the original.
  if(job.stage==='waiting'&&params)this.patch(id,{params:{...params}});
  const order=++this.nextQueueOrder;
  this.queue.push(id);
  this.patch(id,{stage:'queued',status:'В очереди',error:undefined,queueOrder:order});
  this.set({queueCount:this.queue.length});
  this.queueWrites=this.queueWrites.then(()=>this.persist(id));
  // Keep the rejection for ensureQueueSaved() while immediately observing it
  // so a quota failure cannot become a global unhandledrejection event.
  void this.queueWrites.catch(()=>{});
  void this.drain();
 }
 resumeQueue(){if(this.state.ready&&!this.state.busy&&this.queue.length)void this.drain()}
 private async ensureQueueSaved(){
  try{await this.queueWrites}catch{
   for(const id of this.queue)await this.persist(id);
   this.queueWrites=Promise.resolve();
  }
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
    while(this.queue.length){
     await this.ensureQueueSaved();
     const id=this.queue[0];
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
      this.queue.shift();this.set({queueCount:this.queue.length});
     }
    }
   });await this.lease;
  }catch(error){
   // Do not drop persistent queue entries when another tab owns the Web Lock
   // or the browser cannot commit queue metadata. Retry from this checkpoint.
   this.set({notice:'Запуск очереди отложен. Если причина в хранилище, очередь могла не сохраниться — не закрывайте страницу до устранения ошибки. '+message(error)});
  }finally{this.asrHeartbeat=null;this.set({busy:false,activeId:null,operation:'',queueCount:this.queue.length});this.abort=null;this.lease=undefined}
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
  const largeMp3=isLargeMp3(file);
  // Scan MP3 headers using bounded Blob slices. Large source never enters
  // full-buffer browser decode; only current 30-second PCM is held in RAM.
  const overview=largeMp3?await inspectMp3Frames(file,this.abort!.signal):null;
  const audio=largeMp3?null:await this.decode(file,this.abort!.signal);
  this.check();
  const pcmSamples=overview?.pcmSamples??audio!.length;
  this.patch(id,{duration:pcmSamples/16000});
  this.bench(id,b=>addBenchmarkTiming(b,'decodeMs',benchmarkNow()-decodeStarted));
  this.traceEvent(id,'audio-ready','audio',{elapsedMs:Date.now()-audioStarted,pcmSamples});
  if(audio)await this.inspectPcm(id,audio,this.abort!.signal);
  else this.set({operation:'Большой MP3: проверка PCM каждого окна перед Whisper'});
  this.check();
  let stream:Mp3WindowReader|null=null;
  try{
  this.set({operation:'Подготовка модели'});
  const params={...this.job(id).params};
  if(!this.job(id).asrComplete){
   const windows=audioWindows(pcmSamples);
   if(largeMp3)stream=await Mp3WindowReader.open(file,overview!,this.abort!.signal);
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
    const windowPcm=stream?await stream.window(window.start,window.end,this.abort!.signal):audio!.slice(window.start,window.end);
    for(let sample=0;sample<windowPcm.length;sample++){
     if(!Number.isFinite(windowPcm[sample]))throw new AudioValidationError(index+1,window.start+sample,'invalid-sample');
    }
    this.patch(id,{status:currentWindowLabel(windows,index)+' · сохранено '+index+' / '+windows.length+' окон · backend: '+(this.manager.capabilities?.active??this.state.backend),percent:checkpointProgress(windows,index).percent});
    // Retry only the current uncommitted window. Previous windows must not
    // be appended again, and checkpoints remain unchanged until commit().
    this.traceEvent(id,'window-start','asr',{window:index+1,totalWindows:windows.length,startSample:window.start,endSample:window.end,pcmSamples:window.end-window.start,committedWindows:this.job(id).nextWindow,backend:traceBackend(this.manager.capabilities?.active??this.state.backend)});
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
        return this.manager.transcribe(windowPcm,false,()=>{},params.language);
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
    const checkpointStarted=benchmarkNow();
    await this.commit(id,{segments,nextWindow:index+1,percent:after.percent,status:checkpointLabel(after)},segments);
    const checkpointMs=benchmarkNow()-checkpointStarted;
    const uniqueAudioSeconds=(window.end-(index===0?window.start:windows[index-1].end))/16000;
    this.bench(id,b=>recordWindowCommit(b,index+1,successfulAttemptMs,checkpointMs,uniqueAudioSeconds));
    this.traceEvent(id,'checkpoint-committed','checkpoint',{window:index+1,totalWindows:windows.length,committedWindows:index+1});
    this.check();
   }
   if(!this.job(id).segments.some(s=>s.text.trim()))throw new Error('Распознанного текста нет. Проверьте запись.');
   await this.commit(id,{asrComplete:true,percent:100,status:'Текст готов и сохранён'});this.check();
  }
  if(params.diarize&&largeMp3){
   // The existing speaker engine needs whole-record PCM; never allocate it
   // or claim speaker accuracy on a large MP3. ASR checkpoints stay durable.
   this.patch(id,{stage:'partial',status:'Текст готов. Для MP3 свыше 128 МБ разделение говорящих пока недоступно.',percent:100});
  }else if(params.diarize){
   this.set({operation:'Разделение говорящих'});
   this.traceEvent(id,'speaker-start','speaker');
   this.patch(id,{stage:'speakers',status:'Разделение говорящих. Текст уже доступен.',percent:null});await this.persist(id);this.check();
   const speakerStarted=Date.now();let turns:Awaited<ReturnType<ModelManager['diarize']>>;
   const speakerMeasured=benchmarkNow();
   try{turns=await this.manager.diarize(audio!)}catch(error){this.traceEvent(id,'speaker-error','speaker',{elapsedMs:Date.now()-speakerStarted,errorKind:traceErrorKind(error)});throw error}
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
  }else this.patch(id,{stage:'done',status:'Текст готов',percent:100});
  if(this.job(id).stage==='done')this.patch(id,{failure:undefined});
  this.traceEvent(id,'job-complete','job',{committedWindows:this.job(id).nextWindow});
  // Closing the FIFO slot is part of the successful terminal job commit.
  this.patch(id,{queueOrder:undefined});
  await this.persist(id);this.check();
  this.set({operation:'Формирование TXT'});
  // Browser download APIs cannot reliably report a blocked download.
  try{this.export(id,params.diarize&&!largeMp3?'speakers':'plain');this.set({notice:largeMp3?'Большой MP3 распознан потоково. TXT доступен; диаризация больших файлов пока недоступна.':'Автоскачивание TXT запрошено. Если файл не появился, используйте кнопки справа от записи.'})}catch(error){this.set({notice:'Используйте ручное скачивание TXT. '+message(error)})}
  }finally{stream?.close()}
 }
 cancel(){if(!this.state.busy)return;const audioCheck=this.state.operation.startsWith('Проверка аудио');this.cancelled=true;this.abort?.abort();if(!audioCheck)this.manager.cancel();if(!audioCheck)this.set({backend:'Не инициализировано'})}
 async prepare(model:WhisperId,wasmOnly=false){
  if(this.state.busy)return;this.set({busy:true,operation:'Подготовка модели'});this.cancelled=false;
  try{await this.exclusive(async()=>{const prepared=await this.manager.prepare(model,{wasmOnly});this.set({backend:prepared.backend})})}catch(error){this.set({notice:message(error)})}
  finally{this.set({busy:false,operation:''});if(this.queue.length)void this.drain()}
 }
 async preloadSpeakers(){
  if(this.state.busy)return;this.set({busy:true,operation:'Загрузка моделей говорящих'});this.cancelled=false;
  try{await this.exclusive(async()=>{await this.manager.preloadSpeakers();this.set({backend:'Не инициализировано'})})}catch(error){this.set({notice:message(error)})}
  finally{this.set({busy:false,operation:''});if(this.queue.length)void this.drain()}
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
