import type {WhisperDownloadProgress} from './ml/manager';
function size(bytes:number){
 const gb=bytes>=1024**3;
 return (bytes/(gb?1024**3:1024**2)).toLocaleString('ru-RU',{maximumFractionDigits:1})+(gb?' ГБ':' МБ');
}
export function WhisperDownloadStatus({name,cached,active,download}:{name:string;cached:boolean|undefined;active:boolean;download?:WhisperDownloadProgress}){
 const phase=download?.phase;
 const preparing=phase==='loading'||phase==='initializing'||phase==='checking';
 const effectiveCache=phase==='ready'&&download.cachedAfter!==undefined?download.cachedAfter:cached;
 let title=effectiveCache===undefined?'Проверяем локальный кэш…':effectiveCache?'В кэше':'Не скачана';
 let detail='';
 if(phase==='loading'){
  title='HTTP-запросы файлов модели';
  detail='Запросов: '+(download.httpRequests??0)+'. Ответ может прийти из HTTP-кэша браузера.';
 }else if(phase==='initializing'){
  title=download.cachedBefore?'Файлы найдены · инициализация':'Проверка и подготовка файлов';
  detail=download.cachedBefore?'Загрузка в оперативную память и создание ONNX-сессии.':'Файлы могут потребовать сетевой загрузки.';
 }else if(phase==='checking'){
  title='Проверяем сохранение файлов';
  detail='Модель уже инициализирована.';
 }else if(phase==='error'){
  title=effectiveCache?'Кэш есть · ошибка подготовки':'Ошибка загрузки или подготовки';
  detail=download.message??'Повторите попытку.';
 }else if(phase==='cancelled'){
  title=effectiveCache?'Подготовка отменена · файлы в кэше':'Подготовка отменена';
  detail='Состояние кэша можно повторно проверить.';
 }else if(phase==='ready'||active){
  title=effectiveCache?'Готова к работе · в кэше':'Готова к работе · кэш не подтверждён';
  detail=effectiveCache?'Повторная инициализация после перезагрузки необходима.':'После перезагрузки могут потребоваться файлы из сети.';
 }else if(effectiveCache){detail='Файлы на устройстве; модель ещё не инициализирована.'}
 if(preparing&&download?.loadedBytes!==undefined){
  detail+=' Обработано файлов: '+size(download.loadedBytes)+' (не сетевой трафик).';
 }
 return <div className={'download-status '+(effectiveCache?'saved':'')} role="status" aria-live="polite" aria-atomic="true">
  <strong>{title}</strong>
  {detail&&<span>{detail}</span>}
  {(preparing||effectiveCache)&&<progress max={100} value={preparing?undefined:100} aria-label={preparing?`Подготовка ${name}`:`Файлы ${name} в кэше`}/>}
 </div>;
}
