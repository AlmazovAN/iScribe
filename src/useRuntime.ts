import {useEffect,useRef,useState} from 'react';
import {ModelManager,type WhisperId} from './ml/manager';
export function useRuntime(){
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
  return()=>{mounted.current=false;epoch.current++;manager.cancel()};
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
 function cancel(){locked.current=false;epoch.current++;manager.cancel();setBusy(false);setActive(null);setBackend('Не инициализировано');setStatus('Отменено. Worker освобождён.');setPercent(0)}
 return {busy,status,percent,error,active,backend,cached,prepare,cancel};
}
