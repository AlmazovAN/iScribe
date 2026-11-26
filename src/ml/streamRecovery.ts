import {DEFAULT_STREAM_DECODE_IDLE_MS,StreamDecodeStalledError,withActivityWatchdog} from './activityWatchdog';

export const MAX_STREAM_WINDOW_ATTEMPTS=3;
type Reader<W>={length:number;read(window:W):Promise<Float32Array>;close():void};

// Own one decoder generation at a time. A timed-out or failed generation is
// never reused; a late result cannot become the caller's checkpoint.
export async function openRecoverableStream<W>(
 open:(signal:AbortSignal)=>Promise<Reader<W>>,
 signal:AbortSignal,
 timeoutMs=DEFAULT_STREAM_DECODE_IDLE_MS
){
 let active:Reader<W>|undefined;
 let controller:AbortController|undefined;
 let closed=false;
 const dispose=()=>{
  const previous=active;active=undefined;
  controller?.abort();controller=undefined;
  try{previous?.close()}catch{/* Best-effort disposal of a failed decoder. */}
 };
 const close=()=>{
  if(closed)return;
  closed=true;signal.removeEventListener('abort',close);dispose();
 };
 const check=()=>{
  signal.throwIfAborted();
  if(closed)throw new Error('Потоковый декодер закрыт.');
 };
 const options={
  signal,timeoutMs,pollMs:Math.min(1000,Math.max(5,timeoutMs/4)),
  timeoutError:()=>new StreamDecodeStalledError()
 };
 const reopen=async()=>{
  check();dispose();
  const generation=new AbortController();controller=generation;
  const reader=await withActivityWatchdog(async()=>{
   const candidate=await open(generation.signal);
   if(generation.signal.aborted){
    candidate.close();generation.signal.throwIfAborted();
   }
   return candidate;
  },{...options,onTimeout:()=>generation.abort()});
  if(closed||signal.aborted){reader.close();check()}
  active=reader;
  return reader;
 };
 signal.addEventListener('abort',close,{once:true});
 try{
  const length=(await reopen()).length;
  return {
   length,close,
   async read(window:W,onRetry?:(nextAttempt:number,error:unknown)=>void):Promise<Float32Array>{
    for(let attempt=1;attempt<=MAX_STREAM_WINDOW_ATTEMPTS;attempt++){
     check();
     try{
      const reader=active??await reopen();
      if(reader.length!==length)throw new Error('Длительность аудио изменилась при восстановлении декодера.');
      const pcm=await withActivityWatchdog(()=>reader.read(window),{...options,onTimeout:dispose});
      check();return pcm;
     }catch(error){
      dispose();
      check();
      if(attempt===MAX_STREAM_WINDOW_ATTEMPTS)throw error;
      onRetry?.(attempt+1,error);
     }
    }
    throw new Error('Не удалось прочитать окно аудио.');
   }
  };
 }catch(error){close();throw error}
}
