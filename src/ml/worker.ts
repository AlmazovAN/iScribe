import {compressedWasmFetch,validatedModelFetch} from './runtimeFetch';
import {env} from '@huggingface/transformers';
import {preloadDiarizationModels,runSpeakerPass} from '@yourdevice/engine/worker';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
// Runtime files are served with the app, not fetched from an unpinned CDN.
env.allowLocalModels=false;
env.fetch=validatedModelFetch(env.fetch);
env.useWasmCache=true;
if(import.meta.env.PROD)env.fetch=compressedWasmFetch(env.fetch,new URL(wasmUrl,import.meta.url).href);
env.experimental_useCrossOriginStorage=false;
if(env.backends.onnx.wasm)env.backends.onnx.wasm.wasmPaths={wasm:wasmUrl,mjs:mjsUrl};
let preloading=false;
addEventListener('message',(event:MessageEvent<unknown>)=>{
 const data=event.data;
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
