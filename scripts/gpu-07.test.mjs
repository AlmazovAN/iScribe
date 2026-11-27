import {expect,it} from 'vitest';
import {ITEMS,FRAMES,MELS,features,cosine,compareEmbeddings,median} from '../tests/gpu/wespeaker-metrics.mjs';
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
