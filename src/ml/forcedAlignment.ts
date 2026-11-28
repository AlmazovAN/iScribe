// Bounded CTC Viterbi alignment. The text is a fixed target, never decoded anew.
export const ALIGNMENT_CONTRACT='ctc-v1-q8-stride320-min035-word-offsets';
export const ALIGNMENT_MODELS={
 ru:{repo:'onnx-community/wav2vec2-large-xlsr-53-russian-ONNX',revision:'df5ba1d9e0f9a34c44eec437b441f4ae43c842eb',vocabSize:39},
 en:{repo:'onnx-community/wav2vec2-base-960h-ONNX',revision:'729c1a6730fb549c20a1c73a3d3f96f11020225e',vocabSize:32}
} as const;
export type AlignmentLanguage=keyof typeof ALIGNMENT_MODELS;
export const ALIGNMENT_RATE=16000,ALIGNMENT_STRIDE=320,ALIGNMENT_RECEPTIVE=400,ALIGNMENT_MAX_SAMPLES=480000;
export const ALIGNMENT_MAX_SEGMENTS=10000,ALIGNMENT_MAX_TOKENS=512;
export type AlignmentSegment={start:number;end:number;text:string};
export type WordSpan={from:number;to:number;startSample:number;endSample:number;score:number};
export type AlignmentRow={index:number;words:WordSpan[]};
export type AlignmentReport={revision:1;contract:typeof ALIGNMENT_CONTRACT;language:AlignmentLanguage;samples:number;segmentCount:number;rows:AlignmentRow[]};
export type AlignmentTarget={ids:number[];words:{from:number;to:number;first:number;last:number}[]};
export function modelKey(language:AlignmentLanguage){
 const m=ALIGNMENT_MODELS[language];return m.repo+'@'+m.revision+':q8';
}
export function segmentCrop(segment:AlignmentSegment,samples:number):{start:number;end:number}|null{
 if(!segment||typeof segment.text!=='string'||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.end<=segment.start)return null;
 // Stay inside the original ASR interval. Never invent a neighboring utterance.
 const start=Math.min(samples,Math.max(0,Math.ceil(segment.start*ALIGNMENT_RATE))),end=Math.min(samples,Math.floor(segment.end*ALIGNMENT_RATE));
 return end-start>=ALIGNMENT_RECEPTIVE&&end-start<=ALIGNMENT_MAX_SAMPLES?{start,end}:null;
}
export function buildTarget(text:string,language:AlignmentLanguage,vocab:Readonly<Record<string,number>>):AlignmentTarget|null{
 if(typeof text!=='string'||text.length>4096||vocab['<pad>']!==0||vocab['|']!==4)return null;
 const ids:number[]=[],words:AlignmentTarget['words']=[];
 for(const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu)){
  const from=m.index!,to=from+m[0].length;
  const normalized=(language==='ru'?m[0].toLowerCase():m[0].toUpperCase()).normalize('NFC').replaceAll('’',"'");
  if(words.length)ids.push(4);
  const first=ids.length;
  for(const char of normalized){
   const id=vocab[char];
   if(!Number.isInteger(id)||id<5||id>=ALIGNMENT_MODELS[language].vocabSize)return null;
   ids.push(id);if(ids.length>ALIGNMENT_MAX_TOKENS)return null;
  }
  words.push({from,to,first,last:ids.length-1});
 }
 return ids.length?{ids,words}:null;
}
export type TokenSpan={first:number;last:number;score:number};
export function ctcAlign(logits:Float32Array,frames:number,classes:number,ids:readonly number[],blank=0):TokenSpan[]|null{
 if(!(logits instanceof Float32Array)||!Number.isInteger(frames)||frames<1||frames>1500||!Number.isInteger(classes)||classes<2||classes>128||
  logits.length!==frames*classes||!ids.length||ids.length>ALIGNMENT_MAX_TOKENS||ids.some(x=>!Number.isInteger(x)||x<0||x>=classes||x===blank)||
  !Number.isInteger(blank)||blank<0||blank>=classes)return null;
 let needed=ids.length;for(let i=1;i<ids.length;i++)if(ids[i]===ids[i-1])needed++;
 if(needed>frames)return null;
 const states=ids.length*2+1,labels=Array.from({length:states},(_,i)=>i%2?ids[(i-1)/2]:blank);
 const back=new Uint8Array(frames*states),norm=new Float64Array(frames);
 let prev=new Float64Array(states),next=new Float64Array(states);prev.fill(-Infinity);
 for(let t=0;t<frames;t++){
  const base=t*classes;let max=-Infinity,sum=0;
  for(let k=0;k<classes;k++){const x=logits[base+k];if(!Number.isFinite(x))return null;max=Math.max(max,x)}
  for(let k=0;k<classes;k++)sum+=Math.exp(logits[base+k]-max);
  norm[t]=max+Math.log(sum);
  next.fill(-Infinity);
  for(let s=0;s<states;s++){
   const emission=logits[base+labels[s]]-norm[t];
   if(t===0){if(s<=1)next[s]=emission;continue}
   let best=prev[s],step=0;
   if(s>0&&prev[s-1]>best){best=prev[s-1];step=1}
   if(s>1&&s%2===1&&labels[s]!==labels[s-2]&&prev[s-2]>best){best=prev[s-2];step=2}
   next[s]=best+emission;back[t*states+s]=step;
  }
  [prev,next]=[next,prev];
 }
 let state=prev[states-1]>=prev[states-2]?states-1:states-2;
 if(!Number.isFinite(prev[state]))return null;
 const spans=ids.map(()=>({first:frames,last:-1,score:0})),counts=new Uint16Array(ids.length);
 for(let t=frames-1;t>=0;t--){
  if(state%2){const i=(state-1)/2,span=spans[i];span.first=Math.min(span.first,t);span.last=Math.max(span.last,t);span.score+=Math.exp(logits[t*classes+ids[i]]-norm[t]);counts[i]++}
  if(t>0)state-=back[t*states+state];
 }
 if(state>1||spans.some((s,i)=>!counts[i]||s.last<s.first))return null;
 return spans.map((s,i)=>({...s,score:s.score/counts[i]}));
}
export function alignTarget(logits:Float32Array,frames:number,classes:number,target:AlignmentTarget,crop:{start:number;end:number}):WordSpan[]|null{
 const expected=Math.floor((crop.end-crop.start-ALIGNMENT_RECEPTIVE)/ALIGNMENT_STRIDE)+1;
 if(expected!==frames)return null;
 const spans=ctcAlign(logits,frames,classes,target.ids);
 if(!spans)return null;
 const words:WordSpan[]=[];
 for(const word of target.words){
  const part=spans.slice(word.first,word.last+1);
  if(!part.length||part.some(p=>p.score<0.10))return null;
  const score=part.reduce((n,p)=>n+p.score,0)/part.length;
  if(score<0.35)return null;
  words.push({from:word.from,to:word.to,startSample:crop.start+part[0].first*ALIGNMENT_STRIDE,
   endSample:Math.min(crop.end,crop.start+(part.at(-1)!.last+1)*ALIGNMENT_STRIDE),score});
 }
 return words;
}
export function validateAlignmentReport(value:unknown,segments:readonly AlignmentSegment[],samples:number,language:AlignmentLanguage):value is AlignmentReport{
 if(!value||typeof value!=='object'||!Number.isSafeInteger(samples)||samples<1||samples>3600*ALIGNMENT_RATE||segments.length>ALIGNMENT_MAX_SEGMENTS)return false;
 const r=value as AlignmentReport;
 if(r.revision!==1||r.contract!==ALIGNMENT_CONTRACT||r.language!==language||r.samples!==samples||r.segmentCount!==segments.length||!Array.isArray(r.rows)||r.rows.length>segments.length)return false;
 let lastIndex=-1,totalWords=0;
 for(const row of r.rows){
  if(!row||!Number.isSafeInteger(row.index)||row.index<=lastIndex||row.index>=segments.length||!Array.isArray(row.words)||!row.words.length||row.words.length>ALIGNMENT_MAX_TOKENS)return false;
  totalWords+=row.words.length;if(totalWords>50512)return false;
  lastIndex=row.index;const s=segments[row.index],crop=segmentCrop(s,samples);
  if(!crop)return false;
  const matches=[...s.text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu)];
  if(matches.length!==row.words.length)return false;
  let end=crop.start;
  for(let i=0;i<row.words.length;i++){
   const w=row.words[i],m=matches[i];
   if(!w||w.from!==m.index||w.to!==m.index!+m[0].length||!Number.isSafeInteger(w.startSample)||!Number.isSafeInteger(w.endSample)||
    w.startSample<end||w.endSample<=w.startSample||w.endSample>crop.end||!Number.isFinite(w.score)||w.score<0.35||w.score>1)return false;
   end=w.endSample;
  }
 }
 return true;
}
export function alignmentSummary(r:AlignmentReport){
 return {alignedSegments:r.rows.length,unalignedSegments:r.segmentCount-r.rows.length,alignedWords:r.rows.reduce((n,x)=>n+x.words.length,0)};
}

export type AlignmentCheckpoint={revision:1;contract:typeof ALIGNMENT_CONTRACT;language:AlignmentLanguage;samples:number;segmentCount:number;decoderProfile:string;pcmFingerprint:string;transcriptFingerprint:string;alignedSegments:number;alignedWords:number};
const HEX=/^[0-9a-f]{64}$/;
export function validateAlignmentCheckpoint(value:unknown):value is AlignmentCheckpoint{
 if(!value||typeof value!=='object')return false;
 const a=value as AlignmentCheckpoint;
 return a.revision===1&&a.contract===ALIGNMENT_CONTRACT&&(a.language==='ru'||a.language==='en')&&
 Number.isSafeInteger(a.samples)&&a.samples>0&&a.samples<=3600*ALIGNMENT_RATE&&Number.isSafeInteger(a.segmentCount)&&a.segmentCount>=0&&a.segmentCount<=ALIGNMENT_MAX_SEGMENTS&&
 typeof a.decoderProfile==='string'&&a.decoderProfile.length>0&&a.decoderProfile.length<=512&&typeof a.pcmFingerprint==='string'&&HEX.test(a.pcmFingerprint)&&typeof a.transcriptFingerprint==='string'&&HEX.test(a.transcriptFingerprint)&&
 Number.isSafeInteger(a.alignedSegments)&&a.alignedSegments>=0&&a.alignedSegments<=a.segmentCount&&Number.isSafeInteger(a.alignedWords)&&a.alignedWords>=a.alignedSegments&&a.alignedWords<=50512&&(!a.alignedSegments?a.alignedWords===0:true);
}
export function alignmentInputs(a:Pick<AlignmentCheckpoint,'language'|'samples'|'decoderProfile'|'pcmFingerprint'|'transcriptFingerprint'>):readonly unknown[]{
 return [ALIGNMENT_CONTRACT,modelKey(a.language),a.samples,a.decoderProfile,a.pcmFingerprint,a.transcriptFingerprint];
}
export function alignmentMatches(checkpoint:AlignmentCheckpoint,report:AlignmentReport):boolean{
 const s=alignmentSummary(report);
 return checkpoint.language===report.language&&checkpoint.samples===report.samples&&checkpoint.segmentCount===report.segmentCount&&checkpoint.alignedSegments===s.alignedSegments&&checkpoint.alignedWords===s.alignedWords;
}
type Owner={alignmentCheckpoint?:AlignmentCheckpoint;asrComplete:boolean;duration?:number;params:{language:AlignmentLanguage};sourceFingerprint?:string};
export function assertAlignmentForward(old:Owner|undefined,next:Owner,segments:number):void{
 const a=next.alignmentCheckpoint;
 if(a!==undefined&&(!validateAlignmentCheckpoint(a)||!next.asrComplete||!next.sourceFingerprint||a.language!==next.params.language||a.samples!==Math.round((next.duration??0)*ALIGNMENT_RATE)||a.segmentCount!==segments))throw new Error('Некорректная контрольная точка выравнивания.');
 if(old?.alignmentCheckpoint!==undefined&&JSON.stringify(old.alignmentCheckpoint)!==JSON.stringify(a))throw new Error('Нельзя изменить сохранённое выравнивание.');
}
export function alignmentExport(report:AlignmentReport,segments:readonly AlignmentSegment[]){
 if(!validateAlignmentReport(report,segments,report.samples,report.language))throw new Error('Некорректные данные выравнивания.');
 const byIndex=new Map(report.rows.map(r=>[r.index,r.words]));
 return {schema:'iscribe.word-alignment.v1',experimental:true,model:modelKey(report.language),language:report.language,...alignmentSummary(report),segments:segments.map((s,index)=>({
  index,text:s.text,originalStart:s.start,originalEnd:s.end,aligned:byIndex.has(index),
  words:(byIndex.get(index)??[]).map(w=>({text:s.text.slice(w.from,w.to),from:w.from,to:w.to,start:w.startSample/ALIGNMENT_RATE,end:w.endSample/ALIGNMENT_RATE,score:w.score}))
 }))};
}
