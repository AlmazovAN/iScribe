import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Real FFmpeg Worker, production assets and IndexedDB. No Whisper weights
// or hardware inference: model loading is intentionally denied.
function syntheticWav(){
 const rate=16000,n=16000,b=Buffer.alloc(44+n*2);
 b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
 b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
 b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);
 b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++)b.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*440*i/rate)),44+2*i);
 return b;
}
async function persistedAudio(page){
 return page.evaluate(()=>new Promise((resolve,reject)=>{
  const request=indexedDB.open('iscribe-jobs-v1');
  request.onerror=()=>reject(request.error);
  request.onsuccess=()=>{
   const db=request.result,tx=db.transaction('jobs','readonly'),all=tx.objectStore('jobs').getAll();
   tx.oncomplete=()=>{
    db.close();const job=all.result.find(j=>j.name==='synthetic-release.wav');
    resolve(job?{decoder:job.decoderIdentity,check:job.audioCheck?.status,samples:job.audioCheck?.report?.pcmSamples,
     ready:job.trace?.some(e=>e.code==='audio-ready'&&e.decoderKind==='ffmpeg'),stage:job.stage}:null);
   };
   tx.onerror=()=>{db.close();reject(tx.error)};
  };
 }));
}
async function decodeFromUi(page){
 await expect(page.getByRole('button',{name:'Выбрать файлы'})).toBeEnabled();
 await page.getByLabel('Выбрать аудиозаписи',{exact:true}).setInputFiles({
  name:'synthetic-release.wav',mimeType:'audio/wav',buffer:syntheticWav()
 });
 const row=page.locator('.file-row');
 await row.getByRole('button',{name:'Начать',exact:true}).click();
 await expect.poll(()=>persistedAudio(page),{timeout:90000}).toMatchObject({
  decoder:{kind:'ffmpeg',route:'full'},check:'passed',samples:16000,ready:true
 });
 await expect(row).toContainText('FFmpeg');
}
test('DEC-04 actual FFmpeg decodes through the single file:// HTML',async({page,context})=>{
 await context.route('https://**/*',route=>route.abort());
 const localUrl=pathToFileURL(resolve('dist/iScribe.html')).href;
 const otherFiles=[];
 context.on('request',req=>{if(req.url().startsWith('file:')&&req.url()!==localUrl)otherFiles.push(req.url());});
 await page.goto(localUrl);
 await decodeFromUi(page);
 expect(otherFiles).toEqual([]);
});
test('DEC-04 actual FFmpeg decodes in the cached production shell while offline',async({page,context})=>{
 await context.route('https://**/*',route=>route.abort());
 await page.goto('/');
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
 await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
 await context.setOffline(true);
 try{
  await page.reload();
  await decodeFromUi(page);
  expect(await page.evaluate(()=>navigator.onLine)).toBe(false);
 }finally{await context.setOffline(false)}
});
