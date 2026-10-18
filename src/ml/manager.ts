import {EngineClient,type CapabilityReport,type TranscriptSegment,type SpeakerTurn,type BackendId} from '@yourdevice/engine';
import EngineWorker from './worker?worker';
import {MAX_ASR_WINDOW_SAMPLES} from './activityWatchdog';
import {checkWhisperCache,recordWhisperCache,checkSpeakerCache,speakerRepos} from './cache';
export type WhisperId='whisper-tiny'|'whisper-small'|'whisper-large-v3';
export const repos:Record<WhisperId,string>={'whisper-tiny':'onnx-community/whisper-tiny','whisper-small':'onnx-community/whisper-small','whisper-large-v3':'onnx-community/whisper-large-v3-ONNX'};
export type WhisperDownloadProgress={phase:'loading'|'initializing'|'checking'|'ready'|'error'|'cancelled';loadedBytes?:number;totalBytes?:number;httpRequests?:number;cachedBefore?:boolean;cachedAfter?:boolean;message?:string};
export class ModelManager{
 private client:EngineClient|null=null;
 private busy=false;
 private speakerWorker:Worker|null=null;
 private rejectPreload:((error:Error)=>void)|null=null;
 onSpeakerProgress:(id:keyof typeof speakerRepos,status:string)=>void=()=>{};
 private generation=0;
 private preparingId:WhisperId|null=null;
 active:WhisperId|null=null;
 capabilities:CapabilityReport|null=null;
 onWhisperProgress:(id:WhisperId,progress:WhisperDownloadProgress)=>void=()=>{};
 onProgress:(text:string,percent:number|null)=>void=()=>{};
 async cached(id:WhisperId){return checkWhisperCache(repos[id])}
 async prepare(id:WhisperId,options:{wasmOnly?:boolean}={}):Promise<{cached:boolean,backend:string}>{
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  // Selecting the already active model must not dispose its ONNX session.
  if(this.active===id&&this.client&&this.capabilities?.active&&(!options.wasmOnly||this.capabilities.active==='wasm')){
   const cached=await this.cached(id);
   this.onWhisperProgress(id,{phase:'ready',cachedBefore:cached,cachedAfter:cached,httpRequests:0});
   return {cached,backend:this.capabilities.active};
  }
  this.busy=true;this.preparingId=id;const generation=++this.generation;
  this.client?.dispose();this.active=null;this.capabilities=null;
  let client:EngineClient|null=null;
  let cachedBefore=false,requests=0,loadedBytes=0,totalBytes=0;
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
    const worker=new EngineWorker();
    worker.addEventListener('message',(event:MessageEvent<unknown>)=>{
     const d=event.data;
     if(generation!==this.generation||!d||typeof d!=='object'||!('type' in d)||d.type!=='iscribe:model-http-request'||
        !('repo' in d)||d.repo!==repos[id])return;
     requests++;
     progress('loading');
     this.onProgress('HTTP-запрос файлов модели (возможен кэш браузера)…',null);
    });
    return worker;
   });
   this.client=client;
   // Engine download-progress measures model files processed, including cache hits.
   // It does NOT measure bytes transferred over the network.
   client.onDownloadProgress=info=>{
    if(generation!==this.generation)return;
    loadedBytes=info.loadedBytes;totalBytes=info.totalBytes;
    progress(requests>0?'loading':'initializing');
   };
   const report=await client.init(id,options.wasmOnly?{backendPreference:['wasm']}:{});
   if(generation!==this.generation)throw new Error('Операция отменена.');
   if(options.wasmOnly&&report.active!=='wasm')throw new Error('Безопасное восстановление на WASM недоступно.');
   if(!report.active)throw new Error('Вычислительный backend не инициализирован.');
   this.active=id;this.capabilities=report;
   progress('checking');
   const cached=await recordWhisperCache(repos[id]);
   if(generation!==this.generation)throw new Error('Операция отменена.');
   progress('ready',undefined,cached);
   return {cached,backend:report.active};
  }catch(error){
   progress('error',error instanceof Error?error.message:String(error));
   client?.dispose();
   if(this.client===client){this.client=null;this.active=null;this.capabilities=null}
   throw error;
  }finally{if(generation===this.generation){this.busy=false;this.preparingId=null}}
 }
 async recover(id:WhisperId,wasmOnly:boolean):Promise<{cached:boolean,backend:BackendId}>{
  // A failed inference worker must be discarded; ONNX session and pending
  // requests in that worker are not safe to reuse on the next attempt.
  this.client?.dispose();this.client=null;this.active=null;this.capabilities=null;
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
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  this.busy=true;const generation=++this.generation;
  this.client?.dispose();this.client=null;this.active=null;this.capabilities=null;
  let createdWorker:Worker|null=null;
  const requestId='speakers-'+generation;
  try{
   const worker=new EngineWorker();createdWorker=worker;this.speakerWorker=worker;
   await new Promise<void>((resolve,reject)=>{
    this.rejectPreload=reject;
    worker.addEventListener('error',()=>reject(new Error('Worker загрузки моделей говорящих завершился с ошибкой.')));
    worker.addEventListener('messageerror',()=>reject(new Error('Ошибка сообщения от Worker моделей говорящих.')));
    worker.addEventListener('message',(event:MessageEvent<unknown>)=>{
     const data=event.data;
     if(!data||typeof data!=='object'||!('requestId' in data)||data.requestId!==requestId||!('type' in data)||generation!==this.generation)return;
     if(data.type==='iscribe:preload-complete'){resolve();return}
     if(data.type==='iscribe:preload-error'&&'message' in data&&typeof data.message==='string'){reject(new Error(data.message));return}
     if(data.type==='iscribe:preload-progress'&&'model' in data&&typeof data.model==='string'&&'status' in data&&typeof data.status==='string'){
      const id=data.model===speakerRepos.segmentation?'segmentation':data.model===speakerRepos.embedding?'embedding':null;if(!id)return;
      const mb='loaded' in data&&typeof data.loaded==='number'?` · ${(data.loaded/1024/1024).toFixed(1)} МБ`:'';
      const label=id==='segmentation'?'Pyannote':'WeSpeaker';const stage=data.status==='ready'?'Инициализирована':data.status==='initiate'?'Подготовка':'Загрузка'+mb;
      this.onSpeakerProgress(id,stage);this.onProgress(`${label}: ${stage}`,null);
     }
    });
    worker.postMessage({type:'iscribe:preload',requestId});
   });
   if(generation!==this.generation)throw new Error('Операция отменена.');
   const cached=await this.speakersCached();
   if(!cached.segmentation||!cached.embedding)throw new Error('Не подтверждён полный кеш обеих моделей говорящих. Повторите загрузку; проверьте свободное место браузера.');
   return cached;
  }finally{
   createdWorker?.terminate();if(this.speakerWorker===createdWorker){this.speakerWorker=null;this.rejectPreload=null}
   if(generation===this.generation)this.busy=false;
  }
 }
 async transcribe(audio:Float32Array,diarize:boolean,onPartial:(segments:TranscriptSegment[])=>void,language:'ru'|'en'='ru'):Promise<TranscriptSegment[]>{
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  if(!this.client||!this.active)throw new Error('Сначала скачайте и выберите модель.');
  // An unintended whole-recording transfer would duplicate tens/hundreds
  // of MB in Worker memory. Send exactly one <=30 s Float32 PCM window.
  if(!Number.isInteger(audio.length)||audio.length===0||audio.length>MAX_ASR_WINDOW_SAMPLES)
   throw new Error('Некорректный размер окна ASR. Передавайте не более 30 секунд аудио.');
  this.busy=true;const generation=this.generation;
  try{
   this.onProgress(language==='ru'?'Распознавание русской речи…':'Распознавание английской речи…',null);
   const result=await this.client.transcribe(audio,{language,task:'transcribe',diarize},{onDiarizationProgress:(processed,total)=>{if(generation===this.generation)this.onProgress(`Разделение говорящих (WASM): ${processed} / ${total}`,total?processed/total*100:null)},onPartial:(segments,processed,total)=>{if(generation!==this.generation)return;onPartial(segments);this.onProgress(`Распознано ${processed.toFixed(0)} / ${total.toFixed(0)} с`,total?processed/total*100:null)}});
   if(generation!==this.generation)throw new Error('Операция отменена.');
   return result;
  }finally{if(generation===this.generation)this.busy=false}
 }
 async diarize(audio:Float32Array):Promise<SpeakerTurn[]>{
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  this.busy=true;const generation=++this.generation;
  this.client?.dispose();this.client=null;this.active=null;this.capabilities=null;
  let worker:Worker|null=null;
  try{
   worker=new EngineWorker();this.speakerWorker=worker;const requestId='speakers-'+generation;
   return await new Promise<SpeakerTurn[]>((resolve,reject)=>{
    this.rejectPreload=reject;
    worker!.addEventListener('error',()=>reject(new Error('Worker диаризации завершился с ошибкой. Текст сохранён.')));
    worker!.addEventListener('messageerror',()=>reject(new Error('Ошибка сообщения Worker диаризации.')));
    worker!.addEventListener('message',(event:MessageEvent<unknown>)=>{
     const d=event.data;if(!d||typeof d!=='object'||!('requestId' in d)||d.requestId!==requestId||!('type' in d)||generation!==this.generation)return;
     if(d.type==='iscribe:speaker-progress'&&'status' in d&&typeof d.status==='string')this.onProgress(d.status,'percent' in d&&typeof d.percent==='number'&&Number.isFinite(d.percent)?d.percent:null);
     if(d.type==='iscribe:preload-error'&&'message' in d&&typeof d.message==='string')reject(new Error(d.message));
     if(d.type==='iscribe:speaker-result'&&'turns' in d){
      if(!Array.isArray(d.turns)||!d.turns.every(t=>t&&typeof t==='object'&&typeof t.start==='number'&&Number.isFinite(t.start)&&typeof t.end==='number'&&Number.isFinite(t.end)&&t.end>t.start&&typeof t.speaker==='string')){reject(new Error('Некорректные интервалы диаризации.'));return}
      resolve(d.turns);
     }
    });
    worker!.postMessage({type:'iscribe:speakers',requestId,audio});
   });
  }finally{worker?.terminate();if(this.speakerWorker===worker){this.speakerWorker=null;this.rejectPreload=null}if(generation===this.generation)this.busy=false}
 }
 cancel(){if(this.preparingId)this.onWhisperProgress(this.preparingId,{phase:'cancelled'});this.preparingId=null;++this.generation;this.rejectPreload?.(new Error('Операция отменена.'));this.rejectPreload=null;this.speakerWorker?.terminate();this.speakerWorker=null;this.client?.dispose();this.client=null;this.active=null;this.capabilities=null;this.busy=false}
}
