import 'fake-indexeddb/auto';
import {expect,it} from 'vitest';
import {JobStore} from './jobStore';
import {createJob} from './jobs';
import {decoderIdentity} from './decoderDiagnostics';

function name(){return 'iscribe-pr25-'+crypto.randomUUID()}
function file(){return new File(['stored audio'],'reference.wav')}
function job(f:File=file()){return createJob(f,{model:'whisper-small',language:'ru',diarize:true})}
async function inspectDb(dbName:string){
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{
  const open=indexedDB.open(dbName,2);
  open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);
 });
 try{
  return await new Promise<{jobs:unknown[];chunks:{id:string;offset:number;segments:unknown[]}[];speakers:unknown[]}>((resolve,reject)=>{
   const tx=db.transaction(['jobs','asr-chunks-v2','speaker-results-v2'],'readonly');
   const jobs=tx.objectStore('jobs').getAll(),chunks=tx.objectStore('asr-chunks-v2').getAll(),speakers=tx.objectStore('speaker-results-v2').getAll();
   tx.oncomplete=()=>resolve({jobs:jobs.result,chunks:chunks.result,speakers:speakers.result});
   tx.onerror=()=>reject(tx.error);
  });
 }finally{db.close()}
}

it('saves only new transcript suffixes and never rewrites old chunks for metadata updates',async()=>{
 const dbName=name(),store=new JobStore(dbName),f=file(),j=job(f);
 await store.save(j,f);
 const first={...j,stage:'recognizing' as const,nextWindow:1,segments:[{start:3,end:4,text:'window 1'}]};
 await store.save(first);
 await store.save({...first,status:'attempt window 2'});
 const next={...first,nextWindow:2,segments:[...first.segments,{start:28,end:29,text:'window 2'}]};
 await store.save(next);
 await store.save({...next,nextWindow:3,status:'silent final window'});
 const snap=await inspectDb(dbName);
 expect(snap.chunks).toHaveLength(2);
 expect(snap.chunks.map(chunk=>({offset:chunk.offset,length:chunk.segments.length}))).toEqual([{offset:0,length:1},{offset:1,length:1}]);
 expect(snap.jobs).toHaveLength(1);
 expect(snap.jobs[0]).toMatchObject({storageLayout:2,segmentCount:2,nextWindow:3,segments:[]});
 const restored=(await new JobStore(dbName).get(j.id,false))!;
 expect(restored.segments.map(s=>s.text)).toEqual(['window 1','window 2']);
 expect(restored.nextWindow).toBe(3);
 expect(await (await store.audio(j.id))?.text()).toBe('stored audio');
});

it('lazily migrates existing version-1 jobs atomically with the first new checkpoint',async()=>{
 const dbName=name(),f=file(),original=job(f);
 const old={...original,stage:'recognizing' as const,nextWindow:1,segments:[{start:2,end:4,text:'legacy text'}],speakerSegments:[{start:2,end:4,text:'legacy text',speaker:'A'}]};
 await new Promise<void>((resolve,reject)=>{
  const open=indexedDB.open(dbName,1);
  open.onupgradeneeded=()=>{open.result.createObjectStore('jobs',{keyPath:'id'});open.result.createObjectStore('audio')};
  open.onerror=()=>reject(open.error);
  open.onsuccess=()=>{
   const db=open.result,tx=db.transaction(['jobs','audio'],'readwrite');
   tx.objectStore('jobs').put(old);tx.objectStore('audio').put(f,old.id);
   tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);
  };
 });
 const store=new JobStore(dbName);
 const before=(await store.get(old.id,false))!;
 expect(before.segments).toEqual(old.segments);
 expect(before.speakerSegments).toEqual(old.speakerSegments);
 const updated={...before,nextWindow:2,segments:[...old.segments,{start:28,end:29,text:'new text'}]};
 await store.save(updated);
 const raw=await inspectDb(dbName);
 expect(raw.chunks.map(c=>c.offset)).toEqual([0,1]);
 expect(raw.speakers).toHaveLength(1);
 expect(raw.jobs[0]).toMatchObject({storageLayout:2,nextWindow:2,segmentCount:2,segments:[]});
 const reload=(await new JobStore(dbName).get(old.id,false))!;
 expect(reload.segments.map(x=>x.text)).toEqual(['legacy text','new text']);
 expect(reload.speakerSegments).toEqual(old.speakerSegments);
 expect(await (await store.audio(old.id))?.text()).toBe('stored audio');
});

it('rolls back a corrupt new chunk and checkpoint without losing previously committed text',async()=>{
 const dbName=name(),store=new JobStore(dbName),j=job();
 const committed={...j,stage:'recognizing' as const,nextWindow:1,segments:[{start:1,end:2,text:'durable'}]};
 await store.save(committed);
 const unsafe={...committed,nextWindow:2,segments:[...committed.segments,{start:28,end:30,text:'uncloneable',fn:()=>{}} as unknown as typeof committed.segments[number]]};
 await expect(store.save(unsafe)).rejects.toThrow();
 const stored=(await new JobStore(dbName).get(j.id,false))!;
 expect(stored.nextWindow).toBe(1);
 expect(stored.segments.map(s=>s.text)).toEqual(['durable']);
 const raw=await inspectDb(dbName);
 expect(raw.chunks).toHaveLength(1);
 expect(raw.jobs[0]).toMatchObject({nextWindow:1,segmentCount:1});
});

it('rejects stale checkpoint and transcript truncation rather than silently discarding user work',async()=>{
 const dbName=name(),store=new JobStore(dbName),j=job();
 const old={...j,nextWindow:2,segments:[{start:1,end:2,text:'safe'}]};
 await store.save(old);
 await expect(store.save({...old,nextWindow:1})).rejects.toThrow('не могут уменьшиться');
 await expect(store.save({...old,segments:[]})).rejects.toThrow('не могут уменьшиться');
 const saved=(await store.get(j.id,false))!;
 expect(saved.nextWindow).toBe(2);
 expect(saved.segments[0].text).toBe('safe');
});

it('reads only one selected job and deletes its chunks without harming other jobs',async()=>{
 const dbName=name(),store=new JobStore(dbName),one=job(),two=job();
 await store.save({...one,nextWindow:1,segments:[{start:1,end:2,text:'one'}]});
 await store.save({...two,nextWindow:1,segments:[{start:1,end:2,text:'two'}],speakerSegments:[{start:1,end:2,text:'two',speaker:'B'}]});
 expect((await store.get(one.id,false))?.segments[0].text).toBe('one');
 expect((await store.get(two.id,false))?.speakerSegments?.[0].speaker).toBe('B');
 await store.remove(one.id);
 expect(await store.get(one.id,false)).toBeUndefined();
 expect((await store.list(false)).map(j=>j.id)).toEqual([two.id]);
 expect((await inspectDb(dbName)).chunks.map(c=>c.id)).toEqual([two.id]);
 await store.remove(two.id);
 const raw=await inspectDb(dbName);
 expect(raw.chunks).toHaveLength(0);expect(raw.speakers).toHaveLength(0);
});

it('refuses to report an orphaned or missing transcript chunk as a valid completed job',async()=>{
 const dbName=name(),store=new JobStore(dbName),j=job();
 await store.save({...j,nextWindow:1,segments:[{start:1,end:2,text:'durable'}]});
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{
  const open=indexedDB.open(dbName,2);
  open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);
 });
 await new Promise<void>((resolve,reject)=>{
  const tx=db.transaction('asr-chunks-v2','readwrite');
  tx.objectStore('asr-chunks-v2').delete([j.id,0]);
  tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
 });db.close();
 await expect(store.get(j.id,false)).rejects.toThrow('Контрольная точка');
});


it('never persists uncommitted ASR text without advancing nextWindow',async()=>{
 const dbName=name(),store=new JobStore(dbName),j=job();
 await store.save(j);
 const premature={...j,segments:[{start:0,end:1,text:'not committed'}]};
 await expect(store.save(premature)).rejects.toThrow('без подтверждённого номера');
 const saved=(await store.get(j.id,false))!;
 expect(saved.nextWindow).toBe(0);
 expect(saved.segments).toEqual([]);
 const raw=await inspectDb(dbName);
 expect(raw.chunks).toHaveLength(0);
});

it('persists decoder identity and rejects stale full-recovery reservations',async()=>{
 const dbName=name(),store=new JobStore(dbName),f=file(),j=job(f);
 const fixed={...j,decoderIdentity:decoderIdentity('ffmpeg','full'),fullDecodeRecoveries:1};
 await store.save(fixed,f);
 const reloaded=(await new JobStore(dbName).get(j.id,false))!;
 expect(reloaded.decoderIdentity).toEqual(fixed.decoderIdentity);
 expect(reloaded.fullDecodeRecoveries).toBe(1);
 await expect(store.save({...reloaded,decoderIdentity:decoderIdentity('legacy','full')})).rejects.toThrow();
 await expect(store.save({...reloaded,decoderIdentity:undefined})).rejects.toThrow();
 await expect(store.save({...reloaded,fullDecodeRecoveries:0})).rejects.toThrow();
 const after=(await store.get(j.id,false))!;
 expect(after.decoderIdentity).toEqual(fixed.decoderIdentity);
 expect(after.fullDecodeRecoveries).toBe(1);
});

it('pins the recovered full-audio timeline and prevents switching after checkpoint',async()=>{
 const store=new JobStore(name()),f=file(),j=job(f),identity=decoderIdentity('ffmpeg','full');
 await store.save({...j,decoderIdentity:identity},f);
 const fixed={...j,decoderIdentity:identity,fullDecodeRecoveries:1,fullFrameRecoveryExpectedSamples:160000};
 await store.save(fixed);
 const reloaded=(await store.get(j.id,false))!;
 expect(reloaded.fullFrameRecoveryExpectedSamples).toBe(160000);
 await expect(store.save({...reloaded,fullFrameRecoveryExpectedSamples:undefined})).rejects.toThrow();
 await expect(store.save({...reloaded,fullFrameRecoveryExpectedSamples:160001})).rejects.toThrow();
 const k=job(f);
 await store.save({...k,decoderIdentity:identity,nextWindow:1,segments:[{start:0,end:1,text:'saved'}]},f);
 await expect(store.save({...k,decoderIdentity:identity,nextWindow:1,segments:[{start:0,end:1,text:'saved'}],fullDecodeRecoveries:1,fullFrameRecoveryExpectedSamples:160000})).rejects.toThrow();
});
