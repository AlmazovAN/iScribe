import type {TranscriptSegment} from '@yourdevice/engine';
import {decodeAudio,validateFile} from './audio';
import {JobStore} from './jobStore';
import {createJob,audioWindows,absoluteSegments,type Job,type JobParams} from './jobs';
import {ModelManager,type WhisperId} from './ml/manager';
import {mapSpeakers} from './ml/speakers';
import {downloadTranscript,formatTranscript} from './formatTranscript';
export type RunnerSnapshot={jobs:Job[];busy:boolean;ready:boolean;activeId:string|null;notice:string;backend:string;operation:string};
export class JobRunner{
 readonly manager:ModelManager;
 private store:JobStore;
 private state:RunnerSnapshot={jobs:[],busy:false,ready:false,activeId:null,notice:'',backend:'Не инициализировано',operation:''};
 private listeners=new Set<()=>void>();
 private queue:string[]=[];
 private cancelled=false;
 private abort:AbortController|null=null;
 private download:(text:string,name:string)=>void;
 private decode:typeof decodeAudio;
 private initialization:Promise<void>|undefined;
 private lease:Promise<unknown>|undefined;
 constructor(options:{store?:JobStore;manager?:ModelManager;decode?:typeof decodeAudio;download?:typeof downloadTranscript}={}){
  this.store=options.store??new JobStore();this.manager=options.manager??new ModelManager();this.decode=options.decode??decodeAudio;this.download=options.download??downloadTranscript;
  this.manager.onProgress=(status,percent)=>{if(this.cancelled)return;const id=this.state.activeId;if(id)this.patch(id,{status,percent});else this.set({operation:status})};
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}};
 snapshot=()=>this.state;
 private set(patch:Partial<RunnerSnapshot>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn())}
 private patch(id:string,patch:Partial<Job>){this.set({jobs:this.state.jobs.map(j=>j.id===id?{...j,...patch,updated:Date.now()}:j)})}
 private job(id:string){const job=this.state.jobs.find(j=>j.id===id);if(!job)throw new Error('Задание не найдено.');return job}
 init(){return this.initialization??=(async()=>{try{this.set({jobs:await this.store.list()})}catch(error){this.set({notice:'Не удалось открыть сохранённые задания: '+message(error)})}finally{this.set({ready:true})}})()}
 private async persist(id:string){
  try{await this.store.save(this.job(id))}catch(error){this.set({notice:'Не удалось сохранить результат в браузере. Скачайте доступный TXT. '+message(error)});throw new Error('Ошибка локального сохранения. Текст остаётся доступен в этой вкладке.')}
 }
 async add(files:File[],params:JobParams){
  await this.init();
  for(const file of files){
   try{
    validateFile(file);const job=createJob(file,params);await this.store.save(job,file);this.set({jobs:[...this.state.jobs,job]});
   }catch(error){this.set({notice:`${file.name}: ${message(error)}`})}
  }
 }
 async remove(id:string){
  if(this.state.activeId===id||this.queue.includes(id))return;
  try{await this.store.remove(id);this.set({jobs:this.state.jobs.filter(j=>j.id!==id)})}catch(error){this.set({notice:message(error)})}
 }
 enqueue(id:string,params?:JobParams){
  const job=this.job(id);if(this.state.activeId===id||this.queue.includes(id))return;
  // Parameters are captured on the first start. Resume retains the original.
  if(job.stage==='waiting'&&params)this.patch(id,{params:{...params}});
  this.patch(id,{stage:'queued',status:'В очереди',error:undefined});this.queue.push(id);void this.drain();
 }
 private async exclusive(task:()=>Promise<void>){
  // Web Locks prevents two tabs from running heavy models and overwriting the
  // same checkpoint. When unavailable, refuse concurrent recovery guarantees.
  if(typeof navigator!=='undefined'&&navigator.locks){
   await navigator.locks.request('iscribe-processing-v1',{ifAvailable:true},async lock=>{
    if(!lock)throw new Error('Обработка уже идёт в другой вкладке iScribe. Дождитесь завершения и обновите эту страницу.');
    await task();
   });
  }else await task();
 }
 private async drain(){
  if(this.state.busy)return;
  this.set({busy:true});
  try{
   this.lease=this.exclusive(async()=>{
    while(this.queue.length){
     const id=this.queue.shift()!;this.cancelled=false;this.abort=new AbortController();this.set({activeId:id});
     try{await this.execute(id)}catch(error){
      const job=this.job(id);this.patch(id,{stage:this.cancelled?'cancelled':job.asrComplete?'partial':'error',status:this.cancelled?'Отменено. Полученный текст сохранён.':job.asrComplete?'Текст готов. Разделение говорящих не завершено.':'Обработка прервана. Можно продолжить.',error:this.cancelled?undefined:message(error),percent:null});
      try{await this.persist(id)}catch{/* Keep available text in memory and the storage error visible. */}
      if(!this.cancelled&&this.job(id).asrComplete){try{this.export(id,'plain');this.set({notice:'Разделение говорящих не завершено. Автоскачивание готового текста запрошено; ручные кнопки доступны.'})}catch{/* Manual exports remain available. */}}
     }
    }
   });await this.lease;
  }catch(error){
   this.set({notice:message(error)});
   for(const id of this.queue)this.patch(id,{stage:'interrupted',status:'Запуск отложен: другая вкладка занята.'});this.queue=[];
  }finally{this.set({busy:false,activeId:null,operation:''});this.abort=null;this.lease=undefined}
 }
 private check(){if(this.cancelled)throw new Error('Отменено.')}
 private async execute(id:string){
  this.patch(id,{stage:'preparing',status:'Подготовка аудио',percent:null,error:undefined});await this.persist(id);this.check();
  const file=await this.store.audio(id);this.check();if(!file)throw new Error('Исходное аудио недоступно. Добавьте файл заново; сохранённый текст можно скачать.');
  const audio=await this.decode(file,this.abort!.signal);this.check();this.patch(id,{duration:audio.length/16000});
  const params={...this.job(id).params};
  if(!this.job(id).asrComplete){
   if(this.manager.active!==params.model){const prepared=await this.manager.prepare(params.model);this.check();this.set({backend:prepared.backend})}
   this.patch(id,{stage:'recognizing',status:'Распознавание',percent:0});
   const windows=audioWindows(audio.length);
   for(let index=this.job(id).nextWindow;index<windows.length;index++){
    this.check();const window=windows[index];
    const result=await this.manager.transcribe(audio.slice(window.start,window.end),false,()=>{},params.language);this.check();
    const segments=[...this.job(id).segments,...absoluteSegments(result,window)];
    this.patch(id,{segments,nextWindow:index+1,percent:(index+1)/windows.length*100,status:`Распознавание · ${Math.round(window.end/16000)} / ${Math.round(audio.length/16000)} с`});
    await this.persist(id);this.check();
   }
   if(!this.job(id).segments.some(s=>s.text.trim()))throw new Error('Распознанного текста нет. Проверьте запись.');
   this.patch(id,{asrComplete:true,status:'Текст готов и сохраняется'});await this.persist(id);this.check();
  }
  if(params.diarize){
   this.patch(id,{stage:'speakers',status:'Разделение говорящих. Текст уже доступен.',percent:null});await this.persist(id);this.check();
   const turns=await this.manager.diarize(audio);this.check();
   const segments=this.job(id).segments,speakerSegments=mapSpeakers(segments,turns);
   const unlabeled=speakerSegments.filter(s=>s.text.trim()&&!s.speaker).length;
   this.patch(id,{speakerSegments,diagnostics:{turns:turns.length,unlabeled,segments:segments.length,zeroDuration:segments.filter(s=>s.start===s.end).length},stage:unlabeled?'partial':'done',status:unlabeled?`Текст готов · без спикера: ${unlabeled} из ${segments.length}`:'Текст и спикеры готовы',percent:100});
  }else this.patch(id,{stage:'done',status:'Текст готов',percent:100});
  await this.persist(id);this.check();
  this.set({operation:'Формирование TXT'});
  // Browser download APIs cannot reliably report a blocked download.
  try{this.export(id,params.diarize?'speakers':'plain');this.set({notice:'Автоскачивание TXT запрошено. Если файл не появился, используйте кнопки справа от записи.'})}catch(error){this.set({notice:'Используйте ручное скачивание TXT. '+message(error)})}
 }
 cancel(){if(!this.state.busy)return;this.cancelled=true;this.abort?.abort();this.manager.cancel();this.set({backend:'Не инициализировано'})}
 async prepare(model:WhisperId){
  if(this.state.busy)return;this.set({busy:true,operation:'Подготовка модели'});this.cancelled=false;
  try{await this.exclusive(async()=>{const prepared=await this.manager.prepare(model);this.set({backend:prepared.backend})})}catch(error){this.set({notice:message(error)})}
  finally{this.set({busy:false,operation:''});if(this.queue.length)void this.drain()}
 }
 async preloadSpeakers(){
  if(this.state.busy)return;this.set({busy:true,operation:'Загрузка моделей говорящих'});this.cancelled=false;
  try{await this.exclusive(async()=>{await this.manager.preloadSpeakers();this.set({backend:'Не инициализировано'})})}catch(error){this.set({notice:message(error)})}
  finally{this.set({busy:false,operation:''});if(this.queue.length)void this.drain()}
 }
 export(id:string,variant:'plain'|'time'|'speakers'){
  const job=this.job(id);const segments:TranscriptSegment[]=variant==='speakers'?(job.speakerSegments??job.segments):job.segments;
  const text=formatTranscript(segments,{timestamps:variant!=='plain',diarize:variant==='speakers'});
  const suffix=variant==='plain'?'text':variant==='time'?'time':'time_speakers';
  const partial=!job.asrComplete||(variant==='speakers'&&job.stage!=='done');
  this.download(text,job.name.replace(/\.[^.]+$/,'')+'_'+suffix+(partial?'_partial':'')+'.txt');
 }
}
function message(error:unknown){return error instanceof Error?error.message:String(error)}
