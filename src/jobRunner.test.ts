import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';
vi.mock('./ml/worker?worker',()=>({default:class{}}));
import {JobRunner} from './jobRunner';
import {JobStore} from './jobStore';
import {createJob} from './jobs';
import type {ModelManager} from './ml/manager';
function setup(){
 const fake={active:null as string|null,onProgress:()=>{},prepare:vi.fn(async(id:string)=>{fake.active=id;return {cached:true,backend:'wasm'}}),transcribe:vi.fn(async()=>[{start:3,end:4,text:'текст'}]),diarize:vi.fn(async()=>[{start:0,end:60,speaker:'A'}]),cancel:vi.fn(()=>{})};
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
 runner.enqueue(id);await finished(runner);expect(fake.diarize).not.toHaveBeenCalled();expect(runner.snapshot().jobs.find(j=>j.id===id)!.segments).toHaveLength(1);expect(runner.snapshot().notice).toContain('Не удалось сохранить');
});
