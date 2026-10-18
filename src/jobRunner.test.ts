import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';
vi.mock('./ml/worker?worker',()=>({default:class{}}));
import {JobRunner} from './jobRunner';
import {JobStore} from './jobStore';
import {createJob} from './jobs';
import type {ModelManager} from './ml/manager';
function setup(){
 const fake={active:null as string|null,onProgress:(_status:string,_percent:number|null)=>{},prepare:vi.fn(async(id:string)=>{fake.active=id;return {cached:true,backend:'wasm'}}),transcribe:vi.fn(async()=>[{start:3,end:4,text:'текст'}]),diarize:vi.fn(async()=>[{start:0,end:60,speaker:'A'}]),cancel:vi.fn(()=>{})};
 const store=new JobStore(),download=vi.fn(),decode=vi.fn(async()=>new Float32Array(60*16000));
 return {fake,store,download,runner:new JobRunner({store,manager:fake as unknown as ModelManager,decode,download})};
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
 const {runner,fake}=setup();await runner.init();await runner.add([new File(['a'],'other-tab.wav')],{model:'whisper-small',language:'ru',diarize:false});const id=runner.snapshot().jobs.at(-1)!.id;
 vi.stubGlobal('navigator',{locks:{request:async(_name:string,_opts:unknown,callback:(lock:null)=>Promise<void>)=>callback(null)}});
 try{runner.enqueue(id);await finished(runner);expect(fake.prepare).not.toHaveBeenCalled();expect(runner.snapshot().jobs.find(j=>j.id===id)!.stage).toBe('interrupted');expect(runner.snapshot().notice).toContain('другой вкладке')}finally{vi.unstubAllGlobals()}
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
