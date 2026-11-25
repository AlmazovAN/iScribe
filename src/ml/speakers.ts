import type {SpeakerTurn,TranscriptSegment} from '@yourdevice/engine';

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

function normalizedTurns(turns:readonly SpeakerTurn[]){
 const groups=new Map<string,Interval[]>();
 let invalidTurns=0,validTurns=0;
 for(const t of turns){
  const speaker=typeof t?.speaker==='string'?t.speaker.trim():'';
  if(!speaker||!Number.isFinite(t?.start)||!Number.isFinite(t?.end)||t.start<0||t.end<=t.start){
   invalidTurns++;continue;
  }
  validTurns++;
  const group=groups.get(speaker)??[];
  group.push({start:t.start,end:t.end,speaker});
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
export function alignSpeakers(segments:readonly TranscriptSegment[],turns:readonly SpeakerTurn[]):SpeakerAlignment{
 const prepared=normalizedTurns(turns),valid=prepared.merged;
 const stats:SpeakerAlignmentStats={
  turns:turns.length,validTurns:prepared.validTurns,invalidTurns:prepared.invalidTurns,
  mergedTurns:valid.length,speakerCount:prepared.speakerCount,
  turnCoverageSeconds:timelineCoverage(valid),segments:segments.length,
  labeled:0,unlabeled:0,overlapMatches:0,boundaryMatches:0,
  ambiguous:0,uncovered:0,weakEvidence:0,invalidSegments:0,zeroDuration:0
 };
 const result=segments.map(segment=>{
  // An old speaker label must never survive a new, unsuccessful alignment.
  const {speaker:_stale,...plain}=segment;void _stale;
  if(!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||
     segment.start<0||segment.end<segment.start){
   stats.invalidSegments++;stats.unlabeled++;return plain;
  }
  const length=segment.end-segment.start;
  if(length===0)stats.zeroDuration++;
  const evidence=new Map<string,number>();
  for(const t of valid){
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
   const nearest=valid.map(t=>({speaker:t.speaker,delta:distance(segment,t)}))
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
 return {segments:result,stats};
}
export function mapSpeakers(segments:readonly TranscriptSegment[],turns:readonly SpeakerTurn[]):TranscriptSegment[]{
 return alignSpeakers(segments,turns).segments;
}
