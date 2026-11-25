import {useEffect,useState} from 'react';
import {inspectOfflineReadiness,registerOfflineShell,type OfflineReadiness} from './offline';
import type {WhisperId} from './ml/manager';

export function OfflineReadinessPanel({model,diarize,busy,onPrepareWasm}:{
 model:WhisperId;diarize:boolean;busy:boolean;onPrepareWasm:()=>void
}){
 const [revision,setRevision]=useState(0);
 const [report,setReport]=useState<OfflineReadiness|null>(null);
 const [checking,setChecking]=useState(true);
 useEffect(()=>{
  let live=true;
  const refresh=()=>{if(live)setRevision(n=>n+1)};
  void registerOfflineShell().then(refresh);
  if('serviceWorker' in navigator){
   navigator.serviceWorker.addEventListener('controllerchange',refresh);
   void navigator.serviceWorker.ready.then(refresh).catch(()=>{});
  }
  window.addEventListener('online',refresh);window.addEventListener('offline',refresh);
  return()=>{
   live=false;
   if('serviceWorker' in navigator)navigator.serviceWorker.removeEventListener('controllerchange',refresh);
   window.removeEventListener('online',refresh);window.removeEventListener('offline',refresh);
  };
 },[]);
 useEffect(()=>{
  let live=true;
  setChecking(true);
  void inspectOfflineReadiness(model,diarize).then(result=>{
   if(live){setReport(result);setChecking(false)}
  }).catch(()=>{if(live){setReport(null);setChecking(false)}});
  return()=>{live=false};
 },[model,diarize,revision,busy]);
 const shell=report?.shell;
 const status=report?.preliminaryReady
  ?'Файлы предварительно готовы'
  :report?.registration==='unsupported'
   ?'Автономный запуск не поддерживается'
   :report?.registration==='installing'
    ?'Сохраняем файлы приложения'
    :'Не все файлы доступны';
 return <div className="offline-strip" aria-label="Проверка работы без интернета">
  <div className="offline-head">
   <strong>Автономная работа</strong>
   <span role="status">{checking?'Проверяем локальные файлы…':status}</span>
  </div>
  {report&&<div className="offline-facts">
   <span>Сеть: {report.connection==='online'?'доступна по данным браузера':'отключена'}</span>
   <span>Приложение: {shell?.shellComplete?'сохранено':report.registration==='unsupported'?'не поддерживается':'не подтверждено'}</span>
   <span>ONNX/WASM: {shell?.wasmCached?'сохранён':'не подтверждён'}</span>
   <span>Модель: {report.modelCached?'в кэше':'не полная'}</span>
   <span>Профиль WASM q8: {report.wasmProfileCached?'в кэше':'не найден'}</span>
   {diarize&&<span>Спикеры: {report.speakerFilesCached?'в кэше':'не полные'}</span>}
  </div>}
  <div className="offline-foot">
   <span>Проверяются файлы, а не успешность распознавания. Для подтверждения нужен запуск модели без сети.</span>
   <button type="button" className="secondary" onClick={()=>setRevision(n=>n+1)} disabled={checking}>Проверить кэш</button>
   {report&&!report.wasmProfileCached&&<button type="button" className="secondary" onClick={onPrepareWasm} disabled={busy}>Подготовить WASM</button>}
  </div>
 </div>;
}
