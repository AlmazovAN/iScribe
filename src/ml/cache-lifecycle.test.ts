import {afterEach,expect,it,vi} from 'vitest';
import {recordWhisperCache,checkWhisperCache,checkSpeakerCache} from './cache';
afterEach(()=>vi.unstubAllGlobals());
function memoryCache(){
 const stores=new Map<string,Map<string,Response>>();
 const bucket=(name:string)=>{let value=stores.get(name);if(!value){value=new Map();stores.set(name,value)}return value};
 const key=(request:string|Request)=>typeof request==='string'?request:request.url;
 vi.stubGlobal('location',{href:'https://example.test/iScribe/'});
 vi.stubGlobal('caches',{open:async(name:string)=>({keys:async()=>[...bucket(name).keys()].map(url=>new Request(url)),match:async(request:string|Request)=>bucket(name).get(key(request))?.clone(),put:async(request:string|Request,response:Response)=>{bucket(name).set(key(request),response.clone())}})});
 return bucket('transformers-cache');
}
it('invalidates a previously confirmed Whisper manifest when a weight is evicted',async()=>{
 const cache=memoryCache();const repo='onnx-community/whisper-tiny';const prefix=`https://huggingface.co/${repo}/resolve/main/`;
 for(const file of ['config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json','onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx'])cache.set(prefix+file,new Response('cached'));
 expect(await recordWhisperCache(repo)).toBe(true);expect(await checkWhisperCache(repo)).toBe(true);
 cache.delete(prefix+'onnx/decoder_model_merged_quantized.onnx');expect(await checkWhisperCache(repo)).toBe(false);
});
it('requires config, processor and the exact speaker q8 weight, not a different dtype',async()=>{
 const cache=memoryCache();const repo='onnx-community/pyannote-segmentation-3.0';const prefix=`https://huggingface.co/${repo}/resolve/main/`;
 for(const file of ['config.json','preprocessor_config.json','onnx/model.onnx'])cache.set(prefix+file,new Response('cached'));
 expect(await checkSpeakerCache(repo)).toBe(false);cache.set(prefix+'onnx/model_quantized.onnx',new Response('q8'));expect(await checkSpeakerCache(repo)).toBe(true);
});
