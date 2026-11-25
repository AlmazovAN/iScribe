import {expect,it} from 'vitest';
import type {SpeakerTurn} from '@yourdevice/engine';
import {alignSpeakers,MAX_BOUNDARY_GAP_SECONDS,MAX_BOUNDARY_SEGMENT_SECONDS,mapSpeakers} from './speakers';

it('unions overlapping duplicate turns of the SAME speaker instead of double-counting evidence',()=>{
 const transcript=[{start:0,end:9,text:'Overlapping intervals'}];
 const turns=[
  {start:0,end:4,speaker:'A'},
  {start:0,end:4,speaker:'A'}, // Duplicate from model, not independent evidence
  {start:4,end:9,speaker:'B'}
 ];
 const result=alignSpeakers(transcript,turns);
 expect(result.segments[0].speaker).toBe('B'); // B=5 seconds vs unique A=4
 expect(result.stats).toMatchObject({turns:3,validTurns:3,mergedTurns:2,speakerCount:2,turnCoverageSeconds:9,overlapMatches:1,unlabeled:0});
});

it('keeps near-tied speaker evidence unknown instead of making an arbitrary dominant-speaker choice',()=>{
 const transcript=[{start:0,end:10,text:'Crosses two speakers',speaker:'stale label'}];
 const result=alignSpeakers(transcript,[
  {start:0,end:5,speaker:'A'},{start:5,end:9.8,speaker:'B'}
 ]);
 expect(result.segments[0]).toEqual({start:0,end:10,text:'Crosses two speakers'});
 expect(result.stats).toMatchObject({ambiguous:1,unlabeled:1,labeled:0});
});

it('applies only a bounded 80ms timestamp tolerance to very short ASR segments',()=>{
 const turns=[{start:1,end:2,speaker:'A'}];
 const result=alignSpeakers([
  {start:2.02,end:2.11,text:'edge'},
  {start:2.16,end:2.24,text:'silence'},
  {start:2.02,end:2.5,text:'long sentence outside speaker turn'},
  {start:0.92,end:0.99,text:'leading edge'}
 ],turns);
 expect(MAX_BOUNDARY_GAP_SECONDS).toBe(0.08);
 expect(MAX_BOUNDARY_SEGMENT_SECONDS).toBe(0.25);
 expect(result.segments.map(x=>x.speaker)).toEqual(['A',undefined,undefined,'A']);
 expect(result.stats).toMatchObject({boundaryMatches:2,uncovered:2,unlabeled:2});
});

it('does not assign a nearby point to one speaker when two turns are equally close',()=>{
 const turns=[
  {start:1,end:2,speaker:'A'},
  {start:2.04,end:3,speaker:'B'}
 ];
 const result=alignSpeakers([{start:2.02,end:2.02,text:'point'}],turns);
 expect(result.segments[0].speaker).toBeUndefined();
 expect(result.stats).toMatchObject({ambiguous:1,zeroDuration:1,unlabeled:1});
});

it('does not use a small overlapping sliver to label a long sentence in mostly silence',()=>{
 const result=alignSpeakers([
  {start:0,end:20,text:'Long ASR segment'}
 ],[{start:0,end:1,speaker:'A'}]);
 expect(result.segments[0].speaker).toBeUndefined();
 expect(result.stats).toMatchObject({weakEvidence:1,unlabeled:1});
});

it('counts malformed model turns and ASR timestamps without propagating stale labels or throwing',()=>{
 const raw:unknown[]=[
  null,
  {start:2,end:3,speaker:'A'},
  {start:NaN,end:4,speaker:'B'},
  {start:4,end:3,speaker:'C'},
  {start:1,end:2,speaker:'  '},
  {start:2,end:2.5,speaker:' A '}
 ];
 const segments=[
  {start:2.2,end:2.3,text:'valid'},
  {start:-1,end:1,text:'invalid',speaker:'old'},
  {start:NaN,end:3,text:'invalid2'}
 ];
 const result=alignSpeakers(segments,raw as SpeakerTurn[]);
 expect(result.segments.map(s=>s.speaker)).toEqual(['A',undefined,undefined]);
 expect(result.stats).toMatchObject({
  turns:6,validTurns:2,invalidTurns:4,mergedTurns:1,speakerCount:1,
  labeled:1,unlabeled:2,invalidSegments:2
 });
});

it('gaps and point segments are explicit, and mapped array is not mutated',()=>{
 const transcript=[
  {start:1.5,end:1.5,text:'point'},
  {start:2,end:2,text:'next'},
  {start:4,end:5,text:'gap'},
  {start:1,end:3,text:'tie'}
 ];
 const snapshot=structuredClone(transcript);
 const turns=[{start:1,end:2,speaker:'A'},{start:2,end:3,speaker:'B'}];
 expect(mapSpeakers(transcript,turns).map(x=>x.speaker)).toEqual(['A','B',undefined,undefined]);
 expect(transcript).toEqual(snapshot);
 const stats=alignSpeakers(transcript,turns).stats;
 expect(stats).toMatchObject({overlapMatches:2,zeroDuration:2,ambiguous:1,uncovered:1,unlabeled:2});
});


it('does not treat blank ASR placeholders as missing speech labels',()=>{
 const result=alignSpeakers([
  {start:0,end:0.5,text:'   '},
  {start:1,end:2,text:'Audible speech'},
  {start:4,end:5,text:'Uncovered words'}
 ],[{start:1,end:2,speaker:'A'}]);
 expect(result.segments.map(x=>x.speaker)).toEqual([undefined,'A',undefined]);
 expect(result.stats).toMatchObject({segments:3,emptyText:1,labeled:1,unlabeled:1,uncovered:1});
});
