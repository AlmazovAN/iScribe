import type {TranscriptSegment} from '@yourdevice/engine';
import {recoverJob,type Job} from './jobs';
import {sameDecoder} from './decoderDiagnostics';
import {assertRecoveryForward} from './recoveryManager';

// Version 2 adds append-only ASR chunks. The legacy jobs/audio stores remain
// in the same database; a transaction commits text and nextWindow atomically.
const DB='iscribe-jobs-v1';
// v3 adds independent stage artifacts without rewriting v1/v2 jobs.
const DB_VERSION=3;
const ARTIFACTS='stage-artifacts-v3';
const ASR='asr-chunks-v2';
const SPEAKERS='speaker-results-v2';
type StoredJob=Omit<Job,'segments'|'speakerSegments'> & {
 segments?:TranscriptSegment[];
 speakerSegments?:TranscriptSegment[];
 storageLayout?:2;
 segmentCount?:number;
};
type AsrChunk={id:string;offset:number;segments:TranscriptSegment[]};
type SpeakerRecord={id:string;segments:TranscriptSegment[]};
type ArtifactRecord={id:string;key:string;value:unknown};

function restore(records:readonly StoredJob[],chunks:readonly AsrChunk[],speakers:readonly SpeakerRecord[],recover:boolean):Job[]{
 const byJob=new Map<string,AsrChunk[]>();
 const speakerById=new Map(speakers.map(x=>[x.id,x.segments]));
 for(const chunk of chunks){
  const existing=byJob.get(chunk.id)??[];
  existing.push(chunk);byJob.set(chunk.id,existing);
 }
 return records.map(record=>{
  // Existing v1 jobs remain readable until the first write lazily migrates them.
  if(record.storageLayout!==2){
   const old=record as Job;
   return recover?recoverJob(old):old;
  }
  const parts=(byJob.get(record.id)??[]).sort((a,b)=>a.offset-b.offset);
  const segments:TranscriptSegment[]=[];
  for(const chunk of parts){
   if(chunk.offset!==segments.length||!Array.isArray(chunk.segments))
    throw new Error('Повреждены сохранённые сегменты распознавания. Не очищайте данные сайта.');
   segments.push(...chunk.segments);
  }
  if(!Number.isSafeInteger(record.segmentCount)||record.segmentCount!==segments.length)
   throw new Error('Контрольная точка и сохранённый текст не совпадают. Не очищайте данные сайта.');
  const speakerSegments=speakerById.get(record.id);
  const job:Job={...record,segments,...(speakerSegments===undefined?{}:{speakerSegments})};
  return recover?recoverJob(job):job;
 }).sort((a,b)=>a.updated-b.updated);
}

export class JobStore{
 private opening:Promise<IDBDatabase>|undefined;
 constructor(private readonly dbName=DB){}
 private open():Promise<IDBDatabase>{
  return this.opening??=(new Promise<IDBDatabase>((resolve,reject)=>{
   const request=indexedDB.open(this.dbName,DB_VERSION);
   let blocked=false;
   request.onupgradeneeded=()=>{
    const db=request.result;
    if(!db.objectStoreNames.contains('jobs'))db.createObjectStore('jobs',{keyPath:'id'});
    if(!db.objectStoreNames.contains('audio'))db.createObjectStore('audio');
    if(!db.objectStoreNames.contains(ASR))db.createObjectStore(ASR,{keyPath:['id','offset']});
    if(!db.objectStoreNames.contains(SPEAKERS))db.createObjectStore(SPEAKERS,{keyPath:'id'});
    if(!db.objectStoreNames.contains(ARTIFACTS))db.createObjectStore(ARTIFACTS,{keyPath:['id','key']});
   };
   request.onsuccess=()=>{const db=request.result;if(blocked){db.close();return}db.onversionchange=()=>{db.close();this.opening=undefined};resolve(db)};
   request.onerror=()=>{this.opening=undefined;reject(request.error)};
   request.onblocked=()=>{blocked=true;this.opening=undefined;reject(new Error('Закройте другие вкладки iScribe для обновления локального хранилища.'))};
  }));
 }
 async list(recover=true):Promise<Job[]>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction(['jobs',ASR,SPEAKERS],'readonly');
   const jobs=tx.objectStore('jobs').getAll(),chunks=tx.objectStore(ASR).getAll(),speakers=tx.objectStore(SPEAKERS).getAll();
   tx.oncomplete=()=>{
    try{resolve(restore(jobs.result as StoredJob[],chunks.result as AsrChunk[],speakers.result as SpeakerRecord[],recover))}
    catch(error){reject(error)}
   };
   tx.onerror=()=>reject(tx.error);
   tx.onabort=()=>reject(tx.error??new Error('Чтение сохранённых заданий прервано.'));
  });
 }
 // Loading one job avoids decoding/cloning every stored transcript on resume.
 async get(id:string,recover=true):Promise<Job|undefined>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction(['jobs',ASR,SPEAKERS],'readonly');
   const record=tx.objectStore('jobs').get(id);
   const range=IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]);
   const chunks=tx.objectStore(ASR).getAll(range),speaker=tx.objectStore(SPEAKERS).get(id);
   tx.oncomplete=()=>{
    try{
     if(!record.result){resolve(undefined);return}
     resolve(restore([record.result as StoredJob],chunks.result as AsrChunk[],
      speaker.result?[speaker.result as SpeakerRecord]:[],recover)[0]);
    }catch(error){reject(error)}
   };
   tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('Чтение задания прервано.'));
  });
 }
 async save(job:Job,file?:File):Promise<void>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const stores=file?['jobs',ASR,SPEAKERS,'audio']:['jobs',ASR,SPEAKERS];
   const tx=db.transaction(stores,'readwrite');
   const jobs=tx.objectStore('jobs'),chunks=tx.objectStore(ASR),speakers=tx.objectStore(SPEAKERS);
   let integrityError:Error|null=null;
   const current=jobs.get(job.id);
   current.onsuccess=()=>{
    try{
     const old=current.result as StoredJob|undefined;
     assertRecoveryForward(old?.recoveryLedger,job.recoveryLedger);
     const oldCount=old?(old.storageLayout===2?old.segmentCount??NaN:old.segments?.length??0):0;
     if(!Number.isSafeInteger(oldCount)||oldCount<0||
        job.segments.length<oldCount||(old&&job.nextWindow<old.nextWindow))
      throw new Error('Отказ от записи: сохранённый текст или контрольная точка не могут уменьшиться.');
     // Stale metadata from a second tab must never reset a durable retry
     // reservation, even if its ASR checkpoint is still identical.
     if(old?.decoderIdentity&&(!job.decoderIdentity||!sameDecoder(old.decoderIdentity,job.decoderIdentity)))
      throw new Error('Декодер задания изменился. Обновите страницу.');
     if(old?.sourceFingerprint&&(old.sourceFingerprint!==job.sourceFingerprint||old.artifactContract!==job.artifactContract))
      throw new Error('Идентификатор исходного аудио изменился. Добавьте запись как новое задание.');
     if((old?.fullDecodeRecoveries??0)>(job.fullDecodeRecoveries??0))
      throw new Error('Лимит полного декодирования изменился. Обновите страницу.');
     const previous=old?.streamRecovery,next=job.streamRecovery;
     if(previous&&(!next||next.totalRecoveries<previous.totalRecoveries||next.window<previous.window||
       (next.window===previous.window&&next.windowRecoveries<previous.windowRecoveries)))
      throw new Error('Лимит восстановления изменился в другой вкладке. Обновите страницу.');
     if(old&&job.segments.length>oldCount&&job.nextWindow<=old.nextWindow)
      throw new Error('Нельзя записать новый текст без подтверждённого номера следующего окна.');
     if(old?.storageLayout!==2){
      // One-time migration is in this SAME transaction. A failure cannot
      // leave the legacy job stripped of text without its replacement chunks.
      if(old?.segments?.length)chunks.put({id:job.id,offset:0,segments:old.segments} satisfies AsrChunk);
      if(old?.speakerSegments!==undefined&&!job.speakerSegments)
       speakers.put({id:job.id,segments:old.speakerSegments} satisfies SpeakerRecord);
     }
     // Only new segments are copied/written; no repeated whole-transcript
     // serialization for status updates or successive ASR windows.
     if(job.segments.length>oldCount)
      chunks.put({id:job.id,offset:oldCount,segments:job.segments.slice(oldCount)} satisfies AsrChunk);
     if(job.speakerSegments!==undefined)
      speakers.put({id:job.id,segments:job.speakerSegments} satisfies SpeakerRecord);
     const durable:StoredJob={...job,segments:[],storageLayout:2,segmentCount:job.segments.length};
     delete durable.speakerSegments;
     delete durable.volatileSegments;
     jobs.put(durable);
     if(file)tx.objectStore('audio').put(file,job.id);
    }catch(error){
     integrityError=error instanceof Error?error:new Error('Некорректная контрольная точка.');
     tx.abort();
    }
   };
   tx.oncomplete=()=>resolve();
   tx.onerror=()=>reject(integrityError??tx.error);
   tx.onabort=()=>reject(integrityError??tx.error??new Error('Сохранение отменено.'));
  });
 }
 async audio(id:string):Promise<File|undefined>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction('audio','readonly'),req=tx.objectStore('audio').get(id);
   tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
 }
 // Individual records commit atomically. PCM manifests are published last by
 // CheckpointManager; incomplete chunks are never considered a usable PCM.
 async getArtifact(id:string,key:string):Promise<unknown>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction(ARTIFACTS,'readonly'),request=tx.objectStore(ARTIFACTS).get([id,key]);
   tx.oncomplete=()=>resolve((request.result as ArtifactRecord|undefined)?.value);
   tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('Чтение артефакта прервано.'));
  });
 }
 async putArtifact(id:string,key:string,value:unknown):Promise<void>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction(['jobs',ARTIFACTS],'readwrite'),request=tx.objectStore('jobs').get(id);
   request.onsuccess=()=>{if(!request.result){tx.abort();return}
    try{tx.objectStore(ARTIFACTS).put({id,key,value} satisfies ArtifactRecord)}catch{tx.abort()}
   };
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
   tx.onabort=()=>reject(tx.error??new Error('Сохранение артефакта прервано.'));
  });
 }
 async deleteArtifact(id:string,key:string):Promise<void>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction(ARTIFACTS,'readwrite');tx.objectStore(ARTIFACTS).delete([id,key]);
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('Удаление артефакта прервано.'));
  });
 }
 async remove(id:string):Promise<void>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction(['jobs','audio',ASR,SPEAKERS,ARTIFACTS],'readwrite');
   tx.objectStore('jobs').delete(id);
   tx.objectStore('audio').delete(id);
   tx.objectStore(SPEAKERS).delete(id);
   const chunks=tx.objectStore(ASR);
   const range=IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]);
   const keys=chunks.openKeyCursor(range);
   keys.onsuccess=()=>{
    const cursor=keys.result;
    if(cursor){chunks.delete(cursor.primaryKey);cursor.continue()}
   };
   const artifacts=tx.objectStore(ARTIFACTS),artifactKeys=artifacts.openKeyCursor(IDBKeyRange.bound([id,''],[id,'\uffff']));
   artifactKeys.onsuccess=()=>{const cursor=artifactKeys.result;if(cursor){artifacts.delete(cursor.primaryKey);cursor.continue()}};
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('Удаление прервано.'));
  });
 }
}
