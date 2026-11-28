import {InferenceSession,Tensor,env as ortEnv} from 'onnxruntime-web/webgpu';
import {SILERO_REVISION,SILERO_BLOB,VadAccumulator,type VadInference,type VadReport} from './vad';

const MODEL_URL='https://raw.githubusercontent.com/snakers4/silero-vad/'+SILERO_REVISION+'/src/silero_vad/data/silero_vad.onnx';
const MAX_MODEL_BYTES=8*1024*1024;
const CACHE='iscribe-vad-model-v1';
async function readBounded(response:Response):Promise<Uint8Array<ArrayBuffer>>{
 if(!response.ok||!response.body)throw new Error('Silero model unavailable');
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let total=0;
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   total+=value.byteLength;if(total>MAX_MODEL_BYTES){await reader.cancel();throw new Error('Silero model too large')}
   parts.push(value);
  }
 }finally{reader.releaseLock()}
 if(!total)throw new Error('Empty Silero model');
 const bytes=new Uint8Array(total);let offset=0;
 for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}
 return bytes;
}
async function verifyBlob(bytes:Uint8Array<ArrayBuffer>){
 // Git object identity, not a cryptographic security guarantee. Pin both
 // the upstream commit and its actual Git blob; never load a moving branch.
 const header=new TextEncoder().encode('blob '+bytes.byteLength+'\0'),input=new Uint8Array(header.length+bytes.byteLength);
 input.set(header);input.set(bytes,header.length);
 const hash=await crypto.subtle.digest('SHA-1',input);
 const hex=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
 if(hex!==SILERO_BLOB)throw new Error('Silero model identity mismatch');
}
async function loadModel():Promise<Uint8Array<ArrayBuffer>>{
 let cache:Cache|undefined;
 try{if(typeof caches!=='undefined')cache=await caches.open(CACHE)}catch{/* Cache optional, including file://. */}
 let hit:Response|undefined;
 try{hit=await cache?.match(MODEL_URL)}catch{/* Cache lookup unavailable. */}
 if(hit){const bytes=await readBounded(hit);await verifyBlob(bytes);return bytes}
 // Only public model weights are fetched. Audio never enters this request.
 const response=await fetch(MODEL_URL,{credentials:'omit',referrerPolicy:'no-referrer'});
 const bytes=await readBounded(response);await verifyBlob(bytes);
 try{await cache?.put(MODEL_URL,new Response(bytes,{headers:{'Content-Type':'application/octet-stream'}}))}catch{/* Verified current bytes remain usable. */}
 return bytes;
}
export class SileroPass{
 private constructor(private readonly session:InferenceSession,private readonly accumulator:VadAccumulator){}
 static async create(samples:number,prepareRuntime:()=>Promise<void>){
  const accumulator=new VadAccumulator(samples);
  await prepareRuntime();
  ortEnv.wasm.numThreads=1;
  ortEnv.wasm.proxy=false;
  const bytes=await loadModel();
  const session=await InferenceSession.create(bytes,{executionProviders:['wasm']});
  return new SileroPass(session,accumulator);
 }
 private readonly infer:VadInference=async(input,state)=>{
  const x=new Tensor('float32',input,[1,576]),s=new Tensor('float32',state,[2,1,128]),sr=new Tensor('int64',BigInt64Array.of(16000n),[]);
  let result:Awaited<ReturnType<InferenceSession['run']>>|undefined;
  try{
   result=await this.session.run({input:x,state:s,sr});
   const output=result.output?.data,next=result.stateN?.data;
   if(!(output instanceof Float32Array)||output.length!==1||!(next instanceof Float32Array)||next.length!==256)throw new Error('Silero output shape mismatch');
   return {probability:output[0],state:next.slice()};
  }finally{
   x.dispose();s.dispose();sr.dispose();
   if(result)for(const tensor of Object.values(result))tensor.dispose();
  }
 };
 async push(pcm:Float32Array,progress:()=>void){await this.accumulator.push(pcm,this.infer,progress)}
 async finish():Promise<VadReport>{return this.accumulator.finish(this.infer)}
 async release(){await this.session.release()}
}
