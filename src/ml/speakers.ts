import type {SpeakerTurn,TranscriptSegment} from '@yourdevice/engine';
// Sum actual intersection per speaker (a speaker can have several short turns).
// Point segments are matched only when their timestamp is inside a real turn.
// Gaps and tied evidence remain unknown; never propagate the nearest voice.
export function mapSpeakers(segments:readonly TranscriptSegment[],turns:readonly SpeakerTurn[]):TranscriptSegment[]{
 return segments.map(segment=>{
  const evidence=new Map<string,number>();
  for(const t of turns){
   if(!t.speaker?.trim()||!Number.isFinite(t.start)||!Number.isFinite(t.end)||t.end<=t.start)continue;
   const overlap=segment.end===segment.start?(segment.start>=t.start&&segment.start<t.end?1:0):Math.max(0,Math.min(segment.end,t.end)-Math.max(segment.start,t.start));
   if(overlap>0)evidence.set(t.speaker,(evidence.get(t.speaker)??0)+overlap);
  }
  const sorted=[...evidence].sort((a,b)=>b[1]-a[1]);
  const {speaker:_,...plain}=segment;void _;
  return sorted.length&&(!sorted[1]||sorted[0][1]-sorted[1][1]>1e-6)?{...plain,speaker:sorted[0][0]}:plain;
 });
}
