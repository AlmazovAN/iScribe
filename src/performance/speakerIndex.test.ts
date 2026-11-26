import {expect,it} from 'vitest';
import {SpeakerIntervalIndex} from './speakerIndex';
import {alignSpeakers} from '../ml/speakers';
it('returns exactly overlapping inclusive candidates including long nested turns',()=>{
 const turns=[{start:0,end:100},{start:3,end:4},{start:8,end:9},{start:10,end:15},{start:20,end:21}];
 const index=new SpeakerIntervalIndex(turns);
 for(let start=0;start<110;start+=.25){
  const end=start+.5;
  expect(index.candidates(start,end)).toEqual(turns.filter(t=>t.start<=end&&t.end>=start));
 }
});
it('limits candidates on long sparse timelines and preserves original segment order',()=>{
 const turns=Array.from({length:10000},(_,i)=>({start:2*i,end:2*i+1,speaker:i%2?'B':'A'}));
 const segments=[{start:9998.1,end:9998.2,text:'later'},{start:.1,end:.2,text:'earlier'},{start:1.04,end:1.06,text:'boundary'},{start:100,end:100,text:'point'}];
 let queries=0,candidates=0;
 const r=alignSpeakers(segments,turns,(q,c)=>{queries=q;candidates=c});
 expect(r.segments.map(x=>x.speaker)).toEqual(['B','A','A','A']);
 expect(queries).toBe(4);expect(candidates).toBe(4);
 expect(r.stats).toMatchObject({labeled:4,boundaryMatches:1,zeroDuration:1});
});
