import type {AudioWindow} from './recognitionProgress';
import {validateVadReport,type VadReport} from './ml/vad';

export const SEGMENTATION_CONTRACT='pause-aware-v1';
const RATE=16000,MAX=30*RATE,HALF_OVERLAP=40000,SEARCH=5*RATE,MIN_ADVANCE=20*RATE,PAUSE_MARGIN=4000;
const MAX_SAMPLES=3600*RATE;
export type SpeechWindowPlan={revision:1;contract:typeof SEGMENTATION_CONTRACT;samples:number;pcmFingerprint:string;decoderProfile:string;adjustedCuts:number;windows:AudioWindow[]};
export function buildSpeechWindows(samples:number,map:VadReport):{windows:AudioWindow[];adjustedCuts:number}{
 if(!validateVadReport(map,samples))throw new Error('Некорректная карта речи.');
 const gaps:{start:number;end:number}[]=[];
 let covered=0;
 for(const interval of map.intervals){
  if(interval.start-covered>=2*PAUSE_MARGIN)gaps.push({start:covered+PAUSE_MARGIN,end:interval.start-PAUSE_MARGIN});
  covered=interval.end;
 }
 if(samples-covered>=2*PAUSE_MARGIN)gaps.push({start:covered+PAUSE_MARGIN,end:samples-PAUSE_MARGIN});
 const windows:AudioWindow[]=[];let adjustedCuts=0,start=0,gapIndex=0;
 while(samples-start>MAX){
  const target=start+MAX-HALF_OVERLAP,earliest=target-SEARCH;
  let cut=target,best=-1;
  while(gapIndex<gaps.length&&gaps[gapIndex].end<earliest)gapIndex++;
  // The cut belongs to an estimated pause; never remove audio. Use the
  // latest feasible quiet point to keep windows long and limit overhead.
  for(let i=gapIndex;i<gaps.length&&gaps[i].start<=target;i++){
   const candidate=Math.min(target,gaps[i].end);
   if(candidate>=earliest&&candidate>=gaps[i].start)best=Math.max(best,candidate);
  }
  if(best>=earliest)cut=best;
  if(cut!==target)adjustedCuts++;
  windows.push({start,end:cut+HALF_OVERLAP,first:start===0,last:false});
  start=cut-HALF_OVERLAP;
 }
 windows.push({start,end:samples,first:start===0,last:true});
 return {windows,adjustedCuts};
}
export function validateSpeechPlan(value:unknown,samples:number):value is SpeechWindowPlan{
 if(!value||typeof value!=='object'||!Number.isSafeInteger(samples)||samples<1||samples>MAX_SAMPLES)return false;
 const p=value as SpeechWindowPlan;
 if(p.revision!==1||p.contract!==SEGMENTATION_CONTRACT||p.samples!==samples||
  typeof p.pcmFingerprint!=='string'||!/^[0-9a-f]{64}$/.test(p.pcmFingerprint)||
  typeof p.decoderProfile!=='string'||!p.decoderProfile.length||p.decoderProfile.length>512||
  !Array.isArray(p.windows)||p.windows.length<2||p.windows.length>Math.ceil(samples/MIN_ADVANCE)+1||
  !Number.isSafeInteger(p.adjustedCuts)||p.adjustedCuts<1||p.adjustedCuts>=p.windows.length)return false;
 let adjusted=0;
 for(let i=0;i<p.windows.length;i++){
  const w=p.windows[i],previous=p.windows[i-1],last=i===p.windows.length-1;
  if(!w||!Number.isSafeInteger(w.start)||!Number.isSafeInteger(w.end)||
   w.start<0||w.end<=w.start||w.end>samples||w.end-w.start>MAX||
   w.first!==(i===0)||w.last!==last||(!i&&w.start!==0)||
   (i>0&&(w.start!==previous.end-2*HALF_OVERLAP||w.end<=previous.end)))return false;
  if(!last){
   if(w.end===samples||w.end-w.start<MAX-SEARCH||samples-w.start<=MAX)return false;
   if(w.end-w.start!==MAX)adjusted++;
  }else if(w.end!==samples)return false;
 }
 return adjusted===p.adjustedCuts;
}
type PlanOwner={windowPlan?:SpeechWindowPlan;duration?:number;nextWindow:number;asrComplete:boolean;recoveryLedger?:{operations:{asr?:unknown}}};
export function assertSpeechPlanForward(old:PlanOwner|undefined,next:PlanOwner):void{
 const p=next.windowPlan;
 if(p){
  if(!validateSpeechPlan(p,Math.round((next.duration??0)*RATE))||!Number.isSafeInteger(next.nextWindow)||next.nextWindow<0||next.nextWindow>p.windows.length||(next.asrComplete&&next.nextWindow!==p.windows.length))
   throw new Error('Некорректный сохранённый план окон.');
 }
 if(old?.windowPlan){
  if(!p||JSON.stringify(old.windowPlan)!==JSON.stringify(p))throw new Error('Нельзя изменить сохранённый план окон.');
 }else if(p&&((old?.nextWindow??0)>0||old?.asrComplete||old?.recoveryLedger?.operations.asr||next.nextWindow>0||next.asrComplete||next.recoveryLedger?.operations.asr))
  throw new Error('Нельзя менять границы после начала ASR.');
}
