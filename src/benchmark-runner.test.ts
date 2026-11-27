import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';
vi.mock('./ml/worker?worker',()=>({default:class{}}));
import {JobRunner} from './jobRunner';
import {JobStore} from './jobStore';
import {createJob} from './jobs';
import type {ModelManager} from './ml/manager';
import type {diagnosticReport} from './jobTrace';
import {ResourceManager} from './performance/resourceManager';

function setup(){
 const store=new JobStore('pr29-'+crypto.randomUUID());
 const fake={
  active:null as string|null,
  onProgress:(text:string,percent:number|null)=>{void text;void percent},
  prepare:vi.fn(async(model:string)=>{fake.active=model;return {cached:true,backend:'wasm'}}),
  recover:vi.fn(async(model:string)=>{fake.active=model;return {cached:true,backend:'wasm'}}),
  transcribe:vi.fn(async()=>[{start:3,end:4,text:'confidential source text'}]),
  diarize:vi.fn(async()=>[{start:0,end:60,speaker:'A'}]),
  cancel:vi.fn(()=>{})
 };
 const downloadDiagnostic=vi.fn((_report:ReturnType<typeof diagnosticReport>,_name:string)=>{
  void _report;void _name;
 });
 const resources=new ResourceManager(null);
 const boundaryWait=vi.fn(async(_ms:number,_signal:AbortSignal)=>{void _ms;void _signal});
 const runner=new JobRunner({store,resources,boundaryWait,manager:fake as unknown as ModelManager,
  decode:async()=>new Float32Array(60*16000),download:()=>{},downloadDiagnostic});
 return {store,fake,runner,downloadDiagnostic,boundaryWait};
}
async function finished(runner:JobRunner){
 await vi.waitFor(()=>expect(runner.snapshot().busy).toBe(false));
}
it('persists observed run, 3 checkpoint timings, inferred RTF and redacted JSON across reload',async()=>{
 const {store,fake,runner,downloadDiagnostic}=setup();
 await runner.init();
 await runner.add([new File(['SECRET BINARY'],'PRIVATE-MEETING.mp3')],
  {model:'whisper-small',language:'ru',diarize:true});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(saved).toMatchObject({stage:'done',asrComplete:true,nextWindow:3,
  benchmark:{version:1,runs:1,resumedRuns:0,committedWindows:3,
   attempts:3,failedAttempts:0,uniqueAudioSeconds:60}
 });
 expect(saved.benchmark?.windowTimings.map(t=>t.window)).toEqual([1,2,3]);
 expect(saved.benchmark?.checkpointMs).toBeGreaterThanOrEqual(0);
 expect(saved.benchmark?.speakerMs).toBeGreaterThanOrEqual(0);
 expect(fake.transcribe).toHaveBeenCalledTimes(3);
 expect(saved.benchmark?.profiler?.timings.pcmCopy?.count).toBe(3);
 expect(saved.benchmark?.profiler?.timings.betweenAsrAttempts?.count).toBe(2);
 expect(saved.benchmark?.profiler?.timings.fullAudioPreparation?.count).toBe(1);
 expect(saved.benchmark?.profiler?.backendAttempts.wasm).toBe(3);
 runner.exportDiagnostics(id);
 const combined=downloadDiagnostic.mock.calls[0][0];
 const report=combined.benchmark!;
 expect(report).toMatchObject({schema:'iscribe.benchmark.v1',measuredCommittedWindows:3,measuredUniqueAudioSeconds:60,asrWindowMs:{count:3}});
 expect(report.performanceProfiler?.device.cpuUtilizationPercent).toBeNull();
 expect(report.performanceProfiler?.workerTransferMs).toBeNull();
 expect(JSON.stringify(combined)).not.toContain('PRIVATE-MEETING');
 expect(JSON.stringify(combined)).not.toContain('confidential source text');
 const restarted=new JobRunner({store,manager:fake as unknown as ModelManager,
  decode:async()=>new Float32Array(60*16000),download:()=>{},downloadDiagnostic});
 await restarted.init();
 expect(restarted.snapshot().jobs.find(j=>j.id===id)?.benchmark?.committedWindows).toBe(3);
});

it('after refresh measures only newly committed 30 seconds and preserves prior checkpoint',async()=>{
 const {store,fake,runner,downloadDiagnostic}=setup();
 const file=new File(['source'],'partial.wav');
 const original=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...original,stage:'interrupted',nextWindow:1,
  segments:[{start:3,end:4,text:'already committed'}]},file);
 await runner.init();
 runner.enqueue(original.id);await finished(runner);
 const saved=(await store.get(original.id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:3,
  benchmark:{runs:1,resumedRuns:1,committedWindows:2,uniqueAudioSeconds:30,attempts:2}
 });
 expect(fake.transcribe).toHaveBeenCalledTimes(2);
 expect(saved.segments[0].text).toBe('already committed');
 runner.exportDiagnostics(original.id);
 expect(downloadDiagnostic.mock.calls.at(-1)?.[0].benchmark?.measuredUniqueAudioSeconds).toBe(30);
});

it('speaker-only retry increases run counter but does not add ASR timings or processed audio',async()=>{
 const {store,fake,runner}=setup();
 await runner.init();
 await runner.add([new File(['a'],'speaker-retry.wav')],
  {model:'whisper-small',language:'ru',diarize:true});
 const id=runner.snapshot().jobs.at(-1)!.id;
 fake.diarize.mockRejectedValueOnce(new Error('speaker test failure'));
 runner.enqueue(id);await finished(runner);
 const first=(await store.get(id,false))!;
 expect(first.stage).toBe('partial');
 expect(first.benchmark?.committedWindows).toBe(3);
 const count=fake.transcribe.mock.calls.length;
 runner.enqueue(id);await finished(runner);
 const second=(await store.get(id,false))!;
 expect(second.stage).toBe('done');
 expect(fake.transcribe).toHaveBeenCalledTimes(count);
 expect(second.benchmark).toMatchObject({runs:2,resumedRuns:1,failedRuns:1,
  committedWindows:3,uniqueAudioSeconds:60,attempts:3});
});

it('changes performance mode only on the next window and keeps existing checkpoints',async()=>{
 const {store,fake,runner,boundaryWait}=setup();
 await runner.init();runner.setPerformanceMode('eco');
 fake.transcribe.mockImplementationOnce(async()=>{
  expect(runner.snapshot().activeResourcePolicy?.effective).toBe('eco');
  runner.setPerformanceMode('max');
  expect(runner.snapshot().activeResourcePolicy?.effective).toBe('eco');
  return [{start:3,end:4,text:'first'}];
 });
 await runner.add([new File(['a'],'profile.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:3,benchmark:{resources:{windowCounts:{eco:1,medium:0,max:2},lastPolicy:{effective:'max'}}}});
 expect(fake.transcribe).toHaveBeenCalledTimes(3);
 expect(boundaryWait).not.toHaveBeenCalled();
 expect(runner.snapshot().activeResourcePolicy).toBeNull();
});

it('reuses settled ASR payload storage without changing checkpoints',async()=>{
 const {store,fake,runner}=setup();
 await runner.init();runner.setPerformanceMode('max');
 await runner.add([new File(['a'],'memory.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 const saved=(await store.get(id,false))!;
 expect(saved).toMatchObject({stage:'done',nextWindow:3,benchmark:{memory:{payloadAllocations:2,payloadReuses:1,detachedPayloads:0,peakPayloadBytes:1920000}}});
 expect(fake.transcribe).toHaveBeenCalledTimes(3);expect(saved.segments).toHaveLength(3);
 await store.remove(id);
});
