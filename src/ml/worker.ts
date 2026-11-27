import {compressedWasmFetch,validatedModelFetch,observedWhisperHttpFetch,offlineModelFetch} from './runtimeFetch';
import {env} from '@huggingface/transformers';
import {clampWasmRequest,localWasmThreadEnvironment,resolveWasmThreads} from '../performance/wasmThreads';
import {preloadDiarizationModels,runSpeakerPass} from '@yourdevice/engine/worker';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
// Runtime files are served with the app, not fetched from an unpinned CDN.
env.allowLocalModels=false;
env.fetch=validatedModelFetch(offlineModelFetch(env.fetch));
env.fetch=observedWhisperHttpFetch(env.fetch,repo=>postMessage({type:'iscribe:model-http-request',repo}));
env.useWasmCache=import.meta.env.MODE!=='standalone';
if(import.meta.env.PROD&&import.meta.env.MODE!=='standalone')env.fetch=compressedWasmFetch(env.fetch,new URL(wasmUrl,import.meta.url).href);
env.experimental_useCrossOriginStorage=false;
// Opt-in ORT profiling; configure before the first inference session.
if(import.meta.env.VITE_GPU_PROFILE==='1'){
 const gpu=env.backends.onnx.webgpu;
 if(gpu){
  gpu.profiling={mode:'default',ondata:data=>{
   // Only numeric timing and operator metadata; no tensors or transcript.
   console.info('[iscribe:gpu-profile]',JSON.stringify({
    version:data.version,kernelId:data.kernelId,kernelType:data.kernelType,
    kernelName:data.kernelName,programName:data.programName,
    startTime:data.startTime,endTime:data.endTime
   }));
  }};
 }
}
const wasm=env.backends.onnx.wasm;
if(wasm){
 if(import.meta.env.MODE==='standalone'){
  // Use ORT's bundled loader in the classic Worker. A separate module import
  // from a blob:null URL can fail when the HTML is opened from disk.
  wasm.numThreads=1;
  wasm.wasmPaths={wasm:wasmUrl};
 }else{
  wasm.wasmPaths={wasm:wasmUrl,mjs:mjsUrl};
 }
}
// Both ASR and independent speaker hosts send this once before initializing
// models. Speaker backend/dtype remain pinned by the engine's q8/WASM patch.
let threadsConfigured=false;
let preloading=false;
addEventListener('message',(event:MessageEvent<unknown>)=>{
 const data=event.data;
 if(data&&typeof data==='object'&&'type' in data&&data.type==='iscribe:wasm-threads'){
  if(threadsConfigured||!wasm)return;
  threadsConfigured=true;
  const requested=clampWasmRequest('requested' in data?data.requested:undefined);
  const configured=resolveWasmThreads(requested,localWasmThreadEnvironment(import.meta.env.MODE==='standalone'));
  wasm.numThreads=configured;
  postMessage({type:'iscribe:wasm-thread-config',requested,configured});
  return;
 }
 if(import.meta.env.MODE==='standalone'&&wasm&&data&&typeof data==='object'&&
    'type' in data&&data.type==='iscribe:runtime-wasm'&&'binary' in data&&data.binary instanceof ArrayBuffer){
  wasm.wasmBinary=data.binary;
  return;
 }
 if(!data||typeof data!=='object'||!('type' in data)||(data.type!=='iscribe:preload'&&data.type!=='iscribe:speakers')||!('requestId' in data)||typeof data.requestId!=='string')return;
 const requestId=data.requestId;
 if(preloading){postMessage({type:'iscribe:preload-error',requestId,message:'Предварительная загрузка уже выполняется.'});return}
 preloading=true;
 const task=data.type==='iscribe:speakers'
  ? ('audio' in data&&data.audio instanceof Float32Array&&data.audio.length>0&&data.audio.length<=3600*16000
     ? runSpeakerPass(data.audio,(status,percent)=>postMessage({type:'iscribe:speaker-progress',requestId,status,percent})).then(turns=>postMessage({type:'iscribe:speaker-result',requestId,turns}))
     : Promise.reject(new Error('Некорректное аудио для диаризации.')))
  : preloadDiarizationModels(info=>postMessage({type:'iscribe:preload-progress',requestId,...info}));
 void task
  .then(()=>postMessage({type:'iscribe:preload-complete',requestId}))
  .catch((error:unknown)=>postMessage({type:'iscribe:preload-error',requestId,message:error instanceof Error?error.message:String(error)}))
  .finally(()=>{preloading=false});
});
