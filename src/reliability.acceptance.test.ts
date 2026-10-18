import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';
vi.mock('./ml/worker?worker',()=>({default:class{}}));
import {JobRunner} from './jobRunner';
import {JobStore} from './jobStore';
import {createJob,audioWindows} from './jobs';
import {formatTranscript} from './formatTranscript';
import type {ModelManager} from './ml/manager';

const SECONDS=14*60+31;
const PARAMS={model:'whisper-small' as const,language:'ru' as const,diarize:true};
function engine(){
 const api={
  active:null as string|null,onProgress:(_status:string,_percent:number|null)=>{},
  prepare:vi.fn(async(model:string)=>{api.active=model;return {cached:true,backend:'wasm'}}),
  recover:vi.fn(async(model:string)=>{api.active=model;return {cached:true,backend:'wasm'}}),
  transcribe:vi.fn(async()=>[{start:3,end:4,text:'текст'}]),
  diarize:vi.fn(async()=>[{start:0,end:SECONDS,speaker:'A'}]),
  cancel:vi.fn(()=>{api.active=null})
 };
 return api;
}
function runner(store:JobStore,manager:ReturnType<typeof engine>,download=vi.fn()){
 return {instance:new JobRunner({store,manager:manager as unknown as ModelManager,
  decode:async()=>new Float32Array(SECONDS*16000),download}),download};
}
async function idle(r:JobRunner){await vi.waitFor(()=>expect(r.snapshot().busy).toBe(false),{timeout:10000})}
function find(r:JobRunner,id:string){return r.snapshot().jobs.find(j=>j.id===id)!}

it('acceptance: 14:31 audio finishes all 35 windows with monotonic durable checkpoints and correct three TXT exports',async()=>{
 const store=new JobStore(),ml=engine(),{instance:r,download}=runner(store,ml);
 await r.init();const file=new File(['simulated'],'acceptance-14m31s.wav');
 await r.add([file],PARAMS);const id=r.snapshot().jobs.at(-1)!.id;
 const checkpoints:number[]=[];
 const persist=store.save.bind(store);
 vi.spyOn(store,'save').mockImplementation(async(job,file)=>{
  await persist(job,file);
  if(job.id===id&&job.nextWindow>0)checkpoints.push(job.nextWindow);
 });
 r.enqueue(id);await idle(r);
 const done=find(r,id),windows=audioWindows(SECONDS*16000);
 expect(windows).toHaveLength(35);
 expect(ml.transcribe).toHaveBeenCalledTimes(35);
 expect(checkpoints.slice(0,35)).toEqual(Array.from({length:35},(_,i)=>i+1));
 expect(checkpoints.slice(35).every(n=>n===35)).toBe(true);
 expect(done.asrComplete).toBe(true);
 expect(done.stage).toBe('done');
 expect(done.nextWindow).toBe(35);
 expect(done.percent).toBe(100);
 expect(done.segments).toHaveLength(35);
 expect(done.speakerSegments).toHaveLength(35);
 expect((await new JobStore().list()).find(j=>j.id===id)!.asrComplete).toBe(true);
 r.export(id,'plain');r.export(id,'time');r.export(id,'speakers');
 const content=download.mock.calls.slice(-3).map(call=>call[0] as string);
 expect(content[0]).not.toContain('[00:03]');
 expect(content[1]).toContain('[00:03]');
 expect(content[2]).toContain('[SPEAKER_00]');
 expect(content[0].split('\r\n').filter(Boolean)).toHaveLength(35);
 expect(content[1].split('\r\n').filter(Boolean)).toHaveLength(35);
 expect(content[2].split('\r\n').filter(Boolean)).toHaveLength(35);
 expect(formatTranscript(done.segments,{timestamps:true,diarize:false})).toBe(content[1]);
});
it('acceptance: simulated refresh restores only committed windows and resumes once without duplicating text',async()=>{
 const store=new JobStore(),source=new File(['audio'],'resume-14m31s.wav');
 const saved=createJob(source,{...PARAMS,diarize:false});
 const windows=audioWindows(SECONDS*16000);
 const firstWindow={start:3,end:4,text:'первое окно'};
 const secondWindow={start:28,end:29,text:'второе окно'};
 await store.save({...saved,stage:'recognizing',nextWindow:2,segments:[firstWindow,secondWindow],duration:SECONDS,percent:55/SECONDS*100},source);
 const secondTab=runner(new JobStore(),engine());await secondTab.instance.init();
 const interrupted=find(secondTab.instance,saved.id);
 expect(interrupted.stage).toBe('interrupted');
 expect(interrupted.nextWindow).toBe(2);
 expect(interrupted.segments).toEqual([firstWindow,secondWindow]);
 secondTab.instance.enqueue(saved.id);await idle(secondTab.instance);
 const finished=find(secondTab.instance,saved.id);
 expect(secondTab.instance.manager.transcribe).toHaveBeenCalledTimes(windows.length-2);
 expect(finished.nextWindow).toBe(35);
 expect(finished.asrComplete).toBe(true);
 expect(finished.segments.slice(0,2)).toEqual([firstWindow,secondWindow]);
 expect(finished.segments).toHaveLength(35);
 expect((await store.list()).find(j=>j.id===saved.id)!.segments).toHaveLength(35);
});
it('acceptance: speaker failure leaves durable full TXT, retry speaker pass never re-runs Whisper',async()=>{
 const store=new JobStore(),ml=engine(),{instance:r,download}=runner(store,ml);
 await r.init();const source=new File(['simulated'],'speaker-failure-14m31s.wav');
 await r.add([source],PARAMS);const id=r.snapshot().jobs.at(-1)!.id;
 ml.diarize.mockRejectedValueOnce(new Error('speaker model failed'));
 r.enqueue(id);await idle(r);
 const partial=find(r,id);
 expect(partial.asrComplete).toBe(true);
 expect(partial.nextWindow).toBe(35);
 expect(partial.stage).toBe('partial');
 expect(download).toHaveBeenCalled();
 r.export(id,'plain');r.export(id,'time');
 const count=ml.transcribe.mock.calls.length;
 r.enqueue(id);await idle(r);
 expect(ml.transcribe).toHaveBeenCalledTimes(count);
 expect(ml.diarize).toHaveBeenCalledTimes(2);
 expect(find(r,id).stage).toBe('done');
});
