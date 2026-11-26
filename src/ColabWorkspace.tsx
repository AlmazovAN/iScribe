import {useEffect,useReducer,useRef,useState,type FormEvent} from 'react';
import {COLAB_POLL_MS,COLAB_STAGES,colabReducer,demoJob,driveFileId,isActive,restoreColab,saveColab,type ColabJob,type Scenario} from './colabDemo';
import './colab.css';

const statusLabels:Record<ColabJob['status'],string>={
 queued:'В очереди',loading:'Загрузка аудио',ready:'Аудио готово',running:'Распознавание',
 paused:'Приостановлено',interrupted:'Обработка прервана',review:'Требуется проверка',done:'Готов TXT'
};
const runtimeLabels={idle:'Ожидает задания',starting:'Подготовка среды',ready:'Среда готова',off:'Среда отключена'};
const sourceLabels={drive:'Google Drive',local:'С компьютера',example:'Демо-задание'};
const stageLabels=['Участки речи','Текст речи','Временные метки','Говорящие'];
const stageText=['Распознавание речи','Сбой на этапе ASR','Проверка результата'];
const examples:Scenario[]=['success','failure','review'];
const AUDIO_EXTENSIONS=/\.(wav|mp3|m4a|ogg|opus|webm|aac|flac|mp4|mov|mkv)$/i;
const time=new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

function demoDownload(job:ColabJob){
 const text='ДЕМО · WhisperX Colab\n'+job.name+'\n\n[00:00:00] Спикер 1: Пример формата результата. Аудио не обрабатывалось.\n';
 const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
 const link=document.createElement('a');
 link.href=url;link.download=job.name.replace(/\.[^.]+$/,'')+'_demo.txt';
 document.body.append(link);link.click();link.remove();
 window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function ColabWorkspace({hidden,onBack}:{hidden:boolean;onBack:()=>void}){
 const [state,dispatch]=useReducer(colabReducer,undefined,restoreColab);
 const [link,setLink]=useState('');
 const [notice,setNotice]=useState('');
 const [saved,setSaved]=useState(true);
 const [selected,setSelected]=useState<string|null>(null);
 const [scenario,setScenario]=useState<Scenario>('success');
 const [clock,setClock]=useState(()=>Date.now());
 const [autoDownload,setAutoDownload]=useState(true);
 const [dragging,setDragging]=useState(false);
 const input=useRef<HTMLInputElement>(null);
 const heading=useRef<HTMLHeadingElement>(null);
 const offered=useRef(new Set(state.jobs.filter(job=>job.status==='done').map(job=>job.id)));
 useEffect(()=>{
  const timer=window.setInterval(()=>{
   const at=Date.now();setClock(at);dispatch({type:'tick',at});
  },COLAB_POLL_MS);
  return()=>window.clearInterval(timer);
 },[]);
 useEffect(()=>{setSaved(saveColab(state))},[state]);
 useEffect(()=>{if(!hidden)heading.current?.focus()},[hidden]);
 useEffect(()=>{
  for(const job of state.jobs){
   if(job.status!=='done'||offered.current.has(job.id))continue;
   offered.current.add(job.id);
   if(autoDownload&&!hidden)demoDownload(job);
  }
 },[state.jobs,autoDownload,hidden]);

 const queue=state.jobs.filter(isActive);
 const running=queue.find(job=>job.status==='running');
 const inspected=state.jobs.find(job=>job.id===selected)??running??queue[0]??state.jobs.at(-1);
 const remaining=state.disconnectAt===null?null:Math.max(0,Math.ceil((state.disconnectAt-clock)/1000));
 const countdown=remaining===null?null:String(Math.floor(remaining/60)).padStart(2,'0')+':'+String(remaining%60).padStart(2,'0');
 const positions=new Map(queue.map((job,index)=>[job.id,index+1]));

 const addDrive=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();
  const id=driveFileId(link);
  if(!id){setNotice('Вставьте ссылку на файл Google Drive, например drive.google.com/file/d/…');return}
  dispatch({type:'add',jobs:[demoJob('Файл Drive · '+id.slice(-8),'drive')],at:Date.now()});
  setNotice('');setLink('');
 };
 const addFiles=(files:FileList)=>{
  const accepted:ColabJob[]=[];
  let rejected=0;
  for(const file of files){
   if(file.size<=0||file.size>800*1024*1024||!AUDIO_EXTENSIONS.test(file.name)){rejected++;continue}
   accepted.push(demoJob(file.name,'local'));
  }
  if(accepted.length)dispatch({type:'add',jobs:accepted,at:Date.now()});
  setNotice(rejected?'Пропущено файлов: '+rejected+'. Выберите аудиофайл до 800 МБ.':'');
 };
 const change=(type:'pause'|'enqueue'|'remove'|'approve',job:ColabJob)=>{
  if(type==='remove'&&!window.confirm('Удалить демонстрационное задание «'+job.name+'»?'))return;
  dispatch({type,id:job.id,at:Date.now()});
 };

 return <div className="colab-workspace" hidden={hidden}>
  <header className="colab-header">
   <div className="brand"><span className="mark">iS</span>iScribe</div>
   <nav aria-label="Режим обработки">
    <button type="button" onClick={onBack}>Локальный iScribe</button>
    <span aria-current="page">Google Drive / Colab</span>
   </nav>
  </header>
  <main className="colab-main">
   <section className="colab-title">
    <div><h1 ref={heading} tabIndex={-1}>Очередь Colab</h1><p>WhisperX · пакетное распознавание</p></div>
    <div className="colab-demo-label"><strong>Прототип</strong><span>Подключение к Drive и Colab имитируется.</span></div>
   </section>
   <div className="colab-grid">
    <div className="colab-operations">
     <section className="colab-ingest" aria-labelledby="colab-ingest-heading"
      onDragOver={event=>{event.preventDefault();setDragging(true)}}
      onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(false)}}
      onDrop={event=>{event.preventDefault();setDragging(false);addFiles(event.dataTransfer.files)}}
      data-dragging={dragging}>
      <div className="colab-section-head"><h2 id="colab-ingest-heading">Добавить записи</h2><span>Можно добавлять во время обработки</span></div>
      <form className="colab-drive-form" onSubmit={addDrive}>
       <label htmlFor="colab-drive-link">Ссылка на файл Google Drive</label>
       <div><input id="colab-drive-link" type="url" value={link} placeholder="https://drive.google.com/file/d/…"
        onChange={event=>setLink(event.target.value)} required/><button className="colab-primary">В очередь</button></div>
      </form>
      <div className="colab-local-input">
       <input type="file" hidden multiple ref={input} accept="audio/*,.mp3,.wav,.m4a,.ogg,.opus,.webm,.aac,.flac,.mp4,.mov,.mkv"
        onChange={event=>{if(event.target.files)addFiles(event.target.files);event.target.value=''}}/>
       <button type="button" onClick={()=>input.current?.click()}>Выбрать на компьютере</button>
       <span>Можно перетащить сюда · до 800 МБ на файл</span>
      </div>
      {notice&&<p className="colab-alert" role="alert">{notice}</p>}
     </section>
     {!saved&&<p className="colab-alert" role="alert">Браузер не сохранил состояние очереди. При перезагрузке оно может пропасть.</p>}
     <section className="colab-jobs" aria-labelledby="colab-jobs-heading">
      <div className="colab-section-head"><h2 id="colab-jobs-heading">Задания <small>{state.jobs.length}</small></h2>
       <span>{queue.length} в активной очереди · {state.jobs.filter(job=>job.status==='done').length} готово</span></div>
      {state.jobs.length>0?<ul className="colab-job-list">{state.jobs.map(job=>
       <li className="colab-job" key={job.id} data-state={job.status}>
        <div className="colab-job-name"><button type="button" className="colab-name" aria-pressed={inspected?.id===job.id}
         onClick={()=>setSelected(job.id)}>{job.name}</button>
         <small>{sourceLabels[job.source]}{positions.has(job.id)?` · № ${positions.get(job.id)} из ${queue.length}`:''}</small></div>
        <div className="colab-job-state"><strong>{state.runtime==='starting'&&job.status==='queued'?'Подготовка среды':statusLabels[job.status]}</strong>
         {(job.status==='running'||job.completed>0)&&<small>{job.status==='running'?COLAB_STAGES[job.completed]+' · ':''}{job.completed} из 4 этапов{job.status==='running'&&job.attempt?' · попытка 2 из 2':''}</small>}</div>
        <div className="colab-job-actions">
         {isActive(job)&&<button type="button" onClick={()=>change('pause',job)}>Приостановить</button>}
         {['paused','interrupted'].includes(job.status)&&<button type="button" onClick={()=>change('enqueue',job)}>Поставить в очередь</button>}
         {['queued','paused','ready','loading'].includes(job.status)&&<button type="button" className="colab-remove" onClick={()=>change('remove',job)} aria-label={'Удалить '+job.name}>Удалить</button>}
         {job.status==='review'&&<button type="button" onClick={()=>change('approve',job)}>Принять результат</button>}
         {job.status==='done'&&<button type="button" className="colab-primary" onClick={()=>demoDownload(job)}>Скачать TXT</button>}
        </div>
       </li>)}</ul>:<p className="colab-empty">Очередь пуста. Добавьте запись или запустите демо-задание.</p>}
      <div className="colab-demo-controls">
       <label>Сценарий <select value={scenario} onChange={event=>setScenario(event.target.value as Scenario)}>
        {examples.map((example,index)=><option key={example} value={example}>{stageText[index]}</option>)}
       </select></label>
       <button type="button" onClick={()=>dispatch({type:'add',jobs:[demoJob('Демо · '+stageText[examples.indexOf(scenario)]+'.mp3','example',scenario)],at:Date.now()})}>Добавить пример</button>
       <label className="colab-auto"><input type="checkbox" checked={autoDownload} onChange={event=>setAutoDownload(event.target.checked)}/> Автоскачивание демо TXT</label>
      </div>
     </section>
    </div>
    <aside className="colab-sidebar" aria-label="Среда и журнал">
     <section className="colab-runtime">
      <div className="colab-runtime-top"><h2>Среда Colab</h2><span data-runtime={state.runtime}>{runtimeLabels[state.runtime]}</span></div>
      <dl><dt>Распознавание</dt><dd>Whisper large-v3</dd><dt>Говорящие</dt><dd>Pyannote Community-1</dd></dl>
      <p className="colab-countdown">{countdown===null?(state.runtime==='off'?'Новое задание подготовит среду':'Отключение через 6 мин после очереди'):<>До отключения <strong>{countdown}</strong></>}</p>
     </section>
     <section className="colab-pipeline" aria-labelledby="colab-pipeline-heading">
      <h2 id="colab-pipeline-heading">Этапы обработки</h2>
      {inspected&&<p className="colab-selected">{inspected.name}</p>}
      <ol>{COLAB_STAGES.map((stage,index)=>{
       const complete=(inspected?.completed??0)>index;
       const current=inspected?.status==='running'&&inspected.completed===index;
       return <li key={stage} data-phase={complete?'complete':current?'current':'pending'} aria-current={current?'step':undefined}>
        <span className="colab-stage-dot" aria-hidden="true">{complete?'✓':index+1}</span>
        <span><strong>{stage}</strong><small>{stageLabels[index]}</small></span>
        <span className="colab-stage-status">{complete?'Сохранено':current?'В работе':'Ожидает'}</span>
       </li>;
      })}</ol>
      {inspected?.status==='done'&&<p className="colab-result-path">Папка результата в демо <code>AI_Whisper_Cache/History transcripts</code></p>}
     </section>
     <section className="colab-journal" aria-labelledby="colab-journal-heading">
      <h2 id="colab-journal-heading">Журнал событий</h2>
      {state.events.length
       ?<ol>{state.events.map((event,index)=><li key={event.at+'-'+index}><time dateTime={new Date(event.at).toISOString()}>{time.format(event.at)}</time><span>{event.message}</span></li>)}</ol>
       :<p>События появятся после добавления задания.</p>}
     </section>
    </aside>
   </div>
  </main>
 </div>;
}
