import {expect,it} from 'vitest';
import {MIB,STEPS,validateSize,createAddModel,inputValues,validateOutput,plannedTraffic,median} from '../tests/gpu/io-binding-model.mjs';
it('bounds tensor size and creates a deterministic small ONNX payload',()=>{
 expect(validateSize(MIB)).toBe(262144);
 expect(()=>validateSize(2*MIB)).toThrow();
 expect(createAddModel(MIB)).toEqual(createAddModel(MIB));
 expect(createAddModel(MIB).length).toBeLessThan(256);
 expect(createAddModel(MIB)).not.toEqual(createAddModel(4*MIB));
});
it('accounts for logical payloads without claiming bus measurements',()=>{
 expect(plannedTraffic(MIB,'cpu').totalBytes).toBe(16*MIB);
 expect(plannedTraffic(MIB,'gpu').totalBytes).toBe(2*MIB);
 expect(plannedTraffic(MIB,'fixed').totalBytes).toBe(2*MIB);
 expect(()=>plannedTraffic(MIB,'unknown')).toThrow();
});
it('validates every output element and rejects nonfinite values',()=>{
 const data=inputValues(MIB);
 for(let i=0;i<data.length;i++)data[i]*=2**STEPS;
 expect(validateOutput(data,MIB)).toBe(true);
 data[5]=NaN;
 expect(validateOutput(data,MIB)).toBe(false);
 expect(validateOutput(new Float32Array(2),MIB)).toBe(false);
 expect(median([5,1,3])).toBe(3);
 expect(median([2,4])).toBe(3);
 expect(median([Infinity])).toBeNull();
});
