import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import {SAMPLES,CLASSES,RUNS,syntheticWindow,median} from './pyannote-metrics.mjs';
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={wasm:wasmUrl,mjs:mjsUrl};
self.onmessage=async({data})=>{
 let session,stage='initialization',reply;
 const times=[],outputs=[];
 try{
  if(!['wasm','webgpu'].includes(data.backend))throw new Error('Invalid backend');
  const start=performance.now();
  session=await ort.InferenceSession.create(data.model,{executionProviders:[data.backend],preferredOutputLocation:'cpu'});
  const initializationMs=performance.now()-start;
  stage='signature';
  if(session.inputNames.length!==1||session.inputNames[0]!=='input_values'||session.outputNames.length!==1||session.outputNames[0]!=='logits')throw new Error('Unsupported graph signature');
  let warmupMs=null;
  for(let i=0;i<=RUNS;i++){
   stage=i===0?'warmup':'inference';
   const input=new ort.Tensor('float32',syntheticWindow(i),[1,1,SAMPLES]);
   let result;
   try{
    const before=performance.now();
    result=await session.run({input_values:input});
    const logits=await result.logits.getData(),elapsed=performance.now()-before;
    const dims=result.logits.dims;
    if(!(logits instanceof Float32Array)||dims.length!==3||dims[0]!==1||dims[2]!==CLASSES||dims[1]<1||dims[1]>2000||logits.length!==dims[1]*CLASSES||!logits.every(Number.isFinite))throw new Error('Invalid logits');
    if(i===0)warmupMs=elapsed;
    else{times.push(elapsed);outputs.push(logits.slice())}
   }finally{
    try{for(const t of Object.values(result??{}))t.dispose()}finally{input.dispose()}
   }
  }
  reply={summary:{status:'completed',requestedBackend:data.backend,initializationMs,warmupMs,timesMs:times,medianMs:median(times)},outputs};
 }catch(error){
  console.warn('Pyannote lab',stage,error);
  reply={summary:{status:'failed',requestedBackend:data.backend,stage,timesMs:times},outputs:[]};
 }finally{
  try{await session?.release()}catch{reply={summary:{status:'failed',requestedBackend:data.backend,stage:'release'},outputs:[]}}
 }
 self.postMessage(reply,reply.outputs.map(x=>x.buffer));
};
