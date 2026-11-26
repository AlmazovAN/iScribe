import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';
vi.mock('./ml/worker?worker',()=>({default:class{}}));
import {JobRunner} from './jobRunner';
import {JobStore} from './jobStore';
import {createJob} from './jobs';
import type {diagnosticReport} from './jobTrace';
import type {ModelManager} from './ml/manager';
import type {StreamedAudio,openStreamedAudio} from './streamedAudio';
function setup(){
 const fake={active:null as string|null,onProgress:(status:string,percent:number|null)=>{void status;void percent},recover:vi.fn(async(id:string,wasmOnly:boolean)=>{fake.active=id;return {cached:true,backend:wasmOnly?'wasm':'webgpu'}}),prepare:vi.fn(async(id:string)=>{fake.active=id;return {cached:true,backend:'wasm'}}),transcribe:vi.fn(async()=>[{start:3,end:4,text:'текст'}]),diarize:vi.fn(async()=>[{start:0,end:60,speaker:'A'}]),cancel:vi.fn(()=>{})};
 const store=new JobStore(),download=vi.fn(),diagnosticDownload=vi.fn((_report:ReturnType<typeof diagnosticReport>,_filename:string)=>{void _report;void _filename}),decode=vi.fn(async()=>new Float32Array(60*16000));
 return {fake,store,download,diagnosticDownload,decode,runner:new JobRunner({store,manager:fake as unknown as ModelManager,decode,download,downloadDiagnostic:diagnosticDownload})};
}
async function finished(runner:JobRunner){await vi.waitFor(()=>expect(runner.snapshot().busy).toBe(false))}
it('persists full ASR before speakers and keeps TXT available when speakers fail',async()=>{
 const {runner,fake,store,download}=setup();await runner.init();await runner.add([new File(['source'],'failure.wav')],{model:'whisper-small',language:'ru',diarize:true});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.diarize.mockImplementation(async()=>{const j=(await store.list()).find(j=>j.id===id)!;expect(j.asrComplete).toBe(true);expect(j.segments).toHaveLength(3);runner.export(id,'plain');throw new Error('speaker failed')});
 runner.enqueue(id);await finished(runner);
 const j=runner.snapshot().jobs.find(j=>j.id===id)!;expect(j.stage).toBe('partial');expect(j.asrComplete).toBe(true);expect(download).toHaveBeenCalled();
 expect((await new JobStore().list()).find(j=>j.id===id)!.segments).toHaveLength(3);
});
it('resumes at the committed window and never re-runs ASR when only speakers need retry',async()=>{
 const {runner,fake,store}=setup();const file=new File(['a'],'resume.wav');const j=createJob(file,{model:'whisper-small',language:'en',diarize:true});
 await store.save({...j,stage:'recognizing',nextWindow:1,segments:[{start:3,end:4,text:'saved'}]},file);await runner.init();runner.enqueue(j.id);await finished(runner);
 expect(fake.transcribe).toHaveBeenCalledTimes(2);expect(fake.transcribe.mock.calls[0]).toHaveLength(4);
 fake.transcribe.mockClear();runner.enqueue(j.id);await finished(runner);expect(fake.transcribe).not.toHaveBeenCalled();expect(fake.diarize).toHaveBeenCalledTimes(2);
});
it('serializes files and freezes language/model for each queued job',async()=>{
 const {runner,fake}=setup();await runner.init();const p={model:'whisper-tiny' as const,language:'ru' as const,diarize:false};
 await runner.add([new File(['a'],'first.wav'),new File(['b'],'second.wav')],p);const ids=runner.snapshot().jobs.slice(-2).map(j=>j.id);
 runner.enqueue(ids[0],p);runner.enqueue(ids[1],{...p,language:'en'});await finished(runner);
 expect(fake.prepare).toHaveBeenCalledTimes(1);expect(fake.transcribe).toHaveBeenCalledTimes(6);
 expect(runner.snapshot().jobs.find(j=>j.id===ids[1])!.params.language).toBe('en');
});
it('cancellation preserves committed windows and ignores a late worker result',async()=>{
 const {runner,fake}=setup();await runner.init();await runner.add([new File(['a'],'cancel.wav')],{model:'whisper-tiny',language:'ru',diarize:false});const id=runner.snapshot().jobs.at(-1)!.id;
 let release:((value:{start:number;end:number;text:string}[])=>void)|undefined;
 fake.transcribe.mockImplementationOnce(async()=>[{start:3,end:4,text:'committed'}]).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}));
 runner.enqueue(id);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));runner.cancel();release!([{start:3,end:4,text:'late'}]);await finished(runner);
 const job=runner.snapshot().jobs.find(j=>j.id===id)!;expect(job.stage).toBe('cancelled');expect(job.nextWindow).toBe(1);expect(job.segments.map(s=>s.text)).toEqual(['committed']);
});
it('storage failure stops the pipeline before speakers while preserving in-memory TXT',async()=>{
 const {runner,store,fake}=setup();await runner.init();await runner.add([new File(['a'],'quota.wav')],{model:'whisper-tiny',language:'ru',diarize:true});const id=runner.snapshot().jobs.at(-1)!.id;
 const save=store.save.bind(store);vi.spyOn(store,'save').mockImplementation(async(job,file)=>{if(job.nextWindow>0)throw new Error('quota');return save(job,file)});
 runner.enqueue(id);await finished(runner);expect(fake.diarize).not.toHaveBeenCalled();expect(runner.snapshot().jobs.find(j=>j.id===id)!.segments).toHaveLength(0);expect(runner.snapshot().jobs.find(j=>j.id===id)!.nextWindow).toBe(0);expect(runner.snapshot().jobs.find(j=>j.id===id)!.volatileSegments).toHaveLength(1);expect(runner.snapshot().notice).toContain('Не удалось сохранить');
});
it('a denied cross-tab lock starts no inference and leaves a resumable job',async()=>{
 const {runner,fake,store}=setup();await runner.init();await runner.add([new File(['a'],'other-tab.wav')],{model:'whisper-small',language:'ru',diarize:false});const id=runner.snapshot().jobs.at(-1)!.id;
 vi.stubGlobal('navigator',{locks:{request:async(_name:string,_opts:unknown,callback:(lock:null)=>Promise<void>)=>callback(null)}});
 try{runner.enqueue(id);await finished(runner);expect(fake.prepare).not.toHaveBeenCalled();expect(runner.snapshot().jobs.find(j=>j.id===id)!.stage).toBe('queued');expect(runner.snapshot().jobs.find(j=>j.id===id)!.queueOrder).toBeGreaterThan(0);expect(runner.snapshot().queueCount).toBe(1);expect(runner.snapshot().notice).toContain('другой вкладке')}finally{vi.unstubAllGlobals();await store.remove(id)}
});

it('ignores 30-second engine percentages and reports committed progress for the complete audio',async()=>{
 const {runner,fake}=setup();await runner.init();
 await runner.add([new File(['a'],'long-progress.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id,observed:{status:string,percent:number|null}[]=[];
 fake.transcribe.mockImplementation(async()=>{
  fake.onProgress('Распознано 3 / 30 с',10);
  const current=runner.snapshot().jobs.find(j=>j.id===id)!;
  observed.push({status:current.status,percent:current.percent});
  return [{start:3,end:4,text:'текст'}];
 });
 runner.enqueue(id);await finished(runner);
 expect(observed).toHaveLength(3);
 expect(observed[0].status).toContain('окно 1/3');
 expect(observed[1].status).toContain('окно 2/3');
 expect(observed[2].status).toContain('окно 3/3');
 expect(observed.map(x=>x.percent)).toEqual([0,50,55/60*100]);
 expect(runner.snapshot().jobs.find(j=>j.id===id)!.percent).toBe(100);
});
it('never advances a checkpoint when its IndexedDB transaction fails',async()=>{
 const {runner,store,fake}=setup();await runner.init();
 await runner.add([new File(['a'],'checkpoint-failure.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 const realSave=store.save.bind(store);
 vi.spyOn(store,'save').mockImplementation(async(job,file)=>{
  if(job.nextWindow===2)throw new Error('quota exceeded');
  return realSave(job,file);
 });
 runner.enqueue(id);await finished(runner);
 expect(fake.transcribe).toHaveBeenCalledTimes(2);
 const live=runner.snapshot().jobs.find(j=>j.id===id)!;
 expect(live.nextWindow).toBe(1);
 expect(live.segments).toHaveLength(1);
 expect(live.volatileSegments).toHaveLength(2);
 expect(live.stage).toBe('error');
 const persisted=(await store.list()).find(j=>j.id===id)!;
 expect(persisted.nextWindow).toBe(1);
 expect(persisted.segments).toHaveLength(1);
 expect(persisted.volatileSegments).toBeUndefined();
 const download=vi.fn();
 const recovered=new JobRunner({store,manager:fake as unknown as ModelManager,decode:async()=>new Float32Array(60*16000),download});
 await recovered.init();
 const restored=recovered.snapshot().jobs.find(j=>j.id===id)!;
 expect(restored.nextWindow).toBe(1);
 expect(restored.volatileSegments).toBeUndefined();
});
it('a silent ASR window still advances the durable checkpoint without faking text',async()=>{
 const {runner,fake,store}=setup();await runner.init();
 await runner.add([new File(['a'],'silence.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockImplementationOnce(async()=>[]).mockImplementation(async()=>[{start:3,end:4,text:'after silence'}]);
 runner.enqueue(id);await finished(runner);
 const disk=(await store.list()).find(j=>j.id===id)!;
 expect(disk.nextWindow).toBe(3);
 expect(disk.asrComplete).toBe(true);
 expect(disk.segments).toHaveLength(2);
});

it('recovers a failed Worker and commits only one copy of the current window',async()=>{
 const {runner,fake,store}=setup();await runner.init();
 await runner.add([new File(['a'],'worker-recovery.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockImplementationOnce(async()=>[{start:3,end:4,text:'first'}])
  .mockRejectedValueOnce(Object.assign(new Error('Worker died unexpectedly'),{code:'worker-failed'}))
  .mockImplementationOnce(async()=>[{start:3,end:4,text:'second'}])
  .mockImplementationOnce(async()=>[{start:3,end:4,text:'third'}]);
 runner.enqueue(id);await finished(runner);
 expect(fake.transcribe).toHaveBeenCalledTimes(4);
 expect(fake.recover).toHaveBeenCalledExactlyOnceWith('whisper-small',true);
 const saved=(await store.list()).find(j=>j.id===id)!;
 expect(saved.stage).toBe('done');
 expect(saved.asrComplete).toBe(true);
 expect(saved.nextWindow).toBe(3);
 expect(saved.segments.map(s=>s.text)).toEqual(['first','second','third']);
});
it('stops after three failed inference attempts and keeps earlier checkpoint intact',async()=>{
 const {runner,fake,store}=setup();await runner.init();
 await runner.add([new File(['a'],'exhausted.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockImplementationOnce(async()=>[{start:3,end:4,text:'saved'}])
  .mockRejectedValue(Object.assign(new Error('Worker crashed'),{code:'worker-failed'}));
 runner.enqueue(id);await finished(runner);
 expect(fake.transcribe).toHaveBeenCalledTimes(4);
 expect(fake.recover).toHaveBeenCalledTimes(2);
 const saved=(await store.list()).find(j=>j.id===id)!;
 expect(saved.stage).toBe('error');
 expect(saved.nextWindow).toBe(1);
 expect(saved.segments.map(s=>s.text)).toEqual(['saved']);
});
it('does not retry a non-transient model or network error',async()=>{
 const {runner,fake,store}=setup();await runner.init();
 await runner.add([new File(['a'],'network-error.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockRejectedValueOnce(Object.assign(new Error('network unavailable'),{code:'transcribe-failed'}));
 runner.enqueue(id);await finished(runner);
 expect(fake.transcribe).toHaveBeenCalledTimes(1);
 expect(fake.recover).not.toHaveBeenCalled();
 expect((await store.list()).find(j=>j.id===id)!.nextWindow).toBe(0);
});
it('cancellation during recovery prevents another inference attempt',async()=>{
 const {runner,fake,store}=setup();await runner.init();
 await runner.add([new File(['a'],'cancel-recovery.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 let release:()=>void=()=>{};
 const blocked=new Promise<void>(resolve=>{release=resolve});
 fake.transcribe.mockRejectedValueOnce(Object.assign(new Error('Worker crashed'),{code:'worker-failed'}));
 fake.recover.mockImplementationOnce(async()=>{await blocked;return {cached:true,backend:'wasm'}});
 runner.enqueue(id);
 await vi.waitFor(()=>expect(fake.recover).toHaveBeenCalledTimes(1));
 runner.cancel();release();
 await finished(runner);
 expect(fake.transcribe).toHaveBeenCalledTimes(1);
 const job=(await store.list()).find(j=>j.id===id)!;
 expect(job.stage).toBe('cancelled');
 expect(job.nextWindow).toBe(0);
});

it('watchdog recovers a Worker that never resolves without advancing an uncommitted checkpoint',async()=>{
 const {fake,store,download}=setup();
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,decode:async()=>new Float32Array(60*16000),download,asrIdleMs:70});
 await runner.init();await runner.add([new File(['a'],'stalled-worker.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockImplementationOnce(()=>new Promise<{start:number;end:number;text:string}[]>(()=>{}))
  .mockImplementation(async()=>[{start:3,end:4,text:'after recovery'}]);
 runner.enqueue(id);await finished(runner);
 expect(fake.cancel).toHaveBeenCalledTimes(1);
 expect(fake.recover).toHaveBeenCalledOnce();
 expect(fake.transcribe).toHaveBeenCalledTimes(4);
 const saved=(await store.list()).find(j=>j.id===id)!;
 expect(saved.stage).toBe('done');
 expect(saved.nextWindow).toBe(3);
 expect(saved.segments).toHaveLength(3);
 expect(saved.segments.every(s=>s.text==='after recovery')).toBe(true);
});

it('persists the last committed checkpoint and backend when a later ASR window fails',async()=>{
 const {runner,fake,store}=setup();await runner.init();
 await runner.add([new File(['audio'],'diagnostic.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockImplementationOnce(async()=>[{start:3,end:4,text:'saved'}])
  .mockRejectedValueOnce(new Error('GPU worker failed'))
  .mockRejectedValueOnce(new Error('GPU worker failed'))
  .mockRejectedValueOnce(new Error('GPU worker failed'));
 runner.enqueue(id);await finished(runner);
 const job=runner.snapshot().jobs.find(j=>j.id===id)!;
 expect(job.stage).toBe('error');
 expect(job.failure).toMatchObject({reason:'execution-error',stage:'recognizing',completedWindows:1,backend:'wasm',checkpointSeconds:30,message:'GPU worker failed'});
 const disk=(await store.list()).find(j=>j.id===id)!;
 expect(disk.failure).toMatchObject({completedWindows:1,reason:'execution-error',backend:'wasm'});
});

it('commits trace of each ASR window and exposes a redacted downloadable diagnostic report',async()=>{
 const {runner,fake,store,diagnosticDownload}=setup();await runner.init();
 await runner.add([new File(['private recording'],'SECRET-MEETING.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockImplementationOnce(async()=>{
  const inFlight=(await store.list(false)).find(j=>j.id===id)!;
  expect(inFlight.trace).toEqual(expect.arrayContaining([
   expect.objectContaining({phase:'asr',code:'window-start',window:1,startSample:0,endSample:480000,pcmSamples:480000}),
   expect.objectContaining({phase:'asr',code:'window-attempt',window:1,attempt:1})
  ]));
  return [{start:3,end:4,text:'SECRET SPOKEN WORDS'}];
 });
 runner.enqueue(id);await finished(runner);
 const persisted=(await store.list(false)).find(j=>j.id===id)!;
 expect(persisted.trace?.filter(e=>e.code==='window-result')).toHaveLength(3);
 expect(persisted.trace?.filter(e=>e.code==='checkpoint-committed')).toHaveLength(3);
 expect(persisted.trace?.at(-1)?.code).toBe('job-complete');
 runner.exportDiagnostics(id);
 expect(diagnosticDownload).toHaveBeenCalledOnce();
 const [report,filename]=diagnosticDownload.mock.calls[0];
 expect(filename).toMatch(/^iscribe_diagnostics_[0-9a-f]{8}\.json$/);
 expect(report.job).toMatchObject({asrComplete:true,committedWindows:3});
 expect(JSON.stringify(report)).not.toContain('SECRET');
});


it('checks audio independently without starting Whisper and persists the PCM report',async()=>{
 const {runner,fake,store,diagnosticDownload}=setup();await runner.init();
 await runner.add([new File(['audio'],'inspect.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 await runner.inspectAudio(id);
 expect(fake.prepare).not.toHaveBeenCalled();
 expect(fake.transcribe).not.toHaveBeenCalled();
 expect(fake.diarize).not.toHaveBeenCalled();
 const saved=(await store.list(false)).find(j=>j.id===id)!;
 expect(saved).toMatchObject({stage:'waiting',nextWindow:0,asrComplete:false,audioCheck:{status:'passed',report:{pcmSamples:960000,windowCount:3,quietWindows:3}}});
 expect(saved.trace?.some(e=>e.code==='audio-check-pass')).toBe(true);
 runner.exportDiagnostics(id);
 const report=diagnosticDownload.mock.calls.at(-1)?.[0];
 expect(report?.audioCheck?.status).toBe('passed');
});

it('refuses to run ASR when PCM contains nonfinite samples; prior checkpoints remain intact',async()=>{
 const {runner,fake,store,decode}=setup();
 const file=new File(['source'],'invalid-pcm.wav');
 const original=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...original,stage:'interrupted',nextWindow:1,segments:[{start:3,end:4,text:'saved'}]},file);
 const pcm=new Float32Array(60*16000);pcm[800000]=NaN;
 decode.mockResolvedValueOnce(pcm);
 await runner.init();runner.enqueue(original.id);await finished(runner);
 expect(fake.prepare).not.toHaveBeenCalled();
 expect(fake.transcribe).not.toHaveBeenCalled();
 const saved=(await store.list(false)).find(j=>j.id===original.id)!;
 expect(saved.nextWindow).toBe(1);
 expect(saved.segments).toHaveLength(1);
 expect(saved.audioCheck).toMatchObject({status:'failed'});
 expect(saved.trace?.some(e=>e.code==='audio-check-error')).toBe(true);
});

it('standalone PCM inspection does not modify a saved transcript or its checkpoint',async()=>{
 const {runner,fake,store}=setup();
 const file=new File(['source'],'checkpoint-inspection.wav');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:true});
 const savedJob={...job,stage:'interrupted' as const,nextWindow:1,segments:[{start:3,end:4,text:'already saved'}]};
 await store.save(savedJob,file);await runner.init();
 await runner.inspectAudio(job.id);
 const after=(await store.list(false)).find(j=>j.id===job.id)!;
 expect(after.nextWindow).toBe(1);
 expect(after.stage).toBe('interrupted');
 expect(after.segments).toEqual(savedJob.segments);
 expect(fake.transcribe).not.toHaveBeenCalled();
});


it('remembers WebGPU for safe WASM fallback even when watchdog cancellation clears the active backend',async()=>{
 const {fake,store,download}=setup();
 fake.prepare.mockImplementation(async id=>{fake.active=id;return {cached:true,backend:'webgpu'}});
 fake.cancel.mockImplementation(()=>{
  fake.active=null;
  (fake as unknown as {onLifecycleChange:(e:{phase:'cancelled';model:null;backend:null;generation:number})=>void})
   .onLifecycleChange({phase:'cancelled',model:null,backend:null,generation:99});
 });
 fake.transcribe.mockImplementationOnce(()=>new Promise<{start:number;end:number;text:string}[]>(()=>{}))
  .mockImplementation(async()=>[{start:3,end:4,text:'recovered safely'}]);
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,decode:async()=>new Float32Array(60*16000),download,asrIdleMs:55});
 await runner.init();
 await runner.add([new File(['a'],'webgpu-device-lost.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 expect(fake.cancel).toHaveBeenCalledTimes(1);
 expect(fake.recover).toHaveBeenCalledExactlyOnceWith('whisper-small',true);
 const job=(await store.list(false)).find(j=>j.id===id)!;
 expect(job).toMatchObject({asrComplete:true,nextWindow:3});
 expect(job.trace?.some(e=>e.code==='window-error'&&e.backend==='webgpu'&&e.errorKind==='timeout')).toBe(true);
});


it('keeps complete TXT when speaker timeline has gaps; exports numeric reasons and retries diarization without ASR',async()=>{
 const {runner,fake,store,download,diagnosticDownload}=setup();await runner.init();
 await runner.add([new File(['private bytes'],'SECRET-SPEAKER.wav')],{model:'whisper-small',language:'ru',diarize:true});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockImplementation(async()=>[{start:3,end:4,text:'PRIVATE WORDS'}]);
 fake.diarize.mockResolvedValueOnce([
  {start:0,end:10,speaker:'A'},
  {start:25,end:30,speaker:'B'},
  {start:NaN,end:5,speaker:'malformed'}
 ]).mockResolvedValueOnce([{start:0,end:60,speaker:'A'}]);
 runner.enqueue(id);await finished(runner);
 const partial=(await store.get(id,false))!;
 expect(partial).toMatchObject({stage:'partial',asrComplete:true,nextWindow:3,diagnostics:{
  turns:3,validTurns:2,invalidTurns:1,segments:3,labeled:2,unlabeled:1,
  overlapMatches:2,boundaryMatches:0,uncovered:1,ambiguous:0
 }});
 expect(partial.speakerSegments?.map(x=>x.speaker)).toEqual(['A','B',undefined]);
 expect(partial.segments).toHaveLength(3);
 runner.export(id,'plain');
 expect(download).toHaveBeenCalled();
 runner.exportDiagnostics(id);
 const report=diagnosticDownload.mock.calls.at(-1)?.[0];
 expect(report?.speakerAlignment).toMatchObject({invalidTurns:1,uncovered:1,unlabeled:1});
 expect(JSON.stringify(report)).not.toContain('SECRET-SPEAKER');
 expect(JSON.stringify(report)).not.toContain('PRIVATE WORDS');
 const asrCount=fake.transcribe.mock.calls.length;
 runner.enqueue(id);await finished(runner);
 const done=(await store.get(id,false))!;
 expect(fake.transcribe).toHaveBeenCalledTimes(asrCount);
 expect(fake.diarize).toHaveBeenCalledTimes(2);
 expect(done).toMatchObject({stage:'done',asrComplete:true,nextWindow:3,diagnostics:{unlabeled:0,labeled:3}});
 expect(done.speakerSegments).toHaveLength(3);
});


it.each(['decode','resample'] as const)('stops a stalled streamed window 41 at %s without changing the first 40 checkpoints',async(stage)=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'stream-41.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'recognizing',nextWindow:40,segments:[{start:3,end:4,text:'saved'}]},file);
 // Mock only the source size; no 146 MB fixture or full PCM allocation.
 Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const close=vi.fn();
 const read=vi.fn<StreamedAudio['read']>(async(_window,observe)=>{
  if(stage==='resample')await observe?.({code:'stream-resample-start',streamStage:'resample',sourceSampleRate:44100});
  return new Promise<Float32Array>(()=>{});
 });
 let decoderId=0;
 const openStream=vi.fn(async()=>({length:3834*16000,decoderId:++decoderId,read,close}));
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamDecodeIdleMs:100,streamResampleIdleMs:40});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved.stage).toBe('error');
 expect(saved.nextWindow).toBe(40);
 expect(saved.segments.map(x=>x.text)).toEqual(['saved']);
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'window-error',phase:'audio',window:41,streamStage:stage,errorKind:'timeout'})]));
 expect(fake.transcribe).not.toHaveBeenCalled();
 expect(read).toHaveBeenCalledTimes(3);
 expect(openStream).toHaveBeenCalledTimes(3);
 expect(saved.streamRecovery).toEqual({window:41,windowRecoveries:2,totalRecoveries:2});
 expect(close).toHaveBeenCalled();
 // A fresh runner must not reset the persisted retry allowance.
 const resumed=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamDecodeIdleMs:100,streamResampleIdleMs:40});
 await resumed.init();resumed.enqueue(job.id);await finished(resumed);
 expect(openStream).toHaveBeenCalledTimes(4);
 expect(read).toHaveBeenCalledTimes(4);
 expect((await store.get(job.id,false))?.nextWindow).toBe(40);
 await store.remove(job.id);
});


it('reopens a fresh decoder at window 41 and commits each remaining window exactly once',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'stream-recover.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'recognizing',nextWindow:40,segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 let late:(pcm:Float32Array)=>void=()=>{};
 const oldRead=vi.fn<StreamedAudio['read']>(()=>new Promise(resolve=>{late=resolve}));
 const newRead=vi.fn<StreamedAudio['read']>(async window=>new Float32Array(window.end-window.start));
 const oldClose=vi.fn(),newClose=vi.fn(),length=1055*16000;
 const openStream=vi.fn<typeof openStreamedAudio>()
  .mockResolvedValueOnce({length,decoderId:1,read:oldRead,close:oldClose})
  .mockImplementationOnce(async()=>{
   const durable=(await store.get(job.id,false))!;
   expect(durable.nextWindow).toBe(40);
   expect(durable.streamRecovery?.totalRecoveries).toBe(1);
   expect(oldClose).toHaveBeenCalledOnce();
   return {length,decoderId:2,read:newRead,close:newClose};
  });
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamDecodeIdleMs:60});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 late(new Float32Array(480000));
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'done',asrComplete:true,nextWindow:42});
 expect(saved.segments).toHaveLength(3);
 expect(saved.segments[0].text).toBe('saved');
 expect(oldRead.mock.calls[0][0].start).toBe(1000*16000);
 expect(newRead.mock.calls.map(c=>c[0].start)).toEqual([1000*16000,1025*16000]);
 expect(fake.transcribe).toHaveBeenCalledTimes(2);
 expect(fake.prepare).toHaveBeenCalledTimes(1);
 expect(fake.recover).not.toHaveBeenCalled();
 expect(newClose).toHaveBeenCalledOnce();
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'stream-recovered',window:41,decoderId:2,attempt:2})]));
 await store.remove(job.id);
});


it('bounds a stalled decoder reopening and closes any late decoder without touching the checkpoint',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'stream-reopen-timeout.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'recognizing',nextWindow:40,segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const oldClose=vi.fn(),lateClose=vi.fn(),length=1055*16000;
 const read=vi.fn<StreamedAudio['read']>(()=>new Promise(()=>{}));
 let late:(audio:StreamedAudio)=>void=()=>{};
 let retrySignal:AbortSignal|undefined;
 const openStream=vi.fn<typeof openStreamedAudio>()
  .mockResolvedValueOnce({length,decoderId:1,read,close:oldClose})
  .mockImplementationOnce((_file,signal)=>{retrySignal=signal;return new Promise(resolve=>{late=resolve})});
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamDecodeIdleMs:50,streamOpenIdleMs:50});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 expect(retrySignal?.aborted).toBe(true);
 late({length,decoderId:2,read,close:lateClose});
 await vi.waitFor(()=>expect(lateClose).toHaveBeenCalledOnce());
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'error',nextWindow:40,streamRecovery:{totalRecoveries:1}});
 expect(saved.segments.map(x=>x.text)).toEqual(['saved']);
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'stream-recovery-stop',streamStage:'open',window:41,errorKind:'timeout'})]));
 expect(openStream).toHaveBeenCalledTimes(2);
 expect(fake.transcribe).not.toHaveBeenCalled();
 await store.remove(job.id);
});

it('does not reopen a decoder after invalid PCM',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'stream-invalid-pcm.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'recognizing',nextWindow:40,segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const close=vi.fn();
 const read=vi.fn<StreamedAudio['read']>(async window=>{
  const pcm=new Float32Array(window.end-window.start);pcm[0]=NaN;return pcm;
 });
 const openStream=vi.fn(async()=>({length:1055*16000,decoderId:1,read,close}));
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'error',nextWindow:40});
 expect(saved.streamRecovery).toBeUndefined();
 expect(openStream).toHaveBeenCalledOnce();
 expect(fake.transcribe).not.toHaveBeenCalled();
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'window-error',streamStage:'pcm-check',errorKind:'invalid-audio'})]));
 await store.remove(job.id);
});


it.each(['success','short-part','stall-part'] as const)('uses split fallback at window 41: %s',async(scenario)=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'stream-split.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'recognizing',nextWindow:40,segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const stalled=vi.fn<StreamedAudio['read']>(()=>new Promise(()=>{}));
 const starts:number[]=[],length=1028*16000;
 const read=vi.fn<StreamedAudio['read']>(async(window,_observe,_beat,strict)=>{
  expect(strict).toBe(true);
  starts.push(window.start);
  const part=starts.length;
  if(part===3&&scenario==='stall-part')return new Promise(()=>{});
  const pcm=new Float32Array(window.end-window.start-(part===3&&scenario==='short-part'?1:0));
  pcm.fill(part/10);return pcm;
 });
 const openStream=vi.fn<typeof openStreamedAudio>()
  .mockResolvedValueOnce({length,decoderId:1,read:stalled,close:vi.fn()})
  .mockResolvedValueOnce({length,decoderId:2,read:stalled,close:vi.fn()})
  .mockImplementationOnce(async()=>{
   const durable=(await store.get(job.id,false))!;
   expect(durable.nextWindow).toBe(40);
   expect(durable.streamRecovery?.totalRecoveries).toBe(2);
   return {length,decoderId:3,read,close:vi.fn()};
  });
 // Capture the actual PCM given to Whisper; every part must occupy its
 // original sample range, including the short final fragment.
 const actual:Float32Array[]=[];
 fake.transcribe.mockImplementation(async()=>[{start:3,end:4,text:'fallback'}]);
 const original=fake.transcribe;
 const manager={...fake,transcribe:vi.fn(async(pcm:Float32Array)=>{actual.push(pcm);return original()})};
 const runner=new JobRunner({store,manager:manager as unknown as ModelManager,openStream,streamDecodeIdleMs:60});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(openStream).toHaveBeenCalledTimes(3);
 expect(stalled).toHaveBeenCalledTimes(2);
 expect(saved.streamRecovery).toEqual({window:41,windowRecoveries:2,totalRecoveries:2});
 expect(saved.segments[0].text).toBe('saved');
 if(scenario==='success'){
  expect(starts).toEqual([1000,1005,1010,1015,1020,1025].map(x=>x*16000));
  expect(actual).toHaveLength(1);expect(actual[0]).toHaveLength(28*16000);
  for(let i=0;i<6;i++)expect(actual[0][i*80000]).toBeCloseTo((i+1)/10);
  expect(saved).toMatchObject({stage:'done',asrComplete:true,nextWindow:41});
  expect(saved.segments).toHaveLength(2);
  expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'stream-split-ready',window:41,pcmSamples:448000})]));
 }else{
  expect(starts).toHaveLength(3);expect(actual).toHaveLength(0);
  expect(saved).toMatchObject({stage:'error',nextWindow:40});
  expect(saved.segments).toHaveLength(1);
 }
 await store.remove(job.id);
});


it('rotates a healthy stream only at committed window boundaries without spending recovery budget',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'stream-rotation.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'recognizing',nextWindow:38,segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const length=1055*16000,firstClose=vi.fn(),secondClose=vi.fn();
 const firstRead=vi.fn<StreamedAudio['read']>(async w=>new Float32Array(w.end-w.start));
 const secondRead=vi.fn<StreamedAudio['read']>(async w=>new Float32Array(w.end-w.start));
 const openStream=vi.fn<typeof openStreamedAudio>()
  .mockResolvedValueOnce({length,decoderId:1,read:firstRead,close:firstClose})
  .mockImplementationOnce(async()=>{
   expect((await store.get(job.id,false))?.nextWindow).toBe(40);
   expect(firstClose).toHaveBeenCalledOnce();
   return {length,decoderId:2,read:secondRead,close:secondClose};
  });
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamRotateWindows:2});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:42,asrComplete:true});
 expect(firstRead.mock.calls.map(c=>c[0].start)).toEqual([950,975].map(x=>x*16000));
 expect(secondRead.mock.calls.map(c=>c[0].start)).toEqual([1000,1025].map(x=>x*16000));
 expect(openStream).toHaveBeenCalledTimes(2);expect(secondClose).toHaveBeenCalledOnce();
 expect(fake.transcribe).toHaveBeenCalledTimes(4);expect(fake.prepare).toHaveBeenCalledOnce();
 expect(saved.streamRecovery).toBeUndefined();expect(saved.segments).toHaveLength(5);
 expect(saved.trace).toEqual(expect.arrayContaining([
  expect.objectContaining({code:'stream-rotation-ready',window:41,decoderId:2,rotationCount:1}),
  expect.objectContaining({code:'stream-session-closed',decoderId:2,closeReason:'finish',decoderWindows:2})
 ]));
 await store.remove(job.id);
});

it('stops a failed planned rotation with durable text and no extra recovery attempt',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'rotation-failed.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'recognizing',nextWindow:39,segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});vi.spyOn(store,'audio').mockResolvedValue(file);
 const close=vi.fn(),read=vi.fn<StreamedAudio['read']>(async w=>new Float32Array(w.end-w.start));
 const openStream=vi.fn<typeof openStreamedAudio>()
  .mockResolvedValueOnce({length:1055*16000,decoderId:1,read,close})
  .mockRejectedValueOnce(new Error('opening failed'));
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamRotateWindows:1});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'error',nextWindow:40});
 expect(saved.segments).toHaveLength(2);expect(saved.streamRecovery).toBeUndefined();
 expect(openStream).toHaveBeenCalledTimes(2);expect(close).toHaveBeenCalledOnce();
 expect(fake.transcribe).toHaveBeenCalledOnce();
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'stream-rotation-error',window:41})]));
 await store.remove(job.id);
});

it('rotates standalone audio inspection without invoking Whisper or advancing the transcript',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'inspection-rotation.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'interrupted',nextWindow:1,segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});vi.spyOn(store,'audio').mockResolvedValue(file);
 const read=vi.fn<StreamedAudio['read']>(async w=>new Float32Array(w.end-w.start));
 const closes=[vi.fn(),vi.fn(),vi.fn()];let index=0;
 const openStream=vi.fn<typeof openStreamedAudio>(async()=>({length:60*16000,decoderId:index+1,read,close:closes[index++]}));
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamRotateWindows:1});
 await runner.init();await runner.inspectAudio(job.id);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'interrupted',nextWindow:1,audioCheck:{status:'passed'}});
 expect(saved.segments.map(s=>s.text)).toEqual(['saved']);
 expect(openStream).toHaveBeenCalledTimes(3);expect(read).toHaveBeenCalledTimes(3);
 for(const close of closes)expect(close).toHaveBeenCalledOnce();
 expect(fake.prepare).not.toHaveBeenCalled();expect(fake.transcribe).not.toHaveBeenCalled();
 await store.remove(job.id);
});


it('probes only window 41 with both strategies without touching ASR or retry budget',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'window-inspection.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 const budget={window:41,windowRecoveries:2,totalRecoveries:3};
 await store.save({...job,stage:'interrupted',nextWindow:40,segments:[{start:3,end:4,text:'saved'}],streamRecovery:budget},file);
 const whole=vi.fn<StreamedAudio['read']>(async w=>new Float32Array(w.end-w.start));
 const split=vi.fn<StreamedAudio['read']>(async(w,_observe,_beat,strict)=>{
  expect(strict).toBe(true);return new Float32Array(w.end-w.start);
 });
 const close1=vi.fn(),close2=vi.fn(),length=3834*16000;
 const openStream=vi.fn<typeof openStreamedAudio>()
  .mockResolvedValueOnce({length,decoderId:1,read:whole,close:close1})
  .mockResolvedValueOnce({length,decoderId:2,read:split,close:close2});
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream});
 await runner.init();await runner.inspectWindow(job.id,41,'whole');await runner.inspectWindow(job.id,41,'split');
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'interrupted',nextWindow:40,streamRecovery:budget});
 expect(saved.segments.map(x=>x.text)).toEqual(['saved']);
 expect(saved.audioCheck).toBeUndefined();expect(saved.benchmark).toBeUndefined();
 expect(whole.mock.calls.map(c=>c[0].start)).toEqual([1000*16000]);
 expect(split.mock.calls.map(c=>c[0].start)).toEqual([1000,1005,1010,1015,1020,1025].map(x=>x*16000));
 expect(saved.windowInspections).toEqual([
  expect.objectContaining({window:41,strategy:'whole',status:'passed',startSample:16000000,endSample:16480000,completedParts:1}),
  expect.objectContaining({window:41,strategy:'split',status:'passed',completedParts:6,report:expect.objectContaining({pcmSamples:480000})})
 ]);
 expect(fake.prepare).not.toHaveBeenCalled();expect(fake.transcribe).not.toHaveBeenCalled();
 expect(close1).toHaveBeenCalledOnce();expect(close2).toHaveBeenCalledOnce();
 await store.remove(job.id);
});

it('records a failed split probe and rejects invalid window numbers without advancing ASR',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'window-probe-failure.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'interrupted',nextWindow:40,segments:[{start:3,end:4,text:'saved'}]},file);
 let calls=0;
 const read=vi.fn<StreamedAudio['read']>(async w=>{
  if(++calls===3)return new Promise(()=>{});
  return new Float32Array(w.end-w.start);
 });
 const openStream=vi.fn<typeof openStreamedAudio>(async()=>({length:3834*16000,decoderId:1,read,close:vi.fn()}));
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamDecodeIdleMs:60});
 await runner.init();
 await expect(runner.inspectWindow(job.id,0,'whole')).rejects.toThrow();
 expect(openStream).not.toHaveBeenCalled();
 await runner.inspectWindow(job.id,41,'split');
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'interrupted',nextWindow:40});
 expect(saved.windowInspections).toEqual([expect.objectContaining({window:41,status:'failed',strategy:'split',completedParts:2,errorKind:'timeout',failureStage:'decode'})]);
 expect(saved.streamRecovery).toBeUndefined();expect(fake.transcribe).not.toHaveBeenCalled();
 await runner.inspectWindow(job.id,155,'whole');
 expect(read).toHaveBeenCalledTimes(3);
 expect((await store.get(job.id,false))?.windowInspections).toEqual([expect.objectContaining({window:155,status:'failed',errorKind:'invalid-audio',totalWindows:154})]);
 await store.remove(job.id);
});
