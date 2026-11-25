import {expect,it} from 'vitest';
import {addBenchmarkTiming,benchmarkReport,emptyBenchmark,percentile,recordWindowCommit,MAX_BENCH_WINDOW_TIMINGS} from './benchmark';
import {createJob} from './jobs';

it('computes consistent P50/P95, RTF and stage totals without leaking filenames or transcript',()=>{
 const job=createJob(new File(['private audio'],'CONFIDENTIAL-MEETING.mp3'),{model:'whisper-small',language:'ru',diarize:true});
 let metrics=emptyBenchmark();
 metrics={...metrics,runs:2,resumedRuns:1,attempts:5,failedAttempts:1,workerRecoveries:1};
 for(let i=0;i<4;i++)metrics=recordWindowCommit(metrics,i+1,10*(i+1),i+1,15);
 metrics=addBenchmarkTiming(metrics,'asrAttemptMs',2000);
 metrics=addBenchmarkTiming(metrics,'decodeMs',123);
 metrics=addBenchmarkTiming(metrics,'modelInitMs',250);
 metrics=addBenchmarkTiming(metrics,'runMs',2900);
 const report=benchmarkReport({...job,duration:60,nextWindow:4,stage:'partial',
  segments:[{start:0,end:1,text:'PRIVATE SPEECH'}],
  error:'PRIVATE INTERNAL ERROR',benchmark:metrics});
 expect(report).toMatchObject({
  schema:'iscribe.benchmark.v1',
  runs:2,resumedRuns:1,workerRecoveries:1,failedAttempts:1,
  measuredCommittedWindows:4,measuredUniqueAudioSeconds:60,
  asrWindowMs:{count:4,p50:25,p95:38.5,max:40},
  checkpointWindowMs:{count:4,p50:2.5,p95:3.85,max:4},
  asrRtf:0.0333,timingsMs:{decode:123,checkpointPersistence:10}
 });
 const text=JSON.stringify(report);
 for(const sensitive of ['CONFIDENTIAL-MEETING','private audio','PRIVATE SPEECH','PRIVATE INTERNAL ERROR'])
  expect(text).not.toContain(sensitive);
});

it('for 871 seconds and 35 overlapping windows counts unique audio once',()=>{
 const samples=871*16000;
 let metrics=emptyBenchmark(),previousEnd=0;
 for(let index=0;index<35;index++){
  const start=index*25*16000,end=Math.min(start+30*16000,samples);
  const seconds=(end-previousEnd)/16000;
  previousEnd=end;
  metrics=recordWindowCommit(metrics,index+1,100,5,seconds);
 }
 expect(metrics.uniqueAudioSeconds).toBe(871);
 expect(metrics.committedWindows).toBe(35);
 expect(metrics.windowTimings).toHaveLength(35);
 expect(metrics.checkpointMs).toBe(175);
 const job=createJob(new File(['bytes'],'long-secret.wav'),{model:'whisper-small',language:'ru',diarize:false});
 const report=benchmarkReport({...job,benchmark:addBenchmarkTiming(metrics,'asrAttemptMs',3500)});
 expect(report.asrRtf).toBe(0.004);
 expect(report.measuredUniqueAudioSeconds).toBe(871);
});

it('bounds sample arrays and handles missing, nonfinite or zero-duration values conservatively',()=>{
 let metrics=emptyBenchmark();
 for(let i=1;i<=MAX_BENCH_WINDOW_TIMINGS+30;i++)metrics=recordWindowCommit(metrics,i,Number.NaN,Infinity,1);
 expect(metrics.windowTimings).toHaveLength(MAX_BENCH_WINDOW_TIMINGS);
 expect(metrics.windowTimings[0].window).toBe(31);
 expect(metrics.checkpointMs).toBe(0);
 expect(metrics.windowTimings.every(t=>t.inferenceMs===0)).toBe(true);
 expect(()=>recordWindowCommit(metrics,0,1,1,1)).toThrow();
 expect(()=>recordWindowCommit(metrics,2,1,1,-1)).toThrow();
 expect(percentile([],0.95)).toBeNull();
 expect(percentile([1,2,3,4],0.95)).toBeCloseTo(3.85);
 const job=createJob(new File(['audio'],'unstarted.wav'),{model:'whisper-tiny',language:'ru',diarize:false});
 const report=benchmarkReport(job);
 expect(report.asrRtf).toBeNull();
 expect(report.mainThreadHeap.observedPeakBytes).toBeNull();
 expect(report.asrWindowMs.count).toBe(0);
});
