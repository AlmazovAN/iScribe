import {AutoModelForCTC,AutoProcessor,env} from '@huggingface/transformers';
import {ALIGNMENT_MODELS,ALIGNMENT_MAX_SAMPLES,buildTarget,alignTarget,type AlignmentLanguage,type WordSpan} from './forcedAlignment';

type Model=Awaited<ReturnType<typeof AutoModelForCTC.from_pretrained>>;
type Processor=Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
async function loadVocab(language:AlignmentLanguage):Promise<Record<string,number>>{
 const m=ALIGNMENT_MODELS[language];
 const response=await env.fetch('https://huggingface.co/'+m.repo+'/resolve/'+m.revision+'/vocab.json');
 if(!response.ok)throw new Error('Alignment vocabulary unavailable');
 const value:unknown=await response.json();
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid alignment vocabulary');
 const entries=Object.entries(value);
 if(entries.length!==m.vocabSize||entries.some(([,id])=>!Number.isInteger(id)||id<0||id>=m.vocabSize)||new Set(entries.map(([,id])=>id)).size!==entries.length)throw new Error('Invalid alignment vocabulary');
 const vocab=Object.fromEntries(entries) as Record<string,number>;
 if(vocab['<pad>']!==0||vocab['|']!==4)throw new Error('Invalid CTC labels');
 return vocab;
}
export class Wav2VecAlignment{
 private constructor(private readonly language:AlignmentLanguage,private readonly model:Model,private readonly processor:Processor,private readonly vocab:Record<string,number>){}
 static async create(language:AlignmentLanguage,progress:()=>void){
  const m=ALIGNMENT_MODELS[language],vocab=await loadVocab(language);
  const processor=await AutoProcessor.from_pretrained(m.repo,{revision:m.revision,progress_callback:progress});
  const model=await AutoModelForCTC.from_pretrained(m.repo,{revision:m.revision,device:'wasm',dtype:'q8',progress_callback:progress});
  return new Wav2VecAlignment(language,model,processor,vocab);
 }
 async align(pcm:Float32Array,text:string,startSample:number):Promise<WordSpan[]|null>{
  if(!(pcm instanceof Float32Array)||pcm.length>ALIGNMENT_MAX_SAMPLES||pcm.length<400||!pcm.every(Number.isFinite)||!Number.isSafeInteger(startSample)||startSample<0)return null;
  const target=buildTarget(text,this.language,this.vocab);if(!target)return null;
  // Do not ask a forced path to match digital silence.
  if(pcm.every(x=>Math.abs(x)<0.00001))return null;
  const input=await this.processor(pcm);
  let output:unknown;
  try{
   output=await this.model(input);
   if(!output||typeof output!=='object'||!('logits' in output))throw new Error('Unexpected CTC output');
   const logits=output.logits as {dims?:unknown;data?:unknown}|null;
   if(!logits||!Array.isArray(logits.dims)||logits.dims.length!==3||logits.dims[0]!==1||logits.dims[2]!==ALIGNMENT_MODELS[this.language].vocabSize||!(logits.data instanceof Float32Array))throw new Error('Unexpected CTC tensor shape');
   return alignTarget(logits.data,logits.dims[1],logits.dims[2],target,{start:startSample,end:startSample+pcm.length});
  }finally{
   // Processor/model outputs may include non-tensor fields. Only release tensors.
   const seen=new Set<object>();
   for(const value of [...Object.values(input),...Object.values(output&&typeof output==='object'?output:{})]){
    if(value&&typeof value==='object'&&!seen.has(value)&&'dispose' in value&&typeof value.dispose==='function'){seen.add(value);value.dispose()}
   }
  }
 }
 async release(){await this.model.dispose()}
}
