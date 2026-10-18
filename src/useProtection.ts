import {useEffect} from 'react';
import {recordPageExit} from './jobDiagnostics';
export function useProtection(busy:boolean,activeId:string|null){
 useEffect(()=>{
  if(!busy)return;
  const beforeUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=''};
  window.addEventListener('beforeunload',beforeUnload);
  const pageExit=()=>{if(activeId)recordPageExit(activeId)};
  window.addEventListener('pagehide',pageExit);
  // Screen Wake Lock is best-effort. Persistence, not this lock, protects text.
  let active=true,sentinel:WakeLockSentinel|undefined;
  const acquire=async()=>{
   if(document.visibilityState!=='visible'||!navigator.wakeLock)return;
   try{const lock=await navigator.wakeLock.request('screen');if(!active){await lock.release();return}sentinel=lock}catch{/* Unsupported/denied; checkpoints remain the recovery mechanism. */}
  };
  void acquire();const visible=()=>{if(!sentinel||sentinel.released)void acquire()};document.addEventListener('visibilitychange',visible);
  return()=>{active=false;window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('pagehide',pageExit);document.removeEventListener('visibilitychange',visible);void sentinel?.release()};
 },[busy,activeId]);
}
