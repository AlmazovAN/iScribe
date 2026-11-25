import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';
vi.mock('./ml/worker?worker',()=>({default:class{}}));
import {JobRunner} from './jobRunner';
import {JobStore} from './jobStore';
import {createJob,recoverJob} from './jobs';
import type {ModelManager} from './ml/manager';

function setup(){
 const store=new JobStore('iscribe-pr27-'+crypto.randomUUID());
 const fake={
  active:null as string|null,
  onProgress:(_text:string,_percent:number|null)=>{void _text;void _percent},
  prepare:vi.fn(async(id:string)=>{fake.active=id;return {cached:true,backend:'wasm'}}),
  recover:vi.fn(async(id:string)=>{fake.active=id;return {cached:true,backend:'wasm'}}),
  transcribe:vi.fn(async()=>[{start:3,end:4,text:'recognized'}]),
  diarize:vi.fn(async()=>[{start:0,end:60,speaker:'A'}]),
  cancel:vi.fn(()=>{})
 };
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,
  decode:async()=>new Float32Array(60*16000),download:()=>{}});
 const params={model:'whisper-small' as const,language:'ru' as const,diarize:false};
 return {store,fake,runner,params};
}
async function finished(runner:JobRunner){await vi.waitFor(()=>expect(runner.snapshot().busy).toBe(false))}

it('restores three queued jobs in FIFO order after reload; resumable first job keeps its committed window',async()=>{
 const {store,fake,runner,params}=setup();
 const first=createJob(new File(['one'],'first.wav'),params);
 const second=createJob(new File(['two'],'second.wav'),params);
 const third=createJob(new File(['three'],'third.wav'),params);
 // Deliberately seed out of order: FIFO MUST NOT depend on updated or save order.
 await store.save({...third,queueOrder:30,stage:'queued',updated:50},new File(['three'],'third.wav'));
 await store.save({...first,queueOrder:10,stage:'recognizing',nextWindow:1,
  updated:100,segments:[{start:3,end:4,text:'committed before reload'}]},new File(['one'],'first.wav'));
 await store.save({...second,queueOrder:20,stage:'queued',updated:1},new File(['two'],'second.wav'));
 await runner.init();
 expect(runner.snapshot().queueCount).toBe(3);
 expect(runner.snapshot().jobs.find(j=>j.id===first.id)?.stage).toBe('interrupted');
 expect(runner.snapshot().jobs.find(j=>j.id===second.id)?.stage).toBe('queued');
 expect(fake.prepare).not.toHaveBeenCalled();
 expect(fake.transcribe).not.toHaveBeenCalled();
 const processed:string[]=[];
 fake.transcribe.mockImplementation(async()=>{
  processed.push(runner.snapshot().activeId!);
  return [{start:3,end:4,text:'after reload'}];
 });
 runner.resumeQueue();await finished(runner);
 expect([...new Set(processed)]).toEqual([first.id,second.id,third.id]);
 expect(processed.filter(x=>x===first.id)).toHaveLength(2);
 expect(processed.filter(x=>x===second.id)).toHaveLength(3);
 expect(processed.filter(x=>x===third.id)).toHaveLength(3);
 for(const id of [first.id,second.id,third.id]){
  const job=(await store.get(id,false))!;
  expect(job).toMatchObject({stage:'done',asrComplete:true,nextWindow:3});
  expect(job.queueOrder).toBeUndefined();
  expect(job.segments).toHaveLength(3);
 }
 expect((await store.get(first.id,false))!.segments[0].text).toBe('committed before reload');
 expect(runner.snapshot().queueCount).toBe(0);
 const reopened=new JobRunner({store,manager:fake as unknown as ModelManager,
  decode:async()=>new Float32Array(60*16000),download:()=>{}});
 await reopened.init();
 expect(reopened.snapshot().queueCount).toBe(0);
});

it('commits fast multiple enqueues before running and does not insert a restored ID twice',async()=>{
 const {store,fake,runner,params}=setup();await runner.init();
 await runner.add([new File(['a'],'alpha.wav'),new File(['b'],'beta.wav')],params);
 const [first,second]=runner.snapshot().jobs.slice(-2);
 let unblock:()=>void=()=>{};
 fake.transcribe.mockImplementationOnce(()=>new Promise(resolve=>{unblock=()=>resolve([{start:3,end:4,text:'ok'}])}));
 runner.enqueue(first.id);
 runner.enqueue(second.id,{...params,language:'en'});
 await vi.waitFor(()=>expect(fake.transcribe).toHaveBeenCalledTimes(1));
 const during=(await store.list(false)).filter(j=>j.id===first.id||j.id===second.id);
 expect(during.map(j=>j.queueOrder).sort((a,b)=>(a??0)-(b??0))).toEqual([1,2]);
 expect(during.find(j=>j.id===second.id)?.params.language).toBe('en');
 runner.enqueue(second.id);
 expect(runner.snapshot().queueCount).toBe(2);
 unblock();await finished(runner);
 expect((await store.get(first.id,false))?.queueOrder).toBeUndefined();
 expect((await store.get(second.id,false))?.queueOrder).toBeUndefined();
 expect(fake.transcribe).toHaveBeenCalledTimes(6);
});

it('denied Web Lock preserves queued work and does not run inference',async()=>{
 const {store,fake,runner,params}=setup();await runner.init();
 await runner.add([new File(['a'],'blocked.wav')],params);
 const id=runner.snapshot().jobs.at(-1)!.id;
 vi.stubGlobal('navigator',{locks:{request:async(_name:string,_opts:unknown,cb:(lock:null)=>Promise<void>)=>cb(null)}});
 try{
  runner.enqueue(id);
  await finished(runner);
  expect(fake.prepare).not.toHaveBeenCalled();
  expect(runner.snapshot().queueCount).toBe(1);
  expect(runner.snapshot().notice).toContain('другой вкладке');
  const stored=(await store.get(id,false))!;
  expect(stored.stage).toBe('queued');
  expect(stored.queueOrder).toBeGreaterThan(0);
 }finally{vi.unstubAllGlobals()}
 runner.resumeQueue();await finished(runner);
 expect((await store.get(id,false))?.stage).toBe('done');
 expect(runner.snapshot().queueCount).toBe(0);
});

it('legacy queued job without a durable order requires explicit re-enqueue',()=>{
 const job=createJob(new File(['a'],'legacy.wav'),{model:'whisper-small',language:'ru',diarize:false});
 expect(recoverJob({...job,stage:'queued'}).stage).toBe('interrupted');
 expect(recoverJob({...job,stage:'queued',queueOrder:2}).stage).toBe('queued');
});


it('one failed enqueue cannot be bypassed by later saved positions',async()=>{
 const {store,fake,runner,params}=setup();await runner.init();
 await runner.add([new File(['a'],'quota-first.wav'),new File(['b'],'quota-second.wav')],params);
 const [first,second]=runner.snapshot().jobs.slice(-2);
 const original=store.save.bind(store);
 const spy=vi.spyOn(store,'save').mockImplementation(async(job,file)=>{
  if(job.stage==='queued'&&job.id===first.id)throw new Error('synthetic quota');
  return original(job,file);
 });
 runner.enqueue(first.id);
 runner.enqueue(second.id);
 await finished(runner);
 expect(fake.prepare).not.toHaveBeenCalled();
 expect(runner.snapshot().queueCount).toBe(2);
 expect(runner.snapshot().notice).toContain('не сохраниться');
 expect((await store.get(first.id,false))?.queueOrder).toBeUndefined();
 spy.mockRestore();
 runner.resumeQueue();await finished(runner);
 expect((await store.get(first.id,false))?.stage).toBe('done');
 expect((await store.get(second.id,false))?.stage).toBe('done');
 expect(runner.snapshot().queueCount).toBe(0);
});
