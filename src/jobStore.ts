import {recoverJob,type Job} from './jobs';
const DB='iscribe-jobs-v1';
export class JobStore{
 private opening:Promise<IDBDatabase>|undefined;
 private open(){
  return this.opening??=(new Promise<IDBDatabase>((resolve,reject)=>{
   const request=indexedDB.open(DB,1);
   request.onupgradeneeded=()=>{request.result.createObjectStore('jobs',{keyPath:'id'});request.result.createObjectStore('audio')};
   request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();this.opening=undefined};resolve(db)};
   request.onerror=()=>{this.opening=undefined;reject(request.error)};
   request.onblocked=()=>{this.opening=undefined;reject(new Error('Закройте другие вкладки iScribe для доступа к сохранённым заданиям.'))};
  }));
 }
 async list():Promise<Job[]>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction('jobs','readonly'),req=tx.objectStore('jobs').getAll();
   tx.oncomplete=()=>resolve((req.result as Job[]).map(recoverJob).sort((a,b)=>a.updated-b.updated));tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
 }
 async save(job:Job,file?:File):Promise<void>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction(file?['jobs','audio']:['jobs'],'readwrite');
   tx.objectStore('jobs').put(job);if(file)tx.objectStore('audio').put(file,job.id);
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('Сохранение отменено.'));
  });
 }
 async audio(id:string):Promise<File|undefined>{
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction('audio','readonly'),req=tx.objectStore('audio').get(id);
   tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
 }
 async remove(id:string){
  const db=await this.open();return new Promise<void>((resolve,reject)=>{
   const tx=db.transaction(['jobs','audio'],'readwrite');tx.objectStore('jobs').delete(id);tx.objectStore('audio').delete(id);
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
 }
}
