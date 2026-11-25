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
 pcm[0]=1;pcm[800000]=0.2;
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
