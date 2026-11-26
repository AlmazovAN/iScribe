import type {StreamedAudio,StreamReadEvent} from '../streamedAudio';
import type {AudioWindow} from '../recognitionProgress';
import {inspectDecodedPcm,AudioValidationError} from '../audioValidation';
import {StreamDecodeStalledError,withActivityWatchdog} from '../ml/activityWatchdog';
import type {StreamStage} from '../jobTrace';
import {benchmarkNow} from '../benchmark';
export type PreparedStreamWindow={decoderId:number;pcm:Float32Array;decodeMs:number;validationMs:number;events:StreamReadEvent[]};
export type PrefetchTimeouts={decode:number;resample:number;pcm:number};
// A speculative read never writes IndexedDB, modifies status or reserves a
// recovery budget. The consumer publishes its diagnostics at the checkpoint
// boundary and routes failure through the existing durable recovery logic.
export async function prepareStreamWindow(audio:StreamedAudio,window:AudioWindow,index:number,signal:AbortSignal,timeouts:PrefetchTimeouts):Promise<PreparedStreamWindow>{
 signal.throwIfAborted();
 const events:StreamReadEvent[]=[];
 let stage:StreamStage='decode',accepting=true;
 const started=benchmarkNow();
 const pcm=await withActivityWatchdog((beat,beginStage)=>audio.read(window,event=>{
  if(!accepting||signal.aborted)return;
  if(event.code==='stream-read-end'||event.code==='stream-resample-end')beat();
  if(event.code==='stream-resample-start'){stage='resample';beginStage(timeouts.resample)}
  // Retain completion and stage transitions, not an unbounded packet log.
  if(event.code!=='stream-samples'&&events.length<8)events.push(event);
 },beat),{
  timeoutMs:timeouts.decode,pollMs:Math.min(1000,Math.max(5,Math.min(timeouts.decode,timeouts.resample)/4)),
  signal,onTimeout:()=>{accepting=false;audio.close()},timeoutError:()=>new StreamDecodeStalledError(stage)
 }).finally(()=>{accepting=false});
 const decodeMs=benchmarkNow()-started;
 signal.throwIfAborted();
 if(!(pcm instanceof Float32Array)||pcm.length!==window.end-window.start)throw new AudioValidationError(index+1,null,'invalid-window');
 const validationStarted=benchmarkNow();
 await withActivityWatchdog(beat=>inspectDecodedPcm(pcm,{signal,onProgress:beat}),{
  timeoutMs:timeouts.pcm,pollMs:Math.min(1000,Math.max(5,timeouts.pcm/4)),signal,
  onTimeout:()=>audio.close(),timeoutError:()=>new StreamDecodeStalledError('pcm-check')
 });
 signal.throwIfAborted();
 return {decoderId:audio.decoderId,pcm,decodeMs,validationMs:benchmarkNow()-validationStarted,events};
}
