import {expect,it} from 'vitest';
import {addPerfTiming,collectDeviceHints,emptyPerformanceProfile,observeBackend,performanceReport} from './profiler';
it('aggregates only valid samples and retains unavailable metrics as null',()=>{
 let p=emptyPerformanceProfile();
 p=addPerfTiming(p,'streamDecode',10);
 p=addPerfTiming(p,'streamDecode',20);
 p=addPerfTiming(p,'streamDecode',Infinity);
 p=addPerfTiming(p,'streamDecode',-1);
 const r=performanceReport(p)!;
 expect(r.timingsMs.streamDecode).toEqual({count:2,totalMs:30,maxMs:20});
 expect(r.timingsMs.streamResample).toBeNull();
 expect(r.workerTransferMs).toBeNull();
 expect(r.device.effectiveWasmThreads).toBeNull();
 expect(r.device.gpuMemoryBytes).toBeNull();
 expect(performanceReport(undefined)).toBeNull();
});
it('counts actual backend and requested preference separately, sanitizes unknown labels',()=>{
 let p=emptyPerformanceProfile();
 p=observeBackend(p,'webgpu','auto');
 p=observeBackend(p,'wasm','wasm');
 p=observeBackend(p,'private GPU label','private request');
 const r=performanceReport(p)!;
 expect(r.backendAttempts).toEqual({webgpu:1,webnn:0,wasm:1,unknown:1});
 expect(r.requestedBackendAttempts).toEqual({auto:1,wasm:1,webgpu:0,webnn:0,unknown:1});
 expect(JSON.stringify(r)).not.toContain('private');
});
it('device hints are safe to collect without probing models or GPU adapters',()=>{
 const d=collectDeviceHints();
 expect(d.logicalProcessors===null||d.logicalProcessors>0).toBe(true);
 expect(d.deviceMemoryGiB===null||d.deviceMemoryGiB>0).toBe(true);
 expect(d.wasmSimd===null||typeof d.wasmSimd==='boolean').toBe(true);
});

it('does not infer actual operator placement from initialized WebGPU',()=>{
 const p=observeBackend(emptyPerformanceProfile(),'webgpu','webgpu');
 const r=performanceReport(p)!;
 expect(r.backendAttempts.webgpu).toBe(1);
 expect(r.executionEvidence.status).toBe('unverified');
 expect(r.executionEvidence.operatorAssignment).toBeNull();
 expect(r.executionEvidence.gpuKernelEvents).toBeNull();
 expect(r.executionEvidence.cpuFallbackOperators).toBeNull();
 expect(r.executionEvidence.actualAdapter).toBeNull();
});
