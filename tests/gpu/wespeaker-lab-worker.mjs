import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import {ITEMS,FRAMES,MELS,RUNS,BATCHES,features,median} from './wespeaker-metrics.mjs';
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={wasm:wasmUrl,mjs:mjsUrl};
self.onmessage=async({data})=>{
 let session,stage='initialization',reply;
 const times=[],outputs=[];
 try{
  const {backend,batch,threads}=data;
  if(![1,2,4,8].includes(threads))throw new Error('Invalid thread configuration');
  const configuredWasmThreads=backend==='wasm'&&self.crossOriginIsolated===true&&typeof SharedArrayBuffer==='function'?Math.min(threads,Math.max(1,navigator.hardwareConcurrency||1)):1;
  ort.env.wasm.numThreads=configuredWasmThreads;
  if(!['wasm','webgpu'].includes(backend)||!BATCHES.includes(batch))throw new Error('Invalid variant');
  const start=performance.now();
  session=await ort.InferenceSession.create(data.model,{executionProviders:[backend],preferredOutputLocation:'cpu'});
  const initializationMs=performance.now()-start;
  stage='signature';
  if(session.inputNames.length!==1)throw new Error('Unsupported inputs');
  const inputName=session.inputNames[0];
  const outputName=data.outputName.trim()|| (session.outputNames.length===1?session.outputNames[0]:null);
  if(!outputName||!session.outputNames.includes(outputName))throw new Error('Select the actual embedding output name');
  let warmupMs=null,embeddingSize=null;
  for(let run=0;run<=RUNS;run++){
   const runOutputs=[];let elapsed=0;
   for(let i=0;i<ITEMS;i+=batch){
    stage=run===0?'warmup':'inference';
    const input=new ort.Tensor('float32',features(i,batch),[batch,FRAMES,MELS]);
    let result;
    try{
     const before=performance.now();
     result=await session.run({[inputName]:input},[outputName]);
     const tensor=result[outputName],vector=await tensor.getData();
     elapsed+=performance.now()-before;
     const dims=tensor.dims;
     if(!(vector instanceof Float32Array)||dims.length!==2||dims[0]!==batch||dims[1]<1||dims[1]>4096||vector.length!==batch*dims[1]||!vector.every(Number.isFinite))throw new Error('Expected [batch, embedding_size] FP32 output');
     if(embeddingSize!==null&&embeddingSize!==dims[1])throw new Error('Embedding size changed');
     embeddingSize=dims[1];
     for(let row=0;row<batch;row++)runOutputs.push(vector.slice(row*embeddingSize,(row+1)*embeddingSize));
    }finally{
     try{for(const t of Object.values(result??{}))t.dispose()}finally{input.dispose()}
    }
   }
   if(run===0)warmupMs=elapsed;
   else{times.push(elapsed);outputs.push(runOutputs)}
  }
  const medianMs=median(times);
  reply={summary:{status:'completed',requestedBackend:backend,batch,configuredWasmThreads,embeddingSize,initializationMs,warmupMs,timesMs:times,medianMs,embeddingsPerSecond:medianMs>0?ITEMS*1000/medianMs:null},outputs};
 }catch(error){
  console.warn('WeSpeaker lab',stage,error);
  reply={summary:{status:'failed',requestedBackend:data.backend,batch:data.batch,stage,timesMs:times},outputs:[]};
 }finally{
  try{await session?.release()}catch{reply={summary:{status:'failed',requestedBackend:data.backend,batch:data.batch,stage:'release'},outputs:[]}}
 }
 self.postMessage(reply,reply.outputs.flat().map(x=>x.buffer));
};
