import type {DecoderIdentity} from './decoderDiagnostics';
import {MAX_PCM_SAMPLES} from './audioValidation';

const CHUNK_BYTES=4*1024*1024;
const HEX=/^[0-9a-f]{64}$/;
export interface ArtifactStore{
 getArtifact(id:string,key:string):Promise<unknown>;
 putArtifact(id:string,key:string,value:unknown):Promise<void>;
 deleteArtifact(id:string,key:string):Promise<void>;
}
export class CheckpointIntegrityError extends Error{
 readonly code='checkpoint-integrity';
 constructor(){super('Контрольная точка повреждена или несовместима. Сохранённый текст доступен; добавьте запись как новое задание.');this.name='CheckpointIntegrityError'}
}
function requireIntegrity(ok:unknown):asserts ok{if(!ok)throw new CheckpointIntegrityError()}
async function sha(bytes:ArrayBuffer):Promise<string>{
 if(!globalThis.crypto?.subtle)throw new Error('Для проверки контрольных точек требуется Web Crypto SHA-256.');
 const result=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(result),v=>v.toString(16).padStart(2,'0')).join('');
}
async function textHash(text:string){return sha(new TextEncoder().encode(text).buffer)}
// A bounded-memory, versioned SHA-256-of-chunk-hashes fingerprint,
// NOT the standard SHA-256 of the entire file. File name is never included.
export async function sourceFingerprint(file:Blob,signal?:AbortSignal):Promise<string>{
 const hashes:string[]=[];
 for(let offset=0;offset<file.size;offset+=CHUNK_BYTES){
  signal?.throwIfAborted();
  const part=await file.slice(offset,offset+CHUNK_BYTES).arrayBuffer();
  requireIntegrity(part.byteLength===Math.min(CHUNK_BYTES,file.size-offset));
  hashes.push(await sha(part));
 }
 signal?.throwIfAborted();
 return 'chunks-sha256-v1:'+await textHash(JSON.stringify([file.size,CHUNK_BYTES,hashes]));
}
export function decoderProfile(identity:DecoderIdentity,recoveryExpectedSamples?:number):string{
 return JSON.stringify([identity.kind,identity.route,identity.revision,recoveryExpectedSamples??null,'pcm-f32-16000-mono-v1']);
}
type PcmManifest={revision:1;samples:number;hashes:string[]};
type RawRecord={revision:1;json:string;hash:string};
function rawJson(value:unknown):string{
 // Preserve non-finite numeric diagnostics instead of silently turning them
 // into null. Engine outputs are JSON records; unsupported values fail closed.
 const json=JSON.stringify(value,(_key,v:unknown)=>{
  if(typeof v==='number'&&!Number.isFinite(v))return {__iscribeNonfinite:String(v)};
  return v;
 });
 requireIntegrity(typeof json==='string');
 return json;
}
function parseRaw(json:string):unknown{
 return JSON.parse(json,(_key,v:unknown)=>{
  if(v&&typeof v==='object'&&Object.keys(v).length===1&&'__iscribeNonfinite' in v){
   if(v.__iscribeNonfinite==='NaN')return NaN;
   if(v.__iscribeNonfinite==='Infinity')return Infinity;
   if(v.__iscribeNonfinite==='-Infinity')return -Infinity;
   throw new CheckpointIntegrityError();
  }
  return v;
 });
}
export class CheckpointManager{
 constructor(private readonly store:ArtifactStore,private readonly id:string,private readonly source:string,private readonly signal?:AbortSignal){}
 private check(){this.signal?.throwIfAborted()}
 private async key(stage:string,inputs:readonly unknown[]){
  this.check();
  return stage+':'+await textHash(JSON.stringify([this.source,stage,inputs]));
 }
 async loadPcm(profile:string):Promise<Float32Array|undefined>{
  const key=await this.key('pcm-v1',[profile]),value=await this.store.getArtifact(this.id,key);
  this.check();
  if(value===undefined)return undefined;
  const manifest=value as PcmManifest;
  requireIntegrity(manifest?.revision===1&&Number.isSafeInteger(manifest.samples)&&manifest.samples>0&&manifest.samples<=MAX_PCM_SAMPLES&&Array.isArray(manifest.hashes)&&manifest.hashes.length===Math.ceil(manifest.samples*4/CHUNK_BYTES)&&manifest.hashes.every(h=>typeof h==='string'&&HEX.test(h)));
  const pcm=new Float32Array(manifest.samples),target=new Uint8Array(pcm.buffer);
  for(let i=0;i<manifest.hashes.length;i++){
   this.check();
   const part=await this.store.getArtifact(this.id,key+':'+i);
   requireIntegrity(part instanceof ArrayBuffer&&part.byteLength===Math.min(CHUNK_BYTES,target.length-i*CHUNK_BYTES));
   requireIntegrity(await sha(part)===manifest.hashes[i]);
   target.set(new Uint8Array(part),i*CHUNK_BYTES);
  }
  this.check();return pcm;
 }
 async savePcm(profile:string,pcm:Float32Array):Promise<void>{
  requireIntegrity(pcm.length>0&&pcm.length<=MAX_PCM_SAMPLES);
  const key=await this.key('pcm-v1',[profile]),existing=await this.store.getArtifact(this.id,key);
  // Never overwrite a published generation (including a corrupt one).
  requireIntegrity(existing===undefined);
  const hashes:string[]=[];
  for(let offset=0;offset<pcm.length;offset+=CHUNK_BYTES/4){
   this.check();
   const part=pcm.slice(offset,offset+CHUNK_BYTES/4).buffer;
   hashes.push(await sha(part));
   await this.store.putArtifact(this.id,key+':'+(hashes.length-1),part);
  }
  this.check();
  // Only after every bounded chunk has committed, publish its manifest.
  await this.store.putArtifact(this.id,key,{revision:1,samples:pcm.length,hashes} satisfies PcmManifest);
  this.check();
 }
 async loadWindow(profile:string,start:number,end:number):Promise<Float32Array|undefined>{
  const key=await this.key('window-pcm-v1',[profile,start,end]),value=await this.store.getArtifact(this.id,key);
  this.check();if(value===undefined)return undefined;
  const row=value as {revision:1;bytes:ArrayBuffer;hash:string};
  requireIntegrity(row?.revision===1&&row.bytes instanceof ArrayBuffer&&row.bytes.byteLength===(end-start)*4&&end>start&&end-start<=480000&&typeof row.hash==='string'&&HEX.test(row.hash)&&await sha(row.bytes)===row.hash);
  this.check();return new Float32Array(row.bytes);
 }
 async saveWindow(profile:string,start:number,end:number,pcm:Float32Array):Promise<void>{
  requireIntegrity(end-start===pcm.length&&pcm.length>0&&pcm.length<=480000);
  const key=await this.key('window-pcm-v1',[profile,start,end]),bytes=pcm.slice().buffer;
  const hash=await sha(bytes);this.check();
  await this.store.putArtifact(this.id,key,{revision:1,bytes,hash});
  this.check();
 }
 async discardWindow(profile:string,start:number,end:number):Promise<void>{
  const key=await this.key('window-pcm-v1',[profile,start,end]);
  await this.store.deleteArtifact(this.id,key);
 }
 async pcmInput(pcm:Float32Array):Promise<string>{
  // Window-sized PCM, or bounded hash-of-chunks for full speaker input.
  const hashes:string[]=[];
  for(let offset=0;offset<pcm.length;offset+=CHUNK_BYTES/4){
   this.check();
   hashes.push(await sha(pcm.slice(offset,offset+CHUNK_BYTES/4).buffer));
  }
  this.check();return textHash(JSON.stringify([pcm.length,CHUNK_BYTES,hashes]));
 }
 async loadRaw(stage:'asr'|'diarization',inputs:readonly unknown[]):Promise<unknown|undefined>{
  const key=await this.key(stage+'-raw-v1',inputs),value=await this.store.getArtifact(this.id,key);
  this.check();
  if(value===undefined)return undefined;
  const raw=value as RawRecord;
  requireIntegrity(raw?.revision===1&&typeof raw.json==='string'&&typeof raw.hash==='string'&&HEX.test(raw.hash)&&await textHash(raw.json)===raw.hash);
  this.check();return parseRaw(raw.json);
 }
 async saveRaw(stage:'asr'|'diarization',inputs:readonly unknown[],value:unknown):Promise<void>{
  const key=await this.key(stage+'-raw-v1',inputs),json=rawJson(value);
  const hash=await textHash(json);
  // A raw result returned by inference is saved before downstream validation.
  // Never wrap this write in the inference retry loop.
  this.check();await this.store.putArtifact(this.id,key,{revision:1,json,hash} satisfies RawRecord);
  this.check();
 }
}
