import {useEffect,useRef,useState} from 'react';
import type {TranscriptSegment} from '@yourdevice/engine';
import {decodeAudio} from './audio';
import {ModelManager,type WhisperId} from './ml/manager';
export function useRuntime(){
 const [speakerStages,setSpeakerStages]=useState({segmentation:'Кеш не подтверждён',embedding:'Кеш не подтверждён'});
 const [speakersReady,setSpeakersReady]=useState(false);
 const [warning,setWarning]=useState('');
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
  void manager.speakersCached().then(cache=>{if(mounted.current){setSpeakersReady(cache.segmentation&&cache.embedding);setSpeakerStages({segmentation:cache.segmentation?'В кеше':'Кеш не подтверждён',embedding:cache.embedding?'В кеше':'Кеш не подтверждён'})}});
  return()=>{mounted.current=false;epoch.current++;audioAbort.current?.abort();manager.cancel()};
 },[manager]);
 manager.onSpeakerProgress=(id,stage)=>{if(mounted.current)setSpeakerStages(s=>({...s,[id]:stage}))};
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
 async function preloadSpeakers(){
  if(locked.current)return;locked.current=true;const operation=++epoch.current;
  setBusy(true);setError('');setSpeakersReady(false);setActive(null);setBackend('Не инициализировано');setStatus('Загрузка моделей говорящих…');setPercent(null);
  try{
   await manager.preloadSpeakers();if(operation!==epoch.current||!mounted.current)return;
   setSpeakersReady(true);setSpeakerStages({segmentation:'В кеше',embedding:'В кеше'});setStatus('Обе модели говорящих в кеше. Выберите Whisper для запуска.');setPercent(100);
  }catch(e){if(operation===epoch.current&&mounted.current){setError(e instanceof Error?e.message:String(e));setStatus('Загрузка моделей говорящих не завершена.')}}
  finally{if(operation===epoch.current&&mounted.current){locked.current=false;setBusy(false)}}
 }
 async function run(file:File,id:WhisperId,diarize:boolean){
  if(locked.current)return;
  if(manager.active!==id){setError('Нажмите «Скачать» или «Выбрать» для выбранной модели.');return}
  locked.current=true;const operation=++epoch.current;const controller=new AbortController();audioAbort.current=controller;
  setBusy(true);setError('');setWarning('');setComplete(false);setSegments([]);setStatus('Декодирование аудиофайла…');setPercent(null);
  try{
   if(diarize){const cache=await manager.speakersCached();if(!cache.segmentation||!cache.embedding){setSpeakersReady(false);throw new Error('Сначала нажмите «Скачать модели говорящих» или отключите разделение говорящих.')}}
   const audio=await decodeAudio(file,controller.signal);if(operation!==epoch.current)return;
   const result=await manager.transcribe(audio,diarize,partial=>{if(operation===epoch.current&&mounted.current)setSegments(partial)});
   if(operation!==epoch.current||!mounted.current)return;
   if(!result.some(segment=>segment.text.trim()))throw new Error('Распознанных текстовых сегментов нет. Проверьте запись и выбранную модель.');
   const partial=diarize&&result.some(segment=>!segment.speaker?.trim());
   setWarning(partial?'Частичный результат: для некоторых или всех сегментов отсутствуют метки говорящих. Диаризация не подтверждена.':'');
   setSegments(result);setComplete(!partial);setVerified(v=>({...v,[id]:true}));setStatus(partial?'Частичный результат — диаризация не завершена.':diarize?'Текст и метки получены. Качество разделения требует проверки.':'Расшифровка завершена.');setPercent(100);
  }catch(e){if(operation===epoch.current&&mounted.current){setError(e instanceof Error?e.message:String(e));setStatus('Распознавание не завершено.');setComplete(false)}}
  finally{if(operation===epoch.current&&mounted.current){locked.current=false;setBusy(false)}}
 }
 function cancel(){audioAbort.current?.abort();setComplete(false);locked.current=false;epoch.current++;manager.cancel();setBusy(false);setActive(null);setBackend('Не инициализировано');setStatus('Отменено. Worker освобождён.');setPercent(0)}
 return {busy,status,percent,error,active,backend,cached,prepare,cancel,run,segments,complete,verified,speakerStages,speakersReady,preloadSpeakers,warning};
}
