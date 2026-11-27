import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import {MIB,STEPS,validateSize,createAddModel,inputValues,validateOutput,plannedTraffic,median} from './io-binding-model.mjs';

ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={wasm:wasmUrl,mjs:mjsUrl};
const $=id=>document.getElementById(id);
const runs=3;
let report=null;

async function variant(model,bytes,mode){
 const count=validateSize(bytes);
 let session,device,stage='initialization';
 const buffers=[],times=[];
 let warmupMs=null,initializationMs=null;
 let owned=null;
 try{
  const start=performance.now();
  session=await ort.InferenceSession.create(model,{executionProviders:['webgpu'],preferredOutputLocation:mode==='gpu'?'gpu-buffer':'cpu'});
  initializationMs=performance.now()-start;
  device=ort.env.webgpu.device;
  if(!device?.queue)throw new Error('ORT device unavailable');
  if(mode==='fixed'){
   stage='allocation';
   if(bytes>device.limits.maxBufferSize||bytes>device.limits.maxStorageBufferBindingSize)throw new Error('Buffer limit exceeded');
   for(let i=0;i<2;i++)buffers.push(device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}));
   buffers.push(device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));
  }
  const input=inputValues(bytes);
  const fixed=mode==='fixed'?buffers.slice(0,2).map(b=>ort.Tensor.fromGpuBuffer(b,{dataType:'float32',dims:[count]})):null;
  for(let run=0;run<=runs;run++){
   stage=run===0?'warmup':'measured-chain';
   const begin=performance.now();
   let data;
   if(fixed){
    device.queue.writeBuffer(buffers[0],0,input);
    let source=0;
    for(let i=0;i<STEPS;i++){
     const target=1-source;
     const result=await session.run({X:fixed[source]},{Y:fixed[target]});
     if(result.Y.location!=='gpu-buffer'||result.Y.gpuBuffer!==buffers[target]){
      if(result.Y!==fixed[target]&&result.Y!==fixed[source])result.Y.dispose();
      throw new Error('Preallocated output not used');
     }
     source=target;
    }
    const encoder=device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffers[source],0,buffers[2],0,bytes);
    device.queue.submit([encoder.finish()]);
    await buffers[2].mapAsync(GPUMapMode.READ);
    try{data=new Float32Array(buffers[2].getMappedRange()).slice()}finally{buffers[2].unmap()}
   }else{
    owned=new ort.Tensor('float32',input,[count]);
    for(let i=0;i<STEPS;i++){
     const next=(await session.run({X:owned})).Y;
     const previous=owned;owned=next;
     if(previous!==next)previous.dispose();
     if(mode==='gpu'?owned.location!=='gpu-buffer':!['cpu','cpu-pinned'].includes(owned.location))throw new Error('Unexpected output location');
    }
    data=await owned.getData();
   }
   await device.queue.onSubmittedWorkDone();
   const elapsed=performance.now()-begin;
   stage='validation';
   if(!validateOutput(data,bytes))throw new Error('Incorrect chain output');
   owned?.dispose();owned=null;
   if(run===0)warmupMs=elapsed;else times.push(elapsed);
  }
  return {status:'completed',initializationMs,warmupMs,timesMs:times,medianMs:median(times),plannedBoundaryTraffic:plannedTraffic(bytes,mode),
   explicitBufferBytes:mode==='fixed'?3*bytes:null,outputVerified:true};
 }catch(error){
  console.warn('I/O Binding Lab',mode,stage,error);
  return {status:'failed',stage,initializationMs,warmupMs,timesMs:times,medianMs:null,outputVerified:false};
 }finally{
  try{owned?.dispose()}finally{
   try{await session?.release()}finally{for(const buffer of buffers)buffer.destroy()}
  }
 }
}
$('run').addEventListener('click',async()=>{
 $('run').disabled=true;$('save').disabled=true;report=null;
 try{
  const bytes=Number($('size').value)*MIB;
  validateSize(bytes);
  const model=createAddModel(bytes);
  const variants={};
  for(const mode of ['cpu','gpu','fixed']){
   $('report').textContent='Измерение: '+mode+'…';
   variants[mode]=await variant(model,bytes,mode);
  }
  const baseline=variants.cpu;
  const ratios=Object.fromEntries(['gpu','fixed'].map(mode=>[mode,baseline.status==='completed'&&variants[mode].status==='completed'&&baseline.medianMs>0&&variants[mode].medianMs>0?baseline.medianMs/variants[mode].medianMs:null]));
  report={version:1,tensorBytes:bytes,steps:STEPS,runs,variants,speedRatios:ratios,
   limitations:'Synthetic repeated Add graph, not Whisper. Timings include boundary I/O and queue completion; CPU copies and runtime bookkeeping may differ. Planned boundary bytes are logical tensor payloads, not measured physical bus transfers. Explicit GPU allocation bytes exclude ORT and driver allocations. No VRAM, operator placement or end-to-end speedup claim.'};
  $('report').textContent=JSON.stringify(report,null,2);$('save').disabled=false;
 }catch(error){console.warn('I/O Binding Lab failed',error);$('report').textContent='Эксперимент не завершён. Подробности в DevTools.'}
 finally{$('run').disabled=false}
});
$('save').addEventListener('click',()=>{
 if(!report)return;
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='iscribe-gpu05-io-binding.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
