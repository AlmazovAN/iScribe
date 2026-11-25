import {useState} from 'react';
import type {Job} from './jobs';
import {HARDWARE_GATES} from './hardwareAcceptance';

export function HardwareAcceptancePanel({job,onExport,busy}:{
 job:Job|undefined;
 onExport:(id:string)=>Promise<void>;
 busy:boolean
}){
 const [error,setError]=useState('');
 return <details className="hardware-acceptance">
  <summary>Аппаратная приёмка <span>Не подтверждена</span></summary>
  <p>Этот раздел предназначен для испытаний настоящего Whisper на устройстве. Успешная сборка и автоматические тесты не являются аппаратной приёмкой.</p>
  <div className="hardware-acceptance-heading">
   <strong>Контрольные испытания</strong>
   <span>7 проверок · выполнение на реальном аудио</span>
  </div>
  <ol>{HARDWARE_GATES.map(gate=><li key={gate.id}><strong>{gate.id}</strong> {gate.label}<small>Не проверено</small></li>)}</ol>
  <p>Перед проверкой откройте исходную запись длительностью 14:31, выберите Whisper Small и сохраните TXT. Для проверки восстановления перезагрузите страницу после двух сохранённых окон. Отдельно испытайте диаризацию, офлайн-режим и восстановление WASM.</p>
  <p>Выгрузка протокола подтверждает лишь наличие данных и контрольных точек в этом браузере. Подлинность модели, точность спикеров и расход RAM требуют ручной проверки.</p>
  <div className="hardware-acceptance-actions">
   <span>{job?'Выбранное задание: '+job.name:'Сначала добавьте аудиофайл'}</span>
   <button type="button" className="secondary" disabled={!job||busy||job.stage==='queued'||job.stage==='preparing'||job.stage==='recognizing'||job.stage==='speakers'}
    onClick={()=>{if(!job)return;setError('');void onExport(job.id).catch(e=>setError(e instanceof Error?e.message:'Не удалось сформировать протокол.'))}}>
    Скачать протокол наблюдений JSON
   </button>
  </div>
  {error&&<p role="alert">{error}</p>}
 </details>;
}
