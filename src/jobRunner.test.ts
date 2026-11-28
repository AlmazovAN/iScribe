import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';
vi.mock('./ml/worker?worker',()=>({default:class{}}));
import {JobRunner} from './jobRunner';
import {JobStore} from './jobStore';
import {createJob} from './jobs';
import type {diagnosticReport} from './jobTrace';
import type {ModelManager} from './ml/manager';
import type {StreamedAudio,openStreamedAudio} from './streamedAudio';
import {ResourceManager} from './performance/resourceManager';
import {FfmpegDecoderError,decoderIdentity} from './decoderDiagnostics';
import {ALIGNMENT_CONTRACT,type AlignmentReport,type AlignmentSegment} from './ml/forcedAlignment';
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
 expect(j.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'pipeline-stage',pipelineStage:'diarization',pipelineState:'failed'})]));
 expect(j.trace?.some(e=>e.pipelineStage==='speaker-assignment')).toBe(false);
});
it('resumes at the committed window and never re-runs ASR when only speakers need retry',async()=>{
 const {runner,fake,store}=setup();const file=new File(['a'],'resume.wav');const j=createJob(file,{model:'whisper-small',language:'en',diarize:true});
 await store.save({...j,stage:'recognizing',nextWindow:1,segments:[{start:3,end:4,text:'saved'}]},file);await runner.init();runner.enqueue(j.id);await finished(runner);
 expect(fake.transcribe).toHaveBeenCalledTimes(2);expect(fake.transcribe.mock.calls[0]).toHaveLength(4);
 fake.transcribe.mockClear();runner.enqueue(j.id);await finished(runner);expect(fake.transcribe).not.toHaveBeenCalled();expect(fake.diarize).toHaveBeenCalledTimes(2);
 const resumed=(await store.get(j.id,false))!;
 expect(resumed.trace?.filter(e=>e.pipelineStage==='asr').at(-1)).toMatchObject({pipelineState:'reused',pipelineReason:'asr-already-committed'});
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
it('stops after two failed inference attempts and keeps earlier checkpoint intact',async()=>{
 const {runner,fake,store}=setup();await runner.init();
 await runner.add([new File(['a'],'exhausted.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockImplementationOnce(async()=>[{start:3,end:4,text:'saved'}])
  .mockRejectedValue(Object.assign(new Error('Worker crashed'),{code:'worker-failed'}));
 runner.enqueue(id);await finished(runner);
 expect(fake.transcribe).toHaveBeenCalledTimes(3);
 expect(fake.recover).toHaveBeenCalledTimes(1);
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
 const stages=persisted.trace?.filter(e=>e.code==='pipeline-stage'&&e.pipelineState!=='running');
 expect(stages?.map(e=>[e.pipelineStage,e.pipelineState])).toEqual([
  ['preflight','completed'],['decode','completed'],['pcm-gate','completed'],['vad','skipped'],['segmentation','completed'],['asr','completed'],['alignment','skipped'],
  ['diarization','skipped'],['speaker-assignment','skipped'],['finalize','completed'],['export','requested']
 ]);
 expect(persisted.trace?.findIndex(e=>e.code==='job-complete')).toBeLessThan(persisted.trace!.findIndex(e=>e.pipelineStage==='export'));
 expect(persisted.trace?.at(-1)).toMatchObject({code:'pipeline-stage',pipelineStage:'export',pipelineState:'requested'});
 runner.exportDiagnostics(id);
 expect(diagnosticDownload).toHaveBeenCalledOnce();
 const [report,filename]=diagnosticDownload.mock.calls[0];
 expect(filename).toMatch(/^iscribe_diagnostics_[0-9a-f]{8}\.json$/);
 expect(report.job).toMatchObject({asrComplete:true,committedWindows:3});
 expect(report.benchmark).toMatchObject({schema:'iscribe.benchmark.v1',committedCheckpointWindows:3});
 expect(report.activeAsrAttempt).toBeNull();
 expect(JSON.stringify(report)).not.toContain('SECRET');
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
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'audio-check-error',pcmFailureReason:'invalid-sample',pcmFailureWindow:2,pcmFailureSample:800000}),expect.objectContaining({code:'pipeline-stage',pipelineStage:'pcm-gate',pipelineState:'failed'})]));
 expect(saved.trace?.some(e=>e.pipelineStage==='asr')).toBe(false);
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
 expect(read).toHaveBeenCalledTimes(2);
 expect(openStream).toHaveBeenCalledTimes(2);
 expect(saved.streamRecovery).toEqual({window:41,windowRecoveries:1,totalRecoveries:1});
 expect(saved.recoveryLedger?.operations['stream-window']).toMatchObject({unit:41,attempts:2,done:false});
 expect(close).toHaveBeenCalled();
 // A fresh runner must not reset the persisted retry allowance.
 const resumed=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamDecodeIdleMs:100,streamResampleIdleMs:40});
 await resumed.init();resumed.enqueue(job.id);await finished(resumed);
 expect(openStream).toHaveBeenCalledTimes(3); // opening the stream is not a window read
 expect(read).toHaveBeenCalledTimes(2);
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
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'window-error',streamStage:'pcm-check',errorKind:'invalid-audio',pcmFailureReason:'invalid-sample',pcmFailureWindow:41,pcmFailureSample:16000000})]));
 await store.remove(job.id);
});


it.each(['success','short-part','stall-part'] as const)('uses split fallback at window 41: %s',async(scenario)=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'stream-split.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'recognizing',nextWindow:40,segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const stalled=vi.fn<StreamedAudio['read']>(async(_window,observe)=>{
  await observe?.({code:'stream-resample-start',streamStage:'resample',sourceSampleRate:44100});
  return new Promise<Float32Array>(()=>{});
 });
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
  .mockImplementationOnce(async()=>{
   const durable=(await store.get(job.id,false))!;
   expect(durable.nextWindow).toBe(40);
   expect(durable.streamRecovery?.totalRecoveries).toBe(1);
   return {length,decoderId:2,read,close:vi.fn()};
  });
 // Capture the actual PCM given to Whisper; every part must occupy its
 // original sample range, including the short final fragment.
 const actual:Float32Array[]=[];
 fake.transcribe.mockImplementation(async()=>[{start:3,end:4,text:'fallback'}]);
 const original=fake.transcribe;
 const manager={...fake,transcribe:vi.fn(async(pcm:Float32Array)=>{actual.push(pcm);return original()})};
 const runner=new JobRunner({store,manager:manager as unknown as ModelManager,openStream,streamDecodeIdleMs:60,streamResampleIdleMs:60});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(openStream).toHaveBeenCalledTimes(2);
 expect(stalled).toHaveBeenCalledTimes(1);
 expect(saved.streamRecovery).toEqual({window:41,windowRecoveries:1,totalRecoveries:1});
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

it('does not open another decoder if watchdog disposal failed',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'dispose-failure.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,stage:'interrupted',nextWindow:40,segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});vi.spyOn(store,'audio').mockResolvedValue(file);
 const close=vi.fn(()=>{throw new Error('native disposal failed')});
 const read=vi.fn<StreamedAudio['read']>(()=>new Promise(()=>{}));
 const openStream=vi.fn<typeof openStreamedAudio>(async()=>({length:1055*16000,decoderId:1,read,close}));
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,streamDecodeIdleMs:60});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'error',nextWindow:40});
 expect(saved.segments.map(s=>s.text)).toEqual(['saved']);
 expect(openStream).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
 expect(fake.transcribe).not.toHaveBeenCalled();
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'stream-session-close-error',closeReason:'error'})]));
 await store.remove(job.id);
});

it('prefetches next streamed window during ASR and commits in original order',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'pipeline.mp3'),job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save(job,file);Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const resources=new ResourceManager(null),policy={...resources.policy(),targetPrefetchWindows:2 as const,pauseRatio:0,maxPauseMs:0};
 vi.spyOn(resources,'policy').mockReturnValue(policy);
 const read=vi.fn<StreamedAudio['read']>(async w=>new Float32Array(w.end-w.start));
 const close=vi.fn();
 const openStream=vi.fn<typeof openStreamedAudio>(async()=>({length:60*16000,decoderId:1,read,close}));
 const runner=new JobRunner({store,resources,manager:fake as unknown as ModelManager,openStream});
 fake.transcribe.mockImplementationOnce(async()=>{
  await vi.waitFor(()=>expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));
  expect((await store.get(job.id,false))?.nextWindow).toBe(0);
  return [{start:3,end:4,text:'текст'}];
 });
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:3,benchmark:{audioPipeline:{scheduled:2,consumed:2,failed:0,peakQueued:2}}});
 expect(read.mock.calls.map(c=>c[0].start)).toEqual([0,25*16000,50*16000]);
 expect(saved.trace?.filter(e=>e.code==='stream-pcm-check-end').map(e=>e.pcmQuality?.startSample)).toEqual([0,400000,800000]);
 expect(saved.trace?.filter(e=>e.code==='stream-pcm-check-end').every(e=>e.pcmQuality?.rms===0)).toBe(true);
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'pipeline-stage',pipelineStage:'pcm-gate',pipelineState:'deferred',pipelineReason:'per-window-validation'})]));
 expect(fake.transcribe).toHaveBeenCalledTimes(3);expect(saved.segments).toHaveLength(3);
 expect(openStream).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
 await store.remove(job.id);
});
it('defers speculative decoder failure until preceding window commits and uses existing recovery',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'pipeline-stall.mp3'),job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save(job,file);Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const resources=new ResourceManager(null),policy={...resources.policy(),targetPrefetchWindows:2 as const,pauseRatio:0,maxPauseMs:0};
 vi.spyOn(resources,'policy').mockReturnValue(policy);
 const read=vi.fn<StreamedAudio['read']>(async w=>w.start===0?new Float32Array(w.end-w.start):new Promise<Float32Array>(()=>{}));
 const close=vi.fn(),newRead=vi.fn<StreamedAudio['read']>(async w=>new Float32Array(w.end-w.start));
 const openStream=vi.fn<typeof openStreamedAudio>()
  .mockResolvedValueOnce({length:60*16000,decoderId:1,read,close})
  .mockImplementationOnce(async()=>{
   expect((await store.get(job.id,false))?.nextWindow).toBe(1);
   return {length:60*16000,decoderId:2,read:newRead,close:vi.fn()};
  });
 const runner=new JobRunner({store,resources,manager:fake as unknown as ModelManager,openStream,streamDecodeIdleMs:60});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:3,streamRecovery:{window:2,totalRecoveries:1},benchmark:{audioPipeline:{failed:1}}});
 expect(openStream).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledTimes(2);
 expect(newRead.mock.calls.map(c=>c[0].start)).toEqual([25*16000,50*16000]);
 expect(fake.transcribe).toHaveBeenCalledTimes(3);expect(saved.segments).toHaveLength(3);
 await store.remove(job.id);
});

it('coalesces streamed completion metadata but commits every window and preserves trace',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'storage-ui.mp3'),job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save(job,file);Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const resources=new ResourceManager(null);
 vi.spyOn(resources,'policy').mockReturnValue({...resources.policy(),targetPrefetchWindows:0,pauseRatio:0,maxPauseMs:0});
 const read=vi.fn<StreamedAudio['read']>(async(w,observe)=>{
  await observe?.({code:'stream-samples',streamStage:'decode',packets:1});
  await observe?.({code:'stream-read-end',streamStage:'decode',elapsedMs:1});
  await observe?.({code:'stream-resample-start',streamStage:'resample'});
  await observe?.({code:'stream-resample-end',streamStage:'resample',elapsedMs:1});
  return new Float32Array(w.end-w.start);
 });
 const runner=new JobRunner({store,resources,manager:fake as unknown as ModelManager,openStream:async()=>({length:60*16000,decoderId:1,read,close:()=>{}})});
 await runner.init();const writes=vi.spyOn(store,'save');runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:3,benchmark:{storageUi:{deferredMetadataWrites:12}}});
 expect(saved.segments).toHaveLength(3);
 expect(saved.trace?.filter(e=>e.code==='checkpoint-committed')).toHaveLength(3);
 expect(saved.trace?.filter(e=>e.code==='stream-resample-end')).toHaveLength(3);
 // A completion event is stored with the next critical stage, not omitted.
 expect(writes.mock.calls.some(([j])=>j.nextWindow===1&&j.segments.length===1)).toBe(true);
 expect(writes.mock.calls.some(([j])=>j.nextWindow===2&&j.segments.length===2)).toBe(true);
 expect(writes.mock.calls.some(([j])=>j.nextWindow===3&&j.segments.length===3)).toBe(true);
 await store.remove(job.id);
});

it('starts read-only lookahead before attempt metadata settles but never dispatches ASR before durable write',async()=>{
 const {fake,store}=setup();
 const file=new File(['audio'],'early-prefetch.mp3'),job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save(job,file);Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const resources=new ResourceManager(null);
 vi.spyOn(resources,'policy').mockReturnValue({...resources.policy(),targetPrefetchWindows:1,pauseRatio:0,maxPauseMs:0});
 const read=vi.fn<StreamedAudio['read']>(async w=>new Float32Array(w.end-w.start));
 const runner=new JobRunner({store,resources,manager:fake as unknown as ModelManager,openStream:async()=>({length:60*16000,decoderId:1,read,close:()=>{}})});
 await runner.init();
 const save=store.save.bind(store);
 let entered=false,release:()=>void=()=>{};
 vi.spyOn(store,'save').mockImplementation(async(j,file)=>{
  if(!entered&&j.id===job.id&&j.nextWindow===0&&j.trace?.some(e=>e.code==='window-attempt')){
   entered=true;await new Promise<void>(resolve=>{release=resolve});
  }
  return save(j,file);
 });
 runner.enqueue(job.id);
 try{
  await vi.waitFor(()=>expect(entered).toBe(true));
  await vi.waitFor(()=>expect(read.mock.calls.map(c=>c[0].start)).toContain(25*16000));
  expect(fake.transcribe).not.toHaveBeenCalled();
  expect((await store.get(job.id,false))?.nextWindow).toBe(0);
 }finally{release()}
 await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:3,benchmark:{audioPipeline:{scheduled:2,consumed:2,earlyDispatches:2,failed:0,peakQueued:1}}});
 expect(saved.benchmark?.audioPipeline?.preDispatchLeadMs).toBeGreaterThanOrEqual(0);
 expect(fake.transcribe).toHaveBeenCalledTimes(3);
 await store.remove(job.id);
});

it('DEC-04 retries a full FFmpeg worker failure once, reserving the retry before invoking decode',async()=>{
 const {fake,store,decode}=setup();
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,decode,decoderPreference:'ffmpeg',download:vi.fn()});
 await runner.init();await runner.add([new File(['fixture'],'dec04-retry.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 decode.mockRejectedValueOnce(new FfmpegDecoderError('worker','decode'))
  .mockImplementationOnce(async()=>{
   expect((await store.get(id,false))?.fullDecodeRecoveries).toBe(1);
   return new Float32Array(60*16000);
  });
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:3,fullDecodeRecoveries:1,decoderIdentity:decoderIdentity('ffmpeg','full')});
 expect(decode).toHaveBeenCalledTimes(2);
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'decoder-full-retry',decoderKind:'ffmpeg',decoderFailure:'worker'})]));
 await store.remove(id);
});

it('DEC-04 reopens a FFmpeg window on coverage failure and retains prior ASR checkpoint',async()=>{
 const {fake,store}=setup(),file=new File(['fixture'],'dec04-stream.mp3');
 const job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 const length=1030*16000;
 await store.save({...job,stage:'recognizing',nextWindow:40,duration:1030,
  decoderIdentity:decoderIdentity('ffmpeg','windowed'),segments:[{start:3,end:4,text:'saved'}]},file);
 Object.defineProperty(file,'size',{value:146_500_000});
 vi.spyOn(store,'audio').mockResolvedValue(file);
 const read=vi.fn<StreamedAudio['read']>().mockRejectedValue(new FfmpegDecoderError('coverage','decode'));
 const close=vi.fn();
 const nextRead=vi.fn<StreamedAudio['read']>(async w=>new Float32Array(w.end-w.start));
 const openStream=vi.fn<typeof openStreamedAudio>()
  .mockResolvedValueOnce({length,decoderId:1,read,close})
  .mockImplementationOnce(async()=>{
   expect((await store.get(job.id,false))?.streamRecovery?.totalRecoveries).toBe(1);
   expect(close).toHaveBeenCalledOnce();
   return {length,decoderId:2,read:nextRead,close:vi.fn()};
  });
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,openStream,decoderPreference:'legacy',download:vi.fn()});
 await runner.init();runner.enqueue(job.id);await finished(runner);
 const saved=(await store.get(job.id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:41,decoderIdentity:decoderIdentity('ffmpeg','windowed')});
 expect(saved.segments[0].text).toBe('saved');
 expect(openStream).toHaveBeenCalledTimes(2);expect(fake.transcribe).toHaveBeenCalledTimes(1);
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'stream-recovery-start',window:41,decoderKind:'ffmpeg',decoderFailure:'coverage'})]));
 await store.remove(job.id);
});

it('PIPE-02 publishes numeric quality for full decode, preserving exact silence and normal ASR',async()=>{
 const {runner,store,fake}=setup();await runner.init();
 await runner.add([new File(['a'],'pipe02-silence.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:3,audioCheck:{status:'passed',report:{quality:{revision:1,startSample:0,endSample:960000,zeroSamples:960000,rms:0}}}});
 expect(fake.transcribe).toHaveBeenCalledTimes(3);
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'audio-check-pass',pcmQuality:expect.objectContaining({zeroSamples:960000})})]));
 await store.remove(id);
});

it('PIPE-04 reuses full PCM and saved RAW after an ASR commit failure, without duplicating text',async()=>{
 const {fake,store,decode}=setup();
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,download:()=>{}});
 await runner.init();
 await runner.add([new File(['fixture source'],'pipe04-replay.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockRejectedValueOnce(Object.assign(new Error('Worker crashed'),{code:'worker-failed'}));
 const save=store.save.bind(store);let fail=true;
 vi.spyOn(store,'save').mockImplementation(async(job,file)=>{
  if(fail&&job.id===id&&job.nextWindow===1){fail=false;throw new Error('injected transaction failure')}
  return save(job,file);
 });
 runner.enqueue(id);await finished(runner);
 expect((await store.get(id,false))!).toMatchObject({stage:'error',nextWindow:0,segments:[]});
 expect(fake.transcribe).toHaveBeenCalledTimes(2);expect(decode).toHaveBeenCalledTimes(1);
 expect((await store.get(id,false))?.asrQuality).toBeUndefined();
 expect((await store.get(id,false))?.recoveryLedger?.operations.asr).toMatchObject({unit:1,attempts:2,done:false});
 const resumed=new JobRunner({store:new JobStore(),manager:fake as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,download:()=>{}});
 await resumed.init();resumed.enqueue(id);await finished(resumed);
 const result=(await store.get(id,false))!;
 expect(result).toMatchObject({stage:'done',nextWindow:3,asrComplete:true});
 expect(result.segments).toHaveLength(3);
 expect(result.asrQuality).toMatchObject({examinedWindows:3,warningWindows:3,silentTextWindows:3});
 expect(fake.transcribe).toHaveBeenCalledTimes(4);expect(decode).toHaveBeenCalledTimes(1);
 expect(result.trace).toEqual(expect.arrayContaining([
  expect.objectContaining({code:'checkpoint-artifact',artifactStage:'pcm',artifactState:'reused'}),
  expect.objectContaining({code:'checkpoint-artifact',artifactStage:'asr',artifactState:'reused',window:1})
 ]));
 await store.remove(id);
});
it('PIPE-04 preserves invalid RAW timestamps and does not repeat inference on resume',async()=>{
 const {fake,store,decode}=setup();
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,download:()=>{}});
 await runner.init();
 await runner.add([new File(['fixture source'],'pipe04-invalid-raw.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.transcribe.mockResolvedValueOnce([{start:NaN,end:4,text:'invalid timestamp'}]);
 runner.enqueue(id);await finished(runner);
 expect(await store.get(id,false)).toMatchObject({stage:'error',nextWindow:0,segments:[]});
 runner.enqueue(id);await finished(runner);
 expect(await store.get(id,false)).toMatchObject({stage:'error',nextWindow:0,segments:[]});
 expect(fake.transcribe).toHaveBeenCalledTimes(1);expect(decode).toHaveBeenCalledTimes(1);
 const saved=(await store.get(id,false))!;
 expect(saved.asrQuality).toBeUndefined();
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'asr-quality',asrQuality:expect.objectContaining({invalidSegments:1}),errorKind:'inference'})]));
 await store.remove(id);
});
it('PIPE-04 resumes raw speaker intervals after cancellation before assignment',async()=>{
 const {fake,store,decode}=setup();
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,download:()=>{}});
 await runner.init();
 await runner.add([new File(['fixture source'],'pipe04-speakers.wav')],{model:'whisper-small',language:'ru',diarize:true});
 const id=runner.snapshot().jobs.at(-1)!.id;
 const put=store.putArtifact.bind(store);let cancel=true;
 vi.spyOn(store,'putArtifact').mockImplementation(async(jobId,key,value)=>{
  await put(jobId,key,value);
  if(cancel&&jobId===id&&key.startsWith('diarization-raw-v1:')){cancel=false;runner.cancel()}
 });
 runner.enqueue(id);await finished(runner);
 const interrupted=(await store.get(id,false))!;
 expect(interrupted.asrComplete).toBe(true);expect(interrupted.speakerSegments).toBeUndefined();
 expect(fake.diarize).toHaveBeenCalledTimes(1);
 runner.enqueue(id);await finished(runner);
 expect(fake.diarize).toHaveBeenCalledTimes(1);expect(fake.transcribe).toHaveBeenCalledTimes(3);expect(decode).toHaveBeenCalledTimes(1);
 expect((await store.get(id,false))?.speakerSegments).toHaveLength(3);
 await store.remove(id);
});

it('PIPE-05 persists both ASR reservations before dispatch and refuses a third after reopening',async()=>{
 const {runner,store,fake,decode}=setup();await runner.init();
 await runner.add([new File(['fixture'],'durable-retry.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 let dispatched=0;
 fake.transcribe.mockImplementation(async()=>{
  dispatched++;
  const durable=(await store.get(id,false))!;
  expect(durable.recoveryLedger?.operations.asr).toMatchObject({unit:1,attempts:dispatched,done:false});
  throw Object.assign(new Error('Worker crashed'),{code:'worker-failed'});
 });
 runner.enqueue(id);await finished(runner);
 expect(dispatched).toBe(2);expect(fake.recover).toHaveBeenCalledOnce();
 const resumed=new JobRunner({store:new JobStore(),manager:fake as unknown as ModelManager,decode,download:()=>{}});
 await resumed.init();resumed.enqueue(id);await finished(resumed);
 expect(dispatched).toBe(2);expect(fake.recover).toHaveBeenCalledOnce();
 const saved=(await store.get(id,false))!;
 expect(saved).toMatchObject({stage:'error',nextWindow:0,segments:[]});
 expect(saved.recoveryLedger?.operations.asr).toMatchObject({unit:1,attempts:2,done:false});
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'recovery-exhausted',recoveryOperation:'asr',window:1,recoveryLimit:'operation'})]));
 await store.remove(id);
});
it('PIPE-05 never dispatches inference if the reservation cannot be committed',async()=>{
 const {runner,store,fake}=setup();await runner.init();
 await runner.add([new File(['fixture'],'retry-quota.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 const save=store.save.bind(store);
 vi.spyOn(store,'save').mockImplementation(async(j,file)=>{
  if(j.id===id&&j.recoveryLedger?.operations.asr?.attempts)throw new Error('injected quota failure');
  return save(j,file);
 });
 runner.enqueue(id);await finished(runner);
 expect(fake.transcribe).not.toHaveBeenCalled();expect(fake.recover).not.toHaveBeenCalled();
 expect((await store.get(id,false))?.nextWindow).toBe(0);
 await store.remove(id);
});
it('PIPE-05 bounds full FFmpeg failures across fresh runners',async()=>{
 const {fake,store}=setup(),decode=vi.fn(async()=>{throw new FfmpegDecoderError('worker','decode')});
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,decode,decoderPreference:'ffmpeg'});
 await runner.init();await runner.add([new File(['fixture'],'full-retry.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);expect(decode).toHaveBeenCalledTimes(2);
 const resumed=new JobRunner({store:new JobStore(),manager:fake as unknown as ModelManager,decode,decoderPreference:'ffmpeg'});
 await resumed.init();resumed.enqueue(id);await finished(resumed);
 expect(decode).toHaveBeenCalledTimes(2);expect(fake.transcribe).not.toHaveBeenCalled();
 expect((await store.get(id,false))?.recoveryLedger?.operations['full-decode']).toMatchObject({attempts:2,done:false});
 await store.remove(id);
});
it('PIPE-05 retries a transient speaker Worker failure once without replaying committed ASR',async()=>{
 const {runner,store,fake}=setup();await runner.init();
 await runner.add([new File(['fixture'],'speaker-retry.wav')],{model:'whisper-small',language:'ru',diarize:true});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.diarize.mockRejectedValueOnce(Object.assign(new Error('Worker crashed'),{code:'worker-failed'}));
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(fake.transcribe).toHaveBeenCalledTimes(3);expect(fake.diarize).toHaveBeenCalledTimes(2);
 expect(saved).toMatchObject({stage:'done',nextWindow:3,asrComplete:true});
 expect(saved.recoveryLedger?.operations.diarization).toMatchObject({attempts:2,done:true});
 expect(saved.recoveryLedger?.totalRecoveries).toBe(1);
 await store.remove(id);
});

it('PIPE-06 releases an incompatible ready model before decoding the next file',async()=>{
 const {fake,store}=setup(),resources=new ResourceManager(null);
 fake.active='whisper-tiny';
 const releaseIdle=vi.fn(()=>{fake.active=null;return true});
 const manager={...fake,get active(){return fake.active},releaseIdle};
 const decode=vi.fn(async()=>{expect(fake.active).toBeNull();expect(releaseIdle).toHaveBeenCalled();return new Float32Array(60*16000)});
 const runner=new JobRunner({store,resources,manager:manager as unknown as ModelManager,decode,download:()=>{}});
 await runner.init();await runner.add([new File(['fixture'],'lifecycle.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 expect(decode).toHaveBeenCalledOnce();expect((await store.get(id,false))?.stage).toBe('done');
 await store.remove(id);
});
it('PIPE-06 pauses subsequent queued jobs after a Worker disposal failure',async()=>{
 const {fake,store}=setup();const decode=vi.fn(async()=>{throw Object.assign(new Error('retire failure'),{code:'worker-disposal-failed'})});
 // Use the real typed failure; a generic lookalike is not trusted.
 const {WorkerDisposalError}=await import('./ml/activityWatchdog');
 decode.mockImplementation(async()=>{throw new WorkerDisposalError()});
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,decode,download:()=>{}});
 await runner.init();await runner.add([new File(['a'],'one.wav'),new File(['b'],'two.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const [one,two]=runner.snapshot().jobs.slice(-2);
 runner.enqueue(one.id);runner.enqueue(two.id);await finished(runner);
 expect(decode).toHaveBeenCalledOnce();expect(fake.transcribe).not.toHaveBeenCalled();
 expect((await store.get(one.id,false))?.stage).toBe('error');
 expect((await store.get(two.id,false))?.stage).toBe('queued');
 expect(runner.snapshot().notice).toContain('Не подтверждено завершение Worker');
 await store.remove(one.id);await store.remove(two.id);
});

it('PIPE-07 advisory VAD never suppresses ASR, even when the map reports no speech',async()=>{
 const {fake,store,decode}=setup();
 const detectSpeech=vi.fn(async(audio:Float32Array)=>({revision:1,samples:audio.length,frames:Math.ceil(audio.length/512),speechSamples:0,intervals:[]}));
 const manager={...fake,detectSpeech};
 const runner=new JobRunner({store,manager:manager as unknown as ModelManager,decode,download:()=>{},vadEnabled:true});
 await runner.init();await runner.add([new File(['fixture'],'vad-advisory.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(detectSpeech).toHaveBeenCalledOnce();expect(fake.transcribe).toHaveBeenCalledTimes(3);
 expect(saved).toMatchObject({stage:'done',nextWindow:3});
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'vad-result',vadSpeechSamples:0,vadFrames:1875}),expect.objectContaining({code:'pipeline-stage',pipelineStage:'vad',pipelineState:'completed'})]));
 await store.remove(id);
});
it('PIPE-07 unavailable VAD falls back once, with original ASR windows intact',async()=>{
 const {fake,store,decode}=setup(),detectSpeech=vi.fn(async()=>{throw new Error('injected model unavailable')});
 const runner=new JobRunner({store,manager:{...fake,detectSpeech} as unknown as ModelManager,decode,download:()=>{},vadEnabled:true});
 await runner.init();await runner.add([new File(['fixture'],'vad-fallback.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(detectSpeech).toHaveBeenCalledOnce();expect(fake.transcribe).toHaveBeenCalledTimes(3);
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'vad-fallback'}),expect.objectContaining({code:'pipeline-stage',pipelineStage:'vad',pipelineState:'skipped',pipelineReason:'vad-unavailable'})]));
 await store.remove(id);
});

it('PIPE-08 pins adaptive windows before inference and resumes the same plan with flags off',async()=>{
 const {fake,store,decode}=setup(),file=new File(['fixture'],'adaptive-resume.wav');
 const detectSpeech=vi.fn(async(audio:Float32Array)=>({revision:1,samples:audio.length,frames:Math.ceil(audio.length/512),speechSamples:audio.length-40000,intervals:[{start:0,end:384000},{start:424000,end:audio.length}]}));
 const manager={...fake,detectSpeech};
 const runner=new JobRunner({store,manager:manager as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,vadEnabled:true,adaptiveSegmentation:true,download:()=>{}});
 await runner.init();await runner.add([file],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 let called=0;
 fake.transcribe.mockImplementation(async()=>{
  called++;
  const saved=(await store.get(id,false))!;
  expect(saved.windowPlan?.windows.map(w=>[w.start/16000,w.end/16000])).toEqual([[0,28.75],[23.75,53.75],[48.75,60]]);
  if(called===2)throw new Error('injected nonretryable failure');
  return [{start:3,end:4,text:'текст'}];
 });
 runner.enqueue(id);await finished(runner);
 const interrupted=(await store.get(id,false))!;
 expect(interrupted.stage).toBe('error');expect(interrupted.nextWindow).toBe(1);expect(interrupted.windowPlan?.adjustedCuts).toBe(1);
 const resumed=new JobRunner({store:new JobStore(),manager:manager as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,download:()=>{}});
 await resumed.init();resumed.enqueue(id);await finished(resumed);
 const saved=(await store.get(id,false))!;
 expect(saved.stage).toBe('done');expect(saved.nextWindow).toBe(3);expect(saved.segments.map(s=>s.start)).toEqual([3,26.75,51.75]);
 expect(saved.windowPlan).toEqual(interrupted.windowPlan);expect(detectSpeech).toHaveBeenCalledOnce();expect(decode).toHaveBeenCalledOnce();
 expect(called).toBe(4);
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'segmentation-plan',segmentationMode:'pause-aware',adjustedCuts:1}),expect.objectContaining({code:'pipeline-stage',pipelineStage:'vad',pipelineState:'skipped',pipelineReason:'segmentation-plan-pinned'})]));
 await store.remove(id);
});
it('PIPE-08 fails before ASR when adaptive plan publication fails',async()=>{
 const {fake,store,decode}=setup();
 const detectSpeech=vi.fn(async(audio:Float32Array)=>({revision:1,samples:audio.length,frames:Math.ceil(audio.length/512),speechSamples:audio.length-40000,intervals:[{start:0,end:384000},{start:424000,end:audio.length}]}));
 const runner=new JobRunner({store,manager:{...fake,detectSpeech} as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,vadEnabled:true,adaptiveSegmentation:true,download:()=>{}});
 await runner.init();await runner.add([new File(['fixture'],'plan-fail.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id,save=store.save.bind(store);
 vi.spyOn(store,'save').mockImplementation(async(j,file)=>{if(j.id===id&&j.windowPlan)throw new Error('injected plan write failure');return save(j,file)});
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(saved.stage).toBe('error');expect(saved.nextWindow).toBe(0);expect(saved.windowPlan).toBeUndefined();expect(fake.transcribe).not.toHaveBeenCalled();
 await store.remove(id);
});

it('PIPE-09 reports repeated text without deleting it or triggering inference retries',async()=>{
 const {runner,store,fake}=setup();
 await runner.init();await runner.add([new File(['fixture'],'quality.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 const repeated='один два три один два три один два три';
 fake.transcribe.mockResolvedValueOnce([{start:3,end:4,text:repeated}]);
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(saved.stage).toBe('done');expect(saved.segments[0].text).toBe(repeated);
 expect(saved.asrQuality).toMatchObject({examinedWindows:3,warningWindows:3,repeatWindows:1,silentTextWindows:3});
 expect(fake.transcribe).toHaveBeenCalledTimes(3);expect(fake.recover).not.toHaveBeenCalled();
 await store.remove(id);
});

it('PIPE-10 saves alignment after ASR and reuses it on speaker retry without running ASR or alignment again',async()=>{
 const {fake,store,decode}=setup();
 const alignSpeech=vi.fn(async(audio:Float32Array,segments:readonly AlignmentSegment[],language:'ru'|'en'):Promise<AlignmentReport>=>({
  revision:1,contract:ALIGNMENT_CONTRACT,language,samples:audio.length,segmentCount:segments.length,
  rows:segments.map((s,index)=>({index,words:[{from:0,to:s.text.length,startSample:Math.round(s.start*16000)+320,endSample:Math.round(s.start*16000)+640,score:.8}]}))
 }));
 const manager={...fake,alignSpeech};
 const runner=new JobRunner({store,manager:manager as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,alignmentEnabled:true,download:()=>{}});
 await runner.init();await runner.add([new File(['fixture source'],'align-resume.wav')],{model:'whisper-small',language:'ru',diarize:true});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.diarize.mockImplementationOnce(async()=>{
  const saved=(await store.get(id,false))!;
  expect(saved.asrComplete).toBe(true);
  expect(saved.alignmentCheckpoint).toMatchObject({alignedSegments:3,alignedWords:3});
  throw new Error('injected speaker failure');
 });
 runner.enqueue(id);await finished(runner);
 const first=(await store.get(id,false))!;
 expect(first.stage).toBe('partial');expect(first.segments).toHaveLength(3);expect(first.alignmentCheckpoint?.alignedWords).toBe(3);
 expect(alignSpeech).toHaveBeenCalledOnce();expect(fake.transcribe).toHaveBeenCalledTimes(3);
 const resumed=new JobRunner({store:new JobStore(),manager:manager as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,download:()=>{}});
 await resumed.init();resumed.enqueue(id);await finished(resumed);
 const result=(await store.get(id,false))!;
 expect(result.stage).toBe('done');expect(result.segments).toEqual(first.segments);expect(result.alignmentCheckpoint).toEqual(first.alignmentCheckpoint);
 expect(alignSpeech).toHaveBeenCalledOnce();expect(fake.transcribe).toHaveBeenCalledTimes(3);expect(decode).toHaveBeenCalledOnce();
 expect(result.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'pipeline-stage',pipelineStage:'alignment',pipelineState:'reused'})]));
 await store.remove(id);
});
it('PIPE-10 falls back on unavailable alignment without changing original ASR or automatic retry',async()=>{
 const {fake,store,decode}=setup();
 const alignSpeech=vi.fn(async()=>{throw new Error('alignment model unavailable')});
 const runner=new JobRunner({store,manager:{...fake,alignSpeech} as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,alignmentEnabled:true,download:()=>{}});
 await runner.init();await runner.add([new File(['fixture source'],'align-fallback.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(saved.stage).toBe('done');expect(saved.asrComplete).toBe(true);expect(saved.segments).toHaveLength(3);expect(saved.alignmentCheckpoint).toBeUndefined();
 expect(alignSpeech).toHaveBeenCalledOnce();expect(fake.transcribe).toHaveBeenCalledTimes(3);expect(fake.recover).not.toHaveBeenCalled();
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'pipeline-stage',pipelineStage:'alignment',pipelineState:'skipped',pipelineReason:'alignment-unavailable'})]));
 await store.remove(id);
});

it('PIPE-11 pins word-speaker results and reuses the same global clusters on reload with flags off',async()=>{
 const {fake,store,decode}=setup();
 fake.transcribe.mockResolvedValue([{start:3,end:4,text:'один два'}]);
 fake.diarize.mockResolvedValue([{start:0,end:3.5,speaker:'A'},{start:3.5,end:60,speaker:'B'}]);
 const alignSpeech=vi.fn(async(audio:Float32Array,segments:readonly AlignmentSegment[],language:'ru'|'en'):Promise<AlignmentReport>=>({
  revision:1,contract:ALIGNMENT_CONTRACT,language,samples:audio.length,segmentCount:segments.length,
  rows:segments.map((s,index)=>({index,words:[
   {from:0,to:4,startSample:Math.round(s.start*16000)+1600,endSample:Math.round(s.start*16000)+4800,score:.8},
   {from:5,to:8,startSample:Math.round(s.start*16000)+9600,endSample:Math.round(s.start*16000)+14400,score:.8}
  ]}))
 }));
 const manager={...fake,alignSpeech};
 const runner=new JobRunner({store,manager:manager as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,alignmentEnabled:true,wordSpeakerEnabled:true,download:()=>{}});
 await runner.init();await runner.add([new File(['fixture source'],'word-speakers.wav')],{model:'whisper-small',language:'ru',diarize:true});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 const first=(await store.get(id,false))!;
 expect(first.stage).toBe('done');expect(first.segments).toHaveLength(3);expect(first.speakerSegments?.map(s=>s.speaker)).toEqual(['A','B','B','B']);
 expect(first.speakerSegments?.slice(0,2).map(s=>s.text).join('')).toBe('один два');
 expect(first.wordSpeakerStats).toMatchObject({alignedWords:6,labeledWords:6,outputSegments:4,splitSourceSegments:1});
 expect(alignSpeech).toHaveBeenCalledOnce();expect(fake.diarize).toHaveBeenCalledOnce();expect(fake.transcribe).toHaveBeenCalledTimes(3);
 const resumedStore=new JobStore(),resumed=new JobRunner({store:resumedStore,manager:manager as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,download:()=>{}});
 await resumed.init();resumed.enqueue(id);await finished(resumed);
 const saved=(await store.get(id,false))!;
 expect(saved.stage).toBe('done');expect(saved.speakerSegments).toEqual(first.speakerSegments);expect(saved.wordSpeakerStats).toEqual(first.wordSpeakerStats);
 expect(fake.diarize).toHaveBeenCalledOnce();expect(alignSpeech).toHaveBeenCalledOnce();expect(fake.transcribe).toHaveBeenCalledTimes(3);
 expect(saved.trace).toEqual(expect.arrayContaining([expect.objectContaining({code:'checkpoint-artifact',artifactStage:'diarization',artifactState:'reused'})]));
 // Missing pinned RAW must not launch an independent speaker pass.
 const original=resumedStore.getArtifact.bind(resumedStore);
 vi.spyOn(resumedStore,'getArtifact').mockImplementation((id,key)=>key.startsWith('diarization-raw-v1:')?Promise.resolve(undefined):original(id,key));
 resumed.enqueue(id);await finished(resumed);
 const failed=(await store.get(id,false))!;
 expect(failed.stage).toBe('partial');expect(failed.segments).toEqual(first.segments);expect(failed.speakerSegments).toEqual(first.speakerSegments);expect(fake.diarize).toHaveBeenCalledOnce();
 await store.remove(id);
});
it('PIPE-11 keeps segment assignment if the optional alignment has no accepted words',async()=>{
 const {fake,store,decode}=setup();
 const alignSpeech=vi.fn(async(audio:Float32Array,segments:readonly AlignmentSegment[],language:'ru'|'en'):Promise<AlignmentReport>=>({revision:1,contract:ALIGNMENT_CONTRACT,language,samples:audio.length,segmentCount:segments.length,rows:[]}));
 const runner=new JobRunner({store,manager:{...fake,alignSpeech} as unknown as ModelManager,decode,decoderPreference:'ffmpeg',checkpointArtifacts:true,alignmentEnabled:true,wordSpeakerEnabled:true,download:()=>{}});
 await runner.init();await runner.add([new File(['fixture source'],'word-fallback.wav')],{model:'whisper-small',language:'ru',diarize:true});
 const id=runner.snapshot().jobs.at(-1)!.id;runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(saved.stage).toBe('done');expect(saved.wordSpeakerStats).toBeUndefined();expect(saved.speakerSegments).toHaveLength(3);expect(fake.diarize).toHaveBeenCalledOnce();
 await store.remove(id);
});
