import {afterEach,expect,it,vi} from 'vitest';
import {offlineModelFetch} from './runtimeFetch';
import {selectWhisperCache} from './cache';
afterEach(()=>vi.unstubAllGlobals());
const uri='https://huggingface.co/onnx-community/whisper-small/resolve/main/config.json';
it('uses the exact completed cached response with no network when the browser is offline',async()=>{
 const original=vi.fn(async()=>{throw new Error('unexpected network access')});
 vi.stubGlobal('navigator',{onLine:false});
 vi.stubGlobal('caches',{open:async(name:string)=>{
  expect(name).toBe('transformers-cache');
  return {match:async(key:string)=>key===uri?new Response('{"model":"local"}'):undefined};
 }});
 const response=await offlineModelFetch(original)(uri);
 expect(await response.json()).toEqual({model:'local'});
 expect(original).not.toHaveBeenCalled();
});
it('fails without pretending to have missing model weights available offline',async()=>{
 const original=vi.fn(async()=>new Response('should never reach network'));
 vi.stubGlobal('navigator',{onLine:false});
 vi.stubGlobal('caches',{open:async()=>({match:async()=>undefined})});
 await expect(offlineModelFetch(original)(uri)).rejects.toThrow('Нет сети');
 expect(original).not.toHaveBeenCalled();
});
it('never manufactures a byte-range response from a cached whole-file model',async()=>{
 const original=vi.fn(async()=>new Response('range response',{status:206}));
 vi.stubGlobal('navigator',{onLine:false});
 vi.stubGlobal('caches',{open:async()=>({match:async()=>new Response('whole file')})});
 const result=await offlineModelFetch(original)(uri,{headers:{Range:'bytes=0-9'}});
 expect(result.status).toBe(206);
 expect(original).toHaveBeenCalledTimes(1);
});
it('retries exact cached URL if an online model request failed but does not mask other hosts',async()=>{
 const original=vi.fn(async()=>{throw new Error('network failed')});
 vi.stubGlobal('navigator',{onLine:true});
 vi.stubGlobal('caches',{open:async()=>({match:async(key:string)=>key===uri?new Response('cached'):undefined})});
 expect(await (await offlineModelFetch(original)(uri)).text()).toBe('cached');
 await expect(offlineModelFetch(original)('https://untrusted.example/data')).rejects.toThrow('network failed');
});
it('cannot claim a WASM fallback from GPU-only cached weights',()=>{
 const repo='onnx-community/whisper-small',prefix=`https://huggingface.co/${repo}/resolve/main/`;
 const base=['config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json'];
 const gpu=[...base,'onnx/encoder_model_fp16.onnx','onnx/decoder_model_merged_q4.onnx'].map(s=>prefix+s);
 expect(selectWhisperCache(gpu,repo).cached).toBe(true);
 expect(selectWhisperCache(gpu,repo,'wasm-q8').cached).toBe(false);
 const wasm=[...base,'onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx'].map(s=>prefix+s);
 expect(selectWhisperCache(wasm,repo,'wasm-q8')).toMatchObject({cached:true,profile:'wasm-q8'});
});
