import {expect,it} from 'vitest';
import {alignSpeakers,alignWordSpeakers,wordSpeakerSummary,assertWordSpeakerForward} from './speakers';
import {ALIGNMENT_CONTRACT,type AlignmentReport} from './forcedAlignment';
const segments=[{start:0,end:4,text:'  Первый, второй! третий. ',speaker:'stale'},{start:5,end:6,text:'Резерв'}];
const report:AlignmentReport={revision:1,contract:ALIGNMENT_CONTRACT,language:'ru',samples:96000,segmentCount:2,rows:[{index:0,words:[
 {from:2,to:8,startSample:8000,endSample:16000,score:.8},
 {from:10,to:16,startSample:24000,endSample:32000,score:.8},
 {from:18,to:24,startSample:40000,endSample:48000,score:.8}
]}]};
const turns=[{start:0,end:1,speaker:'A'},{start:1,end:3,speaker:'B'},{start:5,end:6,speaker:'A'}];
it('PIPE-11 splits on word speaker change and preserves every original character',()=>{
 const r=alignWordSpeakers(segments,turns,report);
 expect(r.segments.map(x=>x.speaker)).toEqual(['A','B','A']);
 expect(r.segments.slice(0,2).map(x=>x.text).join('')).toBe(segments[0].text);
 expect(r.segments.map(x=>[x.start,x.end])).toEqual([[.5,1],[1.5,3],[5,6]]);
 expect(r.wordStats).toMatchObject({sourceSegments:2,alignedSourceSegments:1,fallbackSourceSegments:1,outputSegments:3,alignedWords:3,labeledWords:3,unknownWords:0,splitSourceSegments:1});
 expect(r.stats).toMatchObject({segments:3,labeled:3,unlabeled:0});
 expect(segments[0].speaker).toBe('stale');
});
it('PIPE-11 never inherits adjacent voices across silence or equal overlap',()=>{
 const r=alignWordSpeakers(segments,[{start:.5,end:1,speaker:'A'},{start:.5,end:1,speaker:'B'},{start:1.45,end:1.49,speaker:'A'},{start:2.5,end:2.6,speaker:'A'}],report);
 expect(r.segments[0].speaker).toBeUndefined();
 expect(r.wordStats).toMatchObject({unknownWords:3,ambiguousWords:1,uncoveredWords:1,weakWords:1});
 expect(r.segments[0].text).toBe(segments[0].text);
 expect(r.stats).toMatchObject({labeled:0,unlabeled:2});
});
it('PIPE-11 merges same-speaker overlaps without double counting and preserves raw cluster identity',()=>{
 const t=[{start:0,end:.8,speaker:'A'},{start:.6,end:1,speaker:'A'},{start:.5,end:1,speaker:'B'}];
 const r=alignWordSpeakers(segments,t,report);
 expect(r.wordStats.ambiguousWords).toBe(1);
 expect(r.segments[0].speaker).toBeUndefined();
 expect(alignWordSpeakers(segments,[...turns].reverse(),report)).toEqual(alignWordSpeakers(segments,turns,report));
});
it('PIPE-11 ignores unknown and out-of-source turns; clamps coverage',()=>{
 const r=alignSpeakers([{start:5,end:6,text:'x'}],[{start:5,end:100,speaker:'A'},{start:6,end:7,speaker:'B'},{start:5,end:6,speaker:'SPEAKER_UNKNOWN'}],undefined,6);
 expect(r.segments[0].speaker).toBe('A');expect(r.stats).toMatchObject({invalidTurns:2,validTurns:1,turnCoverageSeconds:1,speakerCount:1});
});
it('PIPE-11 rejects invalid word geometry rather than silently switching policy',()=>{
 expect(()=>alignWordSpeakers(segments,turns,{...report,rows:[{index:0,words:report.rows[0].words.map((w,i)=>i===1?{...w,from:11}:w)}]})).toThrow('Некорректная');
});
it('PIPE-11 validates numeric summary and guards pinned output against rollback',()=>{
 const s=alignWordSpeakers(segments,turns,report).wordStats;
 expect(wordSpeakerSummary({...s,private:'SECRET'})).toEqual(s);
 expect(wordSpeakerSummary({...s,labeledWords:2})).toBeNull();
 const j={asrComplete:true,params:{diarize:true},alignmentCheckpoint:{segmentCount:2,alignedWords:3,alignedSegments:1},wordSpeakerStats:s};
 expect(()=>assertWordSpeakerForward(undefined,j,2,3)).not.toThrow();
 expect(()=>assertWordSpeakerForward(j,{...j,wordSpeakerStats:undefined},2,3)).toThrow('Нельзя изменить');
 expect(()=>assertWordSpeakerForward(j,j,2,2)).toThrow('Некорректная');
});
