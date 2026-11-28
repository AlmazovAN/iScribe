import {expect,it} from 'vitest';
import {inspectRawAsr,inspectOwnedAsr,hasAsrWarning,addAsrQuality,assertQualityForward,qualitySummary} from './asrQuality';
const pcm=new Float32Array(480000).fill(.02),silent=new Float32Array(480000);
const s=(text:string)=>({start:3,end:4,text});
const scan=(ss:ReturnType<typeof s>[],prior:ReturnType<typeof s>[]=[],audio=pcm)=>inspectOwnedAsr(inspectRawAsr(ss,audio),ss,prior,audio.length);
it('PIPE-09 rejects invalid RAW and measures timestamp anomalies without changing existing tolerance',()=>{
 const x=inspectRawAsr([{start:NaN,end:1,text:'x'},{start:29,end:30.5,text:'x'},{start:2,end:2,text:'x'},{start:1,end:3,text:7}],pcm);
 expect(x).toMatchObject({invalidSegments:2,tailOverrun:1,zeroDuration:1,outOfOrder:1});
 expect(inspectRawAsr(null,pcm).invalidSegments).toBe(1);
 expect(inspectRawAsr([{start:29,end:31.001,text:'x'}],pcm).invalidSegments).toBe(1);
});
it('PIPE-09 detects exact repeated phrases without flagging ordinary short repeated words',()=>{
 expect(scan([s('один два три, ОДИН два три. один два три')]).repeatRuns).toBe(1);
 expect(scan([s('да да да')]).repeatRuns).toBe(0);
 expect(scan([s('one '.repeat(8))]).repeatRuns).toBe(1);
});
it('PIPE-09 detects cross-window repeats but does not recount a prior-only loop',()=>{
 expect(scan([s('one two three')],[s('one two three one two three')]).repeatRuns).toBe(1);
 expect(scan([s('different')],[s('one two three one two three one two three')]).repeatRuns).toBe(0);
});
it('PIPE-09 flags text on near-zero signal without suppressing it or treating empty silence as an error',()=>{
 const ss=[s('possible text')];
 expect(scan(ss,[],silent).silentText).toBe(true);
 expect(ss[0].text).toBe('possible text');
 expect(hasAsrWarning(scan([],[],silent))).toBe(false);
});
it('PIPE-09 bounds text analysis and detects dense output',()=>{
 const x=scan([s('word '.repeat(5000))]);
 expect(x).toMatchObject({ownedWords:4096,scanLimited:true,denseText:true});
 expect(scan([s('a'.repeat(70000))]).scanLimited).toBe(true);
});
it('PIPE-09 advances durable quality counters only with the matching committed window',()=>{
 const a=addAsrQuality(undefined,scan([s('yes')],[],silent)),b=addAsrQuality(a,scan([s('ok')]));
 const old={nextWindow:40},one={nextWindow:41,asrQuality:a},two={nextWindow:42,asrQuality:b};
 expect(()=>assertQualityForward(old,one)).not.toThrow();
 expect(()=>assertQualityForward(one,two)).not.toThrow();
 expect(()=>assertQualityForward(two,two)).not.toThrow();
 expect(()=>assertQualityForward(two,one)).toThrow();
 expect(()=>assertQualityForward(two,{nextWindow:42})).toThrow();
 expect(()=>assertQualityForward(two,{nextWindow:43,asrQuality:b})).toThrow();
 expect(b).toMatchObject({examinedWindows:2,warningWindows:1});
});
it('PIPE-09 exports only validated numeric summary fields',()=>{
 const x=addAsrQuality(undefined,scan([]));
 expect(qualitySummary({...x,warningWindows:2})).toBeNull();
 expect(JSON.stringify(qualitySummary({...x,secret:'PRIVATE'}))).not.toContain('PRIVATE');
 expect(qualitySummary(undefined)).toBeNull();
});
