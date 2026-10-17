import type {WhisperDownloadProgress} from './ml/manager';
function size(bytes:number){
 const gb=bytes>=1024**3;return (bytes/(gb?1024**3:1024**2)).toLocaleString('ru-RU',{maximumFractionDigits:1})+(gb?' ГБ':' МБ');
}
export function WhisperDownloadStatus({name,cached,active,download}:{name:string;cached:boolean|undefined;active:boolean;download?:WhisperDownloadProgress}){
 const loading=download?.phase==='loading';
 const loaded=download?.loadedBytes;
 const total=download?.totalBytes;
 const percent=loaded!==undefined&&Number.isFinite(loaded)&&total!==undefined&&Number.isFinite(total)&&total>0?Math.min(100,Math.max(0,Math.floor(loaded/total*100))):undefined;
 let title=cached===undefined?'Проверяем скачанные файлы…':cached?'Скачана':'Не скачана';
 let detail=cached?'В кэше':'';
 if(loading){
  title=percent===100?'Файлы получены · подготовка модели…':percent!==undefined?`Скачивание: ${percent}%`:cached?'Подготовка к работе…':'Начинаем скачивание…';
  detail=loaded!==undefined?`${size(loaded)}${total&&total>0?' из '+size(total):' · полный объём уточняется'}`:'Ожидаем данные загрузки';
 }else if(download?.phase==='checking'){title='Проверяем сохранение модели…';detail=''}
 else if(download?.phase==='error'){title=cached?'Скачана · ошибка подготовки':'Ошибка загрузки или подготовки';detail=download.message??'Повторите попытку.'}
 else if(download?.phase==='cancelled'){title=cached?'Скачана · подготовка отменена':'Скачивание отменено';detail=cached?'Файлы сохранены в этом браузере.':'Полная загрузка не подтверждена.'}
 else if(active){title=cached?'Скачана · готова к работе':'Готова к работе';detail=cached?'В кэше':'Сохранение не подтверждено.'}
 const pending=loading||download?.phase==='checking'||(cached===undefined&&!download);
 return <div className={'download-status '+(cached?'saved':'')} role="status" aria-live="polite" aria-atomic="true">
  <strong>{title}</strong>
  {detail&&<span>{detail}</span>}
  {(pending||cached)&&<progress max={100} value={pending?(loading?percent:undefined):100} aria-label={`Загрузка ${name}`}/>}
 </div>;
}
