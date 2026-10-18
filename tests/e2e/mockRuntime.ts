import {checkWhisperCache,recordWhisperCache} from '../../src/ml/cache';
import {repos,type WhisperId} from '../../src/ml/manager';
import type {TranscriptSegment,SpeakerTurn} from '@yourdevice/engine';

const SAMPLE_RATE=16000;
const STRIDE=25*SAMPLE_RATE;
const CACHE='transformers-cache';
const MODEL_FILES=[
 'config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json',
 'onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx'
];
const key=(name:string)=>'iscribe-e2e:'+name;
const enabled=(name:string)=>localStorage.getItem(key(name))==='1';

export async function fixtureDecode(file:File,_signal?:AbortSignal):Promise<Float32Array>{
 const seconds=Number(file.name.match(/-(\d+)s\./)?.[1]??60);
 if(!Number.isInteger(seconds)||seconds<1||seconds>3600)throw new Error('Invalid fixture length');
 const pcm=new Float32Array(seconds*SAMPLE_RATE);
 // Mark each 25s boundary so model call identities survive page reloads.
 // We do not create or ship a genuine 14m31s recording.
 for(let i=0;i<pcm.length;i+=STRIDE)pcm[i]=Math.floor(i/STRIDE)+1;
 return pcm;
}
export class FixtureManager{
 active:WhisperId|null=null;
 onWhisperProgress:(_id:WhisperId,_p:{phase:string})=>void=()=>{};
 onSpeakerProgress:(_id:'segmentation'|'embedding',_p:string)=>void=()=>{};
 onProgress:(_text:string,_percent:number|null)=>void=()=>{};
 async cached(id:WhisperId){return checkWhisperCache(repos[id])}
 async speakersCached(){return {segmentation:true,embedding:true}}
 async preloadSpeakers(){return this.speakersCached()}
 async prepare(id:WhisperId){
  if(this.active===id)return {cached:await this.cached(id),backend:'wasm'};
  this.onWhisperProgress(id,{phase:'loading'});
  const cache=await caches.open(CACHE),prefix=`https://huggingface.co/${repos[id]}/resolve/main/`;
  for(const path of MODEL_FILES)await cache.put(prefix+path,new Response('Synthetic test fixture — no actual model weights'));
  const cached=await recordWhisperCache(repos[id]);
  this.active=id;this.onWhisperProgress(id,{phase:'ready'});
  return {cached,backend:'wasm'};
 }
 async transcribe(audio:Float32Array,_diarize:boolean,_partial:(x:TranscriptSegment[])=>void,_language:'ru'|'en'){
  const windowNumber=Math.round(audio[0]);
  const count=Number(localStorage.getItem(key('transcribeCount'))??0);
  localStorage.setItem(key('transcribeCount'),String(count+1));
  this.onProgress('Распознано 2 / 30 с',7);
  if(Number(localStorage.getItem(key('pauseAt'))??0)===windowNumber)
   return new Promise<TranscriptSegment[]>(()=>{});
  await new Promise<void>(resolve=>setTimeout(resolve,70));
  return [{start:6,end:8,text:`Окно ${windowNumber}`}];
 }
 async diarize(audio:Float32Array):Promise<SpeakerTurn[]>{
  if(enabled('failSpeakers'))throw new Error('Synthetic diarization failure');
  return [{start:0,end:audio.length/SAMPLE_RATE,speaker:'Fixture Speaker'}];
 }
 async recover(id:WhisperId,_wasmOnly:boolean){
  return this.prepare(id);
 }
 cancel(){this.active=null}
}
