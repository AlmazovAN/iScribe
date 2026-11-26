import type {Job} from './jobs';
import {performanceReport,type PerformanceProfile} from './performance/profiler';
import {resourceReport} from './performance/resourcePolicy';
import type {ResourceObservations} from './performance/types';
import {calibrationReport,type BackendCalibration} from './performance/backendPolicy';

// Wall-clock timings inside a single tab are monotonic when possible.
// Persist only elapsed durations; performance.now() origins change on reload.
export function benchmarkNow():number{
 return typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now():Date.now();
}
export type BenchmarkTimingKey='decodeMs'|'pcmCheckMs'|'modelInitMs'|'asrAttemptMs'|'checkpointMs'|'speakerMs'|'runMs';
export type BenchmarkWindow={window:number;inferenceMs:number;checkpointMs:number;uniqueAudioSeconds:number};
export type JobBenchmark={
 version:1;
 runs:number;
 resumedRuns:number;
 failedRuns:number;
 attempts:number;
 failedAttempts:number;
 workerRecoveries:number;
 committedWindows:number;
 uniqueAudioSeconds:number;
 decodeMs:number;
 pcmCheckMs:number;
 modelInitMs:number;
 asrAttemptMs:number;
 checkpointMs:number;
 speakerMs:number;
 runMs:number;
 windowTimings:BenchmarkWindow[];
 mainThreadHeapPeakBytes?:number;
 memorySamples:number;
 profiler?:PerformanceProfile;
 resources?:ResourceObservations;
 backendCalibration?:BackendCalibration;
};
// Keep the recent timing sample bounded for long streamed jobs and retries.
export const MAX_BENCH_WINDOW_TIMINGS=150;
export function emptyBenchmark():JobBenchmark{
 return {version:1,runs:0,resumedRuns:0,failedRuns:0,attempts:0,
  failedAttempts:0,workerRecoveries:0,committedWindows:0,uniqueAudioSeconds:0,
  decodeMs:0,pcmCheckMs:0,modelInitMs:0,asrAttemptMs:0,
  checkpointMs:0,speakerMs:0,runMs:0,windowTimings:[],memorySamples:0};
}
export function positiveElapsed(ms:number):number{
 return Number.isFinite(ms)?Math.max(0,ms):0;
}
export function addBenchmarkTiming(b:JobBenchmark,key:BenchmarkTimingKey,ms:number):JobBenchmark{
 return {...b,[key]:b[key]+positiveElapsed(ms)};
}
export function recordWindowCommit(
 b:JobBenchmark,window:number,inferenceMs:number,checkpointMs:number,uniqueAudioSeconds:number
):JobBenchmark{
 if(!Number.isSafeInteger(window)||window<1||!Number.isFinite(uniqueAudioSeconds)||uniqueAudioSeconds<=0)
  throw new Error('Некорректные параметры бенчмарка окна.');
 const sample={window,inferenceMs:positiveElapsed(inferenceMs),
  checkpointMs:positiveElapsed(checkpointMs),uniqueAudioSeconds};
 return {...b,committedWindows:b.committedWindows+1,
  uniqueAudioSeconds:b.uniqueAudioSeconds+uniqueAudioSeconds,
  checkpointMs:b.checkpointMs+sample.checkpointMs,
  windowTimings:[...b.windowTimings,sample].slice(-MAX_BENCH_WINDOW_TIMINGS)};
}
export function sampleMainThreadHeap(b:JobBenchmark):JobBenchmark{
 // Chromium non-standard performance.memory counts JS heap for this
 // context. It does NOT measure GPU, WASM, Workers or the browser process.
 const m=(typeof performance==='undefined'?null:performance as Performance&{memory?:{usedJSHeapSize?:number}})?.memory;
 const bytes=m?.usedJSHeapSize;
 if(typeof bytes!=='number'||!Number.isFinite(bytes)||bytes<=0)return b;
 return {...b,mainThreadHeapPeakBytes:Math.max(bytes,b.mainThreadHeapPeakBytes??0),memorySamples:b.memorySamples+1};
}
export function percentile(sorted:readonly number[],fraction:number):number|null{
 if(!sorted.length)return null;
 const rank=(sorted.length-1)*fraction,lo=Math.floor(rank),hi=Math.ceil(rank);
 return sorted[lo]+(sorted[hi]-sorted[lo])*(rank-lo);
}
function round(value:number|null,digits=2):number|null{
 return value===null||!Number.isFinite(value)?null:Number(value.toFixed(digits));
}
// Only explicit numeric fields. Never export arbitrary IndexedDB objects,
// filenames, speaker names, transcript text, exception strings or device IDs.
export function benchmarkReport(job:Job){
 const b=job.benchmark??emptyBenchmark();
 const successful=b.windowTimings.map(w=>w.inferenceMs).filter(v=>Number.isFinite(v)&&v>=0).sort((a,c)=>a-c);
 const checkpoint=b.windowTimings.map(w=>w.checkpointMs).filter(v=>Number.isFinite(v)&&v>=0).sort((a,c)=>a-c);
 const rtf=b.uniqueAudioSeconds>0?b.asrAttemptMs/(b.uniqueAudioSeconds*1000):null;
 return {
  schema:'iscribe.benchmark.v1',
  source:'browser-observed-timings',
  workload:'real-application-path',
  model:job.params.model,language:job.params.language,
  diarizationRequested:job.params.diarize,
  durationSeconds:job.duration??null,
  stage:job.stage,committedCheckpointWindows:job.nextWindow,
  attempts:b.attempts,failedAttempts:b.failedAttempts,workerRecoveries:b.workerRecoveries,
  runs:b.runs,resumedRuns:b.resumedRuns,failedRuns:b.failedRuns,
  measuredCommittedWindows:b.committedWindows,
  measuredUniqueAudioSeconds:round(b.uniqueAudioSeconds,5),
  timingsMs:{
   decode:round(b.decodeMs),pcmIntegrityCheck:round(b.pcmCheckMs),
   modelInitialization:round(b.modelInitMs),asrIncludingFailedAttempts:round(b.asrAttemptMs),
   checkpointPersistence:round(b.checkpointMs),speakerInference:round(b.speakerMs),
   jobRuns:round(b.runMs)
  },
  asrWindowMs:{count:successful.length,p50:round(percentile(successful,.5)),
   p95:round(percentile(successful,.95)),max:round(successful.at(-1)??null)},
  checkpointWindowMs:{count:checkpoint.length,p50:round(percentile(checkpoint,.5)),
   p95:round(percentile(checkpoint,.95)),max:round(checkpoint.at(-1)??null)},
  asrRtf:round(rtf,4),
  measuredRunRtf:round(b.uniqueAudioSeconds>0&&b.runMs>0?b.runMs/(b.uniqueAudioSeconds*1000):null,4),
  performanceProfiler:performanceReport(b.profiler),
  resourceManagement:resourceReport(b.resources),
  backendCalibration:calibrationReport(b.backendCalibration),
  mainThreadHeap:{
   sampleCount:b.memorySamples,
   observedPeakBytes:b.mainThreadHeapPeakBytes??null,
   limitation:'Chromium main-thread JS heap sample only; excludes Worker/WASM/GPU and may be unavailable.'
  },
  windowTimings:b.windowTimings.map(w=>({
   window:w.window,inferenceMs:round(w.inferenceMs),
   checkpointMs:round(w.checkpointMs),uniqueAudioSeconds:round(w.uniqueAudioSeconds,5)
  })),
  limitations:[
   'RTF is ASR attempt time divided by newly committed unique audio seconds; failed attempts increase numerator.',
   'Measured run RTF uses recorded run wall time divided by measured unique committed audio; includes retries, speaker passes and resumed runs, not unmeasured historical work.',
   'The stage timings are cumulative across resumed runs, not a precise CPU or full-system memory profile.',
   'This report alone does not establish quality, accuracy or real hardware benchmark acceptance.'
  ]
 };
}
export function downloadBenchmarkJson(report:ReturnType<typeof benchmarkReport>,filename:string):void{
 const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'});
 const url=URL.createObjectURL(blob);
 const link=document.createElement('a');link.href=url;link.download=filename;
 document.body.appendChild(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),30000);
}
