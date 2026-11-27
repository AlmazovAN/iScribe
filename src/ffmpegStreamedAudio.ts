import {validateFile} from './audio';
import {AudioValidationError,PCM_SAMPLE_RATE} from './audioValidation';
import {assetURL,FFMPEG_CORE_ASSET,FFMPEG_WASM_ASSET} from './ffmpegDecoder';
import {allocateStreamDecoderId,type StreamedAudio,type StreamReadObserver} from './streamedAudio';
import type {AudioWindow} from './recognitionProgress';
import workerSource from './ffmpegStreamWorker.js?raw';

export const FFMPEG_MAX_WINDOW_SAMPLES=30*PCM_SAMPLE_RATE;
type Opened={id:number;kind:'opened';length:number;sourceRate:number};
type Pcm={id:number;kind:'pcm';buffer:ArrayBuffer};
type Reply=Opened|Pcm|{id:number;kind:'error';code:string}|{id:number;kind:'progress';time:number};
type Pending={id:number;resolve:(reply:Opened|Pcm)=>void;reject:(error:unknown)=>void;onProgress?:()=>void;lastProgress:number};
export function validateFfmpegWindow(window:AudioWindow,length:number):void{
 if(!Number.isSafeInteger(window.start)||!Number.isSafeInteger(window.end)||window.start<0||
  window.end<=window.start||window.end>length||window.end-window.start>FFMPEG_MAX_WINDOW_SAMPLES)
  throw new AudioValidationError(null,null,'invalid-window');
}
export function validateFfmpegWindowPcm(buffer:ArrayBuffer,expected:number):Float32Array{
 if(!Number.isSafeInteger(expected)||expected<1||expected>FFMPEG_MAX_WINDOW_SAMPLES||
  buffer.byteLength!==expected*Float32Array.BYTES_PER_ELEMENT)
  throw new AudioValidationError(null,null,'invalid-window');
 const pcm=new Float32Array(buffer);
 for(let i=0;i<pcm.length;i++)if(!Number.isFinite(pcm[i]))
  throw new AudioValidationError(null,i,'invalid-sample');
 return pcm;
}
const errorMessages:Record<string,string>={
 workerfs:'FFmpeg: WORKERFS недоступна. Копирование всей записи запрещено.',
 probe:'FFmpeg: не удалось определить параметры аудиодорожки.',
 timeline:'FFmpeg: начало аудиодорожки не совпадает с началом контейнера.',
 duration:'FFmpeg: не удалось подтвердить конец аудиозаписи.',
 coverage:'FFmpeg: окно декодировано не полностью.',
 decode:'FFmpeg: ошибка декодирования аудио.',
 window:'FFmpeg: некорректные границы окна.',
 protocol:'FFmpeg: нарушение последовательности запросов.',
 runtime:'FFmpeg: ошибка запуска или обработки.'
};
export async function openFfmpegStreamedAudio(file:File,signal?:AbortSignal):Promise<StreamedAudio>{
 validateFile(file);signal?.throwIfAborted();
 const decoderId=allocateStreamDecoderId();
 const source=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
 let worker:Worker;
 try{worker=new Worker(source)}catch(error){URL.revokeObjectURL(source);throw error}
 let closed=false,reading=false,nextId=0,pending:Pending|undefined;
 const closeWith=(error:unknown)=>{
  if(closed)return;
  closed=true;signal?.removeEventListener('abort',abort);
  worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;
  worker.terminate();URL.revokeObjectURL(source);
  const request=pending;pending=undefined;request?.reject(error);
 };
 const close=()=>closeWith(new Error('Потоковый декодер FFmpeg закрыт.'));
 const abort=()=>closeWith(signal?.reason??new DOMException('Отменено','AbortError'));
 worker.onerror=()=>closeWith(new Error('FFmpeg: ошибка Worker.'));
 worker.onmessageerror=()=>closeWith(new Error('FFmpeg: ошибка передачи PCM.'));
 worker.onmessage=(event:MessageEvent<Reply>)=>{
  const response=event.data,request=pending;
  if(closed||!request||response?.id!==request.id)return;
  if(response.kind==='progress'){
   if(Number.isFinite(response.time)&&response.time>request.lastProgress){
    request.lastProgress=response.time;request.onProgress?.();
   }
   return;
  }
  pending=undefined;
  if(response.kind==='error'){
   const error=new Error(Object.hasOwn(errorMessages,response.code)?errorMessages[response.code]:errorMessages.runtime);
   request.reject(error);closeWith(error);
  }else if(response.kind==='opened'||response.kind==='pcm')request.resolve(response);
  else{const error=new Error(errorMessages.protocol);request.reject(error);closeWith(error)}
 };
 const send=(data:Record<string,unknown>,onProgress?:()=>void):Promise<Opened|Pcm>=>{
  if(closed||pending)return Promise.reject(new Error('FFmpeg: декодер закрыт или занят.'));
  return new Promise((resolve,reject)=>{
   const id=++nextId;pending={id,resolve,reject,onProgress,lastProgress:0};
   try{worker.postMessage({...data,id})}catch(error){closeWith(error)}
  });
 };
 signal?.addEventListener('abort',abort,{once:true});
 try{
  signal?.throwIfAborted();
  const opened=await send({kind:'open',file,coreURL:assetURL(FFMPEG_CORE_ASSET),wasmURL:assetURL(FFMPEG_WASM_ASSET)});
  if(opened.kind!=='opened'||!Number.isSafeInteger(opened.length)||opened.length<=0||
    !Number.isInteger(opened.sourceRate)||opened.sourceRate<8000||opened.sourceRate>384000)
   throw new Error(errorMessages.probe);
  const {length,sourceRate}=opened;
  // The runner owns foreground idle watchdogs, retries and prefetch. This
  // adapter always rejects partial output, including recovery subwindows.
  async function read(window:AudioWindow,observe?:StreamReadObserver,onProgress?:()=>void):Promise<Float32Array>{
   if(closed||reading)throw new Error('FFmpeg: декодер закрыт или занят.');
   signal?.throwIfAborted();validateFfmpegWindow(window,length);
   reading=true;const started=performance.now();
   try{
    const reply=await send({kind:'read',start:window.start,end:window.end},onProgress);
    if(reply.kind!=='pcm'||!(reply.buffer instanceof ArrayBuffer))throw new Error(errorMessages.protocol);
    signal?.throwIfAborted();
    if(closed)throw new Error('Потоковый декодер FFmpeg закрыт.');
    // Decode and resampling are one FFmpeg command; report their combined
    // duration honestly, rather than inventing separate stage timings.
    await observe?.({code:'stream-read-end',streamStage:'decode',sourceSampleRate:sourceRate,
     elapsedMs:performance.now()-started,pcmSamples:reply.buffer.byteLength/4});
    signal?.throwIfAborted();
    if(closed)throw new Error('Потоковый декодер FFmpeg закрыт.');
    const pcm=validateFfmpegWindowPcm(reply.buffer,window.end-window.start);
    onProgress?.();return pcm;
   }finally{reading=false}
  }
  return {length,read,close,decoderId};
 }catch(error){closeWith(error);throw error}
}
