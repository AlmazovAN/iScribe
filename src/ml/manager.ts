import {EngineClient,type CapabilityReport,type TranscriptSegment,type SpeakerTurn,type BackendId} from '@yourdevice/engine';
import EngineWorker from './worker?worker';
import {postSpeakerAudio} from './workerTransfer';
import {SpeakerPassMeter,type SpeakerPassObservation} from '../performance/speakerPerformance';
import type {ResourcePolicy} from '../performance/types';
import {localWasmThreadEnvironment,resolveWasmThreads,validWasmConfiguration,type WasmThreadConfiguration} from '../performance/wasmThreads';
import {MAX_ASR_WINDOW_SAMPLES,withActivityWatchdog,WorkerStalledError} from './activityWatchdog';
import {WorkerRetirement} from '../performance/resourceLifecycle';
import {VAD_BLOCK,VAD_MAX_SAMPLES} from './vad';
import {ALIGNMENT_CONTRACT,ALIGNMENT_MAX_SEGMENTS,ALIGNMENT_MAX_TOKENS,segmentCrop,type AlignmentLanguage,type AlignmentSegment,type AlignmentReport,type AlignmentRow,type WordSpan} from './forcedAlignment';
import {checkWhisperCache,recordWhisperCache,checkSpeakerCache,speakerRepos} from './cache';
declare const __iscribeWasmBinary:ArrayBuffer;
function createEngineWorker(retirement:WorkerRetirement):Worker{
 retirement.assertUsable();
 const worker=new EngineWorker();
 // This message arrives before the engine's init/preload message. Keep the
 // original buffer for replacement workers used by recovery and diarization.
 try{
  if(import.meta.env.MODE==='standalone')worker.postMessage({type:'iscribe:runtime-wasm',binary:__iscribeWasmBinary});
  return worker;
 }catch(error){retirement.terminate(worker);throw error}
}

export type WhisperId='whisper-tiny'|'whisper-small'|'whisper-large-v3';
export const repos:Record<WhisperId,string>={'whisper-tiny':'onnx-community/whisper-tiny','whisper-small':'onnx-community/whisper-small','whisper-large-v3':'onnx-community/whisper-large-v3-ONNX'};
export type WhisperDownloadProgress={phase:'loading'|'initializing'|'checking'|'ready'|'error'|'cancelled';loadedBytes?:number;totalBytes?:number;httpRequests?:number;cachedBefore?:boolean;cachedAfter?:boolean;message?:string};
export type EnginePhase='idle'|'initializing'|'ready'|'transcribing'|'recovering'|'preloading-speakers'|'diarizing'|'cancelled'|'error';
export type EngineLifecycle={phase:EnginePhase;model:WhisperId|null;backend:BackendId|null;generation:number};
export const DEFAULT_MODEL_INIT_IDLE_MS=15*60*1000;
export const DEFAULT_SPEAKER_IDLE_MS=15*60*1000;
export class ModelManager{
 readonly initIdleMs:number;
 readonly speakerIdleMs:number;
 lifecycle:EngineLifecycle={phase:'idle',model:null,backend:null,generation:0};
 onLifecycleChange:(state:EngineLifecycle)=>void=()=>{};
 private phase(phase:EnginePhase,model:WhisperId|null=this.active,backend:BackendId|null=this.capabilities?.active??null){
  this.lifecycle={phase,model,backend,generation:this.generation};
  this.onLifecycleChange({...this.lifecycle});
 }
 constructor(options:{initIdleMs?:number;speakerIdleMs?:number}={}){
  this.initIdleMs=options.initIdleMs??DEFAULT_MODEL_INIT_IDLE_MS;
  this.speakerIdleMs=options.speakerIdleMs??DEFAULT_SPEAKER_IDLE_MS;
 }
 private readonly retirement=new WorkerRetirement();
 get resourceBlocked():boolean{return this.retirement.blocked}
 private client:EngineClient|null=null;
 private asrWorker:Worker|null=null;
 // Always clear references first and terminate the owned Worker even if
 // EngineClient disposal throws. Worker.terminate is idempotent.
 private disposeAsr(){
  const client=this.client,worker=this.asrWorker;
  this.client=null;this.asrWorker=null;this.active=null;this.capabilities=null;
  this.sessionWasmThreads=null;this.wasmThreadConfiguration=null;
  try{client?.dispose()}finally{this.retirement.terminate(worker)}
 }
 releaseIdle():boolean{
  if(this.busy||(!this.client&&!this.asrWorker))return false;
  ++this.generation;
  try{this.disposeAsr();return true}finally{this.phase(this.resourceBlocked?'error':'idle',null,null)}
 }
 private busy=false;
 private speakerWorker:Worker|null=null;
 lastSpeakerPass:SpeakerPassObservation|null=null;
 private rejectPreload:((error:Error)=>void)|null=null;
 onSpeakerProgress:(id:keyof typeof speakerRepos,status:string)=>void=()=>{};
 private generation=0;
 private preparingId:WhisperId|null=null;
 // Observed initialization preference, not the actual execution provider.
 requestedBackend:'auto'|BackendId|'unknown'='unknown';
 // Policy is applied only before initialization or at a committed boundary.
 resourcePolicy:ResourcePolicy|null=null;
 forceSingleWasmThread=false;
 private sessionWasmThreads:number|null=null;
 wasmThreadConfiguration:WasmThreadConfiguration|null=null;
 get targetWasmThreads():number{
  return resolveWasmThreads(this.forceSingleWasmThread?1:this.resourcePolicy?.targetWasmThreads??1,localWasmThreadEnvironment(import.meta.env.MODE==='standalone'));
 }
 needsWasmThreadRefresh():boolean{
  return this.active!==null&&this.capabilities?.active==='wasm'&&this.sessionWasmThreads!==this.targetWasmThreads;
 }
 active:WhisperId|null=null;
 capabilities:CapabilityReport|null=null;
 onWhisperProgress:(id:WhisperId,progress:WhisperDownloadProgress)=>void=()=>{};
 onProgress:(text:string,percent:number|null)=>void=()=>{};
 async cached(id:WhisperId){return checkWhisperCache(repos[id])}
 async prepare(id:WhisperId,options:{wasmOnly?:boolean;backend?:BackendId}={}):Promise<{cached:boolean,backend:string}>{
  this.retirement.assertUsable();
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  const required=options.wasmOnly?'wasm':options.backend;
  const targetThreads=this.targetWasmThreads;
  // Selecting the already active model must not dispose its ONNX session.
  if(this.active===id&&this.client&&this.capabilities?.active&&(!required||this.capabilities.active===required)&&(this.capabilities.active!=='wasm'||this.sessionWasmThreads===targetThreads)){
   // Cache inspection is asynchronous. The active session may be cancelled or
   // replaced before it completes; never resurrect an old ready status.
   const generation=this.generation,client=this.client,backend=this.capabilities.active;
   const cached=await this.cached(id);
   if(generation!==this.generation||this.client!==client||this.active!==id)
    throw new Error('Операция отменена или модель изменена.');
   this.onWhisperProgress(id,{phase:'ready',cachedBefore:cached,cachedAfter:cached,httpRequests:0});
   return {cached,backend};
  }
  this.disposeAsr();
  this.busy=true;this.preparingId=id;const generation=++this.generation;
  this.requestedBackend=required??'auto';
  this.sessionWasmThreads=targetThreads;this.wasmThreadConfiguration={requested:targetThreads,configured:null};
  this.phase('initializing',id,null);
  let client:EngineClient|null=null;
  let cachedBefore=false,requests=0,loadedBytes=0,totalBytes=0;
  let initHeartbeat:(()=>void)|null=null,expired=false;
  const progress=(phase:WhisperDownloadProgress['phase'],message?:string,cachedAfter?:boolean)=>{
   if(generation!==this.generation)return;
   this.onWhisperProgress(id,{phase,cachedBefore,httpRequests:requests,
    loadedBytes:loadedBytes||undefined,totalBytes:totalBytes||undefined,message,cachedAfter});
  };
  try{
   cachedBefore=await this.cached(id);
   if(generation!==this.generation)throw new Error('Операция отменена.');
   progress('initializing');
   this.onProgress(cachedBefore?'Инициализация модели из сохранённых файлов…':'Подготовка и проверка файлов модели…',null);
   client=new EngineClient(()=>{
    const worker=createEngineWorker(this.retirement);this.asrWorker=worker;
    worker.addEventListener('message',(event:MessageEvent<unknown>)=>{
     const d=event.data;
     if(generation!==this.generation||expired||!d||typeof d!=='object'||!('type' in d))return;
     if(d.type==='iscribe:wasm-thread-config'){
      const verified=validWasmConfiguration(d,targetThreads);
      if(verified)this.wasmThreadConfiguration=verified;
      return;
     }
     if(d.type!=='iscribe:model-http-request'||!('repo' in d)||d.repo!==repos[id])return;
     requests++;
     initHeartbeat?.();
     progress('loading');
     this.onProgress('Чтение файлов модели (из кэша или сети)…',null);
    });
    // Worker FIFO: configuration precedes EngineClient.init. Optional call
    // also tolerates deterministic Worker test doubles without postMessage.
    worker.postMessage?.({type:'iscribe:wasm-threads',requested:targetThreads});
    return worker;
   });
   this.client=client;
   // Engine download-progress measures model files processed, including cache hits.
   // It does NOT measure bytes transferred over the network.
   client.onDownloadProgress=info=>{
    if(generation!==this.generation||expired)return;
    initHeartbeat?.();
    loadedBytes=info.loadedBytes;totalBytes=info.totalBytes;
    progress(requests>0?'loading':'initializing');
   };
   const report=await withActivityWatchdog(heartbeat=>{
    initHeartbeat=heartbeat;
    return client!.init(id,required?{backendPreference:[required]}:{})
   },{
    timeoutMs:this.initIdleMs,
    pollMs:Math.min(1000,Math.max(5,this.initIdleMs/4)),
    onTimeout:()=>{expired=true;if(generation===this.generation)this.disposeAsr()}
   });
   if(generation!==this.generation)throw new Error('Операция отменена.');
   if(required&&report.active!==required)throw new Error('Запрошенный backend '+required.toUpperCase()+' недоступен.');
   if(!report.active)throw new Error('Вычислительный backend не инициализирован.');
   this.active=id;this.capabilities=report;
   progress('checking');
   const cached=await recordWhisperCache(repos[id]);
   if(generation!==this.generation)throw new Error('Операция отменена.');
   progress('ready',undefined,cached);
   this.phase('ready',id,report.active);
   return {cached,backend:report.active};
  }catch(error){
   progress('error',error instanceof Error?error.message:String(error));
   if(generation===this.generation){
    try{this.disposeAsr()}catch{/* Preserve the original initialization error. */}
    this.phase('error',id,null);
   }
   throw error;
  }finally{initHeartbeat=null;if(generation===this.generation){this.busy=false;this.preparingId=null}}
 }
 async recover(id:WhisperId,wasmOnly:boolean):Promise<{cached:boolean,backend:BackendId}>{
  this.retirement.assertUsable();
  // A failed inference worker must be discarded; ONNX session and pending
  // requests in that worker are not safe to reuse on the next attempt.
  if(this.busy)throw new Error('Невозможно восстановить Worker во время другой операции.');
  this.phase('recovering',id,null);
  this.disposeAsr();
  const prepared=await this.prepare(id,{wasmOnly});
  const backend=prepared.backend;
  if(backend!=='webnn'&&backend!=='webgpu'&&backend!=='wasm')throw new Error('Неизвестный backend после восстановления.');
  return {...prepared,backend};
 }
 async speakersCached(){
  const [segmentation,embedding]=await Promise.all([checkSpeakerCache(speakerRepos.segmentation),checkSpeakerCache(speakerRepos.embedding)]);
  return {segmentation,embedding};
 }
 async preloadSpeakers(){
  this.retirement.assertUsable();
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  this.disposeAsr();
  this.busy=true;const generation=++this.generation;
  this.phase('preloading-speakers',null,null);
  let createdWorker:Worker|null=null,stopped=false;
  const requestId='speakers-'+generation;
  try{
   const worker=createEngineWorker(this.retirement);createdWorker=worker;this.speakerWorker=worker;
   await withActivityWatchdog(heartbeat=>new Promise<void>((resolve,reject)=>{
    this.rejectPreload=reject;
    worker.addEventListener('error',()=>reject(new Error('Worker загрузки моделей говорящих завершился с ошибкой.')));
    worker.addEventListener('messageerror',()=>reject(new Error('Ошибка сообщения от Worker моделей говорящих.')));
    worker.addEventListener('message',(event:MessageEvent<unknown>)=>{
     const data=event.data;
     if(stopped||!data||typeof data!=='object'||!('requestId' in data)||data.requestId!==requestId||!('type' in data)||generation!==this.generation)return;
     if(data.type==='iscribe:preload-complete'){heartbeat();resolve();return}
     if(data.type==='iscribe:preload-error'&&'message' in data&&typeof data.message==='string'){reject(new Error(data.message));return}
     if(data.type==='iscribe:preload-progress'&&'model' in data&&typeof data.model==='string'&&'status' in data&&typeof data.status==='string'){
      heartbeat();
      const id=data.model===speakerRepos.segmentation?'segmentation':data.model===speakerRepos.embedding?'embedding':null;if(!id)return;
      const mb='loaded' in data&&typeof data.loaded==='number'?` · ${(data.loaded/1024/1024).toFixed(1)} МБ`:'';
      const label=id==='segmentation'?'Pyannote':'WeSpeaker';const stage=data.status==='ready'?'Инициализирована':data.status==='initiate'?'Подготовка':'Загрузка'+mb;
      this.onSpeakerProgress(id,stage);this.onProgress(`${label}: ${stage}`,null);
     }
    });
    worker.postMessage({type:'iscribe:wasm-threads',requested:this.targetWasmThreads});
    worker.postMessage({type:'iscribe:preload',requestId});
   }),{timeoutMs:this.speakerIdleMs,pollMs:Math.min(1000,Math.max(5,this.speakerIdleMs/4)),onTimeout:()=>{stopped=true;this.retirement.terminate(createdWorker);this.rejectPreload?.(new WorkerStalledError())}});
   if(generation!==this.generation)throw new Error('Операция отменена.');
   const cached=await this.speakersCached();
   if(!cached.segmentation||!cached.embedding)throw new Error('Не подтверждён полный кеш обеих моделей говорящих. Повторите загрузку; проверьте свободное место браузера.');
   this.phase('idle',null,null);
   return cached;
  }catch(error){if(generation===this.generation)this.phase('error',null,null);throw error}
  finally{
   stopped=true;try{this.retirement.terminate(createdWorker)}finally{
    if(this.speakerWorker===createdWorker){this.speakerWorker=null;this.rejectPreload=null}
    if(generation===this.generation){this.busy=false;if(this.resourceBlocked)this.phase('error',null,null)}
   }
  }
 }
 async transcribe(audio:Float32Array,diarize:boolean,onPartial:(segments:TranscriptSegment[])=>void,language:'ru'|'en'='ru'):Promise<TranscriptSegment[]>{
  this.retirement.assertUsable();
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  if(!this.client||!this.active)throw new Error('Сначала скачайте и выберите модель.');
  // An unintended whole-recording transfer would duplicate tens/hundreds
  // of MB in Worker memory. Send exactly one <=30 s Float32 PCM window.
  if(!Number.isInteger(audio.length)||audio.length===0||audio.length>MAX_ASR_WINDOW_SAMPLES)
   throw new Error('Некорректный размер окна ASR. Передавайте не более 30 секунд аудио.');
  this.busy=true;const generation=this.generation;
  this.phase('transcribing');
  try{
   this.onProgress(language==='ru'?'Распознавание русской речи…':'Распознавание английской речи…',null);
   const result=await this.client.transcribe(audio,{language,task:'transcribe',diarize},{onDiarizationProgress:(processed,total)=>{if(generation===this.generation)this.onProgress(`Разделение говорящих (WASM): ${processed} / ${total}`,total?processed/total*100:null)},onPartial:(segments,processed,total)=>{if(generation!==this.generation)return;onPartial(segments);this.onProgress(`Распознано ${processed.toFixed(0)} / ${total.toFixed(0)} с`,total?processed/total*100:null)}});
   if(generation!==this.generation)throw new Error('Операция отменена.');
   this.phase('ready');
   return result;
  }catch(error){if(generation===this.generation)this.phase('error');throw error}
  finally{if(generation===this.generation)this.busy=false}
 }
 // Experimental full-PCM pass. Reuse the auxiliary Worker ownership and
 // cancellation path; never overlap VAD with an initialized Whisper session.
 async detectSpeech(audio:Float32Array,signal:AbortSignal):Promise<unknown>{
  this.retirement.assertUsable();signal.throwIfAborted();
  if(this.busy||!Number.isSafeInteger(audio.length)||audio.length<1||audio.length>VAD_MAX_SAMPLES)throw new Error('VAD unavailable');
  this.disposeAsr();this.busy=true;const generation=++this.generation;
  this.phase('initializing',null,null);
  let worker:Worker|null=null,accepting=true;
  const requestId='vad-'+generation;
  try{
   worker=createEngineWorker(this.retirement);this.speakerWorker=worker;
   const owned=worker;
   const result=await withActivityWatchdog(heartbeat=>new Promise<unknown>((resolve,reject)=>{
    this.rejectPreload=reject;
    let offset=0,awaiting:'ready'|'next'|'result'='ready';
    const sendBlock=()=>{
     signal.throwIfAborted();
     const block=audio.slice(offset,offset+VAD_BLOCK);
     offset+=block.length;const final=offset===audio.length;
     awaiting=final?'result':'next';
     owned.postMessage({type:'iscribe:vad-block',requestId,audio:block,final},[block.buffer]);
    };
    owned.addEventListener('error',()=>reject(new Error('VAD Worker unavailable')));
    owned.addEventListener('messageerror',()=>reject(new Error('VAD Worker protocol')));
    owned.addEventListener('message',(event:MessageEvent<unknown>)=>{
     const d=event.data;
     if(!accepting||generation!==this.generation||signal.aborted||!d||typeof d!=='object'||!('requestId' in d)||d.requestId!==requestId||!('type' in d))return;
     try{
      if(d.type==='iscribe:vad-progress'){heartbeat();return}
      if(d.type==='iscribe:vad-error')throw new Error('VAD inference unavailable');
      if(d.type==='iscribe:vad-ready'&&awaiting==='ready'||d.type==='iscribe:vad-next'&&awaiting==='next'){heartbeat();sendBlock();return}
      if(d.type==='iscribe:vad-result'&&awaiting==='result'&&'report' in d){accepting=false;heartbeat();resolve(d.report);return}
      throw new Error('VAD Worker protocol');
     }catch(error){accepting=false;reject(error)}
    });
    owned.postMessage({type:'iscribe:vad-start',requestId,samples:audio.length});
   }),{signal,timeoutMs:this.initIdleMs,pollMs:Math.min(1000,Math.max(5,this.initIdleMs/4)),onTimeout:()=>{accepting=false;this.retirement.terminate(owned)}});
   signal.throwIfAborted();if(generation!==this.generation)throw new Error('Отменено.');
   this.phase('idle',null,null);return result;
  }finally{
   accepting=false;
   try{this.retirement.terminate(worker)}finally{
    if(this.speakerWorker===worker){this.speakerWorker=null;this.rejectPreload=null}
    if(generation===this.generation){this.busy=false;this.phase(this.resourceBlocked?'error':'idle',null,null)}
   }
  }
 }
 // Experimental word-timing pass. One auxiliary Worker, one PCM slice,
 // and one outstanding request; never run concurrently with Whisper.
 async alignSpeech(audio:Float32Array,segments:readonly AlignmentSegment[],language:AlignmentLanguage,signal:AbortSignal):Promise<AlignmentReport>{
  this.retirement.assertUsable();signal.throwIfAborted();
  if(this.busy||!(audio instanceof Float32Array)||!audio.length||audio.length>3600*16000||segments.length>ALIGNMENT_MAX_SEGMENTS)throw new Error('Alignment unavailable');
  const rows:AlignmentRow[]=[];
  const report=():AlignmentReport=>({revision:1,contract:ALIGNMENT_CONTRACT,language,samples:audio.length,segmentCount:segments.length,rows});
  const crops=segments.map(s=>s.text.length<=4096?segmentCrop(s,audio.length):null);
  if(!crops.some(Boolean))return report();
  this.disposeAsr();this.busy=true;const generation=++this.generation;
  this.phase('initializing',null,null);
  let worker:Worker|null=null,accepting=true;
  const requestId='align-'+generation;
  try{
   worker=createEngineWorker(this.retirement);this.speakerWorker=worker;
   const owned=worker;
   const result=await withActivityWatchdog((heartbeat,beginStage)=>new Promise<AlignmentReport>((resolve,reject)=>{
    this.rejectPreload=reject;
    let index=0,awaiting:'ready'|'segment'|'finish'='ready',current=-1,processedSamples=0,wordCount=0;
    const finish=()=>{awaiting='finish';owned.postMessage({type:'iscribe:align-finish',requestId})};
    const send=()=>{
     signal.throwIfAborted();
     while(index<crops.length){
      const i=index++,crop=crops[i];
      if(!crop)continue;
      if(processedSamples+crop.end-crop.start>audio.length*2||wordCount>=50000){finish();return}
      const block=audio.slice(crop.start,crop.end);processedSamples+=block.length;
      awaiting='segment';current=i;
      owned.postMessage({type:'iscribe:align-segment',requestId,index:i,startSample:crop.start,text:segments[i].text,audio:block},[block.buffer]);return;
     }
     finish();
    };
    owned.addEventListener('error',()=>{accepting=false;reject(new Error('Alignment Worker unavailable'))});
    owned.addEventListener('messageerror',()=>{accepting=false;reject(new Error('Alignment Worker protocol'))});
    owned.addEventListener('message',(event:MessageEvent<unknown>)=>{
     const d=event.data;
     if(!accepting||generation!==this.generation||signal.aborted||!d||typeof d!=='object'||!('requestId' in d)||d.requestId!==requestId||!('type' in d))return;
     try{
      if(d.type==='iscribe:align-progress'&&awaiting==='ready'){heartbeat();return}
      if(d.type==='iscribe:align-error')throw new Error('Alignment inference unavailable');
      if(d.type==='iscribe:align-ready'&&awaiting==='ready'){beginStage(5*60*1000);send();return}
      if(d.type==='iscribe:align-result'&&awaiting==='segment'&&'index' in d&&d.index===current&&'words' in d){
       if(d.words!==null){
        if(!Array.isArray(d.words)||!d.words.length||d.words.length>ALIGNMENT_MAX_TOKENS||wordCount+d.words.length>50512)throw new Error('Invalid alignment result');
        rows.push({index:current,words:d.words as WordSpan[]});wordCount+=d.words.length;
       }
       heartbeat();this.onProgress('Уточнение таймкодов: '+(current+1)+' / '+segments.length,(current+1)/segments.length*100);
       send();return;
      }
      if(d.type==='iscribe:align-finished'&&awaiting==='finish'){accepting=false;heartbeat();resolve(report());return}
      throw new Error('Alignment Worker protocol');
     }catch(error){accepting=false;reject(error)}
    });
    owned.postMessage({type:'iscribe:align-start',requestId,language});
   }),{signal,timeoutMs:this.initIdleMs,pollMs:Math.min(1000,Math.max(5,this.initIdleMs/4)),onTimeout:()=>{accepting=false;this.retirement.terminate(owned)}});
   signal.throwIfAborted();if(generation!==this.generation)throw new Error('Отменено.');
   return result;
  }finally{
   accepting=false;
   try{this.retirement.terminate(worker)}finally{
    if(this.speakerWorker===worker){this.speakerWorker=null;this.rejectPreload=null}
    if(generation===this.generation){this.busy=false;this.phase(this.resourceBlocked?'error':'idle',null,null)}
   }
  }
 }
 async diarize(audio:Float32Array):Promise<SpeakerTurn[]>{
  this.retirement.assertUsable();
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  this.lastSpeakerPass=null;
  if(!Number.isSafeInteger(audio.length)||audio.length<1||audio.length>3600*16000)throw new Error('Некорректный размер PCM для диаризации.');
  this.disposeAsr();
  const requested=this.targetWasmThreads,meter=new SpeakerPassMeter(requested,audio.length,performance.now());
  this.lastSpeakerPass=meter.observation;
  this.busy=true;const generation=++this.generation;
  this.phase('diarizing',null,null);
  let worker:Worker|null=null,stopped=false;
  try{
   worker=createEngineWorker(this.retirement);this.speakerWorker=worker;const requestId='speakers-'+generation;
   const turns=await withActivityWatchdog(heartbeat=>new Promise<SpeakerTurn[]>((resolve,reject)=>{
    this.rejectPreload=reject;
    worker!.addEventListener('error',()=>reject(Object.assign(new Error('Worker диаризации завершился с ошибкой. Текст сохранён.'),{code:'worker-failed'})));
    worker!.addEventListener('messageerror',()=>reject(Object.assign(new Error('Ошибка сообщения Worker диаризации.'),{code:'worker-failed'})));
    worker!.addEventListener('message',(event:MessageEvent<unknown>)=>{
     const d=event.data;if(stopped||!d||typeof d!=='object'||!('type' in d)||generation!==this.generation)return;
     if(d.type==='iscribe:wasm-thread-config'){
      const verified=validWasmConfiguration(d,requested);if(verified)meter.observation.threads=verified;return;
     }
     if(!('requestId' in d)||d.requestId!==requestId)return;
     if(d.type==='iscribe:speaker-progress'&&'status' in d&&typeof d.status==='string'){
      heartbeat();meter.progress(d.status,performance.now());
      this.onProgress(d.status,'percent' in d&&typeof d.percent==='number'&&Number.isFinite(d.percent)?d.percent:null);
     }
     if(d.type==='iscribe:preload-error'&&'message' in d&&typeof d.message==='string')reject(new Error(d.message));
     if(d.type==='iscribe:speaker-result'&&'turns' in d){
      if(!Array.isArray(d.turns)||d.turns.length>100000){reject(new Error('Некорректный список интервалов диаризации.'));return}
      // Do not discard 96 valid turns because one result is malformed.
      // The pure alignment stage ignores invalid intervals and counts them
      // in the numeric diagnostic report; it never assigns from bad data.
      heartbeat();resolve(d.turns as SpeakerTurn[]);
     }
    });
    worker!.postMessage({type:'iscribe:wasm-threads',requested});
    meter.observation.transfer=postSpeakerAudio(worker!,{type:'iscribe:speakers',requestId,audio});
   }),{timeoutMs:this.speakerIdleMs,pollMs:Math.min(1000,Math.max(5,this.speakerIdleMs/4)),onTimeout:()=>{stopped=true;this.retirement.terminate(worker);this.rejectPreload?.(new WorkerStalledError())}});
   if(generation!==this.generation)throw new Error('Операция отменена.');
   meter.finish(true,performance.now());this.phase('idle',null,null);
   return turns;
  }catch(error){meter.finish(false,performance.now());if(generation===this.generation)this.phase('error',null,null);throw error}
  finally{stopped=true;try{this.retirement.terminate(worker)}finally{if(this.speakerWorker===worker){this.speakerWorker=null;this.rejectPreload=null}if(generation===this.generation){this.busy=false;if(this.resourceBlocked)this.phase('error',null,null)}}}
 }
 cancel(){
  if(this.preparingId)this.onWhisperProgress(this.preparingId,{phase:'cancelled'});this.preparingId=null;++this.generation;
  this.rejectPreload?.(new Error('Операция отменена.'));this.rejectPreload=null;
  const speaker=this.speakerWorker;this.speakerWorker=null;
  try{this.retirement.terminate(speaker)}catch{/* Failure is latched; cancellation must settle. */}
  finally{
   try{this.disposeAsr()}catch{/* Termination failure is latched; do not throw from UI cancellation. */}
   finally{this.busy=false;this.phase(this.resourceBlocked?'error':'cancelled',null,null)}
  }
 }
}
