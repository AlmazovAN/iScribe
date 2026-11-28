// PIPE-09: advisory, deterministic, bounded QA. No text is changed or dropped.
export const ASR_QUALITY_REVISION=1;
const RATE=16000,MAX_SAMPLES=30*RATE,MAX_TOKENS=4096,MAX_CHARS=65536;
type Segment={start:number;end:number;text:string};
export type AsrWindowQuality={
 revision:1;rawSegments:number;invalidSegments:number;emptySegments:number;zeroDuration:number;
 outOfOrder:number;tailOverrun:number;overlappingSegments:number;
 ownedWords:number;repeatRuns:number;silentText:boolean;denseText:boolean;scanLimited:boolean;
 rms:number;peak:number;
};
export type AsrQualitySummary={revision:1;examinedWindows:number;warningWindows:number;repeatWindows:number;silentTextWindows:number;timestampWindows:number;emptyWindows:number;denseWindows:number;limitedWindows:number};
export class AsrQualityError extends Error{
 readonly code='asr-quality-invalid';
 constructor(){super('Некорректные временные метки ASR в текущем окне. Контрольная точка не изменена.');this.name='AsrQualityError'}
}
function tokens(segments:readonly Segment[],maxChars=MAX_CHARS,maxTokens=MAX_TOKENS){
 const words:string[]=[];let remaining=maxChars,limited=false;
 for(const s of segments){
  if(remaining<=0||words.length>=maxTokens){limited=true;break}
  const text=s.text.slice(0,remaining);remaining-=text.length;
  if(text.length<s.text.length)limited=true;
  const normalized=text.normalize('NFKC').toLowerCase();
  for(const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)){
   if(words.length>=maxTokens){limited=true;break}
   // Do not truncate long words to the same prefix; skip them.
   if(match[0].length>128){limited=true;continue}
   words.push(match[0]);
  }
 }
 return {words,limited};
}
// Exact consecutive repeated phrases, not fuzzy similarity. Count only runs
// reaching the current owned output, so earlier warnings are not repeated.
function repeatedRuns(words:readonly string[],previous:number){
 let runs=0;
 for(let i=0;i<words.length;){
  let span=0;
  for(let width=1;width<=12&&i+width*3<=words.length;width++){
   // Avoid treating ordinary repeated short discourse markers as a loop.
   const count=width===1?8:width===2?4:3;
   if(i+width*count>words.length)continue;
   let equal=true;
   for(let j=width;j<width*count;j++)if(words[i+j]!==words[i+j%width]){equal=false;break}
   if(!equal)continue;
   let end=i+width*count;
   while(end+width<=words.length){
    let same=true;
    for(let k=0;k<width;k++)if(words[end+k]!==words[i+k]){same=false;break}
    if(!same)break;end+=width;
   }
   span=end-i;break;
  }
  if(span){if(i+span>previous)runs++;i+=span}else i++;
 }
 return runs;
}
export function inspectRawAsr(raw:unknown,pcm:Float32Array):AsrWindowQuality{
 if(!(pcm instanceof Float32Array)||!pcm.length||pcm.length>MAX_SAMPLES)throw new Error('Некорректный PCM для проверки ASR.');
 let square=0,peak=0;
 for(const v of pcm){if(!Number.isFinite(v))throw new Error('Некорректный PCM для проверки ASR.');square+=v*v;peak=Math.max(peak,Math.abs(v))}
 const q:AsrWindowQuality={revision:1,rawSegments:Array.isArray(raw)?raw.length:0,invalidSegments:0,emptySegments:0,zeroDuration:0,outOfOrder:0,tailOverrun:0,overlappingSegments:0,ownedWords:0,repeatRuns:0,silentText:false,denseText:false,scanLimited:false,rms:Math.sqrt(square/pcm.length),peak};
 if(!Array.isArray(raw)){q.invalidSegments=1;return q}
 const duration=pcm.length/RATE;
 let previousStart=-1,previousEnd=-1;
 for(const s of raw){
  // Identical hard limits to the existing absoluteSegments gate.
  if(!s||typeof s.text!=='string'||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||s.end>duration+1){q.invalidSegments++;continue}
  if(!s.text.trim())q.emptySegments++;
  if(s.start===s.end)q.zeroDuration++;
  if(s.start<previousStart)q.outOfOrder++;
  if(s.end>duration)q.tailOverrun++;
  if(s.start<previousEnd)q.overlappingSegments++;
  previousStart=s.start;previousEnd=s.end;
 }
 return q;
}
export function inspectOwnedAsr(q:AsrWindowQuality,owned:readonly Segment[],previous:readonly Segment[],samples:number):AsrWindowQuality{
 const current=tokens(owned);
 // The tail is local, ephemeral, and never included in diagnostic output.
 const tail=tokens(previous.slice(-8),2048,256).words.slice(-36);
 const repeatRuns=repeatedRuns([...tail,...current.words],tail.length);
 return {...q,ownedWords:current.words.length,repeatRuns,
  silentText:current.words.length>0&&q.peak<=0.00001&&q.rms<=0.000001,
  denseText:current.words.length/(samples/RATE)>8,
  scanLimited:current.limited};
}
export function hasAsrWarning(q:AsrWindowQuality):boolean{
 return q.invalidSegments>0||q.zeroDuration>0||q.outOfOrder>0||q.tailOverrun>0||q.overlappingSegments>0||q.repeatRuns>0||q.silentText||q.denseText||q.scanLimited;
}
export function addAsrQuality(previous:AsrQualitySummary|undefined,q:AsrWindowQuality):AsrQualitySummary{
 const p=previous??{revision:1,examinedWindows:0,warningWindows:0,repeatWindows:0,silentTextWindows:0,timestampWindows:0,emptyWindows:0,denseWindows:0,limitedWindows:0};
 return {revision:1,examinedWindows:p.examinedWindows+1,warningWindows:p.warningWindows+Number(hasAsrWarning(q)),repeatWindows:p.repeatWindows+Number(q.repeatRuns>0),
  silentTextWindows:p.silentTextWindows+Number(q.silentText),timestampWindows:p.timestampWindows+Number(q.zeroDuration>0||q.outOfOrder>0||q.tailOverrun>0||q.overlappingSegments>0),
  emptyWindows:p.emptyWindows+Number(q.ownedWords===0),denseWindows:p.denseWindows+Number(q.denseText),limitedWindows:p.limitedWindows+Number(q.scanLimited)};
}
const COUNTERS=['warningWindows','repeatWindows','silentTextWindows','timestampWindows','emptyWindows','denseWindows','limitedWindows'] as const;
export function qualitySummary(value:unknown):AsrQualitySummary|null{
 if(!value||typeof value!=='object')return null;
 const q=value as AsrQualitySummary;
 if(q.revision!==1||!Number.isSafeInteger(q.examinedWindows)||q.examinedWindows<0||
  COUNTERS.some(key=>!Number.isSafeInteger(q[key])||q[key]<0||q[key]>q.examinedWindows))return null;
 return {revision:1,examinedWindows:q.examinedWindows,warningWindows:q.warningWindows,repeatWindows:q.repeatWindows,silentTextWindows:q.silentTextWindows,timestampWindows:q.timestampWindows,emptyWindows:q.emptyWindows,denseWindows:q.denseWindows,limitedWindows:q.limitedWindows};
}
type QualityOwner={nextWindow:number;asrQuality?:AsrQualitySummary};
export function assertQualityForward(old:QualityOwner|undefined,next:QualityOwner):void{
 const p=qualitySummary(old?.asrQuality),q=qualitySummary(next.asrQuality);
 if(old?.asrQuality!==undefined&&!p||next.asrQuality!==undefined&&!q||p&&!q)throw new Error('Некорректный журнал качества ASR.');
 if(!q)return;
 const increment=q.examinedWindows-(p?.examinedWindows??0);
 if(q.examinedWindows>next.nextWindow||increment<0||increment>1||
    increment!==next.nextWindow-(old?.nextWindow??0)||
    COUNTERS.some(key=>q[key]<(p?.[key]??0)||q[key]-(p?.[key]??0)>increment))
  throw new Error('Журнал качества ASR не соответствует контрольной точке.');
}
