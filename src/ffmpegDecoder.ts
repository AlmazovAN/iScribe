import {MAX_SECONDS,usesStreamedAudio,validateFile} from './audio';
import {PCM_SAMPLE_RATE,inspectDecodedPcm} from './audioValidation';
import workerSource from './ffmpegWorker.js?raw';
import errorClassifier from './ffmpegErrorClassifier.js?raw';
import {FfmpegDecoderError,ffmpegFailure,safeExitCode,safeFfmpegDetails} from './decoderDiagnostics';

export const FFMPEG_CORE_ASSET='assets/ffmpeg-core-0.12.10.js';
export const FFMPEG_WASM_ASSET='assets/ffmpeg-core-0.12.10.wasm.gz.bin';
const MAX_SAMPLES=MAX_SECONDS*PCM_SAMPLE_RATE;
const DEADLINE_MS=10*60*1000;
type Reply={kind:'pcm';buffer:ArrayBuffer}|{kind:'error';code:string;status?:number;details?:unknown;errorLines?:unknown};
export function assetURL(name:string):string{
 const embedded=(globalThis as typeof globalThis&{__iscribeAssets?:Record<string,string>}).__iscribeAssets?.[name];
 return embedded??new URL(import.meta.env.DEV?'/'+name:name,document.baseURI).href;
}
type EmbeddedFfmpeg={core:Blob;wasm:Blob};
type FfmpegWorkerInput={coreURL:string;wasmURL:string}|{wasmBlob:Blob};
export function ffmpegWorkerAssets(source:string,embedded:EmbeddedFfmpeg|undefined=(globalThis as typeof globalThis&{__iscribeFfmpegEmbedded?:EmbeddedFfmpeg}).__iscribeFfmpegEmbedded):{script:Blob;input:FfmpegWorkerInput}{
 source+=';\n'+errorClassifier;
 if(embedded){
  if(!(embedded.core instanceof Blob)||!(embedded.wasm instanceof Blob)||!embedded.core.size||!embedded.wasm.size)
   throw new FfmpegDecoderError('asset','open');
  // Same classic Worker source and structured-cloned Blob for both routes.
  // Never importScripts/fetch a page-owned blob:null URL from a file worker.
  return {script:new Blob([embedded.core,';\n',source],{type:'text/javascript'}),input:{wasmBlob:embedded.wasm}};
 }
 return {script:new Blob([source],{type:'text/javascript'}),input:{coreURL:assetURL(FFMPEG_CORE_ASSET),wasmURL:assetURL(FFMPEG_WASM_ASSET)}};
}
export function readFfmpegPcm(buffer:ArrayBuffer):Float32Array{
 if(buffer.byteLength===0||buffer.byteLength%4!==0||buffer.byteLength/4>MAX_SAMPLES)
  throw new Error('FFmpeg вернул пустой или слишком длинный PCM.');
 const pcm=new Float32Array(buffer);
 // No amplitude normalization, noise suppression or silent repair.
 return pcm;
}
export async function decodeFfmpegAudio(file:File,signal?:AbortSignal):Promise<Float32Array>{
 validateFile(file);signal?.throwIfAborted();
 if(usesStreamedAudio(file.size))throw new Error('FFmpeg: для этого файла требуется потоковый режим.');
 const assets=ffmpegWorkerAssets(workerSource);
 const source=URL.createObjectURL(assets.script);
 let worker:Worker|undefined;
 try{
  worker=new Worker(source);
  const active=worker;
  const buffer=await new Promise<ArrayBuffer>((resolve,reject)=>{
   let settled=false;
   const finish=(error?:unknown,data?:ArrayBuffer)=>{
    if(settled)return;
    settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
    active.onmessage=null;active.onerror=null;active.onmessageerror=null;
    if(data)resolve(data);else reject(error??new Error('FFmpeg: неизвестная ошибка.'));
   };
   const abort=()=>finish(signal?.reason??new DOMException('Отменено','AbortError'));
   const timer=setTimeout(()=>finish(new FfmpegDecoderError('timeout','decode')),DEADLINE_MS);
   signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return;}
   active.onmessage=(event:MessageEvent<Reply>)=>{
    const reply=event.data;
    if(reply?.kind==='pcm'&&reply.buffer instanceof ArrayBuffer){finish(undefined,reply.buffer);return;}
    if(reply?.kind==='error'){finish(new FfmpegDecoderError(ffmpegFailure(reply.code),'decode',safeExitCode(reply.status),safeFfmpegDetails(reply.details,reply.errorLines)));return;}
    finish(new FfmpegDecoderError('runtime','decode'));
   };
   active.onerror=()=>finish(new FfmpegDecoderError('worker','decode'));
   active.onmessageerror=()=>finish(new FfmpegDecoderError('protocol','decode'));
   try{active.postMessage({file,...assets.input,maxSamples:MAX_SAMPLES});}
   catch(error){finish(error);}
  });
  // Release the WASM heap before PCM inspection / Whisper.
  active.terminate();worker=undefined;
  signal?.throwIfAborted();
  const pcm=readFfmpegPcm(buffer);
  await inspectDecodedPcm(pcm,{signal});
  return pcm;
 }finally{worker?.terminate();URL.revokeObjectURL(source)}
}
