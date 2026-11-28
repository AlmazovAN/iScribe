import type {PerformanceMode} from './types';
import {WorkerDisposalError} from '../ml/activityWatchdog';

// A ready model is reused only when the upcoming job can actually use it.
// Large/eco sessions are not kept alive while another file is decoded.
export function shouldReleaseBeforeJob(mode:PerformanceMode,active:string|null,next:string,asrComplete:boolean):boolean{
 return active!==null&&(asrComplete||active!==next||mode==='eco'||active==='whisper-large-v3');
}
export const IDLE_MODEL_LEASE_MS=120000;
export class IdleModelLease{
 private timer:ReturnType<typeof setTimeout>|undefined;
 private generation=0;
 cancel():void{
  this.generation++;
  if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined}
 }
 schedule(release:()=>void,delayMs=IDLE_MODEL_LEASE_MS):void{
  this.cancel();
  if(!Number.isFinite(delayMs)||delayMs<=0)throw new Error('Некорректное время удержания модели.');
  const generation=this.generation;
  this.timer=setTimeout(()=>{
   if(generation!==this.generation)return;
   this.timer=undefined;release();
  },delayMs);
 }
}
// Worker.terminate() returning normally is an API-level retirement request,
// not a measurement of actual native/GPU memory returned to the OS.
// On a thrown error, prohibit allocation of another Worker in this manager.
export class WorkerRetirement{
 private readonly retired=new WeakSet<object>();
 private failed=false;
 get blocked(){return this.failed}
 assertUsable():void{if(this.failed)throw new WorkerDisposalError()}
 terminate(worker:Pick<Worker,'terminate'>|null|undefined):void{
  if(!worker||this.retired.has(worker))return;
  try{worker.terminate?.();this.retired.add(worker)}
  catch{this.failed=true;throw new WorkerDisposalError()}
 }
}
