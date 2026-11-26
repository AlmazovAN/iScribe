// Privacy-safe observations only. Never probe models, allocate GPU devices,
 // or change execution policy from the profiler.
export const perfTimingKeys=['streamOpen','fullAudioPreparation','streamDecode','streamResample','metadataPersistence','pcmCopy','betweenAsrAttempts','workerRecovery','speakerPass'] as const;
export type PerfTimingKey=typeof perfTimingKeys[number];
export type BackendObservation='webgpu'|'webnn'|'wasm'|'unknown';
export type BackendRequest='auto'|'wasm'|'webgpu'|'webnn'|'unknown';
export type DeviceHints={
 logicalProcessors:number|null;deviceMemoryGiB:number|null;
 webGpuApi:boolean|null;webNnApi:boolean|null;wasmSimd:boolean|null;
 crossOriginIsolated:boolean|null;sharedArrayBuffer:boolean|null;
 wasmThreadPrerequisites:boolean|null;configuredWasmThreads:number|null;
};
type Timing={count:number;totalMs:number;maxMs:number};
export type PerformanceProfile={
 version:1;device:DeviceHints;timings:Partial<Record<PerfTimingKey,Timing>>;
 backendAttempts:Partial<Record<BackendObservation,number>>;
 requestedBackendAttempts:Partial<Record<BackendRequest,number>>;
};
function finitePositive(value:unknown):number|null{
 return typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
}
export function collectDeviceHints():DeviceHints{
 const nav=typeof navigator==='undefined'?null:navigator as Navigator&{deviceMemory?:number;gpu?:unknown;ml?:unknown};
 const isolation=typeof crossOriginIsolated==='boolean'?crossOriginIsolated:null;
 const shared=typeof SharedArrayBuffer==='function';
 let simd:boolean|null=null;
 if(typeof WebAssembly!=='undefined'){
  // Minimal valid module returning v128.const; validation does not run code.
  try{simd=WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,...Array<number>(16).fill(0),11]))}catch{/* Unknown. */}
 }
 return {logicalProcessors:finitePositive(nav?.hardwareConcurrency),deviceMemoryGiB:finitePositive(nav?.deviceMemory),
  webGpuApi:nav?Boolean(nav.gpu):null,webNnApi:nav?Boolean(nav.ml):null,wasmSimd:simd,
  crossOriginIsolated:isolation,sharedArrayBuffer:shared,
  wasmThreadPrerequisites:isolation===null?null:isolation&&shared&&typeof Atomics!=='undefined',
  configuredWasmThreads:import.meta.env.MODE==='standalone'?1:null};
}
export function emptyPerformanceProfile(device:DeviceHints=collectDeviceHints()):PerformanceProfile{
 return {version:1,device,timings:{},backendAttempts:{},requestedBackendAttempts:{}};
}
export function addPerfTiming(profile:PerformanceProfile,key:PerfTimingKey,ms:number):PerformanceProfile{
 if(!Number.isFinite(ms)||ms<0)return profile;
 const prev=profile.timings[key]??{count:0,totalMs:0,maxMs:0};
 return {...profile,timings:{...profile.timings,[key]:{count:prev.count+1,totalMs:prev.totalMs+ms,maxMs:Math.max(prev.maxMs,ms)}}};
}
export function observeBackend(profile:PerformanceProfile,actual:unknown,requested:unknown):PerformanceProfile{
 const backend:BackendObservation=actual==='webgpu'||actual==='webnn'||actual==='wasm'?actual:'unknown';
 const request:BackendRequest=requested==='auto'||requested==='wasm'||requested==='webgpu'||requested==='webnn'?requested:'unknown';
 return {...profile,backendAttempts:{...profile.backendAttempts,[backend]:(profile.backendAttempts[backend]??0)+1},
  requestedBackendAttempts:{...profile.requestedBackendAttempts,[request]:(profile.requestedBackendAttempts[request]??0)+1}};
}
function numeric(value:unknown):number|null{
 return typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.round(value*100)/100:null;
}
function bool(value:unknown):boolean|null{return typeof value==='boolean'?value:null}
export function performanceReport(profile:PerformanceProfile|undefined){
 if(!profile)return null;
 const d=profile.device;
 return {version:1,device:{logicalProcessors:numeric(d.logicalProcessors),deviceMemoryGiB:numeric(d.deviceMemoryGiB),
  webGpuApi:bool(d.webGpuApi),webNnApi:bool(d.webNnApi),wasmSimd:bool(d.wasmSimd),
  crossOriginIsolated:bool(d.crossOriginIsolated),sharedArrayBuffer:bool(d.sharedArrayBuffer),
  wasmThreadPrerequisites:bool(d.wasmThreadPrerequisites),configuredWasmThreads:numeric(d.configuredWasmThreads),
  effectiveWasmThreads:null,cpuUtilizationPercent:null,gpuUtilizationPercent:null,systemRamBytes:null,gpuMemoryBytes:null},
  timingsMs:Object.fromEntries(perfTimingKeys.map(key=>{const t=profile.timings[key];return [key,t?{count:numeric(t.count),totalMs:numeric(t.totalMs),maxMs:numeric(t.maxMs)}:null]})),
  backendAttempts:{webgpu:numeric(profile.backendAttempts.webgpu??0),webnn:numeric(profile.backendAttempts.webnn??0),wasm:numeric(profile.backendAttempts.wasm??0),unknown:numeric(profile.backendAttempts.unknown??0)},
  requestedBackendAttempts:{auto:numeric(profile.requestedBackendAttempts.auto??0),wasm:numeric(profile.requestedBackendAttempts.wasm??0),webgpu:numeric(profile.requestedBackendAttempts.webgpu??0),webnn:numeric(profile.requestedBackendAttempts.webnn??0),unknown:numeric(profile.requestedBackendAttempts.unknown??0)},
  workerTransferMs:null,
  limitations:['Device hints describe the first profiled run; API presence is not adapter or model compatibility.',
   'WASM thread prerequisites and configured threads are not measured effective threads. Device memory is a coarse browser hint, not free RAM.',
   'Timings are cumulative observed wall-clock intervals, may overlap, and exclude work not instrumented. Stream decoder callbacks may include logging waits. Full audio preparation is not separable into decode and resample.',
   'PCM copy is host-side only; transfer time and GPU kernel time are unavailable. Between-attempt time is a host-observed gap, not GPU utilization.',
   'Metadata persistence covers selected critical-path writes, not all IndexedDB transactions. The profiler does not modify checkpoint semantics.',
   'Backend counts record attempted ASR calls, not successful windows. Legacy runs before PERF-01 have no profiler observations.']};
}
