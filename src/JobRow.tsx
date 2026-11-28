import {memo,useMemo} from 'react';
import type {Job} from './jobs';
import {usesStreamedAudio} from './audio';
import {isRunning,audioWindows} from './jobs';
import {checkpointProgress} from './recognitionProgress';
import {validateSpeechPlan} from './speechSegmentation';
import {formatTime} from './formatTranscript';
export const JobRow=memo(function JobRow({job,active,onStart,onExport,onTrash,onPreview,queuePosition}:{job:Job;active:boolean;onStart:(id:string)=>void;onExport:(id:string,variant:'plain'|'time'|'speakers')=>void;onTrash:(id:string)=>void;onPreview:(id:string)=>void;queuePosition?:number}){
 const queued=queuePosition!==undefined&&!active,running=isRunning(job.stage);
 const textSegments=job.volatileSegments??job.segments;
 const hasText=useMemo(()=>textSegments.some(s=>s.text.trim()),[textSegments]);
 const hasSpeakers=useMemo(()=>Boolean(job.speakerSegments?.some(s=>s.text.trim())),[job.speakerSegments]);
 const lastTextEnd=useMemo(()=>job.segments.reduce((end,segment)=>Number.isFinite(segment.end)?Math.max(end,segment.end):end,0),[job.segments]);
 const streamed=usesStreamedAudio(job.size);
 const duration=job.duration,validDuration=typeof duration==='number'&&Number.isFinite(duration)&&duration>0&&(streamed||duration<=3600);
 const samples=validDuration?Math.round(duration*16000):0;
 const windows=useMemo(()=>job.windowPlan!==undefined
  ?(validateSpeechPlan(job.windowPlan,samples)?job.windowPlan.windows:[])
  :Number.isSafeInteger(samples)&&(!streamed||Math.ceil(samples/(25*16000))<=job.size)?audioWindows(samples,streamed):[],[samples,streamed,job.size,job.windowPlan]);
 const progress=windows.length&&Number.isInteger(job.nextWindow)&&job.nextWindow>=0&&job.nextWindow<=windows.length?checkpointProgress(windows,job.nextWindow):null;
 const retry=job.stage==='partial'||job.stage==='error'||job.stage==='interrupted'||job.stage==='cancelled';
 const status=
  active&&queuePosition!==undefined&&job.stage!=='recognizing'&&!job.asrComplete?'Ожидание окружения':
  active&&(job.stage==='recognizing'||job.stage==='speakers')?'Распознавание':
  queued?'Ожидание очереди':
  job.asrComplete?'Распознано':
  job.stage==='waiting'?'Ожидание запуска':job.status;
 const hasMeter=running||queued||job.nextWindow>0;
 const currentWindow=progress&&job.stage==='recognizing'
  ?Math.min(progress.completedWindows+1,progress.totalWindows):progress?.completedWindows;
 const timeline=(seconds:number)=>progress
  ?`${formatTime(seconds)} / ${formatTime(progress.totalSeconds)}`:'—';
 const timeCodeEnd=job.asrComplete?progress?.totalSeconds??0:Math.min(progress?.seconds??0,
  lastTextEnd);
 const speakerPercent=job.stage==='speakers'?Math.max(0,Math.min(job.percent??0,100)):job.speakerSegments?100:0;
 const speakerTime=(progress?.totalSeconds??0)*speakerPercent/100;
 const speakerStatus=!job.params.diarize?'Отключено':streamed?'Недоступно в потоковом режиме':
  (job.stage==='speakers'&&speakerPercent>0&&speakerPercent<100?'≈ ':'')+timeline(speakerTime);
 const detail=job.stage==='recognizing'?(job.error?'Восстановление Worker · повтор окна':null):
  queued&&job.status==='В очереди'?null:job.status;
 const trashLabel=(queuePosition!==undefined||active?'Убрать из очереди':'Удалить запись')+' · '+job.name;
 return <article className={'file-row '+(active?'active':'')} aria-label={job.name}>
  <div className="file-info"><span className="file-icon" aria-hidden="true">≋</span><div><button className="file-title" onClick={()=>onPreview(job.id)} title="Выбрать запись для диагностики">{job.name}</button><small>{validDuration?`${Math.floor(duration/60)} мин ${Math.floor(duration%60)} с`:'Длительность уточняется'} · {(job.size/1024/1024).toLocaleString('ru-RU',{maximumFractionDigits:1})} МБ{streamed?' · потоковый режим':''}</small></div></div>
  <div className="file-state">
   <div className="file-queue-status">
    {queuePosition!==undefined&&<span className="file-queue-number" aria-label={'Место в очереди: '+queuePosition}>{queuePosition}</span>}
    <strong>{status}</strong>
    <span className="file-model">{job.params.model.replace('whisper-','Whisper ')}</span>
   </div>
   {detail&&status!==detail&&<span className="file-state-detail" role="status" aria-live="polite">{detail}</span>}
   {hasMeter&&<>
    <dl className="file-progress-metrics">
     <dt>Whisper</dt><dd title="Текущее окно и сохранённое время">{progress?`${currentWindow}/${progress.totalWindows} (${timeline(progress.seconds)})`:'—'}</dd>
     <dt>Time codes</dt><dd title="Позиция последнего сохранённого таймкода">{timeline(timeCodeEnd)}</dd>
     <dt>Speakers</dt><dd title={job.stage==='speakers'?'Оценка по прогрессу разделения говорящих':undefined}>{speakerStatus}</dd>
    </dl>
    <div className="file-progress-track" data-processing={active&&running}>
     <progress max={100} value={job.stage==='speakers'?job.percent??undefined:progress?.percent} aria-label={`Обработка ${job.name}`}/>
    </div>
   </>}
   <small>{job.params.language}{job.backend?' · '+job.backend:''}{job.decoderIdentity?' · '+(job.decoderIdentity.kind==='ffmpeg'?'FFmpeg':job.decoderIdentity.route==='windowed'?'MediaBunny':'Web Audio'):''}{job.windowPlan?' · адаптивные окна':''}{!job.asrComplete&&hasText?' · промежуточный текст':''}</small>
  </div>
  <div className="file-actions">
   {(!active&&!running&&(!queued||job.stage==='interrupted')&&(job.stage==='waiting'||retry))&&<button className="start" onClick={()=>onStart(job.id)}>{job.asrComplete?'Повторить спикеров':job.nextWindow>0?'Продолжить':'Начать'}</button>}
   <button disabled={!hasText} onClick={()=>onExport(job.id,'plain')}>Скачать TXT</button>
   <button disabled={!hasText} onClick={()=>onExport(job.id,'time')}>TXT + time</button>
   <button disabled={!hasSpeakers} onClick={()=>onExport(job.id,'speakers')}>TXT + time + speaker{job.speakerSegments&&job.stage!=='done'?' *':''}</button>
   <button type="button" className="trash-button" onClick={()=>onTrash(job.id)} aria-label={trashLabel} title={trashLabel}><span className="trash-icon" aria-hidden="true"/></button>
  </div>
  {job.volatileSegments&&<small className="diagnostics" role="alert">Текст последнего окна не сохранён в браузере. Скачайте TXT до закрытия вкладки.</small>}
  {job.error&&<p className="row-error" role="alert">{job.error}</p>}
 </article>;
});
