import {useEffect,useState} from 'react';
import type {ModelManager,WhisperDownloadProgress,WhisperId} from './ml/manager';
export function useModels(manager:ModelManager,busy:boolean){
 const [cached,setCached]=useState<Partial<Record<WhisperId,boolean>>>({});
 const [downloads,setDownloads]=useState<Partial<Record<WhisperId,WhisperDownloadProgress>>>({});
 const [speakers,setSpeakers]=useState({segmentation:'Проверка кэша',embedding:'Проверка кэша',ready:false});
 useEffect(()=>{
  manager.onWhisperProgress=(id,progress)=>{
   setDownloads(d=>({...d,[id]:progress}));
   if(progress.phase==='ready'&&progress.cachedAfter!==undefined)setCached(s=>({...s,[id]:progress.cachedAfter}));
  };
  manager.onSpeakerProgress=(id,status)=>setSpeakers(s=>({...s,[id]:status}));
  return()=>{manager.onWhisperProgress=()=>{};manager.onSpeakerProgress=()=>{}};
 },[manager]);
 useEffect(()=>{
  if(busy)return;let alive=true;
  void Promise.all((['whisper-tiny','whisper-small','whisper-large-v3'] as const).map(async id=>[id,await manager.cached(id)] as const)).then(entries=>{if(alive)setCached(Object.fromEntries(entries))});
  void manager.speakersCached().then(c=>{if(alive)setSpeakers({segmentation:c.segmentation?'В кэше':'Не скачана',embedding:c.embedding?'В кэше':'Не скачана',ready:c.segmentation&&c.embedding})});
  return()=>{alive=false};
 },[manager,busy]);
 return {cached,downloads,speakers};
}
