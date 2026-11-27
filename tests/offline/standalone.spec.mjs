import {expect,test} from '@playwright/test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('standalone HTML opens from disk and its embedded worker reaches model loading',async({page,context})=>{
 const localUrl=pathToFileURL(resolve('dist/iScribe.html')).href;
 const otherFiles=[];
 context.on('request',request=>{
  const url=request.url();
  if(url.startsWith('file:')&&url!==localUrl)otherFiles.push(url);
 });
 // Exercise real Worker startup without downloading weights or private audio.
 await context.route('https://huggingface.co/**',route=>{
  const file=new URL(route.request().url()).pathname.split('/').at(-1);
  const headers={'access-control-allow-origin':'*'};
  if(file.endsWith('.onnx'))return route.fulfill({body:Buffer.from('invalid ONNX test data'),headers});
  const json={
   'config.json':{model_type:'whisper',is_encoder_decoder:true},
   'tokenizer.json':{
    added_tokens:[],normalizer:{type:'NFC'},pre_tokenizer:{type:'ByteLevel'},
    post_processor:{type:'ByteLevel'},decoder:{type:'Fuse'},
    model:{type:'WordLevel',vocab:{'[UNK]':0},unk_token:'[UNK]'}
   },
   'tokenizer_config.json':{tokenizer_class:'WhisperTokenizer',unk_token:'[UNK]'},
   'preprocessor_config.json':{feature_extractor_type:'WhisperFeatureExtractor',feature_size:80,sampling_rate:16000,hop_length:160,n_fft:400,chunk_length:30,n_samples:480000,nb_max_frames:3000}
  }[file];
  return route.fulfill(json?{json,headers}:{status:404,headers});
 });
 await page.goto(localUrl);
 await expect(page.getByRole('heading',{name:'Модель распознавания'})).toBeVisible();
 const runtime=await page.evaluate(async()=>{
  const assets=globalThis.__iscribeAssets;
  const wasm=Object.keys(assets).find(name=>name.endsWith('.wasm'));
  const module=await WebAssembly.compileStreaming(fetch(assets[wasm]));
  const notices=await (await fetch(assets.notices)).text();
  return {exports:WebAssembly.Module.exports(module).length,notices:notices.trim().length};
 });
 expect(runtime.exports).toBeGreaterThan(0);
 expect(runtime.notices).toBeGreaterThan(0);
 const request=context.waitForEvent('request',{
  predicate:request=>request.url().startsWith('https://huggingface.co/onnx-community/'),
  timeout:20000
 });
 await page.locator('.model').filter({hasText:'Whisper Small'}).getByRole('button').click();
 await request;
 const error=page.getByRole('alert');
 await expect(error).toBeVisible({timeout:25000});
 await expect(error).toHaveText(/protobuf parsing failed|invalid protobuf/i,{timeout:1000});
 expect(otherFiles).toEqual([]);
});
