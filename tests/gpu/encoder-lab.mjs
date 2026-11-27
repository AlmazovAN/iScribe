import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';

ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={wasm:wasmUrl,mjs:mjsUrl};
const presets={tiny:[80,384],small:[80,768],large:[128,1280]};
const runs=3;
const $=id=>document.getElementById(id);
let report=null;

function median(values){
 const sorted=[...values].sort((a,b)=>a-b);
 return sorted[Math.floor(sorted.length/2)];
}
function features(size,index){
 const values=new Float32Array(size);
 for(let i=0;i<size;i++)values[i]=Math.sin(i*0.019+index*0.7)*0.4+Math.cos(i*0.007+index)*0.2;
 return values;
}
function compare(a,b){
 if(a.length!==b.length)return {passed:false,maxAbs:null};
 let maxAbs=0,passed=true;
 for(let i=0;i<a.length;i++){
  const diff=Math.abs(a[i]-b[i]);
  if(!Number.isFinite(a[i])||!Number.isFinite(b[i]))return {passed:false,maxAbs:null};
  maxAbs=Math.max(maxAbs,diff);
  if(diff>0.001+0.001*Math.abs(a[i]))passed=false;
 }
 return {passed,maxAbs};
}
async function runVariant(bytes,mel,hidden,capture){
 let session,inputBuffer,outputBuffer,staging;
 const inputDims=[1,mel,3000],outputDims=[1,1500,hidden];
 const inputBytes=mel*3000*4,outputBytes=1500*hidden*4;
 const times=[],outputs=[];
 let stage='initialization';
 try{
  const started=performance.now();
  session=await ort.InferenceSession.create(bytes,{executionProviders:['webgpu'],enableGraphCapture:capture});
  const initializationMs=performance.now()-started;
  stage='model-shape';
  if(session.inputNames.length!==1||session.inputNames[0]!=='input_features'||session.outputNames.length!==1||session.outputNames[0]!=='last_hidden_state')throw new Error('Unsupported encoder signature');
  const device=ort.env.webgpu.device;
  if(!device)throw new Error('ORT device unavailable');
  stage='buffers';
  inputBuffer=device.createBuffer({size:Math.ceil(inputBytes/16)*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
  outputBuffer=device.createBuffer({size:Math.ceil(outputBytes/16)*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
  staging=device.createBuffer({size:outputBytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const input=ort.Tensor.fromGpuBuffer(inputBuffer,{dataType:'float32',dims:inputDims});
  const output=ort.Tensor.fromGpuBuffer(outputBuffer,{dataType:'float32',dims:outputDims});
  let warmupMs=null;
  for(let i=0;i<=runs;i++){
   stage=i===0?'warmup':'measured-run';
   const data=features(mel*3000,i);
   const start=performance.now();
   device.queue.writeBuffer(inputBuffer,0,data);
   const result=await session.run({input_features:input},{last_hidden_state:output});
   if(result.last_hidden_state?.gpuBuffer!==outputBuffer)throw new Error('Output binding not honored');
   await device.queue.onSubmittedWorkDone();
   const elapsed=performance.now()-start;
   if(i===0){warmupMs=elapsed;continue}
   times.push(elapsed);
   stage='readback';
   const encoder=device.createCommandEncoder();
   encoder.copyBufferToBuffer(outputBuffer,0,staging,0,outputBytes);
   device.queue.submit([encoder.finish()]);
   await staging.mapAsync(GPUMapMode.READ);
   try{outputs.push(new Float32Array(staging.getMappedRange()).slice())}finally{staging.unmap()}
  }
  return {summary:{status:'completed',initializationMs,warmupMs,timesMs:times,medianMs:median(times)},outputs};
 }catch(error){
  console.warn('Encoder Lab:',stage,error);
  return {summary:{status:'failed',stage,timesMs:times},outputs:[]};
 }finally{
  try{await session?.release()}finally{staging?.destroy();outputBuffer?.destroy();inputBuffer?.destroy()}
 }
}

$('run').addEventListener('click',async()=>{
 const file=$('model').files[0],preset=$('preset').value;
 if(!file||file.size===0||file.size>512*1024*1024){$('report').textContent='Выберите отдельный ONNX-файл размером до 512 МБ.';return}
 $('run').disabled=true;$('save').disabled=true;report=null;
 try{
  const [mel,hidden]=presets[preset];
  const bytes=new Uint8Array(await file.arrayBuffer());
  $('report').textContent='Обычный WebGPU: загрузка и измерения…';
  const base=await runVariant(bytes,mel,hidden,false);
  $('report').textContent='Graph Capture: загрузка и измерения…';
  const candidate=base.summary.status==='completed'?await runVariant(bytes,mel,hidden,true):{summary:{status:'not-tested'},outputs:[]};
  const comparable=base.outputs.length===runs&&candidate.outputs.length===runs;
  const parity=comparable?base.outputs.map((output,i)=>compare(output,candidate.outputs[i])):null;
  const baselineResponds=comparable?base.outputs[0].some((value,i)=>Math.abs(value-base.outputs[1][i])>0.001):null;
  const speedup=comparable&&candidate.summary.medianMs>0?base.summary.medianMs/candidate.summary.medianMs:null;
  report={version:1,preset,modelBytes:file.size,inputDims:[1,mel,3000],outputDims:[1,1500,hidden],
   baseline:base.summary,capture:candidate.summary,parity,baselineResponds,speedup,
   candidateForFurtherTesting:!!(parity?.every(x=>x.passed)&&baselineResponds&&speedup>=1.1),
   limitations:'Synthetic features; float32 I/O; one model; one warm-up and three runs per variant; timings include input upload and queue completion, exclude readback. No WER, end-to-end speedup, GPU utilization or production acceptance.'};
  $('report').textContent=JSON.stringify(report,null,2);$('save').disabled=false;
 }catch(error){console.warn('Encoder Lab failed',error);$('report').textContent='Эксперимент не завершён. Подробности в DevTools.'}
 finally{$('run').disabled=false}
});
$('save').addEventListener('click',()=>{
 if(!report)return;
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='iscribe-gpu03-encoder.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
