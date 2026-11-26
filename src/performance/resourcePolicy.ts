import {profiles} from './profiles';
import type {DeviceHints} from './profiler';
import type {PerformanceMode,ResourcePolicy,ResourceObservations} from './types';
const ranks:Record<PerformanceMode,number>={eco:0,medium:1,max:2};
export function resolveResourcePolicy(requested:PerformanceMode,hints:DeviceHints,recoveryCap:PerformanceMode='max'):ResourcePolicy{
 const effective=ranks[requested]>ranks[recoveryCap]?recoveryCap:requested;
 const config=profiles[effective];
 const reasons:ResourcePolicy['reasons']=[];
 if(effective!==requested)reasons.push('recovery-cap');
 const cores=Number.isFinite(hints.logicalProcessors)&&hints.logicalProcessors!>0?Math.floor(hints.logicalProcessors!):1;
 let targetWasmThreads=1;
 if(hints.configuredWasmThreads===1||hints.wasmThreadPrerequisites!==true)reasons.push('thread-prerequisites');
 else{
  if(cores<=1)reasons.push('cpu-hint');
  targetWasmThreads=effective==='eco'?1:Math.max(1,Math.min(8,cores-1,effective==='medium'?Math.floor(cores/2):cores-1));
 }
 let targetPrefetchWindows:0|1|2=config.prefetch;
 const memory=hints.deviceMemoryGiB;
 const cap=memory===null||memory<=4?0:memory<16?1:2;
 if(targetPrefetchWindows>cap){targetPrefetchWindows=cap;reasons.push('memory-hint')}
 return {requested,effective,targetWasmThreads,targetPrefetchWindows,pauseRatio:config.pauseRatio,maxPauseMs:config.maxPauseMs,reasons};
}
export function boundaryPauseMs(policy:ResourcePolicy,previousInferenceMs:number):number{
 if(!Number.isFinite(previousInferenceMs)||previousInferenceMs<=0)return 0;
 return Math.min(policy.maxPauseMs,Math.max(0,Math.round(previousInferenceMs*policy.pauseRatio)));
}
export function observeWindowPolicy(previous:ResourceObservations|undefined,policy:ResourcePolicy):ResourceObservations{
 const windowCounts={eco:0,medium:0,max:0,...previous?.windowCounts};
 const requestedWindowCounts={eco:0,medium:0,max:0,...previous?.requestedWindowCounts};
 windowCounts[policy.effective]++;requestedWindowCounts[policy.requested]++;
 return {version:1,windowCounts,requestedWindowCounts,lastPolicy:policy,pauseCount:previous?.pauseCount??0,pauseMs:previous?.pauseMs??0};
}
export function observeResourcePause(previous:ResourceObservations,ms:number):ResourceObservations{
 return Number.isFinite(ms)&&ms>=0?{...previous,pauseCount:previous.pauseCount+1,pauseMs:previous.pauseMs+ms}:previous;
}
export function resourceReport(value:ResourceObservations|undefined,wasmThreadPolicy=false){
 if(!value)return null;
 const p=value.lastPolicy;
 return {version:1,windowCounts:{eco:value.windowCounts.eco,medium:value.windowCounts.medium,max:value.windowCounts.max},
 requestedWindowCounts:{eco:value.requestedWindowCounts.eco,medium:value.requestedWindowCounts.medium,max:value.requestedWindowCounts.max},
 lastPolicy:{requested:p.requested,effective:p.effective,targetWasmThreads:p.targetWasmThreads,targetPrefetchWindows:p.targetPrefetchWindows,
 pauseRatio:p.pauseRatio,maxPauseMs:p.maxPauseMs,reasons:p.reasons},
 pauseCount:value.pauseCount,pauseMs:Math.round(value.pauseMs*100)/100,
 applied:{boundaryPacing:true,wasmThreadPolicy,prefetchPolicy:false,backendSelectionPolicy:true},
 limitation:'WASM thread policy is confirmed only for observed WASM attempts with a Worker configuration message; prefetch remains a planned target. Counts refer to windows admitted to processing, including interrupted windows. Pause time is observed wall time; not measured CPU/GPU utilization.'};
}
