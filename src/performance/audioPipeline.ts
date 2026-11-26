// Bounded lookahead. Only one producer read is in flight, even when two
// windows are queued. No producer callback may change job state or storage.
export type PrefetchResult<T>={ok:true;value:T}|{ok:false;error:unknown};
type Slot<T>={ready:boolean;result:Promise<PrefetchResult<T>>};
export const MAX_PREFETCH_WINDOWS=2;
export class AudioPipeline<T>{
 private slots=new Map<number,Slot<T>>();
 private tail:Promise<void>=Promise.resolve();
 private readonly controller=new AbortController();
 private blocked=false;
 private closed=false;
 private readonly abort=()=>this.controller.abort();
 constructor(private readonly parent:AbortSignal){
  if(parent.aborted)this.abort();else parent.addEventListener('abort',this.abort,{once:true});
 }
 get size(){return this.slots.size}
 fill(start:number,count:number,load:(index:number,signal:AbortSignal)=>Promise<T>):number{
  if(this.closed||this.blocked||this.controller.signal.aborted)return 0;
  let added=0;
  const capacity=Math.max(0,Math.min(MAX_PREFETCH_WINDOWS,Math.floor(count)));
  for(let index=start;index<start+capacity;index++){
   if(this.slots.has(index))continue;
   if(this.slots.size>=capacity)break;
   const slot:Slot<T>={ready:false,result:this.tail.then(async():Promise<PrefetchResult<T>>=>{
    try{
     if(this.blocked||this.closed)throw new Error('Предварительное чтение остановлено.');
     this.controller.signal.throwIfAborted();
     const value=await load(index,this.controller.signal);
     this.controller.signal.throwIfAborted();
     return {ok:true,value};
    }catch(error){this.blocked=true;return {ok:false,error}}
   })};
   this.slots.set(index,slot);added++;
   this.tail=slot.result.then(()=>{slot.ready=true});
  }
  return added;
 }
 async take(index:number):Promise<{result:PrefetchResult<T>;ready:boolean}|undefined>{
  const slot=this.slots.get(index);
  if(!slot){
   if(this.slots.size)throw new Error('Нарушена последовательность буфера аудио.');
   return undefined;
  }
  if(this.slots.keys().next().value!==index)throw new Error('Нарушена последовательность буфера аудио.');
  const ready=slot.ready,result=await slot.result;
  this.slots.delete(index);
  return {result,ready};
 }
 // No new reads after failure. Abort the pending watchdog, discard queued PCM
 // and wait for the bounded producer to settle before the caller closes input.
 async dispose():Promise<void>{
  if(!this.closed){this.closed=true;this.parent.removeEventListener('abort',this.abort);this.controller.abort()}
  await this.tail;this.slots.clear();
 }
}
export type PipelineObservations={version:1;scheduled:number;consumed:number;readyHits:number;failed:number;peakQueued:number;waitMs:number;preparedMs:number};
export function emptyPipeline():PipelineObservations{return {version:1,scheduled:0,consumed:0,readyHits:0,failed:0,peakQueued:0,waitMs:0,preparedMs:0}}
export function pipelineReport(value:PipelineObservations|undefined){
 if(!value)return null;
 return {version:1,scheduled:value.scheduled,consumed:value.consumed,readyHits:value.readyHits,failed:value.failed,
  peakQueued:value.peakQueued,waitMs:Math.round(value.waitMs*100)/100,preparedMs:Math.round(value.preparedMs*100)/100,
  limitation:'Streamed audio only. Scheduled includes queued but discarded work; readyHits counts successfully prepared windows ready at demand. Prepared and wait wall times can overlap ASR, not a measured speedup. Peak queued counts PCM windows (not native decoder or GPU memory).'};
}
