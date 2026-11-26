import {expect,it} from 'vitest';
import {BackendPolicy,candidates,chooseBackend,normalizedText,resourceFailure,type CalibrationSample} from './backendPolicy';
import type {DeviceHints} from './profiler';
const hints:DeviceHints={logicalProcessors:8,deviceMemoryGiB:8,webGpuApi:true,webNnApi:true,wasmSimd:true,crossOriginIsolated:false,sharedArrayBuffer:false,wasmThreadPrerequisites:false,configuredWasmThreads:1};
const sample=(backend:CalibrationSample['backend'],inferenceMs:number,status:CalibrationSample['status']='passed'):CalibrationSample=>({backend,inferenceMs,status,initializationMs:10});
it('compares only matching samples and requires a margin',()=>{
 expect(candidates('wasm',hints)).toEqual(['wasm','webgpu','webnn']);
 expect(candidates('wasm',{...hints,webGpuApi:false,webNnApi:false})).toEqual(['wasm']);
 expect(chooseBackend('wasm',[sample('wasm',100),sample('webgpu',50),sample('webnn',10,'mismatch')])).toBe('webgpu');
 expect(chooseBackend('wasm',[sample('wasm',100),sample('webgpu',95)])).toBe('wasm');
 expect(chooseBackend('wasm',[sample('wasm',100,'empty'),sample('webgpu',10)])).toBe('wasm');
 expect(normalizedText([{start:0,end:1,text:'  Привет   мир '}])).toBe('Привет мир');
});
it('caches choice by model/language/build, invalidates and expires',()=>{
 let now=100;const storageData=new Map<string,string>();
 const storage={getItem:(k:string)=>storageData.get(k)??null,setItem:(k:string,v:string)=>{storageData.set(k,v)}};
 const a=new BackendPolicy(storage,'build1',()=>now);a.remember('whisper-small','ru','webgpu');
 const b=new BackendPolicy(storage,'build1',()=>now);
 expect(b.preferred('whisper-small','ru','max',hints)).toBe('webgpu');
 expect(b.preferred('whisper-small','ru','eco',hints)).toBeUndefined();
 expect(b.preferred('whisper-small','en','max',hints)).toBeUndefined();
 expect(b.preferred('whisper-small','ru','max',{...hints,webGpuApi:false})).toBeUndefined();
 expect(new BackendPolicy(storage,'build2',()=>now).preferred('whisper-small','ru','max',hints)).toBeUndefined();
 b.invalidate('whisper-small','ru','webgpu');expect(b.preferred('whisper-small','ru','max',hints)).toBeUndefined();
 b.remember('whisper-small','ru','wasm');now+=8*24*60*60*1000;
 expect(b.preferred('whisper-small','ru','medium',hints)).toBeUndefined();
 expect(resourceFailure(new Error('out of memory'))).toBe(true);
 expect(resourceFailure(new Error('worker failed'))).toBe(false);
});

it('does not reuse a calibration measured with a different WASM thread target',()=>{
 const policy=new BackendPolicy(null,'build1',()=>100);
 policy.remember('whisper-small','ru','wasm',4);
 expect(policy.preferred('whisper-small','ru','max',hints,4)).toBe('wasm');
 expect(policy.preferred('whisper-small','ru','max',hints,7)).toBeUndefined();
 policy.invalidate('whisper-small','ru','wasm');
 expect(policy.preferred('whisper-small','ru','max',hints,4)).toBeUndefined();
});
