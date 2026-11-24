import {expect,it} from 'vitest';
import {appendTrace,diagnosticReport,MAX_TRACE_EVENTS,traceBackend,traceErrorKind} from './jobTrace';
import {createJob} from './jobs';

it('keeps a bounded ring of structured trace events',()=>{
 let trace:ReturnType<typeof appendTrace>=[];
 for(let i=0;i<MAX_TRACE_EVENTS+12;i++)trace=appendTrace(trace,{at:i,phase:'asr',code:'window-start',window:i+1});
 expect(trace).toHaveLength(MAX_TRACE_EVENTS);
 expect(trace[0].at).toBe(12);
 expect(trace.at(-1)?.window).toBe(MAX_TRACE_EVENTS+12);
});
it('exports useful context but never filenames, transcript text or raw error messages',()=>{
 const j=createJob(new File(['hidden audio'],'PRIVATE-RECORDING.mp3'),{model:'whisper-small',language:'ru',diarize:true});
 const report=diagnosticReport({...j,duration:871,nextWindow:2,backend:'webgpu',
  segments:[{start:3,end:4,text:'SECRET TRANSCRIPT DATA'}],
  error:'SECRET ERROR MESSAGE',
  trace:[{at:123,phase:'asr',code:'window-error',window:3,attempt:2,errorKind:'worker',backend:'webgpu'}],
  failure:{reason:'execution-error',at:123,stage:'recognizing',message:'SECRET STACK TRACE',backend:'webgpu',completedWindows:2,totalWindows:35,checkpointSeconds:55,durationSeconds:871,observedExit:null}
 });
 expect(report.job).toMatchObject({model:'whisper-small',fileSizeBytes:12,durationSeconds:871,committedWindows:2,totalWindows:35});
 expect(report.events[0]).toMatchObject({code:'window-error',attempt:2,errorKind:'worker'});
 const json=JSON.stringify(report);
 expect(json).not.toContain('PRIVATE-RECORDING');
 expect(json).not.toContain('SECRET TRANSCRIPT');
 expect(json).not.toContain('SECRET ERROR');
 expect(json).not.toContain('SECRET STACK');
 expect(json).not.toContain('hidden audio');
});
it('does not leak arbitrary error codes, names, messages or backend strings',()=>{
 expect(traceErrorKind(Object.assign(new Error('PRIVATE PATH'),{code:'PRIVATE CODE'}))).toBe('other');
 expect(traceErrorKind(Object.assign(new Error('stalled'),{name:'WorkerStalledError'}))).toBe('timeout');
 expect(traceErrorKind(Object.assign(new Error('worker'),{code:'worker-failed'}))).toBe('worker');
 expect(traceErrorKind(Object.assign(new Error('disk'),{name:'QuotaExceededError'}))).toBe('storage');
 expect(traceBackend('GPU device model USERNAME')).toBe('unknown');
 expect(traceBackend('wasm')).toBe('wasm');
});
