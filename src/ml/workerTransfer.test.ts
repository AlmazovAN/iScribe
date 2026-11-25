import {expect,it,vi} from 'vitest';
import {postSpeakerAudio} from './workerTransfer';

it('transfers the full PCM ArrayBuffer without keeping a second copy in the sending thread',()=>{
 const audio=new Float32Array(16000);
 audio[0]=0.125;
 let workerAudio:Float32Array|undefined;
 const worker={postMessage:vi.fn((message:unknown,transfer?:Transferable[])=>{
  const payload=structuredClone(message,{transfer});
  workerAudio=(payload as {audio:Float32Array}).audio;
 })};
 expect(postSpeakerAudio(worker as unknown as Pick<Worker,'postMessage'>,{type:'iscribe:speakers',requestId:'a',audio})).toBe('transferred');
 expect(worker.postMessage).toHaveBeenCalledOnce();
 expect(audio.byteLength).toBe(0);
 expect(workerAudio?.length).toBe(16000);
 expect(workerAudio?.[0]).toBe(0.125);
});

it('falls back to normal cloning if transferring PCM is unsupported but source remains intact',()=>{
 const audio=new Float32Array([0.25,0.5]);
 const worker={postMessage:vi.fn((message:unknown,transfers?:Transferable[])=>{
  if(transfers)throw new DOMException('transfer blocked','DataCloneError');
  expect((message as {audio:Float32Array}).audio[0]).toBe(0.25);
 })};
 expect(postSpeakerAudio(worker as unknown as Pick<Worker,'postMessage'>,{type:'iscribe:speakers',requestId:'b',audio})).toBe('cloned');
 expect(worker.postMessage).toHaveBeenCalledTimes(2);
 expect(audio.byteLength).toBe(8);
});

it('never retries cloning a buffer already detached during a failed dispatch',()=>{
 const audio=new Float32Array([0.25]);
 const worker={postMessage:vi.fn((_message:unknown,transfers?:Transferable[])=>{
  if(transfers)structuredClone(audio,{transfer:transfers});
  throw new Error('unexpected failure');
 })};
 expect(()=>postSpeakerAudio(worker as unknown as Pick<Worker,'postMessage'>,{type:'iscribe:speakers',requestId:'c',audio})).toThrow('unexpected failure');
 expect(worker.postMessage).toHaveBeenCalledTimes(1);
});
