import {validateFile} from './audio';
import {AudioValidationError,PCM_SAMPLE_RATE} from './audioValidation';
import {ffmpegWorkerAssets} from './ffmpegDecoder';
import {allocateStreamDecoderId,type StreamedAudio,type StreamReadObserver} from './streamedAudio';
import type {AudioWindow} from './recognitionProgress';
import workerSource from './ffmpegStreamWorker.js?raw';
import {WorkerRetirement} from './performance/resourceLifecycle';
import {WorkerDisposalError} from './ml/activityWatchdog';
import {FfmpegDecoderError,ffmpegFailure,safeExitCode,safeFfmpegDetails,type FfmpegStage} from './decoderDiagnostics';

export const FFMPEG_MAX_WINDOW_SAMPLES=30*PCM_SAMPLE_RATE;
type Opened={id:number;kind:'opened';length:number;sourceRate:number};
type Pcm={id:number;kind:'pcm';buffer:ArrayBuffer};
type Reply=Opened|Pcm|{id:number;kind:'error';code:string;exitCode?:number;details?:unknown;errorLines?:unknown}|{id:number;kind:'progress';time:number};
type Pending={id:number;stage:FfmpegStage;resolve:(reply:Opened|Pcm)=>void;reject:(error:unknown)=>void;onProgress?:()=>void;lastProgress:number};
export function validateFfmpegWindow(window:AudioWindow,length:number):void{
 if(!Number.isSafeInteger(window.start)||!Number.isSafeInteger(window.end)||window.start<0||
  window.end<=window.start||window.end>length||window.end-window.start>FFMPEG_MAX_WINDOW_SAMPLES)
  throw new AudioValidationError(null,null,'invalid-window');
}
export function validateFfmpegWindowPcm(buffer:ArrayBuffer,expected:number,startSample=0):Float32Array{
 if(!Number.isSafeInteger(expected)||expected<1||expected>FFMPEG_MAX_WINDOW_SAMPLES||
  buffer.byteLength!==expected*Float32Array.BYTES_PER_ELEMENT)
  throw new AudioValidationError(null,null,'invalid-window');
 const pcm=new Float32Array(buffer);
 for(let i=0;i<pcm.length;i++)if(!Number.isFinite(pcm[i]))
  throw new AudioValidationError(null,startSample+i,'invalid-sample');
 return pcm;
}
export async function openFfmpegStreamedAudio(file:File,signal?:AbortSignal):Promise<StreamedAudio>{
 validateFile(file);signal?.throwIfAborted();
 const decoderId=allocateStreamDecoderId();
 const assets=ffmpegWorkerAssets(workerSource);
 const source=URL.createObjectURL(assets.script);
 let worker:Worker;
 try{worker=new Worker(source)}catch(error){URL.revokeObjectURL(source);throw error}
 let closed=false,reading=false,nextId=0,pending:Pending|undefined;
 const retirement=new WorkerRetirement();
 let disposalError:WorkerDisposalError|undefined;
 const closeWith=(error:unknown,propagate=false)=>{
  if(!closed){
   closed=true;signal?.removeEventListener('abort',abort);
   worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;
   const request=pending;pending=undefined;
   try{retirement.terminate(worker)}catch{disposalError=new WorkerDisposalError()}
   finally{URL.revokeObjectURL(source);request?.reject(disposalError??error)}
  }
  if(propagate&&disposalError)throw disposalError;
 };
 const close=()=>closeWith(new Error('Потоковый декодер FFmpeg закрыт.'),true);
 const abort=()=>closeWith(signal?.reason??new DOMException('Отменено','AbortError'));
 worker.onerror=()=>closeWith(new FfmpegDecoderError('worker',pending?.stage??'open'));
 worker.onmessageerror=()=>closeWith(new FfmpegDecoderError('protocol',pending?.stage??'open'));
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
   const error=new FfmpegDecoderError(ffmpegFailure(response.code),request.stage,safeExitCode(response.exitCode),safeFfmpegDetails(response.details,response.errorLines));
   request.reject(error);closeWith(error);
  }else if(response.kind==='opened'||response.kind==='pcm')request.resolve(response);
  else{const error=new FfmpegDecoderError('protocol',request.stage);request.reject(error);closeWith(error)}
 };
 const send=(data:Record<string,unknown>,onProgress?:()=>void):Promise<Opened|Pcm>=>{
  if(closed||pending)return Promise.reject(new Error('FFmpeg: декодер закрыт или занят.'));
  return new Promise((resolve,reject)=>{
   const id=++nextId;pending={id,stage:data.kind==='open'?'open':'decode',resolve,reject,onProgress,lastProgress:0};
   try{worker.postMessage({...data,id})}catch(error){closeWith(error)}
  });
 };
 signal?.addEventListener('abort',abort,{once:true});
 try{
  signal?.throwIfAborted();
  const opened=await send({kind:'open',file,...assets.input});
  if(opened.kind!=='opened'||!Number.isSafeInteger(opened.length)||opened.length<=0||
    !Number.isInteger(opened.sourceRate)||opened.sourceRate<8000||opened.sourceRate>384000)
   throw new FfmpegDecoderError('probe','open');
  const {length,sourceRate}=opened;
  // The runner owns foreground idle watchdogs, retries and prefetch. This
  // adapter always rejects partial output, including recovery subwindows.
  async function read(window:AudioWindow,observe?:StreamReadObserver,onProgress?:()=>void):Promise<Float32Array>{
   if(closed||reading)throw new Error('FFmpeg: декодер закрыт или занят.');
   signal?.throwIfAborted();validateFfmpegWindow(window,length);
   reading=true;const started=performance.now();
   try{
    const reply=await send({kind:'read',start:window.start,end:window.end},onProgress);
    if(reply.kind!=='pcm'||!(reply.buffer instanceof ArrayBuffer))throw new FfmpegDecoderError('protocol','decode');
    signal?.throwIfAborted();
    if(closed)throw new Error('Потоковый декодер FFmpeg закрыт.');
    // Decode and resampling are one FFmpeg command; report their combined
    // duration honestly, rather than inventing separate stage timings.
    await observe?.({code:'stream-read-end',streamStage:'decode',sourceSampleRate:sourceRate,
     elapsedMs:performance.now()-started,pcmSamples:reply.buffer.byteLength/4});
    signal?.throwIfAborted();
    if(closed)throw new Error('Потоковый декодер FFmpeg закрыт.');
    const pcm=validateFfmpegWindowPcm(reply.buffer,window.end-window.start,window.start);
    onProgress?.();return pcm;
   }finally{reading=false}
  }
  return {length,read,close,decoderId};
 }catch(error){closeWith(error,true);throw error}
}
