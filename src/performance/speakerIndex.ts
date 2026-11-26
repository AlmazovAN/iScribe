// Query only turns that intersect the segment or its bounded edge tolerance.
// Prefix maximum end retains long intervals spanning shorter ones. Preserve
// start order within each speaker so floating-point accumulation stays stable.
export type TimedInterval={start:number;end:number};
export class SpeakerIntervalIndex<T extends TimedInterval>{
 private readonly sorted:T[];
 private readonly maxEnd:number[];
 constructor(intervals:readonly T[]){
  this.sorted=[...intervals].sort((a,b)=>a.start-b.start||a.end-b.end);
  let max=-Infinity;this.maxEnd=this.sorted.map(t=>(max=Math.max(max,t.end)));
 }
 candidates(start:number,end:number):T[]{
  let lo=0,hi=this.sorted.length;
  while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(this.maxEnd[mid]<start)lo=mid+1;else hi=mid}
  const out:T[]=[];
  for(let i=lo;i<this.sorted.length&&this.sorted[i].start<=end;i++){
   const t=this.sorted[i];if(t.end>=start)out.push(t);
  }
  return out;
 }
}
