import {test,expect} from '@playwright/test';

const openCache=async page=>{
 await page.locator('.diagnostics-panel > summary').click();
 await page.locator('.diagnostics-cache > summary').click();
};

test('production application shell reloads offline with local job metadata',async({page,context})=>{
 await page.goto('/');
 await expect(page.getByRole('button',{name:'Выбрать файлы'})).toBeEnabled();
 const installed=await page.evaluate(async()=>{
  if(!('serviceWorker' in navigator))return false;
  const reg=await navigator.serviceWorker.ready;
  return !!reg.active;
 });
 expect(installed).toBe(true);
 await openCache(page);
 await expect(page.locator('.offline-strip')).toContainText('Приложение: сохранено');
 await expect(page.locator('.offline-strip')).toContainText('ONNX/WASM: сохранён');
 // The source is local and has no model inference or private transcript.
 await page.locator('input[type=file]').setInputFiles({
  name:'test-offline.wav',mimeType:'audio/wav',buffer:Buffer.from([0x52,0x49,0x46,0x46])
 });
 await expect(page.locator('.file-row')).toHaveCount(1);
 await page.reload();
 await context.setOffline(true);
 await page.reload();
 await expect(page.getByRole('button',{name:'Выбрать файлы'})).toBeEnabled();
 await expect(page.locator('.file-row')).toContainText('test-offline.wav');
 await openCache(page);
 await expect(page.locator('.offline-strip')).toContainText('Сеть: отключена');
 await expect(page.locator('.offline-strip')).toContainText('Приложение: сохранено');
 await expect(page.locator('.offline-strip')).toContainText('Профиль WASM q8: не найден');
 await context.setOffline(false);
});

test('GPU-only cache does not falsely confirm offline WASM fallback readiness',async({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>{
  const repo='onnx-community/whisper-small',prefix=`https://huggingface.co/${repo}/resolve/main/`;
  const cache=await caches.open('transformers-cache');
  const files=['config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json','onnx/encoder_model_fp16.onnx','onnx/decoder_model_merged_q4.onnx'];
  for(const file of files)await cache.put(prefix+file,new Response('fixture'));
 });
 await openCache(page);
 await page.getByRole('button',{name:'Проверить кэш'}).click();
 await expect(page.locator('.offline-strip')).toContainText('Модель: в кэше');
 await expect(page.locator('.offline-strip')).toContainText('Профиль WASM q8: не найден');
 await expect(page.locator('.offline-strip')).toContainText('Не все файлы доступны');
});
