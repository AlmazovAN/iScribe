import {expectedWindows} from './jobDiagnostics';
import type {Job} from './jobs';
import {qualitySummary} from './ml/asrQuality';
import {validateAlignmentCheckpoint} from './ml/forcedAlignment';
import {wordSpeakerSummary} from './ml/speakers';

export function DiagnosticsPanel({job,jobs,onSelect,onLog,onAlignment}:{
 job:Job|undefined;jobs:Job[];onSelect:(id:string)=>void;onLog:(id:string)=>void;onAlignment?:(id:string)=>void;
}){
 const total=expectedWindows(job?.duration,job?.windowPlan);
 const current=job&&total!==null?Math.min(total,Math.max(1,job.nextWindow+1)):null;
 const quality=qualitySummary(job?.asrQuality),wordSpeakers=wordSpeakerSummary(job?.wordSpeakerStats);
 return <section className="panel diagnostics-panel" aria-label="Диагностика">
  <h2>Диагностика</h2>
  <select aria-label="Запись для диагностики" value={job?.id??''} disabled={!jobs.length} onChange={e=>onSelect(e.target.value)}>
   {!jobs.length&&<option value="">Нет записей</option>}
   {jobs.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
  </select>
  <span className="diagnostics-window" aria-live="polite">Номер окна: {current??'—'} из {total??'—'}</span>
  {quality&&<span className="diagnostics-window" title={'Повторы: '+quality.repeatWindows+'; текст при почти нулевом сигнале: '+quality.silentTextWindows+'; таймкоды: '+quality.timestampWindows}>Контроль ASR: {quality.warningWindows} из {quality.examinedWindows} окон с предупреждениями</span>}
  {job&&validateAlignmentCheckpoint(job.alignmentCheckpoint)&&<><span className="diagnostics-window">Alignment: {job.alignmentCheckpoint.alignedSegments} из {job.alignmentCheckpoint.segmentCount} сегментов</span>{onAlignment&&<button type="button" title="Локальный файл содержит текст записи" onClick={()=>onAlignment(job.id)}>JSON слов</button>}</>}
  {wordSpeakers&&<span className="diagnostics-window" title={'Неоднозначные: '+wordSpeakers.ambiguousWords+'; слабое покрытие: '+wordSpeakers.weakWords+'; без покрытия: '+wordSpeakers.uncoveredWords}>Speakers (слова): {wordSpeakers.labeledWords} из {wordSpeakers.alignedWords}</span>}
  <button type="button" disabled={!job} onClick={()=>{if(job)onLog(job.id)}}>Логирование JSON</button>
 </section>;
}
