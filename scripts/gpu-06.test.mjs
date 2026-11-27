import {expect,it} from 'vitest';
import {SAMPLES,syntheticWindow,compareFrames,median} from '../tests/gpu/pyannote-metrics.mjs';
it('creates deterministic bounded PCM windows',()=>{
 expect(syntheticWindow(0)).toEqual(syntheticWindow(0));
 expect(syntheticWindow(1).length).toBe(SAMPLES);
 expect(syntheticWindow(1)[1]).not.toBe(syntheticWindow(2)[1]);
});
it('measures frame agreement and numerical differences',()=>{
 const a=Float32Array.of(1,2,3,4,5,6,7),b=a.slice();
 expect(compareFrames(a,b)).toEqual({frames:1,frameAgreement:1,maxAbs:0,meanAbs:0});
 b[0]=10;
 expect(compareFrames(a,b)).toMatchObject({frameAgreement:0,maxAbs:9});
 b[0]=NaN;
 expect(compareFrames(a,b)).toBeNull();
 expect(compareFrames(a,new Float32Array(2))).toBeNull();
 expect(median([3,1,2])).toBe(2);
 expect(median([Infinity])).toBeNull();
});
