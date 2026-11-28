import {audioWindows} from './jobs';
import type {AudioWindow} from './recognitionProgress';

export const PCM_SAMPLE_RATE=16000;
export const MAX_PCM_SAMPLES=3600*PCM_SAMPLE_RATE;
const MAX_WINDOW_SAMPLES=30*PCM_SAMPLE_RATE;
const STEP_SAMPLES=25*PCM_SAMPLE_RATE;
const QUIET_RMS_THRESHOLD=0.00001;

// This is a decoded-PCM integrity check, not a checksum of compressed MP3
// frames. A browser codec may conceal frame damage while decoding successfully.
// Numeric evidence only. A large adjacent step, clipping or zeros can be
// legitimate signal; none is a speech detector or proof of codec corruption.
export type PcmQualityEvidence={
 revision:1;
 startSample:number;
 endSample:number;
 rms:number;
 dcOffset:number;
 zeroSamples:number;
 longestZeroRun:number;
 nearFullScaleSamples:number;
 overRangeSamples:number;
 maxAdjacentDelta:number;
};
export type AudioInspectionReport={
 pcmSamples:number;
 durationSeconds:number;
 windowCount:number;
 quietWindows:number;
 nearClippedWindows:number;
 peakAbsolute:number;
 quality?:PcmQualityEvidence; // absent on historical or aggregate reports
};
export class AudioValidationError extends Error{
 readonly code='audio-validation-failed';
 constructor(readonly windowNumber:number|null,readonly sampleIndex:number|null,readonly reason:'empty'|'invalid-length'|'invalid-window'|'invalid-sample'){
  super(reason==='invalid-sample'
   ? `Некорректное значение PCM: окно ${windowNumber}, отсчёт ${sampleIndex}. Распознавание не запущено.`
   :reason==='empty'?'В аудиозаписи нет декодированных отсчётов.'
   :reason==='invalid-length'?'Некорректная длительность PCM. Поддерживается запись до одного часа.'
   :`Некорректная граница окна ${windowNumber??'?'}. Распознавание не запущено.`);
  this.name='AudioValidationError';
 }
}
// Reject a corrupt window plan before passing sample slices to Whisper.
// The first window is [0, 30s], then step=25s with 5s overlap.
export function validateWindowPlan(samples:number,windows:readonly AudioWindow[]):void{
 if(!Number.isSafeInteger(samples)||samples<0||samples>MAX_PCM_SAMPLES)throw new AudioValidationError(null,null,'invalid-length');
 if(samples===0||windows.length===0)throw new AudioValidationError(null,null,'empty');
 const expected=Math.max(1,Math.ceil((samples-MAX_WINDOW_SAMPLES)/STEP_SAMPLES)+1);
 if(windows.length!==expected)throw new AudioValidationError(null,null,'invalid-window');
 for(let index=0;index<windows.length;index++){
  const w=windows[index],start=index*STEP_SAMPLES,end=Math.min(start+MAX_WINDOW_SAMPLES,samples);
  if(!w||w.start!==start||w.end!==end||w.first!==(index===0)||w.last!==(index===windows.length-1)||
   !Number.isSafeInteger(w.start)||!Number.isSafeInteger(w.end)||w.end<=w.start||
   w.end-w.start>MAX_WINDOW_SAMPLES)throw new AudioValidationError(index+1,null,'invalid-window');
 }
 if(windows[windows.length-1].end!==samples)throw new AudioValidationError(windows.length,null,'invalid-window');
}
export async function inspectDecodedPcm(
 pcm:Float32Array,
 options:{signal?:AbortSignal;onProgress?:(done:number,total:number)=>void;yieldEveryWindows?:number;startSample?:number;windowNumber?:number;expectedSamples?:number}={}
):Promise<AudioInspectionReport>{
 options.signal?.throwIfAborted();
 const offset=options.startSample??0,outer=options.windowNumber??null;
 if(!Number.isSafeInteger(offset)||offset<0||outer!==null&&(!Number.isSafeInteger(outer)||outer<1))throw new AudioValidationError(outer,null,'invalid-window');
 if(!(pcm instanceof Float32Array))throw new AudioValidationError(null,null,'invalid-length');
 if(pcm.length===0)throw new AudioValidationError(null,null,'empty');
 if(!Number.isSafeInteger(pcm.length)||pcm.length>MAX_PCM_SAMPLES)throw new AudioValidationError(null,null,'invalid-length');
 if(!Number.isSafeInteger(offset+pcm.length)||options.expectedSamples!==undefined&&pcm.length!==options.expectedSamples)throw new AudioValidationError(outer,null,'invalid-window');
 const windows=audioWindows(pcm.length);
 validateWindowPlan(pcm.length,windows);
 const every=options.yieldEveryWindows??4;
 let quietWindows=0,nearClippedWindows=0,peakAbsolute=0;
 let uniqueEnd=0,sum=0,squares=0,zeroSamples=0,zeroRun=0,longestZeroRun=0,nearFullScaleSamples=0,overRangeSamples=0,maxAdjacentDelta=0,previous=0;
 for(let i=0;i<windows.length;i++){
  options.signal?.throwIfAborted();
  const {start,end}=windows[i];let sumSq=0,windowPeak=0;
  for(let pos=start;pos<end;pos++){
   // Decode may succeed even when corrupt PCM contains NaN/Infinity.
   const value=pcm[pos];
   if(!Number.isFinite(value))throw new AudioValidationError(outer??i+1,offset+pos,'invalid-sample');
   const abs=Math.abs(value);
   if(abs>windowPeak)windowPeak=abs;
   sumSq+=value*value;
   // Count each source sample once, even though ASR windows overlap.
   if(pos>=uniqueEnd){
    sum+=value;squares+=value*value;
    if(value===0){zeroSamples++;zeroRun++;if(zeroRun>longestZeroRun)longestZeroRun=zeroRun}else zeroRun=0;
    if(abs>=0.999)nearFullScaleSamples++;
    if(abs>1)overRangeSamples++;
    if(pos>0)maxAdjacentDelta=Math.max(maxAdjacentDelta,Math.abs(value-previous));
    previous=value;
   }
  }
  uniqueEnd=end;
  if(windowPeak>peakAbsolute)peakAbsolute=windowPeak;
  if(Math.sqrt(sumSq/(end-start))<QUIET_RMS_THRESHOLD)quietWindows++;
  if(windowPeak>=0.999)nearClippedWindows++;
  options.onProgress?.(i+1,windows.length);
  options.signal?.throwIfAborted();
  if(every>0&&(i+1)%every===0&&i+1<windows.length){
   await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
 }
 return {pcmSamples:pcm.length,durationSeconds:pcm.length/PCM_SAMPLE_RATE,
  windowCount:windows.length,quietWindows,nearClippedWindows,peakAbsolute,
  quality:{revision:1,startSample:offset,endSample:offset+pcm.length,rms:Math.sqrt(squares/pcm.length),dcOffset:sum/pcm.length,
   zeroSamples,longestZeroRun,nearFullScaleSamples,overRangeSamples,maxAdjacentDelta}};
}
