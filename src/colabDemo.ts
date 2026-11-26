export const COLAB_POLL_MS=1750;
const IDLE_MS=6*60*1000;
export const COLAB_STAGES=['VAD','ASR','Alignment','Diarization'] as const;
export type Scenario='success'|'failure'|'review';
type Status='queued'|'loading'|'ready'|'running'|'paused'|'interrupted'|'review'|'done';
export type ColabJob={
 id:string;name:string;source:'drive'|'local'|'example';scenario:Scenario;
 status:Status;completed:number;attempt:number;prepared:boolean;
};
type Event={at:number;message:string};
export type ColabState={
 version:1;jobs:ColabJob[];events:Event[];runtime:'idle'|'starting'|'ready'|'off';
 nextActionAt:number;disconnectAt:number|null;
};
export type Action=
 |{type:'add';jobs:ColabJob[];at:number}
 |{type:'tick';at:number}
 |{type:'pause'|'enqueue'|'remove'|'approve';id:string;at:number};

export const initialColabState:ColabState={version:1,jobs:[],events:[],runtime:'idle',nextActionAt:0,disconnectAt:null};
export const isActive=(job:ColabJob)=>['queued','loading','ready','running'].includes(job.status);
const note=(state:ColabState,at:number,message:string):ColabState=>({
 ...state,events:[{at,message},...state.events].slice(0,60)
});
const replace=(state:ColabState,job:ColabJob):ColabState=>({
 ...state,jobs:state.jobs.map(item=>item.id===job.id?job:item)
});
function wake(state:ColabState,at:number):ColabState{
 if(state.runtime==='ready'||state.runtime==='starting')return {...state,disconnectAt:null};
 return note({...state,runtime:'starting',nextActionAt:at+COLAB_POLL_MS*2,disconnectAt:null},at,'Подготовка среды Colab');
}
export function colabReducer(state:ColabState,action:Action):ColabState{
 const {at}=action;
 if(action.type==='add'){
  const updated=wake(state,at);
  return note({...updated,jobs:[...updated.jobs,...action.jobs]},at,
   action.jobs.length===1?'В очередь добавлено: '+action.jobs[0].name:'Добавлено заданий: '+action.jobs.length);
 }
 if(action.type!=='tick'){
  const job=state.jobs.find(item=>item.id===action.id);
  if(!job)return state;
  switch(action.type){
   case 'pause':
    return isActive(job)?note(replace(state,{...job,status:'paused'}),at,'Приостановлено: '+job.name):state;
   case 'enqueue':
    if(job.status!=='paused'&&job.status!=='interrupted')return state;
    return note(wake({...state,jobs:[...state.jobs.filter(item=>item.id!==job.id),
     {...job,status:job.prepared?'ready':'queued',attempt:0,scenario:job.status==='interrupted'?'success':job.scenario}]},at),at,'Возвращено в очередь: '+job.name);
   case 'remove':
    return job.status==='running'||!['queued','loading','ready','paused'].includes(job.status)?state
     :note({...state,jobs:state.jobs.filter(item=>item.id!==job.id)},at,'Удалено из очереди: '+job.name);
   case 'approve':
    return job.status==='review'?note(replace(state,{...job,status:'done'}),at,'Проверка завершена, TXT готов: '+job.name):state;
  }
 }
 if(state.runtime==='idle'||state.runtime==='off')return state;
 if(state.runtime==='starting')
  return at<state.nextActionAt?state:note({...state,runtime:'ready'},at,'Среда готова');
 const queue=state.jobs.filter(isActive);
 if(!queue.length){
  if(state.disconnectAt===null)return {...state,disconnectAt:at+IDLE_MS};
  if(at<state.disconnectAt)return state;
  return note({...state,runtime:'off',disconnectAt:null},at,'Среда отключена по таймеру');
 }
 let next=state;
 // One input may prepare in parallel. Preparation never changes FIFO order.
 const loading=queue.find(job=>job.status==='loading');
 const waiting=queue.find(job=>job.status==='queued');
 if(loading)next=note(replace(next,{...loading,status:'ready',prepared:true}),at,'Аудио готово: '+loading.name);
 else if(waiting)next=note(replace(next,{...waiting,status:'loading'}),at,'Подготовка аудио: '+waiting.name);

 const first=queue[0];
 if(first.status==='ready')
  return note(replace(next,{...first,status:'running'}),at,'Распознавание: '+first.name);
 if(first.status!=='running')return next;
 const stage=COLAB_STAGES[first.completed];
 if(first.scenario==='failure'&&stage==='ASR'){
  if(first.attempt===0)return note(replace(next,{...first,attempt:1}),at,'Ошибка ASR, повторная попытка: '+first.name);
  return note(replace(next,{...first,status:'interrupted'}),at,'Обработка прервана, контрольная точка сохранена: '+first.name);
 }
 const completed=first.completed+1;
 if(completed<COLAB_STAGES.length)
  return note(replace(next,{...first,completed,attempt:0}),at,`${stage} сохранён: ${first.name}`);
 const status=first.scenario==='review'?'review':'done';
 return note(replace(next,{...first,completed,status}),at,
  (status==='review'?'Требуется проверка JSON: ':'TXT готов: ')+first.name);
}

export function driveFileId(value:string):string|null{
 try{
  const url=new URL(value.trim());
  if(url.protocol!=='https:'||url.host!=='drive.google.com'||url.username||url.password)return null;
  const id=url.pathname.match(/^\/file\/d\/([^/]+)(?:\/.*)?$/)?.[1]??
   (['/open','/uc'].includes(url.pathname)?url.searchParams.get('id'):null);
  return id&&/^[a-zA-Z0-9_-]+$/.test(id)?id:null;
 }catch{return null}
}

export function demoJob(name:string,source:ColabJob['source'],scenario:Scenario='success'):ColabJob{
 return {id:crypto.randomUUID(),name,source,scenario,status:'queued',completed:0,attempt:0,prepared:false};
}

const STORAGE_KEY='iscribe-colab-demo-v1';
export function restoreColab():ColabState{
 try{
  const saved=localStorage.getItem(STORAGE_KEY);
  if(!saved)return initialColabState;
  const state=JSON.parse(saved) as ColabState;
  if(state.version!==1||!Array.isArray(state.jobs)||!Array.isArray(state.events))return initialColabState;
  return state;
 }catch{return initialColabState}
}
export function saveColab(state:ColabState):boolean{
 try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));return true}catch{return false}
}
