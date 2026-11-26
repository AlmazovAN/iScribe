import type {StreamReadEvent} from '../streamedAudio';
// Critical starts are persisted immediately. Completion events are flushed by
// the following stage/commit; sample observations retain a periodic heartbeat.
export const TRACE_PERSIST_INTERVAL_MS=15000;
export const UI_PROGRESS_INTERVAL_MS=250;
export function shouldPersistStreamEvent(code:StreamReadEvent['code'],now:number,lastWrite:number,inspection:boolean):boolean{
 if(inspection||code==='stream-resample-start')return true;
 return code==='stream-samples'&&now-lastWrite>=TRACE_PERSIST_INTERVAL_MS;
}
export class ProgressGate{
 private key:string|null=null;
 private at=-Infinity;
 allow(key:string,now:number):boolean{
  if(key!==this.key||now<this.at||now-this.at>=UI_PROGRESS_INTERVAL_MS){this.key=key;this.at=now;return true}
  return false;
 }
 reset(){this.key=null;this.at=-Infinity}
}
export type StorageUiObservations={version:1;deferredMetadataWrites:number;suppressedProgressUpdates:number};
export function emptyStorageUi():StorageUiObservations{return {version:1,deferredMetadataWrites:0,suppressedProgressUpdates:0}}
export function storageUiReport(value:StorageUiObservations|undefined){
 if(!value)return null;
 return {version:1,deferredMetadataWrites:value.deferredMetadataWrites,suppressedProgressUpdates:value.suppressedProgressUpdates,
  limitation:'Counts represent intermediate metadata writes deferred to a later mandatory transaction and engine progress callbacks not published. Not measured IndexedDB latency or React render counts.'};
}
