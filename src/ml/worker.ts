import {compressedWasmFetch} from './runtimeFetch';
import {env} from '@huggingface/transformers';
import {preloadDiarizationModels} from '@yourdevice/engine/worker';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
// Runtime files are served with the app, not fetched from an unpinned CDN.
env.allowLocalModels=false;
env.useWasmCache=true;
if(import.meta.env.PROD)env.fetch=compressedWasmFetch(env.fetch,new URL(wasmUrl,import.meta.url).href);
env.experimental_useCrossOriginStorage=false;
if(env.backends.onnx.wasm)env.backends.onnx.wasm.wasmPaths={wasm:wasmUrl,mjs:mjsUrl};
let preloading=false;
addEventListener('message',(event:MessageEvent<unknown>)=>{
 const data=event.data;
 if(!data||typeof data!=='object'||!('type' in data)||data.type!=='iscribe:preload'||!('requestId' in data)||typeof data.requestId!=='string')return;
 const requestId=data.requestId;
 if(preloading){postMessage({type:'iscribe:preload-error',requestId,message:'Предварительная загрузка уже выполняется.'});return}
 preloading=true;
 void preloadDiarizationModels(info=>postMessage({type:'iscribe:preload-progress',requestId,...info}))
  .then(()=>postMessage({type:'iscribe:preload-complete',requestId}))
  .catch((error:unknown)=>postMessage({type:'iscribe:preload-error',requestId,message:error instanceof Error?error.message:String(error)}))
  .finally(()=>{preloading=false});
});
