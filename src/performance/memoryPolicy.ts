import type {PerformanceMode} from './types';
import {MAX_ASR_WINDOW_SAMPLES} from '../ml/activityWatchdog';
// One exact-size, privately owned dispatch buffer. Never transfer the
// authoritative PCM needed for recovery or subsequent speaker inference.
export class AsrPayloadPool{
 private spare:Float32Array<ArrayBuffer>|null=null;
 acquire(source:Float32Array):{payload:Float32Array<ArrayBuffer>;reused:boolean}{
  if(source.length<1||source.length>MAX_ASR_WINDOW_SAMPLES)throw new Error('Некорректный размер PCM для ASR.');
  const spare=this.spare;this.spare=null;
  const reused=spare!==null&&spare.length===source.length&&spare.byteLength===source.byteLength;
  const payload=reused?spare!:new Float32Array(source.length);
  payload.set(source);
  return {payload,reused};
 }
 // Call only after a successful, settled ASR request. An engine that
 // transfers the buffer detaches it; no reuse is then possible.
 retain(payload:Float32Array<ArrayBuffer>):'retained'|'detached'|'discarded'{
  this.spare=null;
  if(payload.byteLength===0)return 'detached';
  if(payload.length>MAX_ASR_WINDOW_SAMPLES||payload.byteOffset!==0||payload.buffer.byteLength!==payload.byteLength)return 'discarded';
  this.spare=payload;return 'retained';
 }
 clear(){this.spare=null}
}
export function shouldReleaseAfterQueue(mode:PerformanceMode,deviceMemoryGiB:number|null,model:string|null):boolean{
 return model!==null&&(mode==='eco'||model==='whisper-large-v3'||deviceMemoryGiB===null||!Number.isFinite(deviceMemoryGiB)||deviceMemoryGiB<=8);
}
export type MemoryObservations={version:1;payloadAllocations:number;payloadReuses:number;payloadCopyBytes:number;detachedPayloads:number;peakPayloadBytes:number;idleModelReleases:number;releaseFailures:number};
export function emptyMemoryObservations():MemoryObservations{return {version:1,payloadAllocations:0,payloadReuses:0,payloadCopyBytes:0,detachedPayloads:0,peakPayloadBytes:0,idleModelReleases:0,releaseFailures:0}}
export function observePayload(previous:MemoryObservations|undefined,reused:boolean,bytes:number):MemoryObservations{
 const p=previous??emptyMemoryObservations();
 return {...p,payloadAllocations:p.payloadAllocations+(reused?0:1),payloadReuses:p.payloadReuses+(reused?1:0),
  payloadCopyBytes:p.payloadCopyBytes+bytes,peakPayloadBytes:Math.max(p.peakPayloadBytes,bytes)};
}
export function memoryReport(value:MemoryObservations|undefined){
 if(!value)return null;
 return {version:1,payloadAllocations:value.payloadAllocations,payloadReuses:value.payloadReuses,payloadCopyBytes:value.payloadCopyBytes,
  detachedPayloads:value.detachedPayloads,peakPayloadBytes:value.peakPayloadBytes,idleModelReleases:value.idleModelReleases,releaseFailures:value.releaseFailures,
  limitation:'Counts describe host ASR dispatch buffers, not full RAM, actual process allocation, model memory, or the engine transport. Reuse occurs only after success with intact buffer; failed requests are never reused. Idle release counts successful disposal calls, not measured memory returned to the OS.'};
}
