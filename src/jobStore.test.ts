import 'fake-indexeddb/auto';
import {expect,it} from 'vitest';
import {JobStore} from './jobStore';
import {createJob,absoluteSegments,audioWindows} from './jobs';
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
