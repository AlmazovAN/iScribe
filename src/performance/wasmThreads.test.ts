import {expect,it} from 'vitest';
import {resolveWasmThreads,validWasmConfiguration,observeWasmThreads,wasmThreadReport,type WasmThreadEnvironment} from './wasmThreads';
const env:WasmThreadEnvironment={standalone:false,isolated:true,shared:true,atomics:true,logicalProcessors:8};
it('reserves one logical processor and clamps malformed or excessive requests',()=>{
 expect([1,2,4,6,8].map(n=>resolveWasmThreads(n,env))).toEqual([1,2,4,6,7]);
 expect(resolveWasmThreads(8,{...env,logicalProcessors:16})).toBe(8);
 expect(resolveWasmThreads(100,env)).toBe(7);
 for(const n of [0,-1,NaN,Infinity,1.5,'8',undefined])expect(resolveWasmThreads(n,env)).toBe(1);
});
it('falls back to one if any prerequisite is missing',()=>{
 for(const patch of [{standalone:true},{isolated:false},{shared:false},{atomics:false},{logicalProcessors:null},{logicalProcessors:1}]){
  expect(resolveWasmThreads(8,{...env,...patch})).toBe(1);
 }
});
it('validates acknowledgements and exports configuration, not effective thread count',()=>{
 expect(validWasmConfiguration({requested:4,configured:3},4)).toEqual({requested:4,configured:3});
 for(const value of [{requested:8,configured:3},{requested:4,configured:5},{requested:4,configured:0},{requested:4,configured:1.5},null])expect(validWasmConfiguration(value,4)).toBeNull();
 let observed=observeWasmThreads(undefined,{requested:4,configured:3});
 observed=observeWasmThreads(observed,{requested:1,configured:null});
 const report=wasmThreadReport(observed)!;
 expect(report.requestedCounts).toEqual([1,0,0,1,0,0,0,0]);
 expect(report.configuredCounts).toEqual([0,0,1,0,0,0,0,0]);
 expect(report.unconfirmed).toBe(1);expect(report.effectiveThreads).toBeNull();
 expect(wasmThreadReport(undefined)).toBeNull();
});
