import 'fake-indexeddb/auto';
import {expect,it} from 'vitest';
import {JobStore} from './jobStore';
import {createJob,absoluteSegments,audioWindows} from './jobs';
import {addAsrQuality,inspectRawAsr,inspectOwnedAsr} from './ml/asrQuality';
import {initialLedger,reserveOperation,finishOperation} from './recoveryManager';
import {buildSpeechWindows,SEGMENTATION_CONTRACT,type SpeechWindowPlan} from './speechSegmentation';
it('recovers committed text and source after reopening, without claiming the worker is still running',async()=>{
 const store=new JobStore(),file=new File(['audio'],'meeting.wav'),job=createJob(file,{model:'whisper-small',language:'ru',diarize:true});
 await store.save({...job,stage:'speakers',asrComplete:true,segments:[{start:0,end:2,text:'Сохранено'}]},file);
 const restored=(await new JobStore().list()).find(j=>j.id===job.id)!;
 expect(restored.stage).toBe('interrupted');expect(restored.asrComplete).toBe(true);expect(restored.segments[0].text).toBe('Сохранено');
 expect(await (await store.audio(job.id))!.text()).toBe('audio');
 await store.remove(job.id);expect((await store.list()).some(j=>j.id===job.id)).toBe(false);expect(await store.audio(job.id)).toBeUndefined();
});
it('checkpoint boundaries preserve overlap cuts and absolute timestamps on resume',()=>{
 const windows=audioWindows(60*16000);expect(windows).toHaveLength(3);
 const segments=[{start:0,end:2,text:'duplicate'},{start:3,end:5,text:'keep'}];
 expect(absoluteSegments(segments,windows[1])).toEqual([{start:28,end:30,text:'keep'}]);
 expect(audioWindows(30*16000)).toHaveLength(1);
});

it('does not persist in-memory-only audio segments when saving a failed job',async()=>{
 const file=new File(['audio'],'volatile.wav'),job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 const store=new JobStore();
 await store.save({...job,nextWindow:0,segments:[],volatileSegments:[{start:0,end:1,text:'memory only'}],stage:'error'},file);
 const restored=(await new JobStore().list()).find(j=>j.id===job.id)!;
 expect(restored.volatileSegments).toBeUndefined();
 expect(restored.nextWindow).toBe(0);
 expect(restored.segments).toHaveLength(0);
 await store.remove(job.id);
});

it('rejects stale metadata that would reset durable stream recovery reservations',async()=>{
 const store=new JobStore(),file=new File(['audio'],'retry-budget.mp3'),job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 const checkpoint={...job,nextWindow:40,segments:[{start:3,end:4,text:'saved'}]};
 await store.save(checkpoint,file);
 const budget={window:41,windowRecoveries:2,totalRecoveries:3};
 await store.save({...checkpoint,streamRecovery:budget});
 await expect(store.save({...checkpoint,status:'stale queue metadata'})).rejects.toThrow('Лимит восстановления');
 await expect(store.save({...checkpoint,streamRecovery:{window:41,windowRecoveries:1,totalRecoveries:3}})).rejects.toThrow('Лимит восстановления');
 const saved=(await store.get(job.id,false))!;
 expect(saved.streamRecovery).toEqual(budget);
 expect(saved.nextWindow).toBe(40);
 expect(saved.segments.map(s=>s.text)).toEqual(['saved']);
 await store.remove(job.id);
});

it('PIPE-05 refuses stale reservation writes and commits completion with text',async()=>{
 const store=new JobStore(),file=new File(['audio'],'recovery-ledger.wav'),j=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save(j,file);
 const first=reserveOperation(initialLedger(),'asr',1);
 await store.save({...j,recoveryLedger:first});
 const second=reserveOperation(first,'asr',1);
 await store.save({...j,recoveryLedger:second});
 await expect(store.save({...j,recoveryLedger:first})).rejects.toThrow('Журнал попыток');
 await expect(store.save(j)).rejects.toThrow('Журнал попыток');
 const done=finishOperation(second,'asr',1);
 await store.save({...j,recoveryLedger:done,nextWindow:1,segments:[{start:1,end:2,text:'committed'}]});
 const reopened=(await new JobStore().get(j.id,false))!;
 expect(reopened.recoveryLedger).toEqual(done);
 expect(reopened.nextWindow).toBe(1);expect(reopened.segments).toHaveLength(1);
 await store.remove(j.id);
});

it('PIPE-08 saves immutable window geometry before ASR and rejects a stale or changed plan',async()=>{
 const store=new JobStore(),file=new File(['audio'],'plan.wav'),j={...createJob(file,{model:'whisper-small',language:'ru',diarize:false}),duration:60};
 const samples=960000,intervals=[{start:0,end:384000},{start:424000,end:samples}];
 const plan:SpeechWindowPlan={revision:1,contract:SEGMENTATION_CONTRACT,samples,pcmFingerprint:'a'.repeat(64),decoderProfile:'test',...buildSpeechWindows(samples,{revision:1,samples,frames:1875,speechSamples:920000,intervals})};
 await store.save(j,file);await store.save({...j,windowPlan:plan});
 const saved=(await new JobStore().get(j.id,false))!;
 expect(saved.windowPlan).toEqual(plan);
 await expect(store.save(j)).rejects.toThrow('Нельзя изменить');
 await expect(store.save({...j,windowPlan:{...plan,pcmFingerprint:'b'.repeat(64)}})).rejects.toThrow('Нельзя изменить');
 await store.save({...j,windowPlan:plan,nextWindow:1,segments:[{start:3,end:4,text:'saved'}]});
 expect((await store.get(j.id,false))?.windowPlan).toEqual(plan);
 await store.remove(j.id);
});

it('PIPE-09 preserves quality summary atomically and refuses stale counters',async()=>{
 const store=new JobStore(),file=new File(['audio'],'quality-counter.wav'),j=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save(j,file);
 const pcm=new Float32Array(16000),text=[{start:0,end:1,text:'test'}],quality=addAsrQuality(undefined,inspectOwnedAsr(inspectRawAsr(text,pcm),text,[],pcm.length));
 const first={...j,nextWindow:1,segments:text,asrQuality:quality};
 await store.save(first);
 expect((await new JobStore().get(j.id,false))?.asrQuality).toEqual(quality);
 await expect(store.save({...first,asrQuality:undefined})).rejects.toThrow('журнал качества');
 await expect(store.save({...first,nextWindow:2})).rejects.toThrow('Журнал качества');
 expect((await store.get(j.id,false))?.nextWindow).toBe(1);
 await store.remove(j.id);
});

it('PIPE-10 preserves alignment checkpoint and rejects rollback',async()=>{
 const store=new JobStore(),file=new File(['audio'],'aligned.wav'),job=createJob(file,{model:'whisper-small',language:'ru',diarize:false});
 await store.save({...job,duration:1,sourceFingerprint:'source',artifactContract:'pipe04-v1',nextWindow:1,asrComplete:true,segments:[{start:0,end:1,text:'слово'}]},file);
 const saved=(await store.get(job.id,false))!;
 const alignmentCheckpoint={revision:1 as const,contract:'ctc-v1-q8-stride320-min035-word-offsets' as const,language:'ru' as const,samples:16000,segmentCount:1,decoderProfile:'test',pcmFingerprint:'a'.repeat(64),transcriptFingerprint:'b'.repeat(64),alignedSegments:1,alignedWords:1};
 await store.save({...saved,alignmentCheckpoint});
 expect((await new JobStore().get(job.id,false))?.alignmentCheckpoint).toEqual(alignmentCheckpoint);
 await expect(store.save(saved)).rejects.toThrow('Нельзя изменить');
 await expect(store.save({...saved,alignmentCheckpoint:{...alignmentCheckpoint,alignedWords:2}})).rejects.toThrow('Нельзя изменить');
 await store.remove(job.id);
});
