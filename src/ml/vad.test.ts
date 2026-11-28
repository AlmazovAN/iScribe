import {expect,it} from 'vitest';
import {VadAccumulator,validateVadReport,VAD_FRAME,VAD_BLOCK,type VadInference} from './vad';

const scoring=(probability:number):VadInference=>async(_input,state)=>({probability,state:state.slice()});
it('PIPE-07 uses 512 samples plus 64 previous samples and carries recurrent state across arbitrary blocks',async()=>{
 const pcm=Float32Array.from({length:1100},(_,i)=>i/1100);
 const a=new VadAccumulator(pcm.length);let frames=0;
 const infer:VadInference=async(input,state)=>{
  expect(input.length).toBe(576);expect(state.length).toBe(256);
  expect(state[0]).toBe(frames);
  if(frames===0)expect(input.subarray(0,64)).toEqual(new Float32Array(64));
  if(frames===1)expect(input.subarray(0,64)).toEqual(pcm.subarray(448,512));
  if(frames===2){expect(input.subarray(0,64)).toEqual(pcm.subarray(960,1024));expect(input.subarray(140)).toEqual(new Float32Array(436))}
  frames++;const next=state.slice();next[0]=frames;return {probability:0.9,state:next};
 };
 await a.push(pcm.subarray(0,500),infer);expect(frames).toBe(0);
 await a.push(pcm.subarray(500,1000),infer);expect(frames).toBe(1);
 await a.push(pcm.subarray(1000),infer);
 const result=await a.finish(infer);
 expect(frames).toBe(3);expect(result).toEqual({revision:1,samples:1100,frames:3,speechSamples:1100,intervals:[{start:0,end:1100}]});
 expect(validateVadReport(result,1100)).toBe(true);
});
it('PIPE-07 preserves the timeline and short detected speech; padding is clamped',async()=>{
 const samples=50*VAD_FRAME,pass=new VadAccumulator(samples);let frame=0;
 const infer:VadInference=async(_input,state)=>({probability:frame++===20?0.36:0,state:state.slice()});
 await pass.push(new Float32Array(samples),infer);
 const result=await pass.finish(infer);
 expect(result.intervals).toEqual([{start:20*VAD_FRAME-4000,end:21*VAD_FRAME+4000}]);
 expect(result.speechSamples).toBe(8512);
 expect(validateVadReport(result,samples)).toBe(true);
});
it('PIPE-07 emits an empty advisory map for all-low scores without removing samples',async()=>{
 const samples=VAD_BLOCK+17,a=new VadAccumulator(samples),pcm=new Float32Array(samples);
 await a.push(pcm.subarray(0,VAD_BLOCK),scoring(0));
 await a.push(pcm.subarray(VAD_BLOCK),scoring(0));
 expect(await a.finish(scoring(0))).toEqual({revision:1,samples,frames:Math.ceil(samples/512),speechSamples:0,intervals:[]});
 expect(pcm.length).toBe(samples);
});
it('PIPE-07 merges overlapping padded intervals and uses hysteresis',async()=>{
 const frames=40,samples=frames*VAD_FRAME,a=new VadAccumulator(samples);let i=0;
 const infer:VadInference=async(_input,state)=>{
  const n=i++;return {probability:n===0||n===10?0.9:n===1?0.25:0,state:state.slice()};
 };
 await a.push(new Float32Array(samples),infer);
 const report=await a.finish(infer);
 expect(report.intervals).toEqual([{start:0,end:11*512+4000}]);
 expect(validateVadReport(report,samples)).toBe(true);
});
it('PIPE-07 rejects invalid probabilities, state, block size and incomplete coverage',async()=>{
 const a=new VadAccumulator(512);
 await expect(a.push(new Float32Array(512),scoring(NaN))).rejects.toThrow();
 const b=new VadAccumulator(512);
 await expect(b.push(new Float32Array(512),async()=>({probability:0.5,state:new Float32Array(1)}))).rejects.toThrow();
 const c=new VadAccumulator(513);await c.push(new Float32Array(512),scoring(0));
 await expect(c.finish(scoring(0))).rejects.toThrow('Неполное');
 const d=new VadAccumulator(VAD_BLOCK+1);
 await expect(d.push(new Float32Array(VAD_BLOCK+1),scoring(0))).rejects.toThrow();
});
it('PIPE-07 rejects corrupt maps and false coverage totals',()=>{
 const valid={revision:1,samples:1024,frames:2,speechSamples:200,intervals:[{start:100,end:300}]};
 expect(validateVadReport(valid,1024)).toBe(true);
 for(const bad of [{...valid,frames:3},{...valid,speechSamples:201},{...valid,intervals:[{start:100,end:300},{start:299,end:301}]},{...valid,intervals:[{start:100,end:1025}]},{...valid,intervals:[{start:0.5,end:200.5}]}])expect(validateVadReport(bad,1024)).toBe(false);
});
