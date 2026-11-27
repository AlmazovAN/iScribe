import {test,expect} from '@playwright/test';

test('production application shell reloads offline with local job metadata',async({page,context})=>{
 await page.goto('/');
 await expect(page.getByRole('button',{name:'Выбрать файлы'})).toBeEnabled();
 const installed=await page.evaluate(async()=>{
  if(!('serviceWorker' in navigator))return false;
  const reg=await navigator.serviceWorker.ready;
  return !!reg.active;
 });
 expect(installed).toBe(true);
 const shell=await page.evaluate(async()=>{
  const worker=(await navigator.serviceWorker.ready).active;
  return await new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=e=>{channel.port1.close();resolve(e.data)};worker.postMessage({type:'iscribe:offline-probe'},[channel.port2]);});
 });
 expect(shell).toMatchObject({shellComplete:true,wasmCached:true});
 // The source is local and has no model inference or private transcript.
 await page.getByLabel('Выбрать аудиозаписи',{exact:true}).setInputFiles({
  name:'test-offline.wav',mimeType:'audio/wav',buffer:Buffer.from([0x52,0x49,0x46,0x46])
 });
 await expect(page.locator('.file-row')).toHaveCount(1);
 await page.reload();
 await context.setOffline(true);
 await page.reload();
 await expect(page.getByRole('button',{name:'Выбрать файлы'})).toBeEnabled();
 await expect(page.locator('.file-row')).toContainText('test-offline.wav');
 expect(await page.evaluate(()=>navigator.onLine)).toBe(false);
 await expect(page.locator('.diagnostics-panel details')).toHaveCount(0);
 await context.setOffline(false);
});

test('GPU-only cache does not reintroduce removed cache controls',async({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>{
  const repo='onnx-community/whisper-small',prefix=`https://huggingface.co/${repo}/resolve/main/`;
  const cache=await caches.open('transformers-cache');
  const files=['config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json','onnx/encoder_model_fp16.onnx','onnx/decoder_model_merged_q4.onnx'];
  for(const file of files)await cache.put(prefix+file,new Response('fixture'));
 });
 await page.reload();
 await expect(page.locator('.model-panel')).toContainText('Whisper Small');
 await expect(page.getByRole('button',{name:'Подготовить WASM'})).toHaveCount(0);
});
