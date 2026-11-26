import {expect,it} from 'vitest';
import {emptyExternal,readComparisonRun,summarizeComparison,type ComparisonRun,type CompareGroup,type RunSelection} from './hardwareBenchmark';
const baseline='a'.repeat(40),candidate='b'.repeat(40);
function fixture(group:CompareGroup,wallMs=20000){
 const build=group==='baseline'?baseline:candidate;
 const benchmark={schema:'iscribe.benchmark.v1',model:'whisper-small',language:'ru',diarizationRequested:false,durationSeconds:871,committedCheckpointWindows:35,measuredCommittedWindows:35,measuredUniqueAudioSeconds:871,stage:'done',runs:1,resumedRuns:0,failedRuns:0,attempts:35,failedAttempts:0,workerRecoveries:0,timingsMs:{jobRuns:wallMs,asrIncludingFailedAttempts:wallMs/2,modelInitialization:100},asrWindowMs:{p95:100},
  ...(group==='baseline'?{}:{firstRunContext:{buildRevision:build,launch:'standalone',mode:group,modelResidentAtStart:false,calibrationRequested:false,startCheckpoint:0},resourceManagement:{requestedWindowCounts:{eco:group==='eco'?35:0,medium:group==='medium'?35:0,max:group==='max'?35:0}}})};
 const evidence={schema:'iscribe.hardware-evidence.v1',buildRevision:build,job:{model:'whisper-small',language:'ru',diarizationRequested:false,sourceDurationSeconds:871,sourceSizeBytes:33300000,expectedWindows:35,committedWindows:35,completedASR:true,asrSegmentCount:25,invalidAsrSegments:0,resumedRuns:0,persistedJobFound:true,persistedCheckpointMatches:true,persistedTranscriptMatches:true,savedAudioPresent:true,savedAudioSizeMatches:true,observedBackend:'wasm'},privateText:'DO NOT EXPORT'};
 const selection:RunSelection={test:'T02',group,condition:'cold',launch:'standalone',external:{...emptyExternal(),ramPeakMb:1200}};
 return {evidence,benchmark,selection};
}
function run(group:CompareGroup,wallMs:number):ComparisonRun{
 const f=fixture(group,wallMs);return readComparisonRun(f.evidence,f.benchmark,f.selection);
}
it('accepts paired legacy evidence and new combined evidence without copying raw properties',()=>{
 const f=fixture('medium');
 const r=readComparisonRun({...f.evidence,performanceBenchmark:f.benchmark},null,f.selection);
 expect(r).toMatchObject({eligible:true,buildAtRunConfirmed:true,backend:'wasm',wallMs:20000,external:{ramPeakMb:1200,vramPeakMb:null}});
 expect(JSON.stringify(r)).not.toContain('DO NOT EXPORT');
 const old=fixture('baseline');
 expect(readComparisonRun(old.evidence,old.benchmark,old.selection)).toMatchObject({eligible:true,buildAtRunConfirmed:false});
});
it('excludes incomplete, mixed-mode, resumed and incorrectly paired data',()=>{
 const f=fixture('max');
 expect(readComparisonRun(f.evidence,{...f.benchmark,runs:2},f.selection).eligible).toBe(false);
 expect(readComparisonRun(f.evidence,{...f.benchmark,resourceManagement:{requestedWindowCounts:{eco:1,medium:0,max:34}}},f.selection).eligible).toBe(false);
 expect(readComparisonRun({...f.evidence,job:{...f.evidence.job,persistedTranscriptMatches:false}},f.benchmark,f.selection).eligible).toBe(false);
 expect(readComparisonRun(f.evidence,f.benchmark,{...f.selection,condition:'warm'}).eligible).toBe(false);
 expect(readComparisonRun(f.evidence,{...f.benchmark,measuredUniqueAudioSeconds:800},f.selection).eligible).toBe(false);
});
it('compares medians only with three independent eligible samples per group and explicit comparable conditions',()=>{
 const all=[run('baseline',21000),run('baseline',20000),run('baseline',19000),run('medium',9000),run('medium',10000),run('medium',11000)];
 const get=(r:ComparisonRun[],same=true)=>summarizeComparison(r,'T02','cold','standalone',same);
 expect(get(all).rows.find(r=>r.group==='medium')?.improvementPercent).toBe(50);
 expect(get(all).verdict).toBe('HARDWARE ACCEPTANCE NOT VERIFIED');
 expect(get(all,false).rows.find(r=>r.group==='medium')?.improvementPercent).toBeNull();
 expect(get(all.slice(0,5)).rows.find(r=>r.group==='medium')?.improvementPercent).toBeNull();
 expect(get([...all.slice(0,5),{...all[5],sourceBytes:33300001}]).comparable).toBe(false);
 expect(get([...all.slice(0,5),{...all[5],build:baseline}]).comparable).toBe(false);
 const bad={...all[5],eligible:false,issues:['failed']};
 expect(get([...all,bad]).rows.find(r=>r.group==='medium')).toMatchObject({attempted:4,eligible:3});
});
