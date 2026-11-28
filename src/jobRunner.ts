import type {TranscriptSegment} from '@yourdevice/engine';
import {decodeAudio,usesStreamedAudio,validateFile} from './audio';
import {chooseAudioDecoder,providerForDecoder,openSelectedStream} from './audioDecoderProvider';
import {resolveJobDecoder,canRetryFfmpeg,ffmpegFailureFields,type DecoderIdentity,type AudioDecoderKind} from './decoderDiagnostics';
import type {StreamedAudio} from './streamedAudio';
import {audioDuration} from './audioMetadata';
import {inspectDecodedPcm,AudioValidationError,type AudioInspectionReport} from './audioValidation';
import {JobStore} from './jobStore';
import {createJob,audioWindows,absoluteSegments,recoverJob,type Job,type JobParams} from './jobs';
import {createFailureDiagnostic,consumePageExit} from './jobDiagnostics';
import {appendTrace,pcmValidationFields,diagnosticReport,downloadDiagnosticJson,traceBackend,traceErrorKind,traceHeapBytes,type StreamStage,type TraceCode,type TracePhase,type TraceEvent} from './jobTrace';
import {checkpointProgress,checkpointLabel,currentWindowLabel,type AudioWindow} from './recognitionProgress';
import {MAX_ASR_WINDOW_ATTEMPTS,shouldRetryAsrWindow,preferWasmAfterFailure,reserveStreamRecovery,STREAM_SUBWINDOW_SAMPLES,DEFAULT_STREAM_ROTATE_WINDOWS} from './ml/recoveryPolicy';
import {DEFAULT_ASR_IDLE_MS,DEFAULT_STREAM_OPEN_IDLE_MS,DEFAULT_STREAM_DECODE_IDLE_MS,DEFAULT_STREAM_RESAMPLE_IDLE_MS,DEFAULT_STREAM_PCM_IDLE_MS,StreamDecodeStalledError,withActivityWatchdog} from './ml/activityWatchdog';
import {ModelManager,type EnginePhase,type WhisperId} from './ml/manager';
import {alignSpeakers} from './ml/speakers';
import {downloadTranscript,formatTranscript} from './formatTranscript';
import {addBenchmarkTiming,benchmarkNow,emptyBenchmark,recordWindowCommit,sampleMainThreadHeap,type JobBenchmark} from './benchmark';
import {addPerfTiming,collectDeviceHints,emptyPerformanceProfile,observeBackend,type PerfTimingKey} from './performance/profiler';
import {BackendPolicy,resourceFailure} from './performance/backendPolicy';
import {observeWasmThreads} from './performance/wasmThreads';
import {AsrPayloadPool,emptyMemoryObservations,observePayload,shouldReleaseAfterQueue} from './performance/memoryPolicy';
import {emptyStorageUi,ProgressGate,shouldPersistStreamEvent,type StorageUiObservations} from './performance/storageUiPolicy';
import {emptySpeakerPerformance} from './performance/speakerPerformance';
import {captureRunContext} from './performance/runContext';
import {AudioPipeline,emptyPipeline} from './performance/audioPipeline';
import {prepareStreamWindow,type PreparedStreamWindow} from './performance/prefetchStream';
import {ResourceManager,waitAtBoundary} from './performance/resourceManager';
import {boundaryPauseMs,observeResourcePause,observeWindowPolicy} from './performance/resourcePolicy';
import type {PerformanceMode,ResourcePolicy} from './performance/types';
export type RunnerSnapshot={jobs:Job[];busy:boolean;ready:boolean;activeId:string|null;notice:string;backend:string;enginePhase:EnginePhase;operation:string;queueCount:number;speakerDownload:'idle'|'pending'|'loading';performanceMode:PerformanceMode;activeResourcePolicy:ResourcePolicy|null};
type StreamSession={audio:StreamedAudio;windows:number;rotations:number;closed:boolean};
type SplitPart={part:number;totalParts:number};
export class JobRunner{
 readonly manager:ModelManager;
 private readonly resources:ResourceManager;
 private readonly backendPolicy:BackendPolicy;
 private readonly boundaryWait:typeof waitAtBoundary;
 private store:JobStore;
 private state:RunnerSnapshot={jobs:[],busy:false,ready:false,activeId:null,notice:'',backend:'Не инициализировано',enginePhase:'idle',operation:'',queueCount:0,speakerDownload:'idle',performanceMode:'medium',activeResourcePolicy:null};
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
 private decode?:typeof decodeAudio;
 private openStream?:typeof openSelectedStream;
 private activeDecoder?:DecoderIdentity;
 private readonly requestedDecoder:AudioDecoderKind;
 private initialization:Promise<void>|undefined;
 private lease:Promise<unknown>|undefined;
 private committedWindows=new Map<string,number>();
 private asrHeartbeat:(()=>void)|null=null;
 private readonly progressGate=new ProgressGate();
 // Keep suppressed progress counters off the hot UI path. Flush on normal
 // durable writes, never trigger another notification for a dropped update.
 private suppressedProgress=new Map<string,number>();
 private readonly asrIdleMs:number;
 private readonly streamOpenIdleMs:number;
 private readonly streamDecodeIdleMs:number;
 private readonly streamResampleIdleMs:number;
 private readonly streamPcmIdleMs:number;
 private readonly streamRotateWindows:number;
 constructor(options:{decoderPreference?:AudioDecoderKind;backendPolicy?:BackendPolicy;resources?:ResourceManager;boundaryWait?:typeof waitAtBoundary;store?:JobStore;manager?:ModelManager;decode?:typeof decodeAudio;openStream?:typeof openSelectedStream;download?:typeof downloadTranscript;downloadDiagnostic?:typeof downloadDiagnosticJson;asrIdleMs?:number;streamOpenIdleMs?:number;streamDecodeIdleMs?:number;streamResampleIdleMs?:number;streamPcmIdleMs?:number;streamRotateWindows?:number}={}){
  this.backendPolicy=options.backendPolicy??new BackendPolicy();
  this.resources=options.resources??new ResourceManager();this.boundaryWait=options.boundaryWait??waitAtBoundary;
  this.state={...this.state,performanceMode:this.resources.selected};
  this.store=options.store??new JobStore();this.manager=options.manager??new ModelManager();this.decode=options.decode;this.download=options.download??downloadTranscript;this.diagnosticDownload=options.downloadDiagnostic??downloadDiagnosticJson;
  this.openStream=options.openStream;
   // Injected test/alternate runtimes do not claim to be real FFmpeg.
   this.requestedDecoder=options.decoderPreference??(options.decode||options.openStream?'legacy':chooseAudioDecoder(typeof location==='undefined'?'':location.search).kind);
  this.asrIdleMs=options.asrIdleMs??DEFAULT_ASR_IDLE_MS;
  this.streamOpenIdleMs=options.streamOpenIdleMs??DEFAULT_STREAM_OPEN_IDLE_MS;
  this.streamDecodeIdleMs=options.streamDecodeIdleMs??DEFAULT_STREAM_DECODE_IDLE_MS;
  this.streamResampleIdleMs=options.streamResampleIdleMs??DEFAULT_STREAM_RESAMPLE_IDLE_MS;
  this.streamPcmIdleMs=options.streamPcmIdleMs??DEFAULT_STREAM_PCM_IDLE_MS;
  this.streamRotateWindows=options.streamRotateWindows??DEFAULT_STREAM_ROTATE_WINDOWS;
  if(!Number.isSafeInteger(this.streamRotateWindows)||this.streamRotateWindows<1)throw new Error('Некорректный интервал ротации декодера.');
  this.manager.onLifecycleChange=event=>{
   this.progressGate.reset();
   this.set({enginePhase:event.phase,backend:event.backend??'Не инициализировано'});
  };
  this.manager.onProgress=(status,percent)=>{
   if(this.cancelled)return;
   const id=this.state.activeId;
   if(!id){if(this.progressGate.allow('manual:'+this.state.enginePhase,benchmarkNow()))this.set({operation:status});return}
   // Engine callbacks report progress INSIDE a 30s window. Never replace the
   // persisted whole-recording checkpoint or its percent with this value.
   const stage=this.job(id).stage;
   if(stage==='recognizing'){this.asrHeartbeat?.();return}
   if(!this.progressGate.allow(id+':'+stage,benchmarkNow())){
    this.suppressedProgress.set(id,(this.suppressedProgress.get(id)??0)+1);return;
   }
   this.patch(id,{status,percent:stage==='speakers'?percent:null});
  };
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}};
 snapshot=()=>this.state;
 setPerformanceMode(mode:PerformanceMode){this.resources.select(mode);this.set({performanceMode:this.resources.selected})}
 private set(patch:Partial<RunnerSnapshot>){
  if((Object.keys(patch) as (keyof RunnerSnapshot)[]).every(key=>Object.is(this.state[key],patch[key])))return;
  this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());
 }
 private patch(id:string,patch:Partial<Job>){this.set({jobs:this.state.jobs.map(j=>j.id===id?{...j,...patch,updated:Date.now()}:j)})}
 private job(id:string){const job=this.state.jobs.find(j=>j.id===id);if(!job)throw new Error('Задание не найдено.');return job}
 private bench(id:string,update:(previous:JobBenchmark)=>JobBenchmark){
  const next=sampleMainThreadHeap(update(this.job(id).benchmark??emptyBenchmark()));
  this.patch(id,{benchmark:next});
 }
 private perf(id:string,key:PerfTimingKey,ms:number){
  const b=this.job(id).benchmark;if(!b?.profiler)return;
  this.bench(id,current=>({...current,profiler:addPerfTiming(current.profiler!,key,ms)}));
 }
 private storageUi(id:string,key:keyof Omit<StorageUiObservations,'version'>,count=1){
  if(!this.job(id).benchmark)return;
  this.bench(id,b=>{const current=b.storageUi??emptyStorageUi();return {...b,storageUi:{...current,[key]:current[key]+count}}});
 }
 private flushProgressCounters(id:string){
  const count=this.suppressedProgress.get(id)??0;this.suppressedProgress.delete(id);
  if(count)this.storageUi(id,'suppressedProgressUpdates',count);
 }
 private async timedMetadata(id:string){
  const started=benchmarkNow();
  try{await this.persist(id)}finally{this.perf(id,'metadataPersistence',benchmarkNow()-started)}
 }
 private async inspectPcm(id:string,pcm:Float32Array,signal?:AbortSignal):Promise<AudioInspectionReport>{
  this.traceEvent(id,'audio-check-start','audio',{pcmSamples:pcm.length});
  await this.persist(id);
  try{
   const started=benchmarkNow();
   const onProgress=(done:number,total:number)=>this.set({operation:`Проверка аудио: окно ${done}/${total}`});
   const report=await inspectDecodedPcm(pcm,{signal,onProgress});
   this.bench(id,b=>addBenchmarkTiming(b,'pcmCheckMs',benchmarkNow()-started));
   this.patch(id,{audioCheck:{status:'passed',checkedAt:Date.now(),report}});
   this.traceEvent(id,'audio-check-pass','audio',{pcmSamples:report.pcmSamples,totalWindows:report.windowCount,pcmQuality:report.quality});
   await this.persist(id);
   return report;
  }catch(error){
   if(!this.cancelled){
    const problem=error instanceof AudioValidationError?error.message:'Проверка PCM не завершена. Повторите проверку или проверьте декодирование.';
    this.patch(id,{audioCheck:{status:'failed',checkedAt:Date.now(),problem}});
    this.traceEvent(id,'audio-check-error','audio',{errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error)});
    try{await this.persist(id)}catch{/* Preserve the original failure and existing checkpoint. */}
   }
   throw error;
  }
 }
 private traceEvent(id:string,code:TraceCode,phase:TracePhase,fields:Omit<TraceEvent,'at'|'phase'|'code'>={}){
  const job=this.job(id);
  const decoder=this.activeDecoder??job.decoderIdentity;
   this.patch(id,{trace:appendTrace(job.trace,{at:Date.now(),phase,code,...(decoder?{decoderKind:decoder.kind,decoderRoute:decoder.route}:{}),...fields})});
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
  this.flushProgressCounters(id);
  try{const job={...this.job(id)};delete job.volatileSegments;await this.store.save(job);this.committedWindows.set(id,job.nextWindow)}catch(error){this.set({notice:'Не удалось сохранить результат в браузере. Скачайте доступный TXT. '+message(error)});throw new Error('Ошибка локального сохранения. Текст остаётся доступен в этой вкладке.')}
 }
 // Persist the text and nextWindow in ONE transaction, THEN publish progress.
 // If the transaction fails, keep the uncommitted text only in the open tab
 // for immediate export; it is never considered part of the durable checkpoint.
 private async commit(id:string,patch:Partial<Job>,volatileText?:TranscriptSegment[]){
  this.flushProgressCounters(id);
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
 private releaseIdleModel(id:string){
  try{
   if(this.manager.releaseIdle?.())this.bench(id,b=>{const memory=b.memory??emptyMemoryObservations();return {...b,memory:{...memory,idleModelReleases:memory.idleModelReleases+1}}});
  }catch{
   this.bench(id,b=>{const memory=b.memory??emptyMemoryObservations();return {...b,memory:{...memory,releaseFailures:memory.releaseFailures+1}}});
   this.set({notice:'Не удалось полностью подтвердить освобождение модели. Сохранённый текст доступен.'});
  }
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
     this.cancelled=false;this.abort=new AbortController();this.resources.beginRun();this.manager.forceSingleWasmThread=false;this.manager.resourcePolicy=this.resources.policy();this.set({activeId:id,activeResourcePolicy:null});
     const runStarted=benchmarkNow();let runTimeRecorded=false;
     try{
      await this.execute(id);
      if(this.queue.length<=1&&shouldReleaseAfterQueue(this.resources.selected,collectDeviceHints().deviceMemoryGiB,this.manager.active))this.releaseIdleModel(id);
      this.bench(id,b=>addBenchmarkTiming(b,'runMs',benchmarkNow()-runStarted));runTimeRecorded=true;
      await this.persist(id);
     }catch(error){
      this.releaseIdleModel(id);
      this.bench(id,b=>({...addBenchmarkTiming(b,'runMs',runTimeRecorded?0:benchmarkNow()-runStarted),failedRuns:b.failedRuns+1}));
      const job=this.job(id);
      const failure=createFailureDiagnostic(job,this.cancelled?'cancelled':'execution-error',message(error),job.backend??this.state.backend,this.committedWindows.get(id)??job.nextWindow);
      this.traceEvent(id,this.cancelled?'job-cancelled':'job-error','job',{errorKind:this.cancelled?'cancelled':traceErrorKind(error),committedWindows:job.nextWindow,backend:traceBackend(job.backend??this.state.backend)});
      this.patch(id,{stage:this.cancelled?'cancelled':job.asrComplete?'partial':'error',status:this.cancelled?'Отменено. Полученный текст сохранён.':job.asrComplete?'Текст готов. Разделение говорящих не завершено.':'Обработка прервана. Можно продолжить.',error:this.cancelled?undefined:message(error),percent:null,failure,queueOrder:undefined});
      try{await this.persist(id)}catch{/* Keep available text in memory and the storage error visible. */}
      if(!this.cancelled&&this.job(id).asrComplete){try{this.export(id,'plain');this.set({notice:'Разделение говорящих не завершено. Автоскачивание готового текста запрошено; ручные кнопки доступны.'})}catch{/* Manual exports remain available. */}}
     }finally{
      this.suppressedProgress.delete(id);this.progressGate.reset();this.activeDecoder=undefined;
      this.manager.resourcePolicy=null;this.queue.shift();this.set({activeId:null,activeResourcePolicy:null,queueCount:this.queue.length});
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
 private async readAudio(id:string,file:File){
  const signal=this.abort!.signal;
  const identity=this.activeDecoder!;
  const provider=providerForDecoder(identity.kind);
  if(identity.route==='windowed'){
   try{return await this.openGuardedStream(file,signal)}catch(error){
    this.traceEvent(id,'decoder-open-error','audio',{streamStage:'open',errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error)});throw error;
   }
  }
  const decode=this.decode??provider.decode;
  for(;;){
   try{return await decode(file,signal)}catch(error){
    this.traceEvent(id,'decoder-full-error','audio',{streamStage:'decode',errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error)});
    this.check();signal.throwIfAborted();
    if(!canRetryFfmpeg(error,'full')||(this.job(id).fullDecodeRecoveries??0)>=1)throw error;
    this.patch(id,{fullDecodeRecoveries:1,status:'Повторное декодирование FFmpeg · попытка 2/2'});
    this.traceEvent(id,'decoder-full-retry','audio',{attempt:2,streamStage:'decode',...ffmpegFailureFields(error)});
    await this.persist(id);this.check();
   }
  }
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
    const open=this.openStream??providerForDecoder(this.activeDecoder?.kind??'legacy').openStream;
     const opened=await open(file,controller.signal);
    if(controller.signal.aborted){opened.close();controller.signal.throwIfAborted()}
    return opened;
   },{
    timeoutMs:this.streamOpenIdleMs,pollMs:Math.min(1000,Math.max(5,this.streamOpenIdleMs/4)),
    signal:parent,onTimeout:abort,timeoutError:()=>new StreamDecodeStalledError('open')
   });
   if(parent.aborted){audio.close();parent.throwIfAborted()}
   let closed=false,closeFailed=false,closeError:unknown;
   return {...audio,close:()=>{
    // The watchdog may swallow a disposal exception to reject its pending
    // read. A subsequent recovery must still see that exception and stop.
    if(closed){if(closeFailed)throw closeError;return}closed=true;
    parent.removeEventListener('abort',abort);
    try{audio.close()}catch(error){closeFailed=true;closeError=error;throw error}finally{controller.abort()}
   }};
  }catch(error){parent.removeEventListener('abort',abort);controller.abort();throw error}
 }
 private check(){if(this.cancelled)throw new Error('Отменено.')}
 private async execute(id:string){
  const disk=await this.store.get(id);this.check();
  if(disk&&(disk.asrComplete||disk.nextWindow>this.job(id).nextWindow||disk.decoderIdentity!==undefined||disk.fullDecodeRecoveries!==undefined)){
   this.patch(id,{...disk,stage:'queued'});this.committedWindows.set(id,disk.nextWindow);
  }
  const resumed=this.job(id).nextWindow>0||this.job(id).asrComplete;
  const jobAtStart=this.job(id);
  const context=captureRunContext(this.resources.selected,this.manager.active===jobAtStart.params.model,false,jobAtStart.nextWindow);
  this.bench(id,b=>({...b,profiler:b.profiler??emptyPerformanceProfile(),runs:b.runs+1,resumedRuns:b.resumedRuns+(resumed?1:0),...(b.runs===0?{firstRunContext:context}:{})}));
  this.traceEvent(id,'job-start','job',{committedWindows:this.job(id).nextWindow});
  this.traceEvent(id,'audio-start','audio');
  this.patch(id,{stage:'preparing',status:'Подготовка аудио',percent:null,error:undefined,volatileSegments:undefined});await this.persist(id);this.check();
  const file=await this.store.audio(id);this.check();if(!file)throw new Error('Исходное аудио недоступно. Добавьте файл заново; сохранённый текст можно скачать.');
  const requested=this.requestedDecoder;
   const identity=resolveJobDecoder(this.job(id).decoderIdentity,resumed,requested,usesStreamedAudio(file.size)?'windowed':'full');
   this.activeDecoder=identity;
   this.patch(id,{decoderIdentity:identity});
   this.traceEvent(id,'decoder-selected','audio',{decoderKind:identity.kind,decoderRoute:identity.route});
   await this.persist(id);this.check();
   const audioStarted=Date.now(),decodeStarted=benchmarkNow();
  const audio=await this.readAudio(id,file).finally(()=>this.perf(id,usesStreamedAudio(file.size)?'streamOpen':'fullAudioPreparation',benchmarkNow()-decodeStarted));
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
   this.traceEvent(id,'stream-session-close-error','audio',{...fields,errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error)});
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
  let pendingTrace:Promise<void>|undefined,lastTraceWrite=benchmarkNow();
  operation('Декодирование');
  this.traceEvent(id,'stream-read-start','audio',{...fields,streamStage,jsHeapBytes:traceHeapBytes()});
  await this.persist(id);this.check();lastTraceWrite=benchmarkNow();
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
    if(!inspection&&typeof detail.elapsedMs==='number'){
     if(code==='stream-read-end')this.perf(id,'streamDecode',detail.elapsedMs);
     if(code==='stream-resample-end')this.perf(id,'streamResample',detail.elapsedMs);
    }
    this.traceEvent(id,code,'audio',{...fields,...detail,jsHeapBytes:traceHeapBytes()});
    if(shouldPersistStreamEvent(code,benchmarkNow(),lastTraceWrite,inspection)){
     pendingTrace=this.persist(id);await pendingTrace;lastTraceWrite=benchmarkNow();
    }else this.storageUi(id,'deferredMetadataWrites');
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
   this.traceEvent(id,'window-error','audio',{...fields,streamStage:error instanceof AudioValidationError?'pcm-check':streamStage,elapsedMs:benchmarkNow()-decodeStarted,errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error),jsHeapBytes:traceHeapBytes()});
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
   report=await withActivityWatchdog(heartbeat=>inspectDecodedPcm(pcm,{signal,onProgress:heartbeat,startSample:window.start,windowNumber:index+1,expectedSamples:window.end-window.start}),{
    timeoutMs:this.streamPcmIdleMs,pollMs:Math.min(1000,Math.max(5,this.streamPcmIdleMs/4)),
    signal,onTimeout:()=>audio.close(),timeoutError:()=>new StreamDecodeStalledError('pcm-check')
   });
  }catch(error){
   this.traceEvent(id,'window-error','audio',{...fields,streamStage:'pcm-check',elapsedMs:benchmarkNow()-validationStarted,errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error)});
   throw error;
  }
  if(!inspection)this.bench(id,b=>addBenchmarkTiming(b,'pcmCheckMs',benchmarkNow()-validationStarted));
  this.traceEvent(id,'stream-pcm-check-end','audio',{...fields,streamStage:'pcm-check',elapsedMs:benchmarkNow()-validationStarted,pcmSamples:pcm.length,pcmQuality:report.quality});
  return {pcm,report};
 }
 // Split is an alternative read strategy, not six ASR attempts. The original
 // window is committed only after all parts have passed validation and ASR.
 private async readSplitStreamWindow(id:string,audio:StreamedAudio,window:AudioWindow,index:number,total:number,inspection=false){
  const length=window.end-window.start;
  const totalParts=Math.ceil(length/STREAM_SUBWINDOW_SAMPLES);
  const fields={window:index+1,totalWindows:total,startSample:window.start,endSample:window.end,committedWindows:this.job(id).nextWindow,attempt:inspection?1:3,decoderId:audio.decoderId,strategy:'split' as const,totalParts};
  const pcm=new Float32Array(length);
  this.traceEvent(id,'stream-split-start','audio',fields);await this.persist(id);this.check();
  for(let part=1;part<=totalParts;part++){
   this.check();
   const start=window.start+(part-1)*STREAM_SUBWINDOW_SAMPLES,end=Math.min(start+STREAM_SUBWINDOW_SAMPLES,window.end);
   const subwindow={start,end,first:window.first&&part===1,last:window.last&&part===totalParts};
   const result=await this.readCheckedStreamWindow(id,audio,subwindow,index,total,inspection,inspection?1:3,{part,totalParts});
   this.check();pcm.set(result.pcm,start-window.start);
   this.traceEvent(id,'stream-split-part-ready','audio',{...fields,startSample:start,endSample:end,part,pcmSamples:result.pcm.length});
   await this.persist(id);
  }
  this.check();this.set({operation:(inspection?'Проверка аудио · ':'')+'Проверка собранного PCM · окно '+(index+1)+'/'+total});
  const signal=this.abort!.signal;
  this.traceEvent(id,'stream-pcm-check-start','audio',{...fields,streamStage:'pcm-check',pcmSamples:pcm.length});
  await this.persist(id);this.check();
  const started=benchmarkNow();
  let report:AudioInspectionReport;
  try{
   report=await withActivityWatchdog(heartbeat=>inspectDecodedPcm(pcm,{signal,onProgress:heartbeat,startSample:window.start,windowNumber:index+1,expectedSamples:window.end-window.start}),{
    timeoutMs:this.streamPcmIdleMs,pollMs:Math.min(1000,Math.max(5,this.streamPcmIdleMs/4)),signal,
    onTimeout:()=>audio.close(),timeoutError:()=>new StreamDecodeStalledError('pcm-check')
   });
  }catch(error){
   this.traceEvent(id,'window-error','audio',{...fields,streamStage:'pcm-check',errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error)});
   throw error;
  }
  this.check();if(!inspection)this.bench(id,b=>addBenchmarkTiming(b,'pcmCheckMs',benchmarkNow()-started));
  this.traceEvent(id,'stream-pcm-check-end','audio',{...fields,streamStage:'pcm-check',pcmSamples:pcm.length,elapsedMs:benchmarkNow()-started,pcmQuality:report.quality});
  this.traceEvent(id,'stream-split-ready','audio',{...fields,pcmSamples:pcm.length});
  await this.persist(id);this.check();
  return {pcm,report};
 }
 private async readRecoverableStreamWindow(id:string,session:StreamSession,file:File,window:AudioWindow,index:number,total:number,priorFailure?:{error:unknown}){
  const fields={window:index+1,totalWindows:total,startSample:window.start,endSample:window.end,committedWindows:this.job(id).nextWindow};
  const previous=this.job(id).streamRecovery;
   let attempt=previous?.window===index+1?Math.min(3,previous.windowRecoveries+1):1;
  for(;;){
   this.check();
   try{
    if(priorFailure){const error=priorFailure.error;priorFailure=undefined;
     this.traceEvent(id,'window-error','audio',{...fields,attempt,decoderId:session.audio.decoderId,streamStage:error instanceof StreamDecodeStalledError?error.stage:error instanceof AudioValidationError?'pcm-check':'decode',errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error)});
     throw error;
    }
    const result=attempt===3?await this.readSplitStreamWindow(id,session.audio,window,index,total):await this.readCheckedStreamWindow(id,session.audio,window,index,total,false,attempt);
    if(attempt>1)this.traceEvent(id,'stream-recovered','audio',{...fields,attempt,decoderId:session.audio.decoderId,strategy:attempt===3?'split':'whole',recoveryCount:this.job(id).streamRecovery?.totalRecoveries});
    return result;
   }catch(error){
    this.check();
    const budget=attempt===3?null:reserveStreamRecovery(error,index+1,this.job(id).streamRecovery);
    if(!budget){
     if(error instanceof StreamDecodeStalledError||canRetryFfmpeg(error,'windowed')||attempt===3){
      this.traceEvent(id,'stream-recovery-stop','audio',{...fields,attempt,decoderId:session.audio.decoderId,strategy:attempt===3?'split':'whole',streamStage:error instanceof StreamDecodeStalledError?error.stage:undefined,errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error),recoveryCount:this.job(id).streamRecovery?.totalRecoveries??0});
     }
     throw error;
    }
    const nextAttempt=budget.windowRecoveries+1;
    // Reserve durably before opening another decoder, even after a reload.
    this.patch(id,{streamRecovery:budget,status:'Восстановление декодера · окно '+(index+1)+'/'+total+' · попытка '+nextAttempt+'/3'});
    this.set({operation:nextAttempt===3?'Резервное декодирование частями':'Восстановление потокового декодера'});
    this.traceEvent(id,'stream-recovery-start','audio',{...fields,attempt:nextAttempt,decoderId:session.audio.decoderId,strategy:nextAttempt===3?'split':'whole',recoveryCount:budget.totalRecoveries,errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error)});
    await this.persist(id);this.check();
    try{
     await this.replaceStream(id,session,file,'recovery');
     attempt=nextAttempt;
     this.traceEvent(id,'stream-reopen-ready','audio',{...fields,attempt,decoderId:session.audio.decoderId,strategy:attempt===3?'split':'whole',recoveryCount:budget.totalRecoveries});
     await this.persist(id);this.check();
    }catch(openError){
     this.traceEvent(id,'stream-recovery-stop','audio',{...fields,attempt:nextAttempt,streamStage:'open',errorKind:traceErrorKind(openError),...ffmpegFailureFields(openError),recoveryCount:budget.totalRecoveries});
     throw openError;
    }
   }
  }
 }
 private async executeAudio(id:string,audio:Float32Array|StreamedAudio,audioStarted:number,decodeStarted:number,file:File,session?:StreamSession){
  const streamed=!(audio instanceof Float32Array);
  this.check();
   if(this.job(id).decoderIdentity?.kind==='ffmpeg'&&this.job(id).nextWindow>0&&this.job(id).duration!==undefined&&Math.round(this.job(id).duration!*16000)!==audio.length)
    throw new Error('Длительность PCM не совпадает с сохранённой контрольной точкой. Добавьте аудио как новое задание.');
   const priorDuration=this.job(id).duration;
  const durationDeltaSamples=typeof priorDuration==='number'&&Number.isFinite(priorDuration)&&priorDuration>0&&Number.isSafeInteger(Math.round(priorDuration*16000))?audio.length-Math.round(priorDuration*16000):undefined;
  this.patch(id,{duration:audio.length/16000});
  this.bench(id,b=>addBenchmarkTiming(b,'decodeMs',benchmarkNow()-decodeStarted));
  this.traceEvent(id,'audio-ready','audio',{elapsedMs:Date.now()-audioStarted,pcmSamples:audio.length,decoderId:streamed?audio.decoderId:undefined,durationDeltaSamples});
  if(!streamed)await this.inspectPcm(id,audio,this.abort!.signal);this.check();
  this.set({operation:'Подготовка модели'});
  const params={...this.job(id).params};
  if(!this.job(id).asrComplete){
   const windows=audioWindows(audio.length,streamed);
   // A corrupted checkpoint must never masquerade as a completed transcript.
   const initial=checkpointProgress(windows,this.job(id).nextWindow);
   this.manager.resourcePolicy=this.resources.policy();
   const preferred=this.backendPolicy.preferred(params.model,params.language,this.resources.selected,collectDeviceHints(),this.manager.targetWasmThreads??1);
   if(this.manager.active!==params.model||(preferred!==undefined&&this.manager.capabilities?.active!==preferred)||this.manager.needsWasmThreadRefresh?.()){
    this.traceEvent(id,'model-start','model');await this.persist(id);
    const modelStarted=Date.now(),modelMeasured=benchmarkNow();
    let prepared:Awaited<ReturnType<ModelManager['prepare']>>;
    try{
     try{prepared=preferred?await this.manager.prepare(params.model,{backend:preferred}):await this.manager.prepare(params.model)}
     catch(error){
      this.check();if(!preferred||resourceFailure(error))throw error;
      this.backendPolicy.invalidate(params.model,params.language,preferred);
      prepared=await this.manager.prepare(params.model); // One bounded return to original engine auto policy.
     }
    }finally{
     this.bench(id,b=>addBenchmarkTiming(b,'modelInitMs',benchmarkNow()-modelMeasured));
    }
    this.check();this.set({backend:prepared.backend});
    this.traceEvent(id,'model-ready','model',{elapsedMs:Date.now()-modelStarted,backend:traceBackend(prepared.backend)});
   }
   this.set({operation:'Распознавание'});
   this.patch(id,{stage:'recognizing',status:checkpointLabel(initial),percent:initial.percent,backend:this.manager.capabilities?.active??this.state.backend});
   let previousAttemptEnd:number|undefined,previousInferenceMs=0;
   const pipeline=session?new AudioPipeline<PreparedStreamWindow>(this.abort!.signal):undefined;
   const payloadPool=new AsrPayloadPool();
   try{for(let index=initial.completedWindows;index<windows.length;index++){
    this.check();const window=windows[index];
    // Apply the chosen profile only before a new, uncommitted window.
    // WASM sessions are replaced only if their thread target changes.
    const policy=this.resources.policy();this.manager.resourcePolicy=policy;
    this.set({activeResourcePolicy:policy});
    this.bench(id,b=>({...b,resources:observeWindowPolicy(b.resources,policy)}));
    if(this.manager.needsWasmThreadRefresh?.()){
     this.set({operation:'Настройка потоков WASM'});
     const started=benchmarkNow();
     this.traceEvent(id,'model-start','model',{backend:'wasm'});await this.persist(id);this.check();
     try{
      const prepared=await this.manager.prepare(params.model,{backend:'wasm'});this.check();
      this.set({backend:prepared.backend});this.patch(id,{backend:prepared.backend});
      this.traceEvent(id,'model-ready','model',{backend:traceBackend(prepared.backend),elapsedMs:benchmarkNow()-started});
     }finally{this.bench(id,b=>addBenchmarkTiming(b,'modelInitMs',benchmarkNow()-started))}
    }
    const pauseMs=boundaryPauseMs(policy,previousInferenceMs);
    if(pauseMs>0){
     const pauseStarted=benchmarkNow();
     try{await this.boundaryWait(pauseMs,this.abort!.signal)}finally{
      this.bench(id,b=>({...b,resources:observeResourcePause(b.resources!,benchmarkNow()-pauseStarted)}));
     }
     this.check();
    }
    if(session)await this.rotateStreamIfNeeded(id,session,file,index,windows.length);
    this.patch(id,{status:currentWindowLabel(windows,index)+' · сохранено '+index+' / '+windows.length+' окон · backend: '+(this.manager.capabilities?.active??this.state.backend),percent:checkpointProgress(windows,index).percent});
    // Retry only the current uncommitted window. Previous windows must not
    // be appended again, and checkpoints remain unchanged until commit().
    this.traceEvent(id,'window-start','asr',{window:index+1,totalWindows:windows.length,startSample:window.start,endSample:window.end,pcmSamples:window.end-window.start,committedWindows:this.job(id).nextWindow,backend:traceBackend(this.manager.capabilities?.active??this.state.backend)});
    let pcm:Float32Array;
    if(session&&pipeline){
     const waitStarted=benchmarkNow(),prefetched=await pipeline.take(index);this.check();
     if(prefetched){
      const waitMs=benchmarkNow()-waitStarted;
      this.bench(id,b=>{const prev=b.audioPipeline??emptyPipeline();return {...b,audioPipeline:{...prev,
       consumed:prev.consumed+(prefetched.result.ok?1:0),readyHits:prev.readyHits+(prefetched.ready&&prefetched.result.ok?1:0),
       failed:prev.failed+(prefetched.result.ok?0:1),waitMs:prev.waitMs+waitMs}}});
      if(prefetched.result.ok){
       const prepared=prefetched.result.value;
       if(prepared.decoderId!==session.audio.decoderId)throw new Error('Устаревший буфер декодера.');
       this.resources.observePrefetch(prefetched.ready,waitMs);
       pcm=prepared.pcm;
       const fields={window:index+1,totalWindows:windows.length,startSample:window.start,endSample:window.end,decoderId:prepared.decoderId,attempt:1,committedWindows:this.job(id).nextWindow,strategy:'whole' as const};
       this.traceEvent(id,'stream-read-start','audio',{...fields,streamStage:'decode'});
       for(const event of prepared.events){
        const {code,...detail}=event;
        this.traceEvent(id,code,'audio',{...fields,...detail});
        if(typeof detail.elapsedMs==='number'){
         if(code==='stream-read-end')this.perf(id,'streamDecode',detail.elapsedMs);
         if(code==='stream-resample-end')this.perf(id,'streamResample',detail.elapsedMs);
        }
       }
       this.traceEvent(id,'stream-pcm-check-start','audio',{...fields,streamStage:'pcm-check',pcmSamples:pcm.length});
       this.traceEvent(id,'stream-pcm-check-end','audio',{...fields,streamStage:'pcm-check',pcmSamples:pcm.length,elapsedMs:prepared.validationMs,pcmQuality:prepared.report.quality});
       this.bench(id,b=>{const prev=b.audioPipeline??emptyPipeline();return {...addBenchmarkTiming(addBenchmarkTiming(b,'decodeMs',prepared.decodeMs),'pcmCheckMs',prepared.validationMs),audioPipeline:{...prev,preparedMs:prev.preparedMs+prepared.decodeMs+prepared.validationMs}}});
      }else{
       // Retire all lookahead on decoder failure. Reserve recovery only now,
       // after the preceding ASR window has been durably committed.
       await pipeline.dispose();this.check();
       pcm=(await this.readRecoverableStreamWindow(id,session,file,window,index,windows.length,{error:prefetched.result.error})).pcm;
      }
     }else pcm=(await this.readRecoverableStreamWindow(id,session,file,window,index,windows.length)).pcm;
    }else if(audio instanceof Float32Array)pcm=audio.subarray(window.start,window.end);
    else throw new Error('Потоковый декодер недоступен.');
    this.set({operation:'Распознавание'});
    this.patch(id,{status:currentWindowLabel(windows,index)+' · сохранено '+index+' / '+windows.length+' окон · backend: '+(this.manager.capabilities?.active??this.state.backend)});
    let result:TranscriptSegment[]|undefined,successfulAttemptMs=0;
    for(let attempt=1;attempt<=MAX_ASR_WINDOW_ATTEMPTS;attempt++){
     this.check();
     this.traceEvent(id,'window-attempt','asr',{window:index+1,totalWindows:windows.length,attempt,backend:traceBackend(this.manager.capabilities?.active??this.state.backend)});
     // Start only read-only lookahead; it cannot commit or reserve retries.
     // Overlap preparation with the mandatory metadata transaction as well as ASR.
     let prefetchScheduledAt:number|undefined;
     if(attempt===1&&session&&pipeline&&!this.manager.forceSingleWasmThread){
      // Never read beyond the next mandatory decoder rotation. At most
      // two queued windows, one producer, one active inference.
      const depth=Math.max(0,Math.min(policy.targetPrefetchWindows,windows.length-index-1,this.streamRotateWindows-session.windows-1));
      const decoder=session.audio;
      const added=pipeline.fill(index+1,depth,(next,signal)=>prepareStreamWindow(decoder,windows[next],next,signal,{decode:this.streamDecodeIdleMs,resample:this.streamResampleIdleMs,pcm:this.streamPcmIdleMs}));
      if(added){
       prefetchScheduledAt=benchmarkNow();
       this.bench(id,b=>{const prev=b.audioPipeline??emptyPipeline();return {...b,audioPipeline:{...prev,scheduled:prev.scheduled+added,peakQueued:Math.max(prev.peakQueued,pipeline.size)}}});
      }
     }
     // Save the in-flight window metadata before invoking the Worker.
     // A tab crash can then be diagnosed without claiming a committed result.
     await this.timedMetadata(id);this.check();
     if(prefetchScheduledAt!==undefined){
      const leadMs=Math.max(0,benchmarkNow()-prefetchScheduledAt);
      this.bench(id,b=>{const prev=b.audioPipeline??emptyPipeline();return {...b,audioPipeline:{...prev,earlyDispatches:(prev.earlyDispatches??0)+1,preDispatchLeadMs:(prev.preDispatchLeadMs??0)+leadMs}}});
     }
     const attemptBackend=this.manager.capabilities?.active??this.state.backend;
     const attemptStarted=Date.now(),attemptMeasured=benchmarkNow();
     if(previousAttemptEnd!==undefined)this.perf(id,'betweenAsrAttempts',attemptMeasured-previousAttemptEnd);
     this.bench(id,b=>({...b,profiler:observeBackend(b.profiler??emptyPerformanceProfile(),attemptBackend,this.manager.requestedBackend),
      ...(attemptBackend==='wasm'&&this.manager.wasmThreadConfiguration?{wasmThreads:observeWasmThreads(b.wasmThreads,this.manager.wasmThreadConfiguration)}:{})}));
     let dispatched:Float32Array<ArrayBuffer>|undefined;
     try{
      try{
       result=await withActivityWatchdog(heartbeat=>{
        this.asrHeartbeat=heartbeat;
        const copyStarted=benchmarkNow();const {payload,reused}=payloadPool.acquire(pcm);dispatched=payload;
        this.perf(id,'pcmCopy',benchmarkNow()-copyStarted);
        this.bench(id,b=>({...b,memory:observePayload(b.memory,reused,payload.byteLength)}));
        return this.manager.transcribe(payload,false,()=>{},params.language);
       },{
        timeoutMs:this.asrIdleMs,pollMs:Math.min(1000,Math.max(5,this.asrIdleMs/4)),signal:this.abort!.signal,
        onTimeout:()=>this.manager.cancel()
       });
      }finally{previousAttemptEnd=benchmarkNow();this.asrHeartbeat=null}
      this.check();this.patch(id,{error:undefined});
      if(dispatched&&payloadPool.retain(dispatched)==='detached')this.bench(id,b=>{const memory=b.memory??emptyMemoryObservations();return {...b,memory:{...memory,detachedPayloads:memory.detachedPayloads+1}}});
      dispatched=undefined;
      successfulAttemptMs=benchmarkNow()-attemptMeasured;
      this.bench(id,b=>({...addBenchmarkTiming(b,'asrAttemptMs',successfulAttemptMs),attempts:b.attempts+1}));
      this.traceEvent(id,'window-result','asr',{window:index+1,totalWindows:windows.length,attempt,elapsedMs:Date.now()-attemptStarted,segmentCount:result.length,backend:traceBackend(this.manager.capabilities?.active??this.state.backend)});
      break;
     }catch(error){
      // A timed-out or rejected request may still own its dispatch buffer.
      // Never retain/reuse it; the original window remains intact for retry.
      payloadPool.clear();dispatched=undefined;
      const elapsed=benchmarkNow()-attemptMeasured;
      this.bench(id,b=>({...addBenchmarkTiming(b,'asrAttemptMs',elapsed),attempts:b.attempts+1,failedAttempts:b.failedAttempts+1}));
      this.traceEvent(id,'window-error','asr',{window:index+1,totalWindows:windows.length,attempt,elapsedMs:Date.now()-attemptStarted,errorKind:traceErrorKind(error),backend:traceBackend(attemptBackend)});
      this.check();
      this.backendPolicy.invalidate(params.model,params.language,attemptBackend);
      if(!shouldRetryAsrWindow(error,attempt))throw error;
      if(traceErrorKind(error)==='worker'||(typeof error==='object'&&error!==null&&'code' in error&&(error.code==='gpu-device-lost'||error.code==='webgpu-device-lost')))this.resources.restrictAfterRecovery();
      const next=attempt+1,wasmOnly=preferWasmAfterFailure(attemptBackend);
      // A retry never increases compute pressure, and the rest of this run
      // stays at one WASM thread even when the user selects maximum.
      if(wasmOnly)this.manager.forceSingleWasmThread=true;
      this.traceEvent(id,'window-retry','asr',{window:index+1,totalWindows:windows.length,attempt:next,backend:traceBackend(attemptBackend)});
      this.patch(id,{status:`Ошибка окна ${index+1}/${windows.length} · восстановление Worker · попытка ${next}/${MAX_ASR_WINDOW_ATTEMPTS} · ${checkpointLabel(checkpointProgress(windows,index))}`,error:message(error)});
      // Throw on failed reinit instead of silently continuing on an unknown
      // backend. Explicit cancellation aborts before starting another window.
      const recoveryStarted=benchmarkNow();
      const prepared=await this.manager.recover(params.model,wasmOnly).finally(()=>this.perf(id,'workerRecovery',benchmarkNow()-recoveryStarted));this.check();
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
     // This marker travels in the atomic checkpoint transaction below.
     // The previous durable in-flight attempt remains available on crash.
     this.storageUi(id,'deferredMetadataWrites');this.check();
    }
    const checkpointStarted=benchmarkNow();
    await this.commit(id,{segments,nextWindow:index+1,percent:after.percent,status:checkpointLabel(after)},segments);
    if(session)session.windows++;
    const checkpointMs=benchmarkNow()-checkpointStarted;
    const uniqueAudioSeconds=(window.end-(index===0?window.start:windows[index-1].end))/16000;
    this.bench(id,b=>recordWindowCommit(b,index+1,successfulAttemptMs,checkpointMs,uniqueAudioSeconds));
    previousInferenceMs=successfulAttemptMs;
    this.traceEvent(id,'checkpoint-committed','checkpoint',{window:index+1,totalWindows:windows.length,committedWindows:index+1,elapsedMs:checkpointMs});
    this.check();
   }}finally{payloadPool.clear();await pipeline?.dispose()}
   if(!this.job(id).segments.some(s=>s.text.trim()))throw new Error('Распознанного текста нет. Проверьте запись.');
   await this.commit(id,{asrComplete:true,percent:100,status:'Текст готов и сохранён'});this.check();
  }
  if(params.diarize&&!streamed){
   this.set({operation:'Разделение говорящих'});
   this.traceEvent(id,'speaker-start','speaker');
   this.patch(id,{stage:'speakers',status:'Разделение говорящих. Текст уже доступен.',percent:null});await this.persist(id);this.check();
   // Select thread configuration once before creating the independent
   // speaker Worker. Do not restart the pass or re-run ASR on mode changes.
   this.manager.resourcePolicy=this.resources.policy();
   const speakerStarted=Date.now();let turns:Awaited<ReturnType<ModelManager['diarize']>>;
   const speakerMeasured=benchmarkNow();
   try{turns=await this.manager.diarize(audio)}catch(error){this.traceEvent(id,'speaker-error','speaker',{elapsedMs:Date.now()-speakerStarted,errorKind:traceErrorKind(error),...pcmValidationFields(error),...ffmpegFailureFields(error)});throw error}
   finally{
    this.perf(id,'speakerPass',benchmarkNow()-speakerMeasured);
    const pass=this.manager.lastSpeakerPass;
    if(pass)this.bench(id,b=>{const prev=b.speakerPerformance??emptySpeakerPerformance();return {...b,speakerPerformance:{...prev,passes:prev.passes+1,failedPasses:prev.failedPasses+(pass.status==='passed'?0:1),lastPass:{...pass,threads:{...pass.threads}}}}});
   }
   this.check();
   this.bench(id,b=>addBenchmarkTiming(b,'speakerMs',benchmarkNow()-speakerMeasured));
   this.traceEvent(id,'speaker-result','speaker',{elapsedMs:Date.now()-speakerStarted,segmentCount:turns.length});
   const segments=this.job(id).segments;
   const alignmentStarted=benchmarkNow();let alignmentQueries=0,alignmentCandidates=0;
   const aligned=alignSpeakers(segments,turns,(queries,candidates)=>{alignmentQueries=queries;alignmentCandidates=candidates}),speakerSegments=aligned.segments;
   this.bench(id,b=>{const prev=b.speakerPerformance??emptySpeakerPerformance();return {...b,speakerPerformance:{...prev,alignmentMs:prev.alignmentMs+benchmarkNow()-alignmentStarted,alignmentQueries:prev.alignmentQueries+alignmentQueries,alignmentCandidates:prev.alignmentCandidates+alignmentCandidates}}});
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
  this.resources.beginRun();this.manager.forceSingleWasmThread=false;this.manager.resourcePolicy=this.resources.policy();
  try{await this.exclusive(async()=>{const prepared=await this.manager.prepare(model,{wasmOnly});this.set({backend:prepared.backend})})}catch(error){this.set({notice:message(error)})}
  finally{this.manager.resourcePolicy=null;this.set({busy:false,operation:''});this.continuePending()}
 }
 async preloadSpeakers(){
  if(this.state.speakerDownload!=='idle')return;
  this.set({speakerDownload:'pending'});
  if(!this.state.busy)await this.drain();
 }
 private async downloadSpeakers(){
  this.cancelled=false;
  this.resources.beginRun();this.manager.forceSingleWasmThread=false;this.manager.resourcePolicy=this.resources.policy();
  this.set({speakerDownload:'loading',operation:'Загрузка моделей говорящих'});
  try{
   const cached=await this.manager.speakersCached();
   if(!this.cancelled&&!(cached.segmentation&&cached.embedding)){
    await this.manager.preloadSpeakers();
    this.set({backend:'Не инициализировано'});
   }
  }catch(error){if(!this.cancelled)this.set({notice:message(error)})}
  finally{this.manager.resourcePolicy=null;this.set({speakerDownload:'idle',operation:''})}
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
