import type {SpeakerTurn,TranscriptSegment} from '@yourdevice/engine';
import {SpeakerIntervalIndex} from '../performance/speakerIndex';
import {validateAlignmentReport,type AlignmentReport} from './forcedAlignment';

// Keep the decision conservative: never invent a label across long pauses
// or a segment with nearly equal overlap evidence for two speakers.
export const MAX_BOUNDARY_GAP_SECONDS=0.08;
export const MAX_BOUNDARY_SEGMENT_SECONDS=0.25;
const MIN_COVERAGE_RATIO=0.2;
const MIN_WINNER_MARGIN=0.12;
const EPS=1e-6;

export type SpeakerAlignmentStats={
 turns:number;
 validTurns:number;
 invalidTurns:number;
 mergedTurns:number;
 speakerCount:number;
 turnCoverageSeconds:number;
 segments:number;
 emptyText:number;
 labeled:number;
 unlabeled:number;
 overlapMatches:number;
 boundaryMatches:number;
 ambiguous:number;
 uncovered:number;
 weakEvidence:number;
 invalidSegments:number;
 zeroDuration:number;
};
export type SpeakerAlignment={segments:TranscriptSegment[];stats:SpeakerAlignmentStats};
type Interval={start:number;end:number;speaker:string};

function normalizedTurns(turns:readonly SpeakerTurn[],duration?:number){
 const groups=new Map<string,Interval[]>();
 let invalidTurns=0,validTurns=0;
 for(const t of turns){
  const speaker=typeof t?.speaker==='string'?t.speaker.trim():'';
  if(!speaker||!Number.isFinite(t?.start)||!Number.isFinite(t?.end)||t.start<0||t.end<=t.start||
    (duration!==undefined&&(t.start>=duration||/^(speaker[_ ]?)?unknown$/i.test(speaker)))){
   invalidTurns++;continue;
  }
  validTurns++;
  const group=groups.get(speaker)??[];
  group.push({start:t.start,end:duration===undefined?t.end:Math.min(t.end,duration),speaker});
  groups.set(speaker,group);
 }
 const merged:Interval[]=[];
 for(const [speaker,values] of groups){
  values.sort((a,b)=>a.start-b.start||a.end-b.end);
  for(const turn of values){
   const prev=merged.at(-1);
   // Only merge the current speaker's adjacent/overlapping time spans.
   if(prev?.speaker===speaker&&turn.start<=prev.end+EPS)
    prev.end=Math.max(prev.end,turn.end);
   else merged.push({...turn});
  }
 }
 return {merged,invalidTurns,validTurns,speakerCount:groups.size};
}
function timelineCoverage(turns:readonly Interval[]):number{
 let end=0,total=0;
 for(const t of [...turns].sort((a,b)=>a.start-b.start||a.end-b.end)){
  if(t.end<=end)continue;
  total+=t.end-Math.max(t.start,end);
  end=t.end;
 }
 return Number(total.toFixed(3));
}
function distance(segment:TranscriptSegment,turn:Interval):number{
 // Called only for zero-intersection segments.
 if(segment.end<=turn.start)return turn.start-segment.end;
 if(segment.start>=turn.end)return segment.start-turn.end;
 return 0;
}
export function alignSpeakers(segments:readonly TranscriptSegment[],turns:readonly SpeakerTurn[],observe?:(queries:number,candidates:number)=>void,duration?:number):SpeakerAlignment{
 const prepared=normalizedTurns(turns,duration),valid=prepared.merged;
 const index=new SpeakerIntervalIndex(valid);let queries=0,candidateCount=0;
 const stats:SpeakerAlignmentStats={
  turns:turns.length,validTurns:prepared.validTurns,invalidTurns:prepared.invalidTurns,
  mergedTurns:valid.length,speakerCount:prepared.speakerCount,
  turnCoverageSeconds:timelineCoverage(valid),segments:segments.length,
  emptyText:0,labeled:0,unlabeled:0,overlapMatches:0,boundaryMatches:0,
  ambiguous:0,uncovered:0,weakEvidence:0,invalidSegments:0,zeroDuration:0
 };
 const result=segments.map(segment=>{
  // An old speaker label must never survive a new, unsuccessful alignment.
  const {speaker:_stale,...plain}=segment;void _stale;
  // Empty ASR placeholders are not missing speaker assignments. Preserve
  // the previous runner's semantics: count only text-bearing unknowns.
  if(typeof segment.text!=='string'||!segment.text.trim()){
   stats.emptyText++;return plain;
  }
  if(!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||
     segment.start<0||segment.end<segment.start){
   stats.invalidSegments++;stats.unlabeled++;return plain;
  }
  const length=segment.end-segment.start;
  if(length===0)stats.zeroDuration++;
  const evidence=new Map<string,number>();
  // Include the bounded edge tolerance for short segments; the original
  // exact overlap/distance tests below remain the authority for labels.
  const pad=length<=MAX_BOUNDARY_SEGMENT_SECONDS?MAX_BOUNDARY_GAP_SECONDS+2*EPS:0;
  const candidates=index.candidates(segment.start-pad,segment.end+pad);
  queries++;candidateCount+=candidates.length;
  for(const t of candidates){
   const overlap=length===0
    ?segment.start>=t.start&&segment.start<t.end?1:0
    :Math.max(0,Math.min(segment.end,t.end)-Math.max(segment.start,t.start));
   if(overlap>0)evidence.set(t.speaker,(evidence.get(t.speaker)??0)+overlap);
  }
  const ranked=[...evidence].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  if(ranked.length){
   const best=ranked[0][1],runnerUp=ranked[1]?.[1]??0;
   if(runnerUp>0&&runnerUp>=best*(1-MIN_WINNER_MARGIN)-EPS){
    stats.ambiguous++;stats.unlabeled++;return plain;
   }
   // A fraction of a second of activity should not label a long ASR
   // sentence largely outside detected speech.
   if(length>0&&best/length<MIN_COVERAGE_RATIO){
    stats.weakEvidence++;stats.unlabeled++;return plain;
   }
   stats.overlapMatches++;stats.labeled++;
   return {...plain,speaker:ranked[0][0]};
  }
  // Limited edge compensation for ASR/VAD timestamp rounding. Only
  // sub-250ms segments and gaps within 80ms qualify, never an arbitrary
  // nearest-speaker search through silence.
  if(length<=MAX_BOUNDARY_SEGMENT_SECONDS){
   const nearest=candidates.map(t=>({speaker:t.speaker,delta:distance(segment,t)}))
    .filter(x=>x.delta<=MAX_BOUNDARY_GAP_SECONDS+EPS)
    .sort((a,b)=>a.delta-b.delta||a.speaker.localeCompare(b.speaker));
   if(nearest.length){
    const min=nearest[0].delta;
    const winners=new Set(nearest.filter(x=>x.delta-min<=EPS).map(x=>x.speaker));
    if(winners.size===1){
     stats.boundaryMatches++;stats.labeled++;
     return {...plain,speaker:nearest[0].speaker};
    }
    stats.ambiguous++;stats.unlabeled++;return plain;
   }
  }
  stats.uncovered++;stats.unlabeled++;return plain;
 });
 observe?.(queries,candidateCount);
 return {segments:result,stats};
}
export function mapSpeakers(segments:readonly TranscriptSegment[],turns:readonly SpeakerTurn[]):TranscriptSegment[]{
 return alignSpeakers(segments,turns).segments;
}

export const WORD_SPEAKER_CONTRACT='word-v1';
export type WordSpeakerStats={
 revision:1;mode:typeof WORD_SPEAKER_CONTRACT;sourceSegments:number;alignedSourceSegments:number;
 fallbackSourceSegments:number;outputSegments:number;alignedWords:number;labeledWords:number;
 unknownWords:number;ambiguousWords:number;weakWords:number;uncoveredWords:number;splitSourceSegments:number;
};
type WordDecision={speaker?:string;reason:'overlap'|'ambiguous'|'weak'|'uncovered'};
function wordDecision(start:number,end:number,index:SpeakerIntervalIndex<Interval>,observe:(n:number)=>void):WordDecision{
 const candidates=index.candidates(start,end);observe(candidates.length);
 const evidence=new Map<string,number>();
 for(const t of candidates){
  const n=Math.max(0,Math.min(end,t.end)-Math.max(start,t.start));
  if(n>0)evidence.set(t.speaker,(evidence.get(t.speaker)??0)+n);
 }
 const ranked=[...evidence].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 if(!ranked.length)return {reason:'uncovered'};
 const [speaker,best]=ranked[0],runner=ranked[1]?.[1]??0;
 // Strict word policy: no nearest-neighbor inheritance through silence.
 if(runner>0&&runner>=best*.75-EPS)return {reason:'ambiguous'};
 if(best/(end-start)<.5-EPS)return {reason:'weak'};
 return {speaker,reason:'overlap'};
}
// Global turn identities come from a single full recording pass. Word rows
// split only at original text offsets; no acoustic identity is inferred here.
export function alignWordSpeakers(segments:readonly TranscriptSegment[],turns:readonly SpeakerTurn[],report:AlignmentReport,observe?:(queries:number,candidates:number)=>void):SpeakerAlignment&{wordStats:WordSpeakerStats}{
 if(!validateAlignmentReport(report,segments,report.samples,report.language))throw new Error('Некорректная карта слов для назначения говорящих.');
 const duration=report.samples/16000,prepared=normalizedTurns(turns,duration),index=new SpeakerIntervalIndex(prepared.merged);
 const rows=new Map(report.rows.map(r=>[r.index,r.words]));
 const fallback=segments.filter((_,i)=>!rows.has(i));
 let queries=0,candidateCount=0;
 const base=alignSpeakers(fallback,turns,(q,c)=>{queries+=q;candidateCount+=c},duration),stats=base.stats;
 const wordStats:WordSpeakerStats={revision:1,mode:WORD_SPEAKER_CONTRACT,sourceSegments:segments.length,alignedSourceSegments:rows.size,fallbackSourceSegments:fallback.length,outputSegments:0,alignedWords:0,labeledWords:0,unknownWords:0,ambiguousWords:0,weakWords:0,uncoveredWords:0,splitSourceSegments:0};
 const output:TranscriptSegment[]=[];let fallbackIndex=0;
 for(let i=0;i<segments.length;i++){
  const segment=segments[i],words=rows.get(i);
  if(!words){output.push(base.segments[fallbackIndex++]);continue}
  const decisions=words.map(w=>wordDecision(w.startSample/16000,w.endSample/16000,index,n=>{queries++;candidateCount+=n}));
  for(const d of decisions){
   wordStats.alignedWords++;
   if(d.speaker)wordStats.labeledWords++;
   else{wordStats.unknownWords++;if(d.reason==='ambiguous')wordStats.ambiguousWords++;else if(d.reason==='weak')wordStats.weakWords++;else wordStats.uncoveredWords++}
  }
  let runs=0;
  for(let first=0;first<words.length;){
   let end=first+1;while(end<words.length&&decisions[end].speaker===decisions[first].speaker)end++;
   const from=first===0?0:words[first].from,to=end===words.length?segment.text.length:words[end].from;
   const d=decisions[first];
   // Keep all original characters, including punctuation and whitespace.
   // Do not inherit the original segment's possibly stale speaker.
   const {speaker:_stale,...plain}=segment;void _stale;
   output.push({...plain,text:segment.text.slice(from,to),start:words[first].startSample/16000,end:words[end-1].endSample/16000,...(d.speaker?{speaker:d.speaker}:{})});
   stats.segments++;runs++;
   if(d.speaker){stats.labeled++;stats.overlapMatches++}
   else{
    stats.unlabeled++;const reasons=decisions.slice(first,end).map(x=>x.reason);
    if(reasons.includes('ambiguous'))stats.ambiguous++;else if(reasons.includes('weak'))stats.weakEvidence++;else stats.uncovered++;
   }
   first=end;
  }
  if(runs>1)wordStats.splitSourceSegments++;
 }
 wordStats.outputSegments=output.length;
 observe?.(queries,candidateCount);
 return {segments:output,stats,wordStats};
}
export function wordSpeakerSummary(value:unknown):WordSpeakerStats|null{
 if(!value||typeof value!=='object')return null;
 const s=value as WordSpeakerStats;
 const counts=[s.sourceSegments,s.alignedSourceSegments,s.fallbackSourceSegments,s.outputSegments,s.alignedWords,s.labeledWords,s.unknownWords,s.ambiguousWords,s.weakWords,s.uncoveredWords,s.splitSourceSegments];
 if(s.revision!==1||s.mode!==WORD_SPEAKER_CONTRACT||counts.some(n=>!Number.isSafeInteger(n)||n<0)||
  s.sourceSegments>10000||s.alignedWords>50512||s.sourceSegments!==s.alignedSourceSegments+s.fallbackSourceSegments||
  s.alignedWords!==s.labeledWords+s.unknownWords||s.unknownWords!==s.ambiguousWords+s.weakWords+s.uncoveredWords||
  s.alignedWords<s.alignedSourceSegments||s.splitSourceSegments>s.alignedSourceSegments||
  s.outputSegments<s.sourceSegments||s.outputSegments>s.fallbackSourceSegments+s.alignedWords)return null;
 return {revision:1,mode:WORD_SPEAKER_CONTRACT,sourceSegments:s.sourceSegments,alignedSourceSegments:s.alignedSourceSegments,fallbackSourceSegments:s.fallbackSourceSegments,outputSegments:s.outputSegments,alignedWords:s.alignedWords,labeledWords:s.labeledWords,unknownWords:s.unknownWords,ambiguousWords:s.ambiguousWords,weakWords:s.weakWords,uncoveredWords:s.uncoveredWords,splitSourceSegments:s.splitSourceSegments};
}
type WordOwner={wordSpeakerStats?:WordSpeakerStats;alignmentCheckpoint?:{segmentCount:number;alignedWords:number;alignedSegments:number};asrComplete:boolean;params:{diarize:boolean}};
export function assertWordSpeakerForward(old:WordOwner|undefined,next:WordOwner,sourceCount:number,outputCount:number|undefined){
 const s=wordSpeakerSummary(next.wordSpeakerStats),a=next.alignmentCheckpoint;
 if(next.wordSpeakerStats!==undefined&&(!s||!a||!next.asrComplete||!next.params.diarize||sourceCount!==s.sourceSegments||outputCount!==s.outputSegments||
  a.segmentCount!==sourceCount||a.alignedSegments!==s.alignedSourceSegments||a.alignedWords!==s.alignedWords))throw new Error('Некорректная контрольная точка назначения говорящих.');
 if(old?.wordSpeakerStats!==undefined&&JSON.stringify(old.wordSpeakerStats)!==JSON.stringify(next.wordSpeakerStats))throw new Error('Нельзя изменить сохранённое пословное назначение говорящих.');
}
