// ORT numThreads includes the calling thread. This is configuration, not
// evidence of actual runtime worker counts or CPU usage.
export const MAX_WASM_THREADS=8;
export type WasmThreadEnvironment={standalone:boolean;isolated:boolean;shared:boolean;atomics:boolean;logicalProcessors:number|null};
export type WasmThreadConfiguration={requested:number;configured:number|null};
export type WasmThreadObservations={version:1;last:WasmThreadConfiguration;attempts:number;requestedCounts:number[];configuredCounts:number[];unconfirmed:number};
export function clampWasmRequest(value:unknown):number{
 return typeof value==='number'&&Number.isSafeInteger(value)&&value>=1?Math.min(value,MAX_WASM_THREADS):1;
}
export function resolveWasmThreads(request:unknown,environment:WasmThreadEnvironment):number{
 if(environment.standalone||!environment.isolated||!environment.shared||!environment.atomics)return 1;
 const cores=environment.logicalProcessors;
 if(typeof cores!=='number'||!Number.isFinite(cores)||cores<2)return 1;
 return Math.min(clampWasmRequest(request),Math.max(1,Math.floor(cores)-1));
}
export function localWasmThreadEnvironment(standalone:boolean):WasmThreadEnvironment{
 return {standalone,isolated:typeof crossOriginIsolated==='boolean'&&crossOriginIsolated,
  shared:typeof SharedArrayBuffer==='function',atomics:typeof Atomics!=='undefined',
  logicalProcessors:typeof navigator==='undefined'?null:navigator.hardwareConcurrency};
}
export function validWasmConfiguration(value:unknown,expected:number):WasmThreadConfiguration|null{
 if(!value||typeof value!=='object')return null;
 const v=value as {requested?:unknown;configured?:unknown};
 if(v.requested!==expected||typeof v.configured!=='number'||!Number.isSafeInteger(v.configured)||v.configured<1||v.configured>expected)return null;
 return {requested:expected,configured:v.configured};
}
export function observeWasmThreads(previous:WasmThreadObservations|undefined,configuration:WasmThreadConfiguration):WasmThreadObservations{
 const requested=clampWasmRequest(configuration.requested);
 const configured=validWasmConfiguration(configuration,requested)?.configured??null;
 const requestedCounts=Array.from({length:MAX_WASM_THREADS},(_,i)=>previous?.requestedCounts[i]??0);
 const configuredCounts=Array.from({length:MAX_WASM_THREADS},(_,i)=>previous?.configuredCounts[i]??0);
 requestedCounts[requested-1]++;
 if(configured!==null)configuredCounts[configured-1]++;
 return {version:1,last:{requested,configured},attempts:(previous?.attempts??0)+1,requestedCounts,configuredCounts,
  unconfirmed:(previous?.unconfirmed??0)+(configured===null?1:0)};
}
export function wasmThreadReport(value:WasmThreadObservations|undefined){
 if(!value)return null;
 return {version:1,last:{requested:value.last.requested,configured:value.last.configured},attempts:value.attempts,
  requestedCounts:value.requestedCounts.slice(0,MAX_WASM_THREADS),configuredCounts:value.configuredCounts.slice(0,MAX_WASM_THREADS),
  unconfirmed:value.unconfirmed,effectiveThreads:null,
  limitation:'Counts refer to ASR attempts using reported WASM backend. Configured is the Worker-confirmed value written to ONNX env before initialization; actual ORT thread pool and CPU utilization require independent hardware measurements. Array positions 0–7 mean 1–8 threads.'};
}
