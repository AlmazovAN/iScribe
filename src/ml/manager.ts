import {EngineClient,type CapabilityReport,type TranscriptSegment} from '@yourdevice/engine';
import EngineWorker from './worker?worker';
import {checkWhisperCache,recordWhisperCache,checkSpeakerCache,speakerRepos} from './cache';
export type WhisperId='whisper-tiny'|'whisper-small'|'whisper-large-v3';
export const repos:Record<WhisperId,string>={'whisper-tiny':'onnx-community/whisper-tiny','whisper-small':'onnx-community/whisper-small','whisper-large-v3':'onnx-community/whisper-large-v3-ONNX'};
export class ModelManager{
 private client:EngineClient|null=null;
 private busy=false;
 private speakerWorker:Worker|null=null;
 private rejectPreload:((error:Error)=>void)|null=null;
 onSpeakerProgress:(id:keyof typeof speakerRepos,status:string)=>void=()=>{};
 private generation=0;
 active:WhisperId|null=null;
 capabilities:CapabilityReport|null=null;
 onProgress:(text:string,percent:number|null)=>void=()=>{};
 async cached(id:WhisperId){return checkWhisperCache(repos[id])}
 async prepare(id:WhisperId):Promise<{cached:boolean,backend:string}>{
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  this.busy=true;const generation=++this.generation;
  this.client?.dispose();this.active=null;this.capabilities=null;
  const client=new EngineClient(()=>new EngineWorker());this.client=client;
  client.onDownloadProgress=info=>{if(generation===this.generation)this.onProgress(`Загрузка ${(info.loadedBytes/1024/1024).toFixed(1)} МБ${info.totalBytes?' / '+(info.totalBytes/1024/1024).toFixed(1)+' МБ':''}`,info.totalBytes?Math.min(100,info.loadedBytes/info.totalBytes*100):null)};
  try{
   this.onProgress('Загрузка и инициализация модели…',null);
   const report=await client.init(id);if(generation!==this.generation)throw new Error('Операция отменена.');
   if(!report.active)throw new Error('Вычислительный backend не инициализирован.');
   this.active=id;this.capabilities=report;
   const cached=await recordWhisperCache(repos[id]);return {cached,backend:report.active};
  }catch(error){client.dispose();if(this.client===client){this.client=null;this.active=null;this.capabilities=null}throw error}
  finally{if(generation===this.generation)this.busy=false}
 }
 async speakersCached(){
  const [segmentation,embedding]=await Promise.all([checkSpeakerCache(speakerRepos.segmentation),checkSpeakerCache(speakerRepos.embedding)]);
  return {segmentation,embedding};
 }
 async preloadSpeakers(){
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  this.busy=true;const generation=++this.generation;
  this.client?.dispose();this.client=null;this.active=null;this.capabilities=null;
  const worker=new EngineWorker();this.speakerWorker=worker;
  const requestId='speakers-'+generation;
  try{
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
   worker.terminate();if(this.speakerWorker===worker){this.speakerWorker=null;this.rejectPreload=null}
   if(generation===this.generation)this.busy=false;
  }
 }
 async transcribe(audio:Float32Array,diarize:boolean,onPartial:(segments:TranscriptSegment[])=>void):Promise<TranscriptSegment[]>{
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  if(!this.client||!this.active)throw new Error('Сначала скачайте и выберите модель.');
  this.busy=true;const generation=this.generation;
  try{
   this.onProgress('Распознавание русской речи…',null);
   const result=await this.client.transcribe(audio,{language:'ru',task:'transcribe',diarize},{onDiarizationProgress:(processed,total)=>{if(generation===this.generation)this.onProgress(`Разделение говорящих (WASM): ${processed} / ${total}`,total?processed/total*100:null)},onPartial:(segments,processed,total)=>{if(generation!==this.generation)return;onPartial(segments);this.onProgress(`Распознано ${processed.toFixed(0)} / ${total.toFixed(0)} с`,total?processed/total*100:null)}});
   if(generation!==this.generation)throw new Error('Операция отменена.');
   return result;
  }finally{if(generation===this.generation)this.busy=false}
 }
 cancel(){++this.generation;this.rejectPreload?.(new Error('Операция отменена.'));this.rejectPreload=null;this.speakerWorker?.terminate();this.speakerWorker=null;this.client?.dispose();this.client=null;this.active=null;this.capabilities=null;this.busy=false}
}
