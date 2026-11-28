// PIPE-07: independent advisory speech map, in original 16 kHz sample units.
export const SILERO_REVISION='6478567951ae5c9979ad7b234185b5515f4be7a1';
export const SILERO_BLOB='b3e3a900c0d70e67b5e2b90a33ad856ee7947930';
export const VAD_CONTRACT='silero-v5.1.2-16k-512-ctx64-state256-hysteresis035-020-gap8-pad4000-v1';
export const VAD_FRAME=512;
export const VAD_CONTEXT=64;
export const VAD_BLOCK=30*16000; // transfer limit, not a recurrent-state reset
export const VAD_MAX_SAMPLES=3600*16000;
export type SpeechInterval={start:number;end:number};
export type VadReport={revision:1;samples:number;frames:number;speechSamples:number;intervals:SpeechInterval[]};
export type VadScore={probability:number;state:Float32Array};
export type VadInference=(input:Float32Array,state:Float32Array)=>Promise<VadScore>;

export class VadAccumulator{
 private cursor=0;
 private frames=0;
 private state=new Float32Array(256);
 private context=new Float32Array(VAD_CONTEXT);
 private pending=new Float32Array(VAD_FRAME);
 private pendingCount=0;
 private start:number|null=null;
 private quiet=0;
 private intervals:SpeechInterval[]=[];
 private finished=false;
 constructor(readonly samples:number){
  if(!Number.isSafeInteger(samples)||samples<1||samples>VAD_MAX_SAMPLES)throw new Error('Некорректная длина VAD.');
 }
 private async frame(valid:number,infer:VadInference){
  const input=new Float32Array(VAD_FRAME+VAD_CONTEXT);
  input.set(this.context);input.set(this.pending,VAD_CONTEXT);
  const next=await infer(input,this.state);
  if(!Number.isFinite(next.probability)||next.probability<0||next.probability>1||!(next.state instanceof Float32Array)||next.state.length!==256||!next.state.every(Number.isFinite))throw new Error('Некорректный результат VAD.');
  this.state.set(next.state);this.context.set(input.subarray(VAD_FRAME));
  const position=this.cursor;this.cursor+=valid;this.frames++;
  if(this.start===null){
   if(next.probability>=0.35){this.start=position;this.quiet=0}
  }else if(next.probability<0.20){
   this.quiet++;
   if(this.quiet>=8){
    this.intervals.push({start:this.start,end:Math.max(this.start+1,position-(this.quiet-1)*VAD_FRAME)});
    this.start=null;this.quiet=0;
   }
  }else this.quiet=0;
  this.pending.fill(0);this.pendingCount=0;
 }
 async push(block:Float32Array,infer:VadInference,onProgress?:()=>void){
  if(this.finished||!(block instanceof Float32Array)||block.length<1||block.length>VAD_BLOCK||this.cursor+this.pendingCount+block.length>this.samples||!block.every(Number.isFinite))throw new Error('Некорректный блок VAD.');
  for(let offset=0;offset<block.length;){
   const count=Math.min(VAD_FRAME-this.pendingCount,block.length-offset);
   this.pending.set(block.subarray(offset,offset+count),this.pendingCount);
   this.pendingCount+=count;offset+=count;
   if(this.pendingCount===VAD_FRAME){await this.frame(VAD_FRAME,infer);if(this.frames%32===0)onProgress?.()}
  }
 }
 async finish(infer:VadInference):Promise<VadReport>{
  if(this.finished||this.cursor+this.pendingCount!==this.samples)throw new Error('Неполное покрытие VAD.');
  this.finished=true;
  if(this.pendingCount)await this.frame(this.pendingCount,infer);
  if(this.start!==null)this.intervals.push({start:this.start,end:this.samples});
  // Conservative padding, retain even short utterances, merge only touching
  // padded ranges. No physical trimming and no timeline compression.
  const intervals:SpeechInterval[]=[];
  for(const raw of this.intervals){
   const x={start:Math.max(0,raw.start-4000),end:Math.min(this.samples,raw.end+4000)};
   const last=intervals.at(-1);
   if(last&&x.start<=last.end)last.end=Math.max(last.end,x.end);else intervals.push(x);
  }
  return {revision:1,samples:this.samples,frames:this.frames,speechSamples:intervals.reduce((n,x)=>n+x.end-x.start,0),intervals};
 }
}
export function validateVadReport(value:unknown,samples:number):value is VadReport{
 if(!value||typeof value!=='object'||!Number.isSafeInteger(samples)||samples<1||samples>VAD_MAX_SAMPLES)return false;
 const r=value as VadReport;
 if(r.revision!==1||r.samples!==samples||r.frames!==Math.ceil(samples/VAD_FRAME)||!Array.isArray(r.intervals)||r.intervals.length>r.frames)return false;
 let last=-1,sum=0;
 for(const x of r.intervals){
  if(!x||!Number.isSafeInteger(x.start)||!Number.isSafeInteger(x.end)||x.start<0||x.start<=last||x.end<=x.start||x.end>samples)return false;
  last=x.end;sum+=x.end-x.start;
 }
 return r.speechSamples===sum;
}
