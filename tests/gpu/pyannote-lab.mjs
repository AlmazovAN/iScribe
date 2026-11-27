import {RUNS,compareFrames} from './pyannote-metrics.mjs';
const $=id=>document.getElementById(id);
let report=null;
function variant(model,backend){
 return new Promise(resolve=>{
  let worker,timer,settled=false;
  const finish=value=>{
   if(settled)return;
   settled=true;clearTimeout(timer);worker?.terminate();resolve(value);
  };
  const failed=stage=>finish({summary:{status:'failed',requestedBackend:backend,stage},outputs:[]});
  try{
   worker=new Worker(new URL('./pyannote-lab-worker.mjs',import.meta.url),{type:'module'});
   worker.onmessage=e=>finish(e.data);
   worker.onerror=()=>failed('worker-error');
   worker.onmessageerror=()=>failed('message-error');
   timer=setTimeout(()=>failed('timeout'),120000);
   const copy=model.slice(0);
   worker.postMessage({backend,model:copy},[copy]);
  }catch{failed('worker-start')}
 });
}
$('run').addEventListener('click',async()=>{
 const file=$('model').files[0];
 if(!file||!file.size||file.size>64*1024*1024){$('report').textContent='Выберите отдельный ONNX-файл до 64 МБ.';return}
 $('run').disabled=true;$('save').disabled=true;report=null;
 try{
  const model=await file.arrayBuffer();
  $('report').textContent='WASM: исходный вариант…';
  const base=await variant(model,'wasm');
  $('report').textContent='WebGPU: эксперимент…';
  const gpu=base.summary.status==='completed'?await variant(model,'webgpu'):{summary:{status:'not-tested'},outputs:[]};
  const comparable=base.outputs.length===RUNS&&gpu.outputs.length===RUNS;
  const parity=comparable?base.outputs.map((v,i)=>compareFrames(v,gpu.outputs[i])):null;
  const speedup=comparable&&gpu.summary.medianMs>0?base.summary.medianMs/gpu.summary.medianMs:null;
  let fallback=null;
  if(gpu.summary.status==='failed'){
   $('report').textContent='Проверка резервного WASM после ошибки WebGPU…';
   const recovered=await variant(model,'wasm');
   fallback={summary:recovered.summary,parity:recovered.outputs.length===RUNS?base.outputs.map((v,i)=>compareFrames(v,recovered.outputs[i])):null};
  }
  report={version:1,modelBytes:file.size,windows:RUNS,windowSeconds:10,wasm:base.summary,webgpu:gpu.summary,parity,speedup,fallback,
   candidateForFurtherTesting:!!(parity?.every(x=>x&&x.frameAgreement>=0.99&&x.meanAbs<=0.01)&&speedup>=1.1),
   limitations:'Synthetic PCM, same local graph, one WASM thread, requested providers only. No proof of GPU operator placement. Frame agreement is not DER or real speech quality. Thresholds are preliminary. Fallback is a lab-only independent worker restart.'};
  $('report').textContent=JSON.stringify(report,null,2);$('save').disabled=false;
 }catch(error){console.warn('Pyannote lab failed',error);$('report').textContent='Эксперимент не завершён. Подробности в DevTools.'}
 finally{$('run').disabled=false}
});
$('save').addEventListener('click',()=>{
 if(!report)return;
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='iscribe-gpu06-pyannote.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
