import {expect,it} from 'vitest';
import {ALIGNMENT_CONTRACT,ctcAlign,buildTarget,alignTarget,segmentCrop,validateAlignmentReport,alignmentExport,validateAlignmentCheckpoint,alignmentMatches,assertAlignmentForward,alignmentInputs,type AlignmentReport,type AlignmentCheckpoint} from './forcedAlignment';
const hot=(seq:number[],classes=8)=>{const a=new Float32Array(seq.length*classes).fill(-10);seq.forEach((v,i)=>{a[i*classes+v]=10});return a};
const vocab={'<pad>':0,'|':4,'а':7,'б':8,'ё':6,'A':7,'B':24};
it('PIPE-10 preserves CTC repeated symbols separated by blank',()=>{
 const p=ctcAlign(hot([0,5,0,5,4,6,6,0]),8,8,[5,5,4,6])!;
 expect(p.map(x=>[x.first,x.last])).toEqual([[1,1],[3,3],[4,4],[5,6]]);
 expect(p.every(x=>x.score>.99)).toBe(true);
 expect(ctcAlign(hot([5,5]),2,8,[5,5])).toBeNull();
});
it('PIPE-10 maps original UTF-16 word offsets and rejects unsupported words',()=>{
 expect(buildTarget('Аа, б!','ru',vocab)).toEqual({ids:[7,7,4,8],words:[{from:0,to:2,first:0,last:1},{from:4,to:5,first:3,last:3}]});
 expect(buildTarget('Е\u0308','ru',vocab)?.ids).toEqual([6]);
 expect(buildTarget('a b','en',vocab)?.ids).toEqual([7,4,24]);
 expect(buildTarget('аб 42','ru',vocab)).toBeNull();
 expect(buildTarget('а'.repeat(513),'ru',vocab)).toBeNull();
});
it('PIPE-10 converts acoustic frames to absolute samples and rejects weak evidence',()=>{
 const target=buildTarget('а б','ru',vocab)!,start=16000,end=start+400+4*320;
 const words=alignTarget(hot([0,7,4,8,0],39),5,39,target,{start,end})!;
 expect(words.map(w=>[w.from,w.to,w.startSample,w.endSample])).toEqual([[0,1,16320,16640],[2,3,16960,17280]]);
 expect(alignTarget(new Float32Array(5*39),5,39,target,{start,end})).toBeNull();
 expect(alignTarget(hot([0,7,4,8,0],39),5,39,target,{start,end:end+320})).toBeNull();
 expect(segmentCrop({start:0,end:31,text:'a'},500000)).toBeNull();
 expect(segmentCrop({start:1,end:3,text:'а'},32000)).toEqual({start:16000,end:32000});
});
it('PIPE-10 rejects nonfinite logits and invalid dimensions',()=>{
 const x=hot([0,5]);x[0]=NaN;expect(ctcAlign(x,2,8,[5])).toBeNull();
 expect(ctcAlign(new Float32Array(8),1501,8,[5])).toBeNull();
 expect(ctcAlign(hot([5]),1,8,[0])).toBeNull();
});
const segments=[{start:1,end:2,text:'А б!'},{start:2,end:3,text:'42'}];
const report:AlignmentReport={revision:1,contract:ALIGNMENT_CONTRACT,language:'ru',samples:48000,segmentCount:2,rows:[{index:0,words:[{from:0,to:1,startSample:16320,endSample:16640,score:.8},{from:2,to:3,startSample:16960,endSample:17280,score:.9}]}]};
const meta:AlignmentCheckpoint={revision:1,contract:ALIGNMENT_CONTRACT,language:'ru',samples:48000,segmentCount:2,decoderProfile:'test',pcmFingerprint:'a'.repeat(64),transcriptFingerprint:'b'.repeat(64),alignedSegments:1,alignedWords:2};
it('PIPE-10 validates complete rows, preserves original transcript and leaves skipped words unaligned',()=>{
 expect(validateAlignmentReport(report,segments,48000,'ru')).toBe(true);
 const result=alignmentExport(report,segments);
 expect(result.segments.map(x=>x.text)).toEqual(segments.map(x=>x.text));
 expect(result.segments[0].words.map(x=>x.text)).toEqual(['А','б']);
 expect(result.segments[1].aligned).toBe(false);expect(result.segments[0].words[0].start).toBe(1.02);
 expect(validateAlignmentReport({...report,rows:[{...report.rows[0],index:2}]},segments,48000,'ru')).toBe(false);
 expect(validateAlignmentReport({...report,rows:[{index:0,words:[{...report.rows[0].words[0],from:1},report.rows[0].words[1]]}]},segments,48000,'ru')).toBe(false);
 expect(validateAlignmentReport({...report,rows:[{index:0,words:[report.rows[0].words[0],{...report.rows[0].words[1],startSample:16000}]}]},segments,48000,'ru')).toBe(false);
});
it('PIPE-10 prevents stale alignment metadata and binds identity to text',()=>{
 expect(validateAlignmentCheckpoint(meta)).toBe(true);expect(alignmentMatches(meta,report)).toBe(true);
 expect(alignmentMatches({...meta,alignedWords:3},report)).toBe(false);
 const job={asrComplete:true,duration:3,params:{language:'ru' as const},sourceFingerprint:'source',alignmentCheckpoint:meta};
 expect(()=>assertAlignmentForward(undefined,job,2)).not.toThrow();
 expect(()=>assertAlignmentForward(job,{...job,alignmentCheckpoint:undefined},2)).toThrow();
 expect(()=>assertAlignmentForward(undefined,{...job,asrComplete:false},2)).toThrow();
 expect(alignmentInputs(meta)).not.toEqual(alignmentInputs({...meta,transcriptFingerprint:'c'.repeat(64)}));
});
it('PIPE-10 compares Viterbi optimum to exhaustive short paths',()=>{
 const collapse=(p:number[])=>p.filter((x,i)=>x!==0&&(i===0||x!==p[i-1]));
 let seed=5;const rng=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 for(let k=0;k<200;k++){
  const frames=1+Math.floor(rng()*6),classes=3,ids=Array.from({length:1+Math.floor(rng()*3)},()=>1+Math.floor(rng()*2)),logits=Float32Array.from({length:frames*classes},()=>rng()*8-4);
  let best=-Infinity;
  for(let n=0;n<classes**frames;n++){let q=n,score=0;const path:number[]=[];for(let t=0;t<frames;t++){const x=q%classes;q=Math.floor(q/classes);path.push(x);score+=logits[t*classes+x]}if(JSON.stringify(collapse(path))===JSON.stringify(ids))best=Math.max(best,score)}
  const spans=ctcAlign(logits,frames,classes,ids);
  if(!Number.isFinite(best)){expect(spans).toBeNull();continue}
  expect(spans).not.toBeNull();const path=new Array<number>(frames).fill(0);
  spans!.forEach((s,i)=>{for(let t=s.first;t<=s.last;t++)path[t]=ids[i]});
  expect(collapse(path)).toEqual(ids);expect(Math.abs(path.reduce((n,x,t)=>n+logits[t*classes+x],0)-best)).toBeLessThan(1e-5);
 }
});
