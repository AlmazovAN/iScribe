import {afterEach,expect,it,vi} from 'vitest';
import {committedSeconds,expectedWindows,createFailureDiagnostic,recordPageExit,consumePageExit} from './jobDiagnostics';
import {createJob,recoverJob} from './jobs';
afterEach(()=>vi.unstubAllGlobals());
function job(){return createJob(new File(['test'],'meeting.mp3'),{model:'whisper-small',language:'ru',diarize:true})}
it('computes the last fully committed window, not the current running window',()=>{
 const j={...job(),duration:871,nextWindow:2};
 expect(expectedWindows(871)).toBe(35);
 expect(committedSeconds(j)).toBe(55);
 const failure=createFailureDiagnostic({...j,stage:'recognizing'},'execution-error','worker stopped','webgpu',1,null,42);
 expect(failure).toMatchObject({at:42,stage:'recognizing',backend:'webgpu',completedWindows:1,totalWindows:35,checkpointSeconds:30,durationSeconds:871,observedExit:null});
});
it('classifies an ended session without claiming a browser crash or reload',()=>{
 const j={...job(),stage:'recognizing' as const,nextWindow:1,duration:871,backend:'wasm'};
 const recovered=recoverJob(j);
 expect(recovered.stage).toBe('interrupted');
 expect(recovered.failure).toMatchObject({reason:'session-ended',stage:'recognizing',backend:'wasm',completedWindows:1,checkpointSeconds:30,observedExit:null});
 expect(recoverJob({...recovered})).toEqual(recovered);
});
it('records only a pagehide observation and consumes it once',()=>{
 const data=new Map<string,string>();
 vi.stubGlobal('sessionStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,val:string)=>{data.set(key,val)},removeItem:(key:string)=>{data.delete(key)}});
 recordPageExit('job-a');
 expect(consumePageExit()).toMatchObject({jobId:'job-a',event:'pagehide'});
 expect(consumePageExit()).toBeNull();
});
it('degrades safely when session storage is not accessible',()=>{
 vi.stubGlobal('sessionStorage',{getItem:()=>{throw new Error('denied')},setItem:()=>{throw new Error('denied')}});
 expect(()=>recordPageExit('job')).not.toThrow();
 expect(consumePageExit()).toBeNull();
});
