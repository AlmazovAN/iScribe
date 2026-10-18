import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import './style.css';
import {WhisperDownloadStatus} from './WhisperDownloadStatus';
import {JobRunner} from './jobRunner';
import {JobRow} from './JobRow';
import {useModels} from './useModels';
import {useProtection} from './useProtection';
import {formatTranscript} from './formatTranscript';
import type {WhisperId} from './ml/manager';
import type {JobParams} from './jobs';
const models=[{id:'whisper-tiny',name:'Whisper Tiny',tag:'Быстрые заметки',description:'Короткие записи и проверка устройства.'},{id:'whisper-small',name:'Whisper Small',tag:'По умолчанию',description:'Встречи и повседневная работа.'},{id:'whisper-large-v3',name:'Whisper Large v3',tag:'Экспериментальная',description:'Полная модель. Несколько ГБ и высокий расход памяти.'}] as const;
export function App(){
 const [runner]=useState(()=>new JobRunner());
 const state=useSyncExternalStore(runner.subscribe,runner.snapshot,runner.snapshot);
 const [selected,setSelected]=useState<WhisperId>('whisper-small');
 const [language,setLanguage]=useState<'ru'|'en'>('ru');
 const [diarize,setDiarize]=useState(true);
 const [drag,setDrag]=useState(false),[error,setError]=useState('');
 const [previewId,setPreviewId]=useState<string|null>(null);
 const [cancelTarget,setCancelTarget]=useState<string|null>(null);
 const openCancel=()=>{setCancelTarget(state.activeId);setCancelOpen(true)};
 const [cancelOpen,setCancelOpen]=useState(false),[removeId,setRemoveId]=useState<string|null>(null);
 const cancelDialog=useRef<HTMLDialogElement>(null),removeDialog=useRef<HTMLDialogElement>(null);
 const input=useRef<HTMLInputElement>(null);
 const modelState=useModels(runner.manager,state.busy);
 useProtection(state.busy);
 useEffect(()=>{void runner.init()},[runner]);
 useEffect(()=>{if(cancelOpen)cancelDialog.current?.showModal();else cancelDialog.current?.close()},[cancelOpen]);
 useEffect(()=>{if(removeId)removeDialog.current?.showModal();else removeDialog.current?.close()},[removeId]);
 const params:JobParams={model:selected,language,diarize};
 const largeAllowed=()=>window.confirm('Whisper Large v3 — экспериментальная модель. Несколько ГБ загрузки и высокий расход памяти могут привести к закрытию вкладки. Продолжить?');
 const start=(id:string)=>{
  const job=state.jobs.find(j=>j.id===id)!;
  if((job.stage==='waiting'?selected:job.params.model)==='whisper-large-v3'&&!largeAllowed())return;
  runner.enqueue(id,params);
 };
 const add=(files:FileList|File[])=>{setError('');void runner.add(Array.from(files),params);if(navigator.storage?.persist)void navigator.storage.persist().catch(()=>false)};
 const download=(id:string,variant:'plain'|'time'|'speakers')=>{try{runner.export(id,variant)}catch(e){setError(e instanceof Error?e.message:String(e))}};
 const chosen=state.jobs.find(j=>j.id===previewId)??state.jobs.find(j=>j.id===state.activeId)??state.jobs.at(-1);
 let preview='';try{if(chosen)preview=formatTranscript(chosen.speakerSegments??chosen.volatileSegments??chosen.segments,{timestamps:true,diarize:!!chosen.speakerSegments})}catch{preview='Не удалось сформировать предпросмотр. Проверьте временные метки.'}
 return <div className="app">
  <header><a className="brand" href="./"><span className="mark">iS</span>iScribe</a><span className="local"><i/>Обработка на вашем устройстве</span></header>
  <main>
   <section className="intro"><p className="eyebrow">ИЗ ЗАПИСИ — В ТЕКСТ</p><h1>Слова остаются.<span> Всё лишнее — уходит.</span></h1><p>Добавьте записи. Получайте текст, время и спикеров — по мере готовности.</p></section>
   <section className="panel model-panel" aria-label="Модели и настройки"><div className="panel-heading"><h2>Модель распознавания</h2><label className="language">Язык <select value={language} onChange={e=>setLanguage(e.target.value as 'ru'|'en')}><option value="ru">Русский</option><option value="en">English</option></select></label></div>
    <div className="models">{models.map(m=><article className={'model '+(selected===m.id?'selected':'')} key={m.id}>
     <label className="model-name"><input type="radio" name="model" checked={selected===m.id} onChange={()=>setSelected(m.id)}/><strong>{m.name}</strong></label><span className="tag">{m.tag}</span><p>{m.description}</p>
     <WhisperDownloadStatus name={m.name} cached={modelState.cached[m.id]} active={runner.manager.active===m.id} download={modelState.downloads[m.id]}/>
     <button className="secondary" disabled={state.busy} onClick={()=>{setSelected(m.id);if(m.id!=='whisper-large-v3'||largeAllowed())void runner.prepare(m.id)}}>{runner.manager.active===m.id?'Готова к работе':modelState.cached[m.id]?'Выбрать':'Скачать'}</button>
    </article>)}
    <article className={'model speakers '+(diarize?'enabled':'')}><label className="model-name"><strong>Разделение говорящих</strong><input type="checkbox" checked={diarize} onChange={e=>setDiarize(e.target.checked)} aria-label="Разделять говорящих"/></label><span className="tag">Pyannote + WeSpeaker</span><p>Кто говорил и когда. После получения текста.</p><div className="download-status" role="status"><strong>{modelState.speakers.ready?'Скачаны · в кэше':'Комплект из двух моделей'}</strong><span>Pyannote: {modelState.speakers.segmentation}</span><span>WeSpeaker: {modelState.speakers.embedding}</span></div><button className="secondary" disabled={state.busy||modelState.speakers.ready} onClick={()=>void runner.preloadSpeakers()}>{modelState.speakers.ready?'Готово к работе':'Скачать комплект'}</button></article>
    </div>
    {state.busy&&<p className="next-settings">Настройки применятся к следующим заданиям. Текущая обработка продолжится со своими параметрами.</p>}
   </section>
   <section className="panel audio-panel"><div className="panel-heading"><h2>Аудиозаписи <span className="count">{state.jobs.length}</span></h2><div className="heading-actions">{state.busy&&<button className="cancel" onClick={openCancel}>Отменить</button>}{state.jobs.filter(j=>j.stage==='waiting').length>1&&<button className="secondary" onClick={()=>{if(selected==='whisper-large-v3'&&!largeAllowed())return;state.jobs.filter(j=>j.stage==='waiting').forEach(j=>runner.enqueue(j.id,params))}}>Начать все</button>}</div></div>
    <div className={'drop '+(drag?'drag':'')} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);if(state.ready)add(e.dataTransfer.files)}}><span className="audio-icon" aria-hidden="true">≋</span><div><h3>Перетащите аудиофайлы сюда</h3><p>Или выберите файлы на компьютере</p></div><button className="secondary" disabled={!state.ready} onClick={()=>input.current?.click()}>Выбрать файлы</button><input ref={input} type="file" multiple accept="audio/*,.mp3,.wav,.m4a,.ogg,.opus,.webm,.aac,.flac" aria-label="Выбрать аудиозаписи" onChange={e=>{if(e.target.files)add(e.target.files);e.target.value=''}}/></div>
    {!state.ready&&<p role="status">Восстанавливаем сохранённые задания…</p>}
    <div className="file-list">{state.jobs.map(job=><JobRow key={job.id} job={job} active={state.activeId===job.id} onStart={()=>start(job.id)} onExport={variant=>download(job.id,variant)} onCancel={openCancel} onRemove={()=>setRemoveId(job.id)} onPreview={()=>setPreviewId(job.id)}/>)}</div>
    {!state.jobs.length&&state.ready&&<p className="empty-list">Добавленные записи появятся здесь. До 128 МБ и одного часа на файл.</p>}
   </section>
   <div className="runtime-bar" role="status"><span className={'activity '+(state.busy?'working':'')}/><strong>{state.busy?(state.operation||'Обработка записи'):'Готов к работе'}</strong><span className="backend">ASR: {state.backend} · спикеры: WASM</span></div>
   {(error||state.notice)&&<p className="notice" role="alert">{error||state.notice}</p>}
   {chosen&&<section className="panel result"><div className="panel-heading"><h2>Текст записи</h2><span className="preview-name">{chosen.name}</span></div>{!chosen.asrComplete&&preview&&<p className="note">Промежуточный текст. Распознавание ещё не завершено.</p>}<div className={preview?'transcript':'empty'}>{preview||'Текст появится по мере распознавания.'}</div></section>}
   <p className="privacy">Аудио и результаты сохраняются в этом браузере на вашем устройстве. Перезагрузка остановит вычисления; сохранённую работу можно продолжить. Не очищайте данные сайта до скачивания результатов.</p>
  </main>
  <footer><strong>iScribe</strong><span>Локально. Под вашим контролем.</span><a href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.txt`} target="_blank" rel="noreferrer">Модели и лицензии</a></footer>
  <dialog ref={cancelDialog} onCancel={()=>setCancelOpen(false)} onClose={()=>setCancelOpen(false)}><h2>Отменить расшифровку?</h2><p>Текущая обработка будет остановлена. Уже полученный текст останется доступен. Следующие задания очереди продолжат обрабатываться.</p><div className="dialog-actions"><button className="start" autoFocus onClick={()=>setCancelOpen(false)}>Продолжить обработку</button><button className="cancel" onClick={()=>{if(runner.snapshot().activeId===cancelTarget)runner.cancel();else setError('Задача уже завершена. Следующая задача не отменена.');setCancelOpen(false)}}>Отменить задачу</button></div></dialog>
  <dialog ref={removeDialog} onCancel={()=>setRemoveId(null)} onClose={()=>setRemoveId(null)}><h2>Удалить запись и результаты?</h2><p>Исходное аудио и сохранённый текст этой записи будут удалены из браузера.</p><div className="dialog-actions"><button className="secondary" autoFocus onClick={()=>setRemoveId(null)}>Оставить</button><button className="cancel" onClick={()=>{if(removeId)void runner.remove(removeId);setRemoveId(null)}}>Удалить</button></div></dialog>
 </div>;
}
