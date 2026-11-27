import {expect,it} from 'vitest';
import {ITEMS,FRAMES,MELS,features,cosine,compareEmbeddings,median,parityPassed,selectCandidate} from '../tests/gpu/wespeaker-metrics.mjs';
it('creates identical input features regardless of batch grouping',()=>{
 expect(features(0,8).length).toBe(ITEMS*FRAMES*MELS);
 expect(features(0,2).slice(FRAMES*MELS)).toEqual(features(1,1));
 expect(()=>features(7,2)).toThrow();
});
it('validates cosine and pairwise geometry',()=>{
 expect(cosine([1,0],[1,0])).toBe(1);
 expect(cosine([1,0],[0,1])).toBe(0);
 expect(cosine([1,0],[-1,0])).toBe(-1);
 expect(cosine([0,0],[1,0])).toBeNull();
 expect(cosine([NaN],[1])).toBeNull();
 const a=Array.from({length:ITEMS},(_,i)=>[1,i+1]);
 expect(compareEmbeddings(a,a).minCosine).toBeCloseTo(1);
 expect(compareEmbeddings(a,a).maxPairDrift).toBe(0);
 expect(compareEmbeddings(a,a.slice(1))).toBeNull();
 expect(median([3,1,2])).toBe(2);
 expect(median([Infinity])).toBeNull();
});

it('compares GPU against fastest quality-qualified WASM, not just batch one',()=>{
 const parity=Array.from({length:3},()=>({minCosine:1,maxPairDrift:0}));
 const baseline={status:'completed',requestedBackend:'wasm',batch:1,medianMs:100,repeatability:parity};
 const variant=(backend,batch,ms,p=parity)=>({status:'completed',requestedBackend:backend,batch,medianMs:ms,parity:p});
 expect(parityPassed([])).toBe(false);
 expect(parityPassed(parity.slice(1))).toBe(false);
 expect(parityPassed([null,...parity.slice(1)])).toBe(false);
 expect(parityPassed(parity.map(p=>({...p,minCosine:Infinity})))).toBe(false);
 expect(selectCandidate(baseline,[variant('wasm',4,50),variant('webgpu',8,80)]).status).toBe('no-material-gpu-gain');
 expect(selectCandidate(baseline,[variant('wasm',4,50),variant('webgpu',8,40),variant('webgpu',4,20,[])])).toMatchObject({status:'gpu-candidate',speedup:1.25,webgpu:{batch:8}});
 expect(selectCandidate(baseline,[variant('webgpu',2,0)]).status).toBe('no-valid-gpu');
 expect(selectCandidate({...baseline,repeatability:null},[]).status).toBe('no-reference');
});
