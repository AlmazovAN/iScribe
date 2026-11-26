import {expect,it,vi} from 'vitest';
import {ResourceManager,RESOURCE_MODE_KEY,waitAtBoundary} from './resourceManager';
import {resolveResourcePolicy,boundaryPauseMs,observeWindowPolicy,observeResourcePause,resourceReport} from './resourcePolicy';
import type {DeviceHints} from './profiler';
const device:DeviceHints={logicalProcessors:8,deviceMemoryGiB:8,webGpuApi:true,webNnApi:false,wasmSimd:true,crossOriginIsolated:true,sharedArrayBuffer:true,wasmThreadPrerequisites:true,configuredWasmThreads:null};
it('persists valid modes and tolerates blocked storage',()=>{
 const values=new Map<string,string>();
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)}};
 const a=new ResourceManager(storage,device);
 expect(a.selected).toBe('medium');a.select('max');
 expect(new ResourceManager(storage,device).selected).toBe('max');
 values.set(RESOURCE_MODE_KEY,'invalid');
 expect(new ResourceManager(storage,device).selected).toBe('medium');
 const blocked=new ResourceManager({getItem:()=>{throw new Error('blocked')},setItem:()=>{throw new Error('blocked')}},device);
 blocked.select('eco');expect(blocked.selected).toBe('eco');
});
it('computes conservative targets, not applied threads or buffers',()=>{
 const eco=resolveResourcePolicy('eco',device),medium=resolveResourcePolicy('medium',device),max=resolveResourcePolicy('max',device);
 expect([eco.targetWasmThreads,medium.targetWasmThreads,max.targetWasmThreads]).toEqual([1,4,7]);
 expect([eco.targetPrefetchWindows,medium.targetPrefetchWindows,max.targetPrefetchWindows]).toEqual([0,1,1]);
 expect([eco,medium,max].map(p=>boundaryPauseMs(p,2000))).toEqual([300,60,0]);
 expect(resolveResourcePolicy('max',{...device,configuredWasmThreads:1,deviceMemoryGiB:null})).toMatchObject({targetWasmThreads:1,targetPrefetchWindows:0});
 expect(resolveResourcePolicy('max',{...device,deviceMemoryGiB:16}).targetPrefetchWindows).toBe(2);
 expect(boundaryPauseMs(eco,1e9)).toBe(1000);
 expect(boundaryPauseMs(eco,NaN)).toBe(0);
});
it('recovery caps effective mode within the run without changing persisted selection',()=>{
 const manager=new ResourceManager(null,device);manager.select('max');
 manager.restrictAfterRecovery();expect(manager.policy()).toMatchObject({requested:'max',effective:'medium',reasons:expect.arrayContaining(['recovery-cap'])});
 manager.restrictAfterRecovery();expect(manager.policy().effective).toBe('eco');
 manager.beginRun();expect(manager.policy().effective).toBe('max');
});
it('records requested and effective modes, and distinguishes implemented features',()=>{
 const p=resolveResourcePolicy('max',device,'medium');
 const report=resourceReport(observeResourcePause(observeWindowPolicy(undefined,p),30))!;
 expect(report.requestedWindowCounts.max).toBe(1);expect(report.windowCounts.medium).toBe(1);
 expect(report.pauseMs).toBe(30);expect(report.applied.wasmThreadPolicy).toBe(false);
 expect(resourceReport(undefined)).toBeNull();
});
it('boundary delay is interruptible without waiting for the timer',async()=>{
 vi.useFakeTimers();
 try{
  const c=new AbortController();const wait=waitAtBoundary(1000,c.signal);
  const result=expect(wait).rejects.toBeDefined();c.abort();await result;
  expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers()}
});
