import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

const HARNESS='/tests/e2e/harness.html';
const row=page=>page.locator('.file-row');
const small=page=>page.locator('.model-panel .model').nth(1);
const add=async(page,name)=>{
 await page.locator('input[type="file"]').setInputFiles({
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
const downloadText=async(page,label)=>{
 const [download]=await Promise.all([
  page.waitForEvent('download'),
  row(page).getByRole('button',{name:label,exact:true}).click()
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

test('14m31s: committed windows survive refresh; resume once; all three real TXT downloads',async({page})=>{
 await page.evaluate(()=>localStorage.setItem('iscribe-e2e:pauseAt','3'));
 await loadFixture(page);
 await add(page,'meeting-871s.wav');
 await row(page).getByRole('button',{name:'Начать',exact:true}).click();
 await expect(row(page)).toContainText('окон 2/35');
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
