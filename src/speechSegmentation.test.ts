import {expect,it} from 'vitest';
import {buildSpeechWindows,validateSpeechPlan,assertSpeechPlanForward,SEGMENTATION_CONTRACT,type SpeechWindowPlan} from './speechSegmentation';
import type {SpeechInterval,VadReport} from './ml/vad';
import {absoluteSegments,audioWindows} from './jobs';
import {checkpointProgress} from './recognitionProgress';
import {committedSeconds,expectedWindows} from './jobDiagnostics';

const RATE=16000;
function map(samples:number,intervals:SpeechInterval[]):VadReport{
 return {revision:1,samples,frames:Math.ceil(samples/512),speechSamples:intervals.reduce((n,x)=>n+x.end-x.start,0),intervals};
}
function example():SpeechWindowPlan{
 const samples=60*RATE,report=map(samples,[{start:0,end:24*RATE},{start:26.5*RATE,end:samples}]);
 return {revision:1,contract:SEGMENTATION_CONTRACT,samples,pcmFingerprint:'a'.repeat(64),decoderProfile:'test',...buildSpeechWindows(samples,report)};
}
it('PIPE-08 moves a boundary into a pause while retaining all input and exact overlap',()=>{
 const p=example();expect(p.adjustedCuts).toBe(1);expect(validateSpeechPlan(p,p.samples)).toBe(true);
 expect(p.windows.map(w=>[w.start/RATE,w.end/RATE])).toEqual([[0,28.75],[23.75,53.75],[48.75,60]]);
});
it('PIPE-08 keeps baseline windows on speech-only, silence-only and no suitable pause',()=>{
 const samples=60*RATE;
 for(const intervals of [[],[{start:0,end:samples}],[{start:0,end:3*RATE},{start:4*RATE,end:samples}]]){
  const r=buildSpeechWindows(samples,map(samples,intervals));expect(r.adjustedCuts).toBe(0);expect(r.windows).toEqual(audioWindows(samples));
 }
});
it('PIPE-08 handles fractional and tiny tails without losing samples',()=>{
 for(const n of [1,511,480000,480001,880001,57600000]){
  const r=buildSpeechWindows(n,map(n,[]));expect(r.windows).toEqual(audioWindows(n));
 }
});
it('PIPE-08 keeps midpoint ownership and absolute timestamps on adaptive cuts',()=>{
 const p=example(),[a,b]=p.windows;
 expect(absoluteSegments([{start:25,end:27.5,text:'boundary'}],a)).toEqual([]);
 expect(absoluteSegments([{start:1.25,end:3.75,text:'boundary'}],b)).toEqual([{start:25,end:27.5,text:'boundary'}]);
 expect(checkpointProgress(p.windows,1).seconds).toBe(28.75);
 expect(committedSeconds({duration:60,nextWindow:1,windowPlan:p})).toBe(28.75);
 expect(expectedWindows(60,p)).toBe(3);
});
it('PIPE-08 rejects corrupt plan geometry, fingerprint, counts and map',()=>{
 const p=example();
 for(const bad of [{...p,adjustedCuts:2},{...p,windows:p.windows.map((w,i)=>i===1?{...w,start:w.start+1}:w)},{...p,pcmFingerprint:'bad'},{...p,samples:p.samples-1},{...p,contract:'future'}])
  expect(validateSpeechPlan(bad,p.samples)).toBe(false);
 expect(()=>buildSpeechWindows(60*RATE,{...map(60*RATE,[]),speechSamples:1})).toThrow('карта речи');
});
it('PIPE-08 freezes the plan before ASR reservation and refuses stale metadata',()=>{
 const p=example(),base={duration:60,nextWindow:0,asrComplete:false},saved={...base,windowPlan:p};
 expect(()=>assertSpeechPlanForward(base,saved)).not.toThrow();
 expect(()=>assertSpeechPlanForward(saved,{...saved,nextWindow:1})).not.toThrow();
 expect(()=>assertSpeechPlanForward(saved,base)).toThrow('Нельзя изменить');
 expect(()=>assertSpeechPlanForward(saved,{...saved,windowPlan:{...p,pcmFingerprint:'b'.repeat(64)}})).toThrow('Нельзя изменить');
 expect(()=>assertSpeechPlanForward({...base,nextWindow:1},saved)).toThrow('после начала ASR');
 expect(()=>assertSpeechPlanForward({...base,recoveryLedger:{operations:{asr:{}}}},saved)).toThrow('после начала ASR');
 expect(()=>assertSpeechPlanForward(saved,{...saved,asrComplete:true})).toThrow('Некорректный');
});
it('PIPE-08 preserves full coverage and deterministic bounded geometry across 1000 generated maps',()=>{
 let seed=9;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 const template=example();
 for(let k=0;k<1000;k++){
  const n=1+Math.floor(rand()*57600000),a:SpeechInterval[]=[];let cursor=0;
  while(cursor<n){cursor+=1+Math.floor(rand()*120000);if(cursor>=n)break;const end=Math.min(n,cursor+1+Math.floor(rand()*720000));a.push({start:cursor,end});cursor=end}
  const m=map(n,a),y=buildSpeechWindows(n,m);
  expect(y).toEqual(buildSpeechWindows(n,m));expect(y.windows[0].start).toBe(0);expect(y.windows.at(-1)!.end).toBe(n);
  let unique=0;
  for(let i=0;i<y.windows.length;i++){const w=y.windows[i];expect(w.end-w.start).toBeLessThanOrEqual(480000);expect(w.end).toBeGreaterThan(unique);if(i)expect(w.start).toBe(unique-80000);unique=w.end}
  if(y.adjustedCuts)expect(validateSpeechPlan({...template,samples:n,...y},n)).toBe(true);
 }
},15000);
