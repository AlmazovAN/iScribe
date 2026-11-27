import {BATCHES,RUNS,compareEmbeddings,parityPassed,selectCandidate} from './wespeaker-metrics.mjs';
const $=id=>document.getElementById(id);
let report=null,cancelled=false,stop=null;
function variant(model,backend,batch,outputName,threads){
 return new Promise(resolve=>{
  let worker,timer,settled=false;
  const finish=value=>{
   if(settled)return;
   settled=true;clearTimeout(timer);worker?.terminate();stop=null;resolve(value);
  };
  const failed=stage=>finish({summary:{status:'failed',requestedBackend:backend,batch,stage},outputs:[]});
  try{
   worker=new Worker(new URL('./wespeaker-lab-worker.mjs',import.meta.url),{type:'module'});
   stop=()=>failed('cancelled');
   worker.onmessage=e=>finish(e.data);
   worker.onerror=()=>failed('worker-error');
   worker.onmessageerror=()=>failed('message-error');
   timer=setTimeout(()=>failed('timeout'),120000);
   const copy=model.slice(0);
   worker.postMessage({backend,batch,outputName,threads,model:copy},[copy]);
  }catch{failed('worker-start')}
 });
}
$('cancel').addEventListener('click',()=>{cancelled=true;stop?.()});
$('run').addEventListener('click',async()=>{
 const file=$('model').files[0],outputName=$('output').value,threads=Number($('threads').value);
 if(!file||!file.size||file.size>64*1024*1024){$('report').textContent='Выберите отдельный ONNX-файл до 64 МБ.';return}
 $('run').disabled=true;$('cancel').disabled=false;$('save').disabled=true;report=null;cancelled=false;
 try{
  const model=await file.arrayBuffer();
  if(cancelled){$('report').textContent='Испытание отменено.';return;}
  $('report').textContent='WASM: пакет 1…';
  const base=await variant(model,'wasm',1,outputName,threads);
  base.summary.repeatability=base.outputs.length===RUNS?base.outputs.map(v=>compareEmbeddings(base.outputs[0],v)):null;
  const variants=[];
  let fallback=null;
  if(base.summary.status==='completed'){
   for(const backend of ['wasm','webgpu']){
    for(const batch of BATCHES){
     if(cancelled)break;
     if(backend==='wasm'&&batch===1)continue;
     $('report').textContent=backend+' · пакет '+batch+'…';
     const result=await variant(model,backend,batch,outputName,threads);
     const parity=result.outputs.length===RUNS?base.outputs.map((v,i)=>compareEmbeddings(v,result.outputs[i])):null;
     const speedup=result.summary.status==='completed'&&result.summary.medianMs>0?base.summary.medianMs/result.summary.medianMs:null;
     variants.push({...result.summary,parity,speedup,candidateForFurtherTesting:!!(parityPassed(parity)&&speedup>=1.1)});
     if(backend==='webgpu'&&batch===1&&result.summary.status==='failed'&&!cancelled)break;
    }
   }
   if(!cancelled&&variants.some(v=>v.requestedBackend==='webgpu'&&v.status==='failed')){
    $('report').textContent='Проверка резервного WASM…';
    const recovered=await variant(model,'wasm',1,outputName);
    fallback={summary:recovered.summary,parity:recovered.outputs.length===RUNS?base.outputs.map((v,i)=>compareEmbeddings(v,recovered.outputs[i])):null};
   }
  }
  report={version:1,modelBytes:file.size,cancelled,requestedWasmThreads:threads,baseline:base.summary,variants,fallback,selection:cancelled?null:selectCandidate(base.summary,variants),
   limitations:'Synthetic filterbank-like inputs, same graph, configured WASM threads are not measured active threads; requested providers only. Fixed [batch,198,80] FP32 input. Batch support depends on actual graph. Cosine agreement is not DER or speaker recognition quality. No physical GPU placement or VRAM measurement. No production changes.'};
  $('report').textContent=JSON.stringify(report,null,2);$('save').disabled=false;
 }catch(error){console.warn('WeSpeaker lab failed',error);$('report').textContent='Эксперимент не завершён. Подробности в DevTools.'}
 finally{$('run').disabled=false;$('cancel').disabled=true}
});
$('save').addEventListener('click',()=>{
 if(!report)return;
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='iscribe-gpu07-wespeaker.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
