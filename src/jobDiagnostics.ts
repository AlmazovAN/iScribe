import type {Job,JobStage} from './jobs';
import {validateSpeechPlan,type SpeechWindowPlan} from './speechSegmentation';

// A pagehide observation does not distinguish reload, navigation or closing the tab.
export type PageExitEvent='pagehide';
export type StopReason='execution-error'|'cancelled'|'session-ended';
export type JobFailure={
 reason:StopReason;
 at:number;
 stage:JobStage;
 message:string;
 backend:string|null;
 completedWindows:number;
 totalWindows:number|null;
 checkpointSeconds:number;
 durationSeconds:number|null;
 observedExit:PageExitEvent|null;
};
export type PageExitMarker={jobId:string;event:PageExitEvent;at:number};
const KEY='iscribe-page-exit-v1';

export function committedSeconds(job:Pick<Job,'duration'|'nextWindow'|'windowPlan'>,windows=job.nextWindow):number{
 if(!Number.isFinite(windows)||windows<=0)return 0;
 if(job.windowPlan!==undefined){
  if(!validateSpeechPlan(job.windowPlan,Math.round((job.duration??0)*16000))||!Number.isSafeInteger(windows)||windows>job.windowPlan.windows.length)return 0;
  return job.windowPlan.windows[windows-1].end/16000;
 }
 const end=30+(Math.floor(windows)-1)*25;
 return job.duration!==undefined&&Number.isFinite(job.duration)&&job.duration>0?Math.min(end,job.duration):end;
}
export function expectedWindows(duration:number|undefined,plan?:SpeechWindowPlan):number|null{
 if(plan!==undefined)return validateSpeechPlan(plan,Math.round((duration??0)*16000))?plan.windows.length:null;
 if(duration===undefined||!Number.isFinite(duration)||duration<=0)return null;
 return Math.max(1,Math.ceil((duration-30)/25)+1);
}
export function createFailureDiagnostic(
 job:Job,reason:StopReason,message:string,backend?:string|null,
 completedWindows=job.nextWindow,observedExit:PageExitEvent|null=null,at=Date.now()
):JobFailure{
 const count=Math.max(0,Math.floor(completedWindows));
 return {reason,at,stage:job.stage,message,
  backend:backend&&backend!=='Не инициализировано'?backend:null,
  completedWindows:count,totalWindows:expectedWindows(job.duration,job.windowPlan),
  checkpointSeconds:committedSeconds(job,count),
  durationSeconds:job.duration!==undefined&&Number.isFinite(job.duration)&&job.duration>0?job.duration:null,
  observedExit};
}

export function recordPageExit(jobId:string):void{
 try{
  if(typeof sessionStorage==='undefined')return;
  sessionStorage.setItem(KEY,JSON.stringify({jobId,event:'pagehide',at:Date.now()} satisfies PageExitMarker));
 }catch{/* Browser may deny sessionStorage; never block transcription. */}
}
export function consumePageExit():PageExitMarker|null{
 try{
  if(typeof sessionStorage==='undefined')return null;
  const raw=sessionStorage.getItem(KEY);sessionStorage.removeItem(KEY);
  if(!raw)return null;
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||!('jobId' in value)||typeof value.jobId!=='string'||
     !('event' in value)||value.event!=='pagehide'||!('at' in value)||typeof value.at!=='number'||
     !Number.isFinite(value.at)||value.at>Date.now()+60000||Date.now()-value.at>86400000)return null;
  return value as PageExitMarker;
 }catch{return null}
}
