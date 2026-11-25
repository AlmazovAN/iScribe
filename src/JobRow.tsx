import type {Job} from './jobs';
import {isRunning,audioWindows} from './jobs';
import {checkpointLabel,checkpointProgress} from './recognitionProgress';
import {benchmarkReport} from './benchmark';
export function JobRow({job,active,onStart,onExport,onCancel,onRemove,onPreview,onDiagnostics,onBenchmark,onInspectAudio,checking=false,inspectDisabled=false,queuePosition}:{job:Job;active:boolean;onStart:()=>void;onExport:(variant:'plain'|'time'|'speakers')=>void;onCancel:()=>void;onRemove:()=>void;onPreview:()=>void;onDiagnostics?:()=>void;onBenchmark?:()=>void;onInspectAudio?:()=>void;checking?:boolean;inspectDisabled?:boolean;queuePosition?:number}){
 const queued=job.stage==='queued',running=isRunning(job.stage),hasText=(job.volatileSegments??job.segments).some(s=>s.text.trim());
 const duration=job.duration,validDuration=typeof duration==='number'&&Number.isFinite(duration)&&duration>0&&duration<=3600;
 const windows=validDuration?audioWindows(Math.round(duration*16000)):[];
 const progress=windows.length?checkpointProgress(windows,Math.min(job.nextWindow,windows.length)):null;
 const retry=job.stage==='partial'||job.stage==='error'||job.stage==='interrupted'||job.stage==='cancelled';
 const benchmark=job.benchmark?.committedWindows?benchmarkReport(job):null;
 const detailsAvailable=!!(job.audioCheck||job.failure||job.diagnostics||benchmark||(!job.asrComplete&&job.nextWindow>0));
 return <article className={'file-row '+(active?'active':'')} aria-label={job.name}>
  <div className="file-info"><span className="file-icon" aria-hidden="true">≋</span><div><button className="file-title" onClick={onPreview} title="Показать текст">{job.name}</button><small>{validDuration?`${Math.floor(duration/60)} мин ${Math.floor(duration%60)} с`:'Длительность уточняется'} · {(job.size/1024/1024).toLocaleString('ru-RU',{maximumFractionDigits:1})} МБ</small></div></div>
  <div className="file-state"><span role="status" aria-live="polite">{job.status}</span>{(running||queued||(!job.asrComplete&&job.nextWindow>0))&&<progress max={100} value={job.stage==='recognizing'||!running?progress?.percent??undefined:job.percent??undefined} aria-label={`Обработка ${job.name}`}/>}<small>{job.params.model.replace('whisper-','Whisper ')} · {job.params.language}{job.asrComplete?' · текст готов':hasText?' · промежуточный текст':''}</small></div>
  <div className="file-actions">
   {(!running&&!queued&&!checking&&(job.stage==='waiting'||retry))&&<button className="start" onClick={onStart}>{job.asrComplete?'Повторить спикеров':job.nextWindow>0?'Продолжить':'Начать'}</button>}
   {queued&&<span className="queued">В очереди{queuePosition?` · №${queuePosition}`:''}</span>}
   <button disabled={!hasText} onClick={()=>onExport('plain')}>Скачать TXT</button>
   <button disabled={!hasText} onClick={()=>onExport('time')}>TXT + time</button>
   <button disabled={!job.speakerSegments?.some(s=>s.text.trim())} onClick={()=>onExport('speakers')}>TXT + time + speaker{job.speakerSegments&&job.stage!=='done'?' *':''}</button>
   {(onInspectAudio||job.trace?.length||job.failure||job.benchmark?.runs)&&<details className="file-tools">
    <summary aria-label={`Дополнительно — ${job.name}`}>Дополнительно</summary>
    <div className="file-tools-menu" role="group" aria-label="Служебные действия">
     {onInspectAudio&&!running&&!queued&&<button type="button" className="secondary" onClick={onInspectAudio} disabled={inspectDisabled||checking} title="Проверить декодирование, PCM и 30-секундные окна без Whisper">{checking?'Проверка аудио…':'Проверить аудио'}</button>}
     {(job.trace?.length||job.failure)&&<button type="button" className="secondary" onClick={onDiagnostics} disabled={!onDiagnostics} title="Скачать журнал без аудио, текста и имени записи">Диагностика JSON</button>}
     {!!job.benchmark?.runs&&<button type="button" className="secondary" onClick={onBenchmark} disabled={!onBenchmark} title="Скачать измерения времени обработки без текста и имени записи">Бенчмарк JSON</button>}
    </div>
   </details>}
   {active?<button className="cancel" onClick={onCancel}>Отменить</button>:!queued&&<button className="remove" onClick={onRemove} aria-label={`Удалить ${job.name}`} title="Удалить запись и сохранённые результаты">×</button>}
  </div>
  {job.volatileSegments&&<small className="diagnostics" role="alert">Текст последнего окна не сохранён в браузере. Скачайте TXT до закрытия вкладки.</small>}
  {job.error&&<p className="row-error" role="alert">{job.error}</p>}
  {detailsAvailable&&<details className="row-details">
   <summary>Подробности обработки{job.nextWindow>0&&!job.asrComplete?' · сохранено окон: '+job.nextWindow:''}{job.diagnostics?.unlabeled?' · без спикера: '+job.diagnostics.unlabeled:''}</summary>
   <div className="row-detail-content">
    {!job.asrComplete&&job.nextWindow>0&&progress&&<small className="diagnostics">{checkpointLabel(progress)}</small>}
    {job.audioCheck?.status==='passed'&&<small className="diagnostics">PCM проверен: {job.audioCheck.report.windowCount} окон · {job.audioCheck.report.quietWindows} тихих · {job.audioCheck.report.nearClippedWindows} с пиковыми уровнями · пик {job.audioCheck.report.peakAbsolute.toFixed(3)}</small>}
    {job.audioCheck?.status==='failed'&&<small className="diagnostics" role="alert">Проверка аудио: {job.audioCheck.problem}</small>}
    {benchmark&&<small className="diagnostics" aria-label="Измерения производительности">Бенчмарк: {benchmark.measuredCommittedWindows} окон · RTF ASR: {benchmark.asrRtf??'—'} · p95 окна: {benchmark.asrWindowMs.p95??'—'} мс · запись контрольных точек: {benchmark.timingsMs.checkpointPersistence??'—'} мс · возобновлений: {benchmark.resumedRuns}{benchmark.mainThreadHeap.observedPeakBytes!==null?' · оценка JS heap: '+(benchmark.mainThreadHeap.observedPeakBytes/1e6).toFixed(1)+' МБ':''}</small>}
    {job.failure&&<small className="diagnostics" aria-label="Диагностика прерывания">Последнее прерывание: {job.failure.reason==='session-ended'?'завершение предыдущей сессии':job.failure.reason==='cancelled'?'отмена пользователем':'ошибка выполнения'} · этап: {job.failure.stage} · сохранено окон: {job.failure.completedWindows}{job.failure.totalWindows!==null?` / ${job.failure.totalWindows}`:''} · до {Math.round(job.failure.checkpointSeconds)} с{job.failure.durationSeconds!==null?` из ${Math.round(job.failure.durationSeconds)} с`:''} · backend: {job.failure.backend??'неизвестен'} · {job.failure.observedExit==='pagehide'?'зафиксирован выход со страницы (не обязательно перезагрузка)':'событие выхода не зафиксировано'} · {job.failure.message}</small>}
    {job.diagnostics&&<small className="diagnostics">Интервалов: {job.diagnostics.turns} · сегментов: {job.diagnostics.segments} · без спикера: {job.diagnostics.unlabeled} · точечных сегментов: {job.diagnostics.zeroDuration}{job.stage==='partial'?' · * частичный результат':''}{job.diagnostics.overlapMatches!==undefined&&<> · пустых ASR: {job.diagnostics.emptyText??0} · по перекрытию: {job.diagnostics.overlapMatches} · границы: {job.diagnostics.boundaryMatches} · неоднозначные: {job.diagnostics.ambiguous} · вне интервалов: {job.diagnostics.uncovered} · слабое перекрытие: {job.diagnostics.weakEvidence}{job.diagnostics.invalidTurns?` · неверные интервалы: ${job.diagnostics.invalidTurns}`:''}</>}</small>}
   </div>
  </details>}
 </article>;
}
