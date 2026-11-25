import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';
vi.mock('./ml/worker?worker',()=>({default:class{}}));
import {JobRunner} from './jobRunner';
import {JobStore} from './jobStore';
import {createJob} from './jobs';
import type {ModelManager} from './ml/manager';
import type {benchmarkReport} from './benchmark';

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
 const downloadBenchmark=vi.fn((_report:ReturnType<typeof benchmarkReport>,_name:string)=>{
  void _report;void _name;
 });
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,
  decode:async()=>new Float32Array(60*16000),download:()=>{},downloadBenchmark});
 return {store,fake,runner,downloadBenchmark};
}
async function finished(runner:JobRunner){
 await vi.waitFor(()=>expect(runner.snapshot().busy).toBe(false));
}
it('persists observed run, 3 checkpoint timings, inferred RTF and redacted JSON across reload',async()=>{
 const {store,fake,runner,downloadBenchmark}=setup();
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
 runner.exportBenchmark(id);
 const report=downloadBenchmark.mock.calls[0][0];
 expect(report).toMatchObject({schema:'iscribe.benchmark.v1',measuredCommittedWindows:3,measuredUniqueAudioSeconds:60,asrWindowMs:{count:3}});
 expect(JSON.stringify(report)).not.toContain('PRIVATE-MEETING');
 expect(JSON.stringify(report)).not.toContain('confidential source text');
 const restarted=new JobRunner({store,manager:fake as unknown as ModelManager,
  decode:async()=>new Float32Array(60*16000),download:()=>{},downloadBenchmark});
 await restarted.init();
 expect(restarted.snapshot().jobs.find(j=>j.id===id)?.benchmark?.committedWindows).toBe(3);
});

it('after refresh measures only newly committed 30 seconds and preserves prior checkpoint',async()=>{
 const {store,fake,runner,downloadBenchmark}=setup();
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
 runner.exportBenchmark(original.id);
 expect(downloadBenchmark.mock.calls.at(-1)?.[0].measuredUniqueAudioSeconds).toBe(30);
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
