import type {TranscriptSegment} from '@yourdevice/engine';
import type {WhisperId} from './ml/manager';
export type JobParams={model:WhisperId;language:'ru'|'en';diarize:boolean};
export type JobStage='waiting'|'queued'|'preparing'|'recognizing'|'speakers'|'done'|'partial'|'interrupted'|'cancelled'|'error';
export type Job={id:string;name:string;size:number;duration?:number;params:JobParams;stage:JobStage;status:string;percent:number|null;segments:TranscriptSegment[];speakerSegments?:TranscriptSegment[];asrComplete:boolean;nextWindow:number;updated:number;error?:string;diagnostics?:{turns:number;unlabeled:number;segments:number;zeroDuration:number};};
export const isRunning=(stage:JobStage)=>['preparing','recognizing','speakers'].includes(stage);
export function recoverJob(job:Job):Job{
 return isRunning(job.stage)||job.stage==='queued'?{...job,stage:'interrupted',status:job.asrComplete?'Текст сохранён. Можно повторить разделение говорящих.':'Обработка прервана. Можно продолжить с сохранённого фрагмента.',percent:null}:job;
}
export function createJob(file:File,params:JobParams):Job{
 return {id:crypto.randomUUID(),name:file.name,size:file.size,params:{...params},stage:'waiting',status:'Ожидает',percent:0,segments:[],asrComplete:false,nextWindow:0,updated:Date.now()};
}
// Same 30 s / 5 s overlap and midpoint cuts as the pinned engine. A checkpoint
// is committed ONLY after a whole window: interrupted windows are replayed.
export function audioWindows(samples:number){
 const out:{start:number;end:number;first:boolean;last:boolean}[]=[];
 for(let start=0;start<samples;start+=25*16000){const end=Math.min(start+30*16000,samples);out.push({start,end,first:start===0,last:end===samples});if(end===samples)break}return out;
}
export function absoluteSegments(segments:TranscriptSegment[],window:ReturnType<typeof audioWindows>[number]){
 const offset=window.start/16000;
 return segments.map(s=>({...s,start:s.start+offset,end:s.end+offset})).filter(s=>{
  const mid=(s.start+s.end)/2;return (window.first||mid>=offset+2.5)&&(window.last||mid<window.end/16000-2.5);
 });
}
