import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import './style.css';
import {ColabWorkspace} from './ColabWorkspace';
import {WhisperDownloadStatus} from './WhisperDownloadStatus';
import {OfflineReadinessPanel} from './OfflineReadinessPanel';
import {DiagnosticsPanel} from './DiagnosticsPanel';
import {JobRunner} from './jobRunner';
import {performanceLabels} from './performance/profiles';
import {JobRow} from './JobRow';
import {useModels} from './useModels';
import {useProtection} from './useProtection';
import type {WhisperId} from './ml/manager';
import type {JobParams,WindowInspectionStrategy} from './jobs';
declare const __ISCRIBE_BUILD_SHA__:string;
const buildRevision=typeof __ISCRIBE_BUILD_SHA__==='string'&&__ISCRIBE_BUILD_SHA__!=='unavailable'?__ISCRIBE_BUILD_SHA__.slice(0,7):'недоступен';
const engineLabels={idle:'Не инициализировано',initializing:'Инициализация',ready:'Готова',transcribing:'Распознавание',recovering:'Восстановление Worker','preloading-speakers':'Загрузка спикеров',diarizing:'Диаризация',cancelled:'Отменено',error:'Ошибка'} as const;
declare const __ISCRIBE_NOTICES_URL__:string;
const models=[{id:'whisper-tiny',name:'Whisper Tiny',tag:'Быстрые заметки',description:'Короткие записи и проверка устройства.'},{id:'whisper-small',name:'Whisper Small',tag:'По умолчанию',description:'Встречи и повседневная работа.'},{id:'whisper-large-v3',name:'Whisper Large v3',tag:'Экспериментальная',description:'Полная модель. Несколько ГБ и высокий расход памяти.'}] as const;
export function App({createRunner}:{createRunner?:()=>JobRunner}={}){
 const [colab,setColab]=useState<'unopened'|'open'|'closed'>('unopened');
 const [runner]=useState(()=>createRunner?createRunner():new JobRunner());
 const state=useSyncExternalStore(runner.subscribe,runner.snapshot,runner.snapshot);
 const [selected,setSelected]=useState<WhisperId>('whisper-small');
 const [language,setLanguage]=useState<'ru'|'en'>('ru');
 const performanceMode=state.performanceMode;
 const [diarize,setDiarize]=useState(true);
 const [drag,setDrag]=useState(false),[error,setError]=useState('');
 const [previewId,setPreviewId]=useState<string|null>(null);
 const [cancelTarget,setCancelTarget]=useState<string|null>(null);
 const openCancel=()=>{setCancelTarget(state.activeId);setCancelOpen(true)};
 const [cancelOpen,setCancelOpen]=useState(false),[removeId,setRemoveId]=useState<string|null>(null);
 const cancelDialog=useRef<HTMLDialogElement>(null),removeDialog=useRef<HTMLDialogElement>(null);
 const input=useRef<HTMLInputElement>(null);
 const colabButton=useRef<HTMLButtonElement>(null);
 const modelState=useModels(runner.manager,state.busy,state.speakerDownload);
 const modelBusy=state.busy;
 useProtection(state.busy,state.activeId);
 useEffect(()=>{void runner.init()},[runner]);
 useEffect(()=>{if(colab==='closed')colabButton.current?.focus()},[colab]);
 useEffect(()=>{if(cancelOpen)cancelDialog.current?.showModal();else cancelDialog.current?.close()},[cancelOpen]);
 useEffect(()=>{if(removeId)removeDialog.current?.showModal();else removeDialog.current?.close()},[removeId]);
 const params:JobParams={model:selected,language,diarize};
 const largeAllowed=()=>window.confirm('Whisper Large v3 — экспериментальная модель. Несколько ГБ загрузки и высокий расход памяти могут привести к закрытию вкладки. Продолжить?');
 const start=(id:string)=>{
  const job=state.jobs.find(j=>j.id===id)!;
  if((job.stage==='waiting'?selected:job.params.model)==='whisper-large-v3'&&!largeAllowed())return;
  runner.enqueue(id,params);
 };
 const add=(files:FileList|File[])=>{setError('');void runner.add(Array.from(files),params).catch(e=>setError(e instanceof Error?e.message:'Не удалось сохранить аудиозапись.'));if(navigator.storage?.persist)void navigator.storage.persist().catch(()=>false)};
 const download=(id:string,variant:'plain'|'time'|'speakers')=>{try{runner.export(id,variant)}catch(e){setError(e instanceof Error?e.message:String(e))}};
 const downloadDiagnostics=(id:string)=>{try{runner.exportDiagnostics(id)}catch(e){setError(e instanceof Error?e.message:String(e))}};
 const downloadBenchmark=(id:string)=>{try{runner.exportBenchmark(id)}catch(e){setError(e instanceof Error?e.message:String(e))}};
 const downloadHardware=(id:string)=>runner.exportHardwareEvidence(id);
 const inspectAudio=(id:string)=>{setError('');void runner.inspectAudio(id).catch(e=>setError(e instanceof Error?e.message:String(e)))};
 const inspectWindow=(id:string,window:number,strategy:WindowInspectionStrategy)=>{setError('');void runner.inspectWindow(id,window,strategy).catch(e=>setError(e instanceof Error?e.message:String(e)))};
 const chosen=state.jobs.find(j=>j.id===previewId)??state.jobs.find(j=>j.id===state.activeId)??state.jobs.at(-1);
 const queue=state.jobs.filter(job=>job.queueOrder!==undefined&&job.stage!=='done')
  .sort((a,b)=>a.queueOrder!-b.queueOrder!||a.id.localeCompare(b.id));
 const queuePositions=new Map(queue.map((job,index)=>[job.id,index+1]));
 const outsideQueue=state.jobs.filter(job=>!queuePositions.has(job.id));
 const orderedJobs=[...queue,...outsideQueue.filter(job=>!job.asrComplete),
  ...outsideQueue.filter(job=>job.asrComplete).sort((a,b)=>a.updated-b.updated)];
 const trash=(id:string)=>{
  if(state.activeId===id)openCancel();
  else if(queuePositions.has(id))runner.dequeue(id);
  else setRemoveId(id);
 };
 const speakerButton=state.speakerDownload==='pending'?(state.activeId?'После текущей записи':'После текущей операции'):
  state.speakerDownload==='loading'?'Загрузка комплекта…':
  modelState.speakers.ready?'Скачано':'Скачать комплект';
 return <>
 <div className="app" hidden={colab==='open'}>
  <header><a className="brand" href="./"><span className="mark">iS</span>iScribe</a><div className="local-header-actions"><span className="local"><i/>Обработка на вашем устройстве</span><button ref={colabButton} type="button" onClick={()=>setColab('open')}>Google Drive / Colab</button></div></header>
  <main>
   <section className="intro"><p className="eyebrow">ИЗ ЗАПИСИ — В ТЕКСТ</p><h1>Лишнее уходит.<span> Нужное остаётся</span></h1><p>Добавьте записи. Получайте текст, время и спикеров — по мере готовности.</p></section>
   <section className="panel model-panel" aria-label="Модели и настройки"><div className="panel-heading"><h2>Модель распознавания</h2><div className="model-settings"><div className="setting-group"><span>Производительность:</span><div className="segmented-setting" role="group" aria-label="Производительность">{([{id:'eco',label:'Экономичная'},{id:'medium',label:'Средняя'},{id:'max',label:'Максимальная'}] as const).map(mode=><button type="button" key={mode.id} aria-pressed={performanceMode===mode.id} onClick={()=>runner.setPerformanceMode(mode.id)}>{mode.label}</button>)}</div></div><div className="setting-group"><span>Язык:</span><div className="segmented-setting" role="group" aria-label="Язык"><button type="button" aria-pressed={language==='ru'} onClick={()=>setLanguage('ru')}>RUS</button><button type="button" aria-pressed={language==='en'} onClick={()=>setLanguage('en')}>ENG</button></div></div></div></div>
    <div className="models">{models.map(m=><article className={'model '+(selected===m.id?'selected':'')} key={m.id}>
     <label className="model-name"><input type="radio" name="model" checked={selected===m.id} onChange={()=>setSelected(m.id)}/><strong>{m.name}</strong></label><span className="tag">{m.tag}</span><p>{m.description}</p>
     <WhisperDownloadStatus name={m.name} cached={modelState.cached[m.id]} active={runner.manager.active===m.id} download={modelState.downloads[m.id]}/>
     <button className="secondary" disabled={modelBusy||(selected===m.id&&runner.manager.active===m.id)} onClick={()=>{if(m.id==='whisper-large-v3'&&!largeAllowed())return;setSelected(m.id);void runner.prepare(m.id)}}>{selected===m.id?(runner.manager.active===m.id?'Выбрана · используется':'Выбрана · '+(modelState.cached[m.id]?'в кэше':'скачать')):modelState.cached[m.id]?'Выбрать':'Скачать'}</button>
    </article>)}
    <article className={'model speakers '+(diarize?'enabled':'')}><label className="model-name"><strong>Разделение говорящих</strong><input type="checkbox" checked={diarize} onChange={e=>setDiarize(e.target.checked)} aria-label="Разделять говорящих"/></label><span className="tag">Pyannote + WeSpeaker</span><p>Кто говорил и когда. После получения текста.</p><div className="download-status" role="status"><strong>{modelState.speakers.ready?'Скачаны · в кэше':'Комплект из двух моделей'}</strong><span>Pyannote: {modelState.speakers.segmentation}</span><span>WeSpeaker: {modelState.speakers.embedding}</span></div><button className="secondary" disabled={state.speakerDownload!=='idle'||modelState.speakers.ready} onClick={()=>void runner.preloadSpeakers()}>{speakerButton}</button></article>
    </div>
     {state.busy&&<p className="next-settings">Модель, язык и спикеры применятся к следующим заданиям. Производительность — на границе следующего окна (WASM может потребовать переинициализацию модели).{state.activeResourcePolicy&&<> Текущий режим: {performanceLabels[state.activeResourcePolicy.effective]}.{state.activeResourcePolicy.reasons.includes('recovery-cap')?' Ограничен после сбоя Worker/GPU.':''}{state.activeResourcePolicy.requested!==performanceMode?' Новый режим ожидает применения.':''}</>}</p>}
   </section>
   <section className="panel audio-panel"><div className="panel-heading"><h2>Аудиозаписи <span className="count">{state.jobs.length}</span></h2><div className="heading-actions">{state.busy&&state.activeId===null&&<button type="button" className="trash-button" onClick={openCancel} aria-label="Отменить операцию" title="Отменить операцию"><span className="trash-icon" aria-hidden="true"/></button>}{state.jobs.filter(j=>j.stage==='waiting').length>1&&<button className="secondary" onClick={()=>{if(selected==='whisper-large-v3'&&!largeAllowed())return;state.jobs.filter(j=>j.stage==='waiting').forEach(j=>runner.enqueue(j.id,params))}}>Начать все</button>}</div></div>
    {state.queueCount>0&&<div className="queue-banner" role="status"><span>Очередь: {state.queueCount} {state.queueCount===1?'задание':'заданий'}{!state.busy?' · восстановлена':''}</span>{!state.busy&&<button className="start" onClick={()=>runner.resumeQueue()}>Продолжить очередь</button>}</div>}
    <div className={'drop '+(drag?'drag':'')} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);if(state.ready)add(e.dataTransfer.files)}}><span className="audio-icon" aria-hidden="true">≋</span><div><h3>Перетащите аудиофайлы сюда</h3><p>Или выберите файлы на компьютере</p></div><button className="secondary" disabled={!state.ready} onClick={()=>input.current?.click()}>Выбрать файлы</button><input ref={input} type="file" multiple accept="audio/*,.mp3,.wav,.m4a,.ogg,.opus,.webm,.aac,.flac" aria-label="Выбрать аудиозаписи" onChange={e=>{if(e.target.files)add(e.target.files);e.target.value=''}}/></div>
    {!state.ready&&<p role="status">Восстанавливаем сохранённые задания…</p>}
    <div className="file-list">{orderedJobs.map(job=><JobRow key={job.id} job={job} active={state.activeId===job.id} onStart={()=>start(job.id)} onExport={variant=>download(job.id,variant)} onTrash={()=>trash(job.id)} onPreview={()=>setPreviewId(job.id)} queuePosition={queuePositions.get(job.id)} checking={state.activeId===job.id&&state.operation.startsWith('Проверка аудио')}/>)}</div>
    {!state.jobs.length&&state.ready&&<p className="empty-list">Добавленные записи появятся здесь. До 500 МБ. Свыше 128 МБ — потоковое распознавание без разметки спикеров.</p>}
   </section>
   {(error||state.notice)&&<p className="notice" role="alert">{error||state.notice}</p>}
   <div className="runtime-bar" role="status"><span className={'activity '+(state.busy?'working':'')}/><strong>{state.busy?(state.operation||'Обработка записи'):'Готов к работе'}</strong><span className="backend">ML: {engineLabels[state.enginePhase]} · ASR: {state.backend} · спикеры: WASM</span></div>
   <DiagnosticsPanel job={chosen} jobs={state.jobs} busy={state.busy} checking={chosen?.id===state.activeId&&state.operation.startsWith('Проверка аудио')}
    onSelect={setPreviewId} onInspect={inspectAudio} onInspectWindow={inspectWindow} onLog={downloadDiagnostics} onBenchmark={downloadBenchmark} onHardware={downloadHardware}>
    <section className="diagnostics-record" aria-label="Сравнение бэкендов"><label><input type="checkbox" disabled={state.busy} checked={state.calibrateNext} onChange={e=>runner.setBackendCalibration(e.target.checked)}/> Сравнить бэкенды при следующем распознавании</label><p>Один локальный фрагмент до 15 с, прогрев и два замера на каждом доступном бэкенде. Возможна дополнительная загрузка файлов той же модели. Результаты теста не добавляются в текст. В средней и максимальной производительности проверенный выбор используется повторно.</p></section>
    <OfflineReadinessPanel model={selected} diarize={diarize} busy={state.busy} onPrepareWasm={()=>void runner.prepare(selected,true)}/>
   </DiagnosticsPanel>
   <p className="privacy">Аудио и результаты сохраняются в этом браузере на вашем устройстве. Перезагрузка остановит вычисления; сохранённую работу можно продолжить. Не очищайте данные сайта до скачивания результатов.</p>
  </main>
  <footer><strong>iScribe</strong><span>Локально. Под вашим контролем.</span><span className="release-id" title="Сборка не прошла аппаратную приёмку">Тестовая сборка · {buildRevision}</span><a href={__ISCRIBE_NOTICES_URL__} target="_blank" rel="noreferrer">Модели и лицензии</a></footer>
  <dialog ref={cancelDialog} onCancel={()=>setCancelOpen(false)} onClose={()=>setCancelOpen(false)}><h2>{cancelTarget?'Убрать запись из очереди?':'Отменить текущую операцию?'}</h2><p>{cancelTarget?'Обработка остановится. Исходная запись и сохранённый текст останутся доступны.':'Текущая подготовка моделей будет остановлена.'}</p><div className="dialog-actions"><button className="start" autoFocus onClick={()=>setCancelOpen(false)}>Продолжить обработку</button><button className="cancel" onClick={()=>{if(runner.snapshot().activeId===cancelTarget)runner.cancel();else setError('Задача уже завершена. Следующая задача не отменена.');setCancelOpen(false)}}>Отменить задачу</button></div></dialog>
  <dialog ref={removeDialog} onCancel={()=>setRemoveId(null)} onClose={()=>setRemoveId(null)}><h2>Удалить запись и результаты?</h2><p>Исходное аудио и сохранённый текст этой записи будут удалены из браузера.</p><div className="dialog-actions"><button className="secondary" autoFocus onClick={()=>setRemoveId(null)}>Оставить</button><button className="cancel" onClick={()=>{if(removeId)void runner.remove(removeId).catch(e=>setError(e instanceof Error?e.message:'Не удалось удалить запись.'));setRemoveId(null)}}>Удалить</button></div></dialog>
 </div>
 {colab!=='unopened'&&<ColabWorkspace hidden={colab!=='open'} onBack={()=>setColab('closed')}/>}
 </>;
}
