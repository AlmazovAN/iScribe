import {useEffect,useRef,useState} from 'react';
import type {TranscriptSegment} from '@yourdevice/engine';
import {decodeAudio} from './audio';
import {ModelManager,type WhisperId} from './ml/manager';
export function useRuntime(){
 const [segments,setSegments]=useState<TranscriptSegment[]>([]);
 const [complete,setComplete]=useState(false);
 const [verified,setVerified]=useState<Partial<Record<WhisperId,boolean>>>({});
 const audioAbort=useRef<AbortController|null>(null);
 const [manager]=useState(()=>new ModelManager());
 const [busy,setBusy]=useState(false);
 const [status,setStatus]=useState('Ожидание');
 const [percent,setPercent]=useState<number|null>(0);
 const [error,setError]=useState('');
 const [active,setActive]=useState<WhisperId|null>(null);
 const [backend,setBackend]=useState('Не инициализировано');
 const [cached,setCached]=useState<Partial<Record<WhisperId,boolean>>>({});
 const locked=useRef(false);const epoch=useRef(0);const mounted=useRef(true);
 useEffect(()=>{
  mounted.current=true;
  void Promise.all((['whisper-tiny','whisper-small','whisper-large-v3'] as const).map(async id=>[id,await manager.cached(id)] as const)).then(entries=>{if(mounted.current)setCached(Object.fromEntries(entries))});
  return()=>{mounted.current=false;epoch.current++;audioAbort.current?.abort();manager.cancel()};
 },[manager]);
 manager.onProgress=(text,value)=>{if(mounted.current){setStatus(text);setPercent(value)}};
 async function prepare(id:WhisperId){
  if(locked.current)return;locked.current=true;const run=++epoch.current;setBusy(true);setError('');setActive(null);setBackend('Инициализация…');
  try{
   const result=await manager.prepare(id);if(run!==epoch.current||!mounted.current)return;
   setActive(id);setBackend(result.backend);setCached(c=>({...c,[id]:result.cached}));
   setStatus(result.cached?'Модель активна. Комплект в кеше подтверждён.':'Модель активна; сохранение полного комплекта в кеше не подтверждено.');setPercent(100);
  }catch(e){if(run===epoch.current&&mounted.current){setError(e instanceof Error?e.message:String(e));setStatus('Ошибка инициализации');setActive(null);setBackend('Не инициализировано')}}
  finally{if(run===epoch.current&&mounted.current){locked.current=false;setBusy(false)}}
 }
 async function run(file:File,id:WhisperId){
  if(locked.current)return;
  if(manager.active!==id){setError('Нажмите «Скачать» или «Выбрать» для выбранной модели.');return}
  locked.current=true;const operation=++epoch.current;const controller=new AbortController();audioAbort.current=controller;
  setBusy(true);setError('');setComplete(false);setSegments([]);setStatus('Декодирование аудиофайла…');setPercent(null);
  try{
   const audio=await decodeAudio(file,controller.signal);if(operation!==epoch.current)return;
   const result=await manager.transcribe(audio,partial=>{if(operation===epoch.current&&mounted.current)setSegments(partial)});
   if(operation!==epoch.current||!mounted.current)return;
   if(!result.some(segment=>segment.text.trim()))throw new Error('Распознанных текстовых сегментов нет. Проверьте запись и выбранную модель.');
   setSegments(result);setComplete(true);setVerified(v=>({...v,[id]:true}));setStatus('Расшифровка завершена.');setPercent(100);
  }catch(e){if(operation===epoch.current&&mounted.current){setError(e instanceof Error?e.message:String(e));setStatus('Распознавание не завершено.');setComplete(false)}}
  finally{if(operation===epoch.current&&mounted.current){locked.current=false;setBusy(false)}}
 }
 function cancel(){audioAbort.current?.abort();setComplete(false);locked.current=false;epoch.current++;manager.cancel();setBusy(false);setActive(null);setBackend('Не инициализировано');setStatus('Отменено. Worker освобождён.');setPercent(0)}
 return {busy,status,percent,error,active,backend,cached,prepare,cancel,run,segments,complete,verified};
}
