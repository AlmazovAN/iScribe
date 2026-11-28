import {compressedWasmFetch,validatedModelFetch,observedWhisperHttpFetch,offlineModelFetch} from './runtimeFetch';
import {env} from '@huggingface/transformers';
import {SileroPass} from './sileroVad';
import {Wav2VecAlignment} from './wav2vecAlignment';
import {ALIGNMENT_MAX_SAMPLES} from './forcedAlignment';
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

// The VAD host uses a dedicated instance of this existing bundled Worker.
// No new worker asset or extra ONNX runtime version.
let vadPass:SileroPass|undefined,vadBusy=false,vadId:string|undefined;
addEventListener('message',(event:MessageEvent<unknown>)=>{
 const d=event.data;
 if(!d||typeof d!=='object'||!('type' in d)||!('requestId' in d)||typeof d.requestId!=='string')return;
 if(d.type!=='iscribe:vad-start'&&d.type!=='iscribe:vad-block')return;
 const requestId=d.requestId;
 if(vadBusy){postMessage({type:'iscribe:vad-error',requestId});return}
 vadBusy=true;
 void (async()=>{
  if(d.type==='iscribe:vad-start'){
   if(vadPass||vadId!==undefined||!('samples' in d)||typeof d.samples!=='number')throw new Error('Invalid VAD start');
   vadId=requestId;
   vadPass=await SileroPass.create(d.samples,async()=>{
    if(!wasm)throw new Error('Missing local WASM runtime');
    // Standalone receives the verified embedded binary from the parent.
    // Web production uses the existing compressed-runtime transport.
    if(import.meta.env.MODE!=='standalone'){
     const response=await env.fetch(new URL(wasmUrl,import.meta.url).href);
     if(!response.ok)throw new Error('Local WASM unavailable');
     wasm.wasmBinary=await response.arrayBuffer();
    }
   });
   postMessage({type:'iscribe:vad-ready',requestId});return;
  }
  if(!vadPass||vadId!==requestId||!('audio' in d)||!(d.audio instanceof Float32Array)||!('final' in d)||typeof d.final!=='boolean')throw new Error('Invalid VAD block');
  await vadPass.push(d.audio,()=>postMessage({type:'iscribe:vad-progress',requestId}));
  if(d.final){
   const report=await vadPass.finish();
   await vadPass.release();vadPass=undefined;
   postMessage({type:'iscribe:vad-result',requestId,report});
  }else postMessage({type:'iscribe:vad-next',requestId});
 })().catch(()=>{
  // Do not export arbitrary runtime errors or source content.
  postMessage({type:'iscribe:vad-error',requestId});
 }).finally(()=>{vadBusy=false});
});

// Dedicated instance of the same bundled Worker; one model and one slice at a time.
let alignPass:Wav2VecAlignment|undefined,alignBusy=false,alignId:string|undefined;
addEventListener('message',(event:MessageEvent<unknown>)=>{
 const d=event.data;
 if(!d||typeof d!=='object'||!('type' in d)||!('requestId' in d)||typeof d.requestId!=='string')return;
 if(d.type!=='iscribe:align-start'&&d.type!=='iscribe:align-segment'&&d.type!=='iscribe:align-finish')return;
 const requestId=d.requestId;
 if(alignBusy){postMessage({type:'iscribe:align-error',requestId});return}
 alignBusy=true;
 void (async()=>{
  if(d.type==='iscribe:align-start'){
   if(alignId!==undefined||!('language' in d)||(d.language!=='ru'&&d.language!=='en')||!wasm)throw new Error('Invalid alignment start');
   alignId=requestId;wasm.numThreads=1;wasm.proxy=false;
   alignPass=await Wav2VecAlignment.create(d.language,()=>postMessage({type:'iscribe:align-progress',requestId}));
   postMessage({type:'iscribe:align-ready',requestId});return;
  }
  if(!alignPass||alignId!==requestId)throw new Error('Invalid alignment session');
  if(d.type==='iscribe:align-finish'){
   await alignPass.release();alignPass=undefined;
   postMessage({type:'iscribe:align-finished',requestId});return;
  }
  if(!('audio' in d)||!(d.audio instanceof Float32Array)||d.audio.length>ALIGNMENT_MAX_SAMPLES||
   !('text' in d)||typeof d.text!=='string'||d.text.length>4096||!('startSample' in d)||typeof d.startSample!=='number'||
   !('index' in d)||typeof d.index!=='number'||!Number.isSafeInteger(d.index)||d.index<0)throw new Error('Invalid alignment slice');
  const words=await alignPass.align(d.audio,d.text,d.startSample);
  postMessage({type:'iscribe:align-result',requestId,index:d.index,words});
 })().catch(()=>postMessage({type:'iscribe:align-error',requestId})).finally(()=>{alignBusy=false});
});
