import {test,expect} from '@playwright/test';
import {open,readFile,rm,writeFile} from 'node:fs/promises';

const HARNESS='/tests/e2e/harness.html';
const row=page=>page.locator('.file-row');
const small=page=>page.locator('.model-panel .model').nth(1);
const diagnostics=page=>page.locator('.diagnostics-panel');
const add=async(page,name)=>{
 await page.getByLabel('Выбрать аудиозаписи',{exact:true}).setInputFiles({
  name,mimeType:'audio/wav',buffer:Buffer.from([0x52,0x49,0x46,0x46])
 });
 await expect(row(page)).toHaveCount(1);
};
const loadFixture=async page=>{
 await small(page).getByRole('button',{name:'Скачать'}).click();
 await expect(small(page).locator('.download-status')).toContainText(/готова к работе/i);
};
const snapshot=async(page)=>page.evaluate(async()=>new Promise((resolve,reject)=>{
 const request=indexedDB.open('iscribe-jobs-v1');
 request.onerror=()=>reject(request.error?.message);
 request.onsuccess=()=>{
  const db=request.result;
  const tx=db.transaction(['jobs','asr-chunks-v2','speaker-results-v2'],'readonly');
  const jobs=tx.objectStore('jobs').getAll();
  const chunks=tx.objectStore('asr-chunks-v2').getAll();
  const speakers=tx.objectStore('speaker-results-v2').getAll();
  tx.onerror=()=>reject(tx.error?.message);
  tx.oncomplete=()=>{
   db.close();
   try{
    const result=jobs.result.map(job=>{
     if(job.storageLayout!==2)return job;
     const parts=chunks.result.filter(c=>c.id===job.id).sort((a,b)=>a.offset-b.offset);
     const segments=[];
     for(const part of parts){
      if(part.offset!==segments.length)throw new Error('ASR chunk sequence broken');
      segments.push(...part.segments);
     }
     if(segments.length!==job.segmentCount)throw new Error('Checkpoint/ASR segments mismatch');
     const speakerSegments=speakers.result.find(s=>s.id===job.id)?.segments;
     return {...job,segments,speakerSegments};
    });
    resolve(result);
   }catch(error){reject(error.message)}
  };
 };
}));
const downloadText=async(page,label,target=row(page))=>{
 const [download]=await Promise.all([
  page.waitForEvent('download'),
  target.getByRole('button',{name:label,exact:true}).click()
 ]);
 return {name:download.suggestedFilename(),text:await readFile(await download.path(),'utf8')};
};

test.beforeEach(async({page})=>{
 page.on('dialog',dialog=>dialog.accept());
 await page.goto(HARNESS);
 await expect(page.getByRole('button',{name:'Выбрать файлы'})).toBeEnabled();
});

test('actual Cache API persists across reload and notices eviction',async({page})=>{
 await loadFixture(page);
 expect(await page.evaluate(async()=>{const c=await caches.open('transformers-cache');return (await c.keys()).length})).toBeGreaterThan(0);
 await page.reload();
 // Cached files survive reload; ONNX session itself must be initialized again.
 await expect(small(page).locator('.download-status')).toContainText('В кэше');
 await expect(small(page).getByRole('button',{name:'Выбрана · в кэше'})).toBeVisible();
 await small(page).getByRole('button',{name:'Выбрана · в кэше'}).click();
 await expect(small(page).locator('.download-status')).toContainText(/готова к работе/i);
 await page.evaluate(()=>caches.delete('transformers-cache'));
 await page.reload();
 await expect(small(page).locator('.download-status')).toContainText('Не скачана');
});

test('14m31s: committed windows survive refresh; resume once; all three real TXT downloads',async({page},testInfo)=>{
 await page.evaluate(()=>localStorage.setItem('iscribe-e2e:pauseAt','3'));
 await loadFixture(page);
 await add(page,'meeting-871s.wav');
 await row(page).getByRole('button',{name:'Начать',exact:true}).click();
 await expect(row(page).locator('.file-progress-metrics')).toContainText('3/35 (00:55 / 14:31)');
 await expect(row(page).locator('.file-progress-metrics')).toContainText('Time codes');
 await expect(row(page).locator('.file-progress-metrics')).toContainText('00:33 / 14:31');
 await expect(row(page).locator('.file-queue-status')).toContainText('Whisper small');
 await expect(row(page).locator('.file-progress-track')).toHaveAttribute('data-processing','true');
 const before=(await snapshot(page))[0];
 expect(before.nextWindow).toBe(2);
 expect(before.segments.map(s=>s.text)).toEqual(['Окно 1','Окно 2']);
 // Export while the third window is still in-flight, before any diarization.
 const partial=await downloadText(page,'Скачать TXT');
 expect(partial.name).toContain('_partial');
 expect(partial.text).toContain('Окно 1');
 expect(partial.text).not.toContain('Окно 3');
 await page.reload();
 await page.evaluate(()=>localStorage.removeItem('iscribe-e2e:pauseAt'));
 await expect(row(page).getByRole('button',{name:'Продолжить'})).toBeVisible();
 await expect(row(page)).toContainText('00:55 / 14:31');
 await row(page).getByRole('button',{name:'Продолжить'}).click();
 await expect(row(page)).toContainText('Текст и спикеры готовы',{timeout:90000});
 const after=(await snapshot(page))[0];
 expect(after.asrComplete).toBe(true);
 expect(after.nextWindow).toBe(35);
 expect(after.segments).toHaveLength(35);
 expect(new Set(after.segments.map(s=>s.text)).size).toBe(35);
 expect(after.speakerSegments).toHaveLength(35);
 const plain=await downloadText(page,'Скачать TXT');
 expect(plain.text.match(/Окно \d+/g)).toHaveLength(35);
 expect(plain.text).not.toContain('[SPEAKER_');
 expect(plain.text).not.toContain('[00:');
 const timed=await downloadText(page,'TXT + time');
 expect(timed.text).toContain('[00:06] Окно 1');
 expect(timed.text).toContain('Окно 35');
 const speakers=await downloadText(page,'TXT + time + speaker');
 expect(speakers.text).toContain('[SPEAKER_00]: Окно 1');
 expect(speakers.text).toContain('Окно 35');
 expect(speakers.text.match(/Окно \d+/g)).toHaveLength(35);
 const benchmark=await downloadText(page,'Логирование JSON',diagnostics(page));
 const report=JSON.parse(benchmark.text).benchmark;
 expect(report).toMatchObject({schema:'iscribe.benchmark.v1',source:'browser-observed-timings',
  resumedRuns:1,measuredCommittedWindows:35,measuredUniqueAudioSeconds:871,
  asrWindowMs:{count:35},committedCheckpointWindows:35});
 expect(report.timingsMs.checkpointPersistence).toBeGreaterThanOrEqual(0);
 expect(report.asrWindowMs.p95).toBeGreaterThanOrEqual(0);
 expect(report.windowTimings).toHaveLength(35);
 expect(benchmark.text).not.toContain('meeting-871s.wav');
 expect(benchmark.text).not.toContain('Окно 1');
 // CI artifact contains synthetic fixture timings, not hardware Whisper scores.
 await writeFile(testInfo.outputPath('synthetic-benchmark.json'),JSON.stringify({
  ...report,ciFixture:'mocked-Whisper-871s; NOT a real inference benchmark'
 },null,2));

});

test('speaker failures do not destroy complete TXT or rerun ASR on retry',async({page})=>{
 await page.evaluate(()=>localStorage.setItem('iscribe-e2e:failSpeakers','1'));
 await loadFixture(page);
 await add(page,'meeting-60s.wav');
 await row(page).getByRole('button',{name:'Начать',exact:true}).click();
 await expect(row(page)).toContainText('Текст готов. Разделение говорящих не завершено.');
 const before=(await snapshot(page))[0];
 expect(before.asrComplete).toBe(true);
 expect(before.nextWindow).toBe(3);
 expect(before.segments).toHaveLength(3);
 await expect(row(page).getByRole('button',{name:'TXT + time + speaker'})).toBeDisabled();
 const txt=await downloadText(page,'Скачать TXT');
 expect(txt.text).toContain('Окно 3');
 const timed=await downloadText(page,'TXT + time');
 expect(timed.text).toContain('[00:06]');
 const count=await page.evaluate(()=>localStorage.getItem('iscribe-e2e:transcribeCount'));
 await page.evaluate(()=>localStorage.removeItem('iscribe-e2e:failSpeakers'));
 await row(page).getByRole('button',{name:'Повторить спикеров'}).click();
 await expect(row(page)).toContainText('Текст и спикеры готовы');
 expect(await page.evaluate(()=>localStorage.getItem('iscribe-e2e:transcribeCount'))).toBe(count);
 await expect(row(page).getByRole('button',{name:'TXT + time + speaker'})).toBeEnabled();
});


test('durable FIFO restores three jobs after a reload; one click resumes only unfinished windows',async({page})=>{
 await page.evaluate(()=>localStorage.setItem('iscribe-e2e:pauseAt','2'));
 await loadFixture(page);
 const names=['queue-one-60s.wav','queue-two-60s.wav','queue-three-60s.wav'];
 for(let i=0;i<names.length;i++){
  await page.getByLabel('Выбрать аудиозаписи',{exact:true}).setInputFiles({
   name:names[i],mimeType:'audio/wav',buffer:Buffer.from([0x52,0x49,0x46,0x46])
  });
  await expect(row(page)).toHaveCount(i+1);
 }
 for(let i=0;i<names.length;i++)
  await row(page).nth(i).getByRole('button',{name:'Начать',exact:true}).click();
 await expect.poll(async()=>((await snapshot(page)).find(j=>j.name===names[0])?.nextWindow)).toBe(1);
 await expect.poll(async()=>((await snapshot(page)).filter(j=>j.queueOrder!==undefined)).length).toBe(3);
 const before=await snapshot(page);
 expect(before.filter(j=>j.queueOrder).sort((a,b)=>a.queueOrder-b.queueOrder).map(j=>j.name)).toEqual(names);
 expect(before.find(j=>j.name===names[0])?.segments).toHaveLength(1);
 await page.reload();
 await expect(page.getByRole('button',{name:'Продолжить очередь'})).toBeVisible();
 await expect(page.locator('.queue-banner')).toContainText('Очередь: 3 заданий');
 expect((await snapshot(page)).find(j=>j.name===names[0])?.nextWindow).toBe(1);
 await expect(page.locator('.file-row[aria-label="queue-two-60s.wav"] .file-queue-number')).toHaveText('2');
 await expect(page.locator('.file-row[aria-label="queue-three-60s.wav"] .file-queue-number')).toHaveText('3');
 // Opening the page never triggers costly ML work automatically.
 const pausedCalls=await page.evaluate(()=>localStorage.getItem('iscribe-e2e:transcribeCount'));
 await page.waitForTimeout(150);
 expect(await page.evaluate(()=>localStorage.getItem('iscribe-e2e:transcribeCount'))).toBe(pausedCalls);
 await page.evaluate(()=>localStorage.removeItem('iscribe-e2e:pauseAt'));
 await page.getByRole('button',{name:'Продолжить очередь'}).click();
 await expect(page.locator('.file-row[aria-label="queue-three-60s.wav"]')).toContainText('Текст и спикеры готовы',{timeout:90000});
 const after=await snapshot(page);
 expect(after).toHaveLength(3);
 for(const name of names){
  const job=after.find(j=>j.name===name);
  expect(job).toMatchObject({stage:'done',asrComplete:true,nextWindow:3});
  expect(job.segments.map(s=>s.text)).toEqual(['Окно 1','Окно 2','Окно 3']);
  expect(job.queueOrder).toBeUndefined();
 }
 await expect(page.locator('.queue-banner')).toHaveCount(0);
 await page.reload();
 await expect(page.locator('.queue-banner')).toHaveCount(0);
 expect((await snapshot(page)).every(j=>j.queueOrder===undefined)).toBe(true);
});


test('speaker gaps remain unlabeled; saved TXT stays downloadable and speaker retry does not rerun ASR',async({page})=>{
 await page.evaluate(()=>localStorage.setItem('iscribe-e2e:speakerGaps','1'));
 await loadFixture(page);
 await add(page,'speaker-gaps-60s.wav');
 await row(page).getByRole('button',{name:'Начать',exact:true}).click();
 await expect(row(page)).toContainText('Текст готов · без спикера: 2 из 3',{timeout:90000});
 const persisted=(await snapshot(page))[0];
 expect(persisted).toMatchObject({asrComplete:true,nextWindow:3,stage:'partial',diagnostics:{unlabeled:2,uncovered:2,overlapMatches:1}});
 expect(persisted.speakerSegments.map(s=>s.speaker)).toEqual(['Fixture Speaker',undefined,undefined]);
 const plain=await downloadText(page,'Скачать TXT');
 expect(plain.text.match(/Окно \d/g)).toHaveLength(3);
 const before=await page.evaluate(()=>localStorage.getItem('iscribe-e2e:transcribeCount'));
 await page.evaluate(()=>localStorage.removeItem('iscribe-e2e:speakerGaps'));
 await row(page).getByRole('button',{name:'Повторить спикеров'}).click();
 await expect(row(page)).toContainText('Текст и спикеры готовы',{timeout:90000});
 expect(await page.evaluate(()=>localStorage.getItem('iscribe-e2e:transcribeCount'))).toBe(before);
 const final=(await snapshot(page))[0];
 expect(final.diagnostics.unlabeled).toBe(0);
 expect(final.speakerSegments.every(s=>!!s.speaker)).toBe(true);
});


test('diagnostics follow runtime status and keep TXT controls on the file row',async({page})=>{
 await loadFixture(page);
 await add(page,'compact-ui-60s.wav');
 const file=row(page);
 const panel=diagnostics(page);
 await expect(page.locator('.runtime-bar + .diagnostics-panel')).toHaveCount(1);
 await expect(file.getByRole('button',{name:'Скачать TXT',exact:true})).toBeDisabled();
 await expect(file.getByRole('button',{name:'Начать',exact:true})).toBeVisible();
 await expect(panel.getByRole('button',{name:'Логирование JSON'})).toBeVisible();
 await expect(panel.locator('details, summary')).toHaveCount(0);
 await expect(panel.getByRole('button')).toHaveCount(1);
 await file.getByRole('button',{name:'Начать',exact:true}).click();
 await expect(file).toContainText('Текст и спикеры готовы',{timeout:90000});
 await expect(file.getByRole('button',{name:'Скачать TXT',exact:true})).toBeEnabled();
 const log=await downloadText(page,'Логирование JSON',panel);
 const combined=JSON.parse(log.text);
 expect(combined.schema).toBe('iscribe.diagnostics.v1');
 expect(combined.benchmark.schema).toBe('iscribe.benchmark.v1');
 expect(combined.events.some(e=>e.code==='checkpoint-committed')).toBe(true);
 expect(log.text).not.toContain('compact-ui-60s.wav');
 await page.setViewportSize({width:390,height:844});
 await expect(file.getByRole('button',{name:'TXT + time',exact:true})).toBeVisible();
 await expect(file.getByRole('button',{name:'TXT + time + speaker',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
 const plain=await downloadText(page,'Скачать TXT');
 expect(plain.text).toContain('Окно 3');
 await page.reload();
 await expect(row(page)).toHaveCount(1);
 await expect(row(page).getByRole('button',{name:'Скачать TXT',exact:true})).toBeEnabled();
 await expect(diagnostics(page).getByRole('button',{name:'Логирование JSON'})).toBeVisible();
});


test('large audio decodes only the current windows and resumes after reload',async({page},testInfo)=>{
 const path=testInfo.outputPath('streamed-silence.wav');
 const bytes=129*1024*1024;
 const header=Buffer.alloc(44);
 header.write('RIFF',0);header.writeUInt32LE(bytes+36,4);
 header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);
 header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);
 header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(bytes,40);
 const file=await open(path,'w');
 try{await file.writeFile(header);await file.truncate(bytes+44)}
 finally{await file.close()}
 try{
  await page.addInitScript(()=>{
   const read=Blob.prototype.arrayBuffer;
   Blob.prototype.arrayBuffer=function(){
    if(this.size>16*1024*1024)throw new Error('Large audio must be read in bounded chunks');
    return read.call(this);
   };
  });
  await page.reload();
  await page.evaluate(()=>localStorage.setItem('iscribe-e2e:pauseAfterCalls','2'));
  await page.getByLabel('Выбрать аудиозаписи',{exact:true}).setInputFiles(path);
  await expect(row(page)).toContainText('потоковый режим');
  await row(page).getByRole('button',{name:'Начать',exact:true}).click();
  await expect.poll(async()=>(await snapshot(page))[0]?.nextWindow).toBe(1);
  const before=(await snapshot(page))[0];
  expect(before.duration).toBeGreaterThan(3600);
  await expect.poll(()=>page.evaluate(()=>Number(localStorage.getItem('iscribe-e2e:transcribeCount')))).toBe(2);
  await page.reload();
  await page.evaluate(()=>localStorage.setItem('iscribe-e2e:pauseAfterCalls','4'));
  await row(page).getByRole('button',{name:'Продолжить'}).click();
  await expect.poll(async()=>(await snapshot(page))[0]?.nextWindow).toBe(2);
  const after=(await snapshot(page))[0];
  expect(after.segments.map(item=>item.start)).toEqual([6,31]);
  expect(after.segments[0]).toEqual(before.segments[0]);
  await row(page).getByRole('button',{name:/Убрать из очереди/}).click();
  await page.getByRole('button',{name:'Отменить задачу'}).click();
  await expect(row(page).getByRole('button',{name:'Продолжить'})).toBeVisible();
 }finally{await rm(path,{force:true})}
});


test('FIFO rows move above waiting records, allow removal, and schedule speaker downloads',async({page})=>{
 await page.evaluate(()=>{
  localStorage.setItem('iscribe-e2e:speakerModelsMissing','1');
  localStorage.setItem('iscribe-e2e:pauseAt','2');
 });
 await page.reload();
 const records=['unused-60s.wav','remove-60s.wav','first-60s.wav','second-60s.wav'];
 await page.getByLabel('Выбрать аудиозаписи',{exact:true}).setInputFiles(records.map(name=>({
  name,mimeType:'audio/wav',buffer:Buffer.from([0x52,0x49,0x46,0x46])
 })));
 const file=name=>page.getByRole('article',{name,exact:true});
 const names=()=>row(page).evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')));
 const speakers=page.locator('.model.speakers');
 await file(records[2]).getByRole('button',{name:'Начать',exact:true}).click();
 await expect(file(records[2]).locator('.file-progress-metrics')).toContainText('2/3 (00:30 / 01:00)');
 await file(records[1]).getByRole('button',{name:'Начать',exact:true}).click();
 await file(records[3]).getByRole('button',{name:'Начать',exact:true}).click();
 expect(await names()).toEqual([records[2],records[1],records[3],records[0]]);
 await expect(file(records[2]).locator('.file-queue-status')).toContainText('Распознавание');
 await expect(file(records[1]).locator('.file-queue-number')).toHaveText('2');
 await expect(file(records[1]).locator('.file-queue-status')).toContainText('Ожидание очереди');
 await expect(file(records[3]).locator('.file-queue-number')).toHaveText('3');
 await file(records[1]).getByRole('button',{name:/Убрать из очереди/}).click();
 await expect(file(records[1])).toContainText('Убрано из очереди');
 await expect(file(records[3]).locator('.file-queue-number')).toHaveText('2');
 await expect.poll(async()=>(await snapshot(page)).find(j=>j.name===records[1])?.queueOrder??null).toBeNull();
 await speakers.getByRole('button',{name:'Скачать комплект'}).click();
 await expect(speakers.getByRole('button',{name:'После текущей записи'})).toBeDisabled();
 await page.evaluate(()=>localStorage.removeItem('iscribe-e2e:pauseAt'));
 await file(records[2]).getByRole('button',{name:/Убрать из очереди/}).click();
 await page.getByRole('button',{name:'Отменить задачу'}).click();
 await expect(speakers.getByRole('button',{name:'Скачано'})).toBeDisabled();
 await expect(file(records[3])).toContainText('Распознано');
 expect((await names()).at(-1)).toBe(records[3]);
 await expect(file(records[2]).getByRole('button',{name:'Скачать TXT',exact:true})).toBeEnabled();
 await expect(file(records[0]).getByRole('button',{name:/Удалить запись/})).toBeVisible();
 await page.reload();
 await expect(file(records[1]).getByRole('button',{name:'Начать',exact:true})).toBeVisible();
 await expect(file(records[3])).toContainText('Распознано');
});
