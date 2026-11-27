// Development-only lab. No production decoder settings are changed.
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';

ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={wasm:wasmUrl,mjs:mjsUrl};
const presets={tiny:[4,6,384],small:[12,12,768],large:[32,20,1280]};
const steps=8, runs=3, audioFrames=1500, headSize=64;
const $=id=>document.getElementById(id);
let report=null;

function cacheNames(inputs,outputs,layers){
 const pairs=[];
 for(let i=0;i<layers;i++)for(const part of ['decoder','encoder'])for(const kind of ['key','value']){
  const suffix=i+'.'+part+'.'+kind;
  const input='past_key_values.'+suffix, output='present.'+suffix;
  if(!inputs.includes(input)||!outputs.includes(output))throw new Error('Unsupported KV signature');
  pairs.push({input,output,part});
 }
 return pairs;
}
function median(values){
 const sorted=[...values].sort((a,b)=>a-b);
 return sorted[Math.floor(sorted.length/2)];
}
function argmax(values){
 let index=0;
 for(let i=1;i<values.length;i++)if(values[i]>values[index])index=i;
 return index;
}
function compareLogits(a,b){
 if(!a.length||a.length!==b.length)return {passed:false,maxAbs:null,argmaxEqual:false};
 let maxAbs=0,passed=true;
 for(let i=0;i<a.length;i++){
  if(!Number.isFinite(a[i])||!Number.isFinite(b[i]))return {passed:false,maxAbs:null,argmaxEqual:false};
  const diff=Math.abs(a[i]-b[i]);maxAbs=Math.max(maxAbs,diff);
  if(diff>0.001+0.001*Math.abs(a[i]))passed=false;
 }
 const argmaxEqual=argmax(a)===argmax(b);
 return {passed:passed&&argmaxEqual,maxAbs,argmaxEqual};
}
function hiddenFeatures(hidden){
 const values=new Float32Array(audioFrames*hidden);
 for(let i=0;i<values.length;i++)values[i]=0.1*Math.sin(i*0.017)+0.05*Math.cos(i*0.007);
 return values;
}
function cacheLength(tensor,heads){
 const dims=tensor.dims;
 if(dims.length!==4||dims[0]!==1||dims[1]!==heads||dims[3]!==headSize||tensor.type!=='float32')
  throw new Error('Unsupported cache dtype/shape');
 return dims[2];
}
function nonemptyLocationOK(location,gpu){
 return gpu?location==='gpu-buffer':location==='cpu'||location==='cpu-pinned';
}
function fixedToken(step){
 // Teacher-forced synthetic token IDs, not generated speech or a transcript.
 return BigInt(step===0?50258:100+step);
}
async function runVariant(bytes,layers,heads,hidden,gpu){
 let session,stage='initialization';
 const times=[],allLogits=[],locations=new Set();
 try{
  const outputs=['logits'];
  for(let i=0;i<layers;i++)for(const part of ['decoder','encoder'])for(const kind of ['key','value'])
   outputs.push('present.'+i+'.'+part+'.'+kind);
  const preferredOutputLocation=Object.fromEntries(outputs.map(n=>[n,n==='logits'||!gpu?'cpu':'gpu-buffer']));
  const started=performance.now();
  session=await ort.InferenceSession.create(bytes,{executionProviders:['webgpu'],preferredOutputLocation});
  const initializationMs=performance.now()-started;
  stage='signature';
  const pairs=cacheNames(session.inputNames,session.outputNames,layers);
  const idName=session.inputNames.includes('input_ids')?'input_ids':'decoder_input_ids';
  const expected=[idName,'encoder_hidden_states','use_cache_branch',...pairs.map(p=>p.input)];
  if(session.inputNames.length!==expected.length||!expected.every(n=>session.inputNames.includes(n))||
   session.outputNames.length!==outputs.length||!outputs.every(n=>session.outputNames.includes(n)))throw new Error('Unsupported merged decoder signature');
  const device=ort.env.webgpu.device;
  if(!device?.queue)throw new Error('ORT device unavailable');
  const states=hiddenFeatures(hidden);
  let warmupMs=null;
  for(let run=0;run<=runs;run++){
   const owned=new Set();
   const own=t=>{owned.add(t);return t};
   const drop=t=>{if(owned.delete(t))t.dispose()};
   const cache=new Map();
   const stepLogits=[];
   let elapsed=0;
   try{
    stage='initial-cache';
    const encoder=own(new ort.Tensor('float32',states,[1,audioFrames,hidden]));
    for(const p of pairs)cache.set(p.input,own(new ort.Tensor('float32',new Float32Array(0),[1,heads,0,headSize])));
    for(let step=0;step<steps;step++){
     stage=run===0?'warmup':'measured-step';
     const ids=own(new ort.Tensor('int64',BigInt64Array.of(fixedToken(step)),[1,1]));
     const branch=own(new ort.Tensor('bool',Uint8Array.of(step===0?0:1),[1]));
     const feeds=Object.fromEntries(cache);
     feeds[idName]=ids;feeds.encoder_hidden_states=encoder;feeds.use_cache_branch=branch;
     const begin=performance.now();
     const result=await session.run(feeds);
     for(const t of Object.values(result))own(t);
     await device.queue.onSubmittedWorkDone();
     const logits=await result.logits.getData();
     elapsed+=performance.now()-begin;
     stage='validate-cache';
     if(!(logits instanceof Float32Array)||!logits.length||!logits.every(Number.isFinite))throw new Error('Invalid FP32 logits');
     if(run!==0)stepLogits.push(logits.slice());
     drop(result.logits);drop(ids);drop(branch);
     for(const p of pairs){
      const next=result[p.output],old=cache.get(p.input);
      const length=cacheLength(next,heads);
      // A merged graph may emit an empty cross-attention placeholder
      // when the already computed cross-attention cache is reused.
      if(p.part==='encoder'&&step>0&&length===0){drop(next);continue}
      const expectedLength=p.part==='encoder'?audioFrames:step+1;
      if(length!==expectedLength||!nonemptyLocationOK(next.location,gpu))throw new Error('Cache shape/location mismatch');
      locations.add(next.location);
      if(next!==old){cache.set(p.input,next);drop(old)}
     }
    }
    if(run===0)warmupMs=elapsed;
    else{times.push(elapsed);allLogits.push(stepLogits)}
   }finally{
    for(const t of owned){try{t.dispose()}catch{/* Dispose remaining tensors even after one failure. */}}
   }
  }
  const medianMs=median(times);
  return {summary:{status:'completed',initializationMs,warmupMs,timesMs:times,medianMs,
    stepsPerSecond:medianMs>0?steps*1000/medianMs:null,cacheLocations:[...locations]},logits:allLogits};
 }catch(error){
  console.warn('Decoder Lab:',stage,error);
  return {summary:{status:'failed',stage,timesMs:times,cacheLocations:[...locations]},logits:[]};
 }finally{if(session)await session.release()}
}
$('run').addEventListener('click',async()=>{
 const file=$('model').files[0],preset=$('preset').value;
 if(!file||!file.size||file.size>512*1024*1024){$('report').textContent='Выберите отдельный ONNX-файл до 512 МБ.';return}
 $('run').disabled=true;$('save').disabled=true;report=null;
 try{
  const [layers,heads,hidden]=presets[preset];
  const bytes=new Uint8Array(await file.arrayBuffer());
  $('report').textContent='WebGPU с CPU cache: измерение…';
  const baseline=await runVariant(bytes,layers,heads,hidden,false);
  $('report').textContent='WebGPU с GPU cache: измерение…';
  const candidate=baseline.summary.status==='completed'?await runVariant(bytes,layers,heads,hidden,true):{summary:{status:'not-tested'},logits:[]};
  const comparable=baseline.logits.length===runs&&candidate.logits.length===runs;
  const parity=comparable?baseline.logits.flatMap((run,i)=>run.map((v,j)=>compareLogits(v,candidate.logits[i][j]))):null;
  const speedup=comparable&&candidate.summary.medianMs>0?baseline.summary.medianMs/candidate.summary.medianMs:null;
  report={version:1,preset,modelBytes:file.size,steps,runs,baseline:baseline.summary,gpuCache:candidate.summary,parity,speedup,
   candidateForFurtherTesting:!!(parity?.every(x=>x.passed)&&speedup>=1.1),
   limitations:'Synthetic encoder features and teacher-forced IDs. FP32 merged decoder only. Both variants request WebGPU; logits returned to CPU; timings include session.run, queue completion and logits availability. Steps/s is not end-to-end generated tokens/s. No WER, VRAM or operator-placement measurement.'};
  $('report').textContent=JSON.stringify(report,null,2);$('save').disabled=false;
 }catch(error){console.warn('Decoder Lab failed',error);$('report').textContent='Эксперимент не завершён. Подробности в DevTools.'}
 finally{$('run').disabled=false}
});
$('save').addEventListener('click',()=>{
 if(!report)return;
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='iscribe-gpu04-decoder.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
