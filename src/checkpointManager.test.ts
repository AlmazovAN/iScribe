import {describe,expect,it} from 'vitest';
import {CheckpointManager,CheckpointIntegrityError,decoderProfile,sourceFingerprint,type ArtifactStore} from './checkpointManager';

class MemoryArtifacts implements ArtifactStore{
 rows=new Map<string,unknown>();
 writes=0;failAt=Infinity;
 async getArtifact(id:string,key:string){return structuredClone(this.rows.get(id+'|'+key))}
 async putArtifact(id:string,key:string,value:unknown){if(++this.writes===this.failAt)throw new Error('quota');this.rows.set(id+'|'+key,structuredClone(value))}
 async deleteArtifact(id:string,key:string){this.rows.delete(id+'|'+key)}
}
const full=decoderProfile({kind:'ffmpeg',route:'full',revision:'test'});
const recovered=decoderProfile({kind:'ffmpeg',route:'full',revision:'test'},16000);
const make=()=>{const store=new MemoryArtifacts();return {store,manager:new CheckpointManager(store,'job','source')}};
describe('PIPE-04 stage artifact integrity',()=>{
 it('fingerprints source bytes across bounded chunks independently of filename',async()=>{
  const a=new Uint8Array(4*1024*1024+1),b=a.slice();b[b.length-1]=1;
  const first=await sourceFingerprint(new File([a],'a.mp3'));
  expect(first).toMatch(/^chunks-sha256-v1:[0-9a-f]{64}$/);
  expect(await sourceFingerprint(new File([a],'b.mp3'))).toBe(first);
  expect(await sourceFingerprint(new Blob([b]))).not.toBe(first);
 });
 it('publishes PCM only after all chunks and rejects damaged published data',async()=>{
  const {store,manager}=make(),x=new Float32Array(1048577);x[1048575]=-.5;x[1048576]=.25;
  await manager.savePcm(full,x);expect(store.rows.size).toBe(3);
  const reopened=new CheckpointManager(store,'job','source');
  expect(await reopened.loadPcm(full)).toEqual(x);
  expect(await reopened.loadPcm(recovered)).toBeUndefined();
  expect(await new CheckpointManager(store,'job','different').loadPcm(full)).toBeUndefined();
  await expect(reopened.savePcm(full,x)).rejects.toBeInstanceOf(CheckpointIntegrityError);
  const key=[...store.rows.keys()].find(k=>k.endsWith(':1'))!;
  new Uint8Array(store.rows.get(key) as ArrayBuffer)[0]^=1;
  await expect(reopened.loadPcm(full)).rejects.toBeInstanceOf(CheckpointIntegrityError);
 });
 it('recovers interrupted PCM publication, without exposing incomplete chunks',async()=>{
  const {store,manager}=make(),x=new Float32Array(1048577);store.failAt=2;
  await expect(manager.savePcm(full,x)).rejects.toThrow('quota');
  expect(await manager.loadPcm(full)).toBeUndefined();
  store.failAt=Infinity;await manager.savePcm(full,x);expect(await manager.loadPcm(full)).toEqual(x);
 });
 it('rejects missing chunks when the manifest exists',async()=>{
  const {store,manager}=make();await manager.savePcm(full,new Float32Array(8));
  store.rows.delete([...store.rows.keys()].find(k=>k.endsWith(':0'))!);
  await expect(manager.loadPcm(full)).rejects.toBeInstanceOf(CheckpointIntegrityError);
 });
 it('validates exact window bounds and supports cleanup after commit',async()=>{
  const {manager}=make(),x=new Float32Array([0,.5,-.5]);
  await manager.saveWindow(full,400000,400003,x);
  expect(await manager.loadWindow(full,400000,400003)).toEqual(x);
  expect(await manager.loadWindow(full,400001,400004)).toBeUndefined();
  await manager.discardWindow(full,400000,400003);
  expect(await manager.loadWindow(full,400000,400003)).toBeUndefined();
  await expect(manager.saveWindow(full,0,4,x)).rejects.toBeInstanceOf(CheckpointIntegrityError);
 });
 it('keeps invalid RAW timestamps, isolates PCM/config inputs and rejects altered JSON',async()=>{
  const {store,manager}=make();
  const a=await manager.pcmInput(new Float32Array([0,.5])),b=await manager.pcmInput(new Float32Array([0,-.5]));
  expect(a).not.toBe(b);
  const raw=[{start:NaN,end:Infinity,text:'synthetic'}],inputs=[a,'small','ru'];
  await manager.saveRaw('asr',inputs,raw);
  expect(await manager.loadRaw('asr',inputs)).toEqual(raw);
  expect(await manager.loadRaw('asr',[b,'small','ru'])).toBeUndefined();
  expect(await manager.loadRaw('asr',[a,'tiny','ru'])).toBeUndefined();
  const record=[...store.rows.values()][0] as {json:string};record.json+=' ';
  await expect(manager.loadRaw('asr',inputs)).rejects.toBeInstanceOf(CheckpointIntegrityError);
 });
 it('stores diarization independently of ASR',async()=>{
  const {manager}=make(),inputs=['pcm','speaker-engine'],turns=[{start:0,end:1,speaker:'A'}];
  await manager.saveRaw('diarization',inputs,turns);
  expect(await manager.loadRaw('diarization',inputs)).toEqual(turns);
  expect(await manager.loadRaw('asr',inputs)).toBeUndefined();
 });
 it('does not publish an artifact when already cancelled',async()=>{
  const {store}=make(),controller=new AbortController(),p=new CheckpointManager(store,'job','source',controller.signal);
  controller.abort();
  await expect(p.savePcm(full,new Float32Array(1))).rejects.toMatchObject({name:'AbortError'});
  expect(store.rows.size).toBe(0);
 });
});
