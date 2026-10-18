import type {Job} from './jobs';
import {isRunning} from './jobs';
export function JobRow({job,active,onStart,onExport,onCancel,onRemove,onPreview}:{job:Job;active:boolean;onStart:()=>void;onExport:(variant:'plain'|'time'|'speakers')=>void;onCancel:()=>void;onRemove:()=>void;onPreview:()=>void}){
 const queued=job.stage==='queued',running=isRunning(job.stage),hasText=job.segments.some(s=>s.text.trim());
 const retry=job.stage==='partial'||job.stage==='error'||job.stage==='interrupted'||job.stage==='cancelled';
 return <article className={'file-row '+(active?'active':'')} aria-label={job.name}>
  <div className="file-info"><span className="file-icon" aria-hidden="true">≋</span><div><button className="file-title" onClick={onPreview} title="Показать текст">{job.name}</button><small>{job.duration?`${Math.floor(job.duration/60)} мин ${Math.floor(job.duration%60)} с`:'Длительность уточняется'} · {(job.size/1024/1024).toLocaleString('ru-RU',{maximumFractionDigits:1})} МБ</small></div></div>
  <div className="file-state"><span role="status">{job.status}</span>{(running||queued)&&<progress max={100} value={job.percent??undefined} aria-label={`Обработка ${job.name}`}/>}<small>{job.params.model.replace('whisper-','Whisper ')} · {job.params.language}{job.asrComplete?' · текст готов':hasText?' · промежуточный текст':''}</small></div>
  <div className="file-actions">
   {(!running&&!queued&&(job.stage==='waiting'||retry))&&<button className="start" onClick={onStart}>{job.asrComplete?'Повторить спикеров':job.nextWindow>0?'Продолжить':'Начать'}</button>}
   {queued&&<span className="queued">В очереди</span>}
   <button disabled={!hasText} onClick={()=>onExport('plain')}>Скачать TXT</button>
   <button disabled={!hasText} onClick={()=>onExport('time')}>TXT + time</button>
   <button disabled={!job.speakerSegments?.some(s=>s.text.trim())} onClick={()=>onExport('speakers')}>TXT + time + speaker{job.speakerSegments&&job.stage!=='done'?' *':''}</button>
   {active?<button className="cancel" onClick={onCancel}>Отменить</button>:!queued&&<button className="remove" onClick={onRemove} aria-label={`Удалить ${job.name}`} title="Удалить запись и сохранённые результаты">×</button>}
  </div>
  {job.error&&<p className="row-error" role="alert">{job.error}</p>}
  {job.failure&&<small className="diagnostics" aria-label="Диагностика прерывания">Последнее прерывание: {job.failure.reason==='session-ended'?'завершение предыдущей сессии':job.failure.reason==='cancelled'?'отмена пользователем':'ошибка выполнения'} · этап: {job.failure.stage} · сохранено окон: {job.failure.completedWindows}{job.failure.totalWindows!==null?` / ${job.failure.totalWindows}`:''} · до {Math.round(job.failure.checkpointSeconds)} с{job.failure.durationSeconds!==null?` из ${Math.round(job.failure.durationSeconds)} с`:''} · backend: {job.failure.backend??'неизвестен'} · {job.failure.observedExit==='pagehide'?'зафиксирован выход со страницы (не обязательно перезагрузка)':'событие выхода не зафиксировано'} · {job.failure.message}</small>
  {job.diagnostics&&<small className="diagnostics">Интервалов: {job.diagnostics.turns} · сегментов: {job.diagnostics.segments} · без спикера: {job.diagnostics.unlabeled} · точечных сегментов: {job.diagnostics.zeroDuration}{job.stage==='partial'?' · * частичный результат':''}</small>}
 </article>;
}
