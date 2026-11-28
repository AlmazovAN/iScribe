import {expect,it,vi} from 'vitest';
import {audioWindows,absoluteSegments} from './jobs';
import {AudioValidationError,inspectDecodedPcm,MAX_PCM_SAMPLES,validateWindowPlan} from './audioValidation';

it('accepts 14m31s PCM as precisely 35 overlapping windows without gaps',()=>{
 const count=871*16000,windows=audioWindows(count);
 expect(windows).toHaveLength(35);
 expect(()=>validateWindowPlan(count,windows)).not.toThrow();
 expect(windows[0]).toMatchObject({start:0,end:480000,first:true,last:false});
 expect(windows[1]).toMatchObject({start:400000,end:880000,first:false,last:false});
 expect(windows[34].end).toBe(count);
 for(let i=1;i<windows.length;i++){
  expect(windows[i].start-windows[i-1].start).toBe(400000);
  expect(windows[i].start).toBeLessThan(windows[i-1].end);
 }
});

it('handles short audio and the 30s/30s+1-sample boundary',()=>{
 const short=audioWindows(15999);
 expect(short).toHaveLength(1);
 validateWindowPlan(15999,short);
 const exact=audioWindows(480000);expect(exact).toHaveLength(1);
 const extra=audioWindows(480001);expect(extra).toHaveLength(2);
 expect(extra[1].start).toBe(400000);
 expect(extra[1].end).toBe(480001);
 validateWindowPlan(480001,extra);
});
it('rejects invalid PCM lengths before unbounded window allocation',()=>{
 for(const samples of [NaN,Infinity,-1,1.5,MAX_PCM_SAMPLES+1]){
  expect(()=>audioWindows(samples)).toThrow();
 }
 expect(()=>validateWindowPlan(0,[])).toThrow(AudioValidationError);
});
it('rejects gaps, overlaps with wrong step, invalid flags and tampered final window',()=>{
 const base=audioWindows(871*16000);
 const gap=base.map(w=>({...w}));gap[1].start++;
 expect(()=>validateWindowPlan(871*16000,gap)).toThrow('граница окна');
 const last=base.map(w=>({...w}));last[34].end-=10;
 expect(()=>validateWindowPlan(871*16000,last)).toThrow();
 const flags=base.map(w=>({...w}));flags[0].last=true;
 expect(()=>validateWindowPlan(871*16000,flags)).toThrow();
});
it('checks PCM with no inference; labels silent and near-clipped windows without treating them as failure',async()=>{
 const pcm=new Float32Array(60*16000);
 pcm[0]=1;
 const updates:number[]=[];
 const result=await inspectDecodedPcm(pcm,{onProgress:(done,total)=>{updates.push(done);expect(total).toBe(3)}});
 expect(result).toMatchObject({pcmSamples:960000,durationSeconds:60,windowCount:3,nearClippedWindows:1,peakAbsolute:1});
 expect(result.quietWindows).toBeGreaterThanOrEqual(1);
 expect(updates).toEqual([1,2,3]);
});
it('reports exact failing window and sample index for NaN or Infinity',async()=>{
 const pcm=new Float32Array(60*16000);
 pcm[800001]=NaN;
 await expect(inspectDecodedPcm(pcm)).rejects.toMatchObject({code:'audio-validation-failed',reason:'invalid-sample',windowNumber:2,sampleIndex:800001});
 pcm[800001]=0;pcm[0]=Infinity;
 await expect(inspectDecodedPcm(pcm)).rejects.toMatchObject({windowNumber:1,sampleIndex:0});
});
it('aborts an inspection between windows and never claims success',async()=>{
 const pcm=new Float32Array(65*16000),controller=new AbortController();
 const progress=vi.fn((done:number)=>{if(done===1)controller.abort()});
 await expect(inspectDecodedPcm(pcm,{signal:controller.signal,onProgress:progress,yieldEveryWindows:1})).rejects.toThrow();
 expect(progress).toHaveBeenCalledTimes(1);
});
it('rejects malformed model timestamps instead of persisting them as ASR progress',()=>{
 const window=audioWindows(60*16000)[0];
 expect(()=>absoluteSegments([{start:NaN,end:3,text:'corrupt'}],window)).toThrow('временные метки');
 expect(()=>absoluteSegments([{start:-3,end:4,text:'corrupt'}],window)).toThrow('временные метки');
 expect(()=>absoluteSegments([{start:1,end:0,text:'corrupt'}],window)).toThrow('временные метки');
 expect(()=>absoluteSegments([{start:3,end:35,text:'corrupt'}],window)).toThrow('временные метки');
 expect(absoluteSegments([{start:26,end:27,text:'valid'}],window)).toHaveLength(1);
});

it('PIPE-02 counts source samples only once across overlapping ASR windows',async()=>{
 const pcm=new Float32Array(60*16000);
 pcm[400000]=1.25;pcm[479999]=-1;pcm[480000]=0.5;
 const report=await inspectDecodedPcm(pcm);
 expect(report.quality).toMatchObject({revision:1,startSample:0,endSample:960000,zeroSamples:959997,nearFullScaleSamples:2,overRangeSamples:1,longestZeroRun:479999,maxAdjacentDelta:1.5});
 expect(report.quality?.rms).toBeCloseTo(Math.sqrt((1.25**2+1+0.25)/960000),12);
 expect(report.quality?.dcOffset).toBeCloseTo(0.75/960000,12);
 expect(report.nearClippedWindows).toBe(2); // overlapping window count, intentionally not unique samples
});
it('PIPE-02 allows exact silence, very quiet samples and finite out-of-range values without mutating audio',async()=>{
 const pcm=new Float32Array([0,0,0.0000001,-0.0000001,1.1]);
 const before=pcm.slice();
 const report=await inspectDecodedPcm(pcm);
 expect(report.quality).toMatchObject({zeroSamples:2,longestZeroRun:2,nearFullScaleSamples:1,overRangeSamples:1});
 expect(pcm).toEqual(before);
 const silence=await inspectDecodedPcm(new Float32Array(16000));
 expect(silence.quality).toMatchObject({zeroSamples:16000,longestZeroRun:16000,rms:0,dcOffset:0,maxAdjacentDelta:0});
 expect(silence.quietWindows).toBe(1);
});
it('PIPE-02 validates exact coverage and reports absolute source sample coordinates',async()=>{
 const pcm=new Float32Array([0,0.1,NaN]);
 await expect(inspectDecodedPcm(pcm,{startSample:16000000,windowNumber:41,expectedSamples:3})).rejects.toMatchObject({reason:'invalid-sample',windowNumber:41,sampleIndex:16000002});
 await expect(inspectDecodedPcm(new Float32Array(2),{startSample:400000,windowNumber:2,expectedSamples:3})).rejects.toMatchObject({reason:'invalid-window',windowNumber:2});
 await expect(inspectDecodedPcm(new Float32Array(3),{startSample:-1})).rejects.toMatchObject({reason:'invalid-window'});
 const ok=await inspectDecodedPcm(new Float32Array(3),{startSample:400000,windowNumber:2,expectedSamples:3});
 expect(ok.quality).toMatchObject({startSample:400000,endSample:400003});
});
it('PIPE-02 cancellation on the final progress callback is not a successful check',async()=>{
 const controller=new AbortController();
 await expect(inspectDecodedPcm(new Float32Array(16),{signal:controller.signal,onProgress:()=>controller.abort()})).rejects.toMatchObject({name:'AbortError'});
});
