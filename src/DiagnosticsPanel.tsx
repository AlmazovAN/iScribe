import {expectedWindows} from './jobDiagnostics';
import type {Job} from './jobs';

export function DiagnosticsPanel({job,jobs,onSelect,onLog}:{
 job:Job|undefined;jobs:Job[];onSelect:(id:string)=>void;onLog:(id:string)=>void;
}){
 const total=expectedWindows(job?.duration);
 const current=job&&total!==null?Math.min(total,Math.max(1,job.nextWindow+1)):null;
 return <section className="panel diagnostics-panel" aria-label="Диагностика">
  <h2>Диагностика</h2>
  <select aria-label="Запись для диагностики" value={job?.id??''} disabled={!jobs.length} onChange={e=>onSelect(e.target.value)}>
   {!jobs.length&&<option value="">Нет записей</option>}
   {jobs.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
  </select>
  <span className="diagnostics-window" aria-live="polite">Номер окна: {current??'—'} из {total??'—'}</span>
  <button type="button" disabled={!job} onClick={()=>{if(job)onLog(job.id)}}>Логирование JSON</button>
 </section>;
}
