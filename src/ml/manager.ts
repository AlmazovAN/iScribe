import {EngineClient,type CapabilityReport,type TranscriptSegment} from '@yourdevice/engine';
import EngineWorker from './worker?worker';
import {checkWhisperCache,recordWhisperCache} from './cache';
export type WhisperId='whisper-tiny'|'whisper-small'|'whisper-large-v3';
export const repos:Record<WhisperId,string>={'whisper-tiny':'onnx-community/whisper-tiny','whisper-small':'onnx-community/whisper-small','whisper-large-v3':'onnx-community/whisper-large-v3-ONNX'};
export class ModelManager{
 private client:EngineClient|null=null;
 private busy=false;
 private generation=0;
 active:WhisperId|null=null;
 capabilities:CapabilityReport|null=null;
 onProgress:(text:string,percent:number|null)=>void=()=>{};
 async cached(id:WhisperId){return checkWhisperCache(repos[id])}
 async prepare(id:WhisperId):Promise<{cached:boolean,backend:string}>{
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  if(id==='whisper-large-v3')throw new Error('Large v3 ещё не подключена.');
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
 async transcribe(audio:Float32Array,onPartial:(segments:TranscriptSegment[])=>void):Promise<TranscriptSegment[]>{
  if(this.busy)throw new Error('Дождитесь текущей операции.');
  if(!this.client||!this.active)throw new Error('Сначала скачайте и выберите модель.');
  this.busy=true;const generation=this.generation;
  try{
   this.onProgress('Распознавание русской речи…',null);
   const result=await this.client.transcribe(audio,{language:'ru',task:'transcribe',diarize:false},{onPartial:(segments,processed,total)=>{if(generation!==this.generation)return;onPartial(segments);this.onProgress(`Распознано ${processed.toFixed(0)} / ${total.toFixed(0)} с`,total?processed/total*100:null)}});
   if(generation!==this.generation)throw new Error('Операция отменена.');
   return result;
  }finally{if(generation===this.generation)this.busy=false}
 }
 cancel(){++this.generation;this.client?.dispose();this.client=null;this.active=null;this.capabilities=null;this.busy=false}
}
