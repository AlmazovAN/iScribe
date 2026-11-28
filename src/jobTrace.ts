import type {Job} from './jobs';
import {expectedWindows} from './jobDiagnostics';
import {benchmarkReport} from './benchmark';
import {AudioValidationError,type PcmQualityEvidence} from './audioValidation';
import {decoderReport,FfmpegDecoderError,type AudioDecoderKind,type DecoderRoute,type FfmpegFailure,type FfmpegStage,type FfmpegDetailCode} from './decoderDiagnostics';

// Structured diagnostic events deliberately omit filenames, transcript text,
// raw exception messages, audio buffers and browser/device identifiers.
export type TracePhase='job'|'audio'|'model'|'asr'|'checkpoint'|'speaker';
export type TraceCode=
 'decoder-selected'|'decoder-full-retry'|'decoder-full-error'|'decoder-open-error'|'job-start'|'audio-start'|'audio-ready'|'audio-check-start'|'audio-check-pass'|'audio-check-error'|'model-start'|'model-ready'|
 'window-inspection-start'|'window-inspection-pass'|'window-inspection-error'|'window-inspection-cancelled'|
 'stream-rotation-start'|'stream-rotation-ready'|'stream-rotation-error'|'stream-session-closed'|'stream-session-close-error'|
 'stream-split-start'|'stream-split-part-ready'|'stream-split-ready'|
 'stream-recovery-start'|'stream-reopen-ready'|'stream-recovered'|'stream-recovery-stop'|
 'stream-read-start'|'stream-samples'|'stream-read-end'|'stream-resample-start'|'stream-resample-end'|'stream-pcm-check-start'|'stream-pcm-check-end'|'checkpoint-start'|
 'window-start'|'window-attempt'|'window-result'|'window-error'|'window-retry'|
 'checkpoint-committed'|'checkpoint-error'|'speaker-start'|'speaker-result'|'speaker-alignment'|'speaker-error'|
 'job-complete'|'job-error'|'job-cancelled';
export type TraceErrorKind='worker'|'timeout'|'inference'|'network'|'storage'|'cancelled'|'invalid-audio'|'decoder'|'other';
export type TraceBackend='webgpu'|'webnn'|'wasm'|'unknown';
export type StreamStage='open'|'decode'|'resample'|'pcm-check';
export type TraceEvent={
 at:number;
 phase:TracePhase;
 code:TraceCode;
 elapsedMs?:number;
 backend?:TraceBackend;
 window?:number;
 totalWindows?:number;
 attempt?:number;
 startSample?:number;
 endSample?:number;
 pcmSamples?:number;
 pcmQuality?:PcmQualityEvidence;
 pcmFailureReason?:AudioValidationError['reason'];
 pcmFailureWindow?:number;
 pcmFailureSample?:number;
 durationDeltaSamples?:number;
 decoderId?:number;
 decoderKind?:AudioDecoderKind;
 decoderRoute?:DecoderRoute;
 decoderFailure?:FfmpegFailure;
 decoderFailureStage?:FfmpegStage;
 decoderExitCode?:number;
 decoderDetails?:FfmpegDetailCode[];
 decoderErrorLines?:number;
 recoveryCount?:number;
 decoderWindows?:number;
 rotationCount?:number;
 closeReason?:'rotation'|'recovery'|'finish'|'error'|'cancel';
 strategy?:'whole'|'split';
 part?:number;
 totalParts?:number;
 streamStage?:StreamStage;
 packets?:number;
 decodedFrames?:number;
 sourceSampleRate?:number;
 jsHeapBytes?:number;
 committedWindows?:number;
 segmentCount?:number;
 unlabeled?:number;
 ambiguous?:number;
 uncovered?:number;
 boundaryMatches?:number;
 errorKind?:TraceErrorKind;
};
export function pcmValidationFields(error:unknown):Pick<TraceEvent,'pcmFailureReason'|'pcmFailureWindow'|'pcmFailureSample'>{
 if(!(error instanceof AudioValidationError))return {};
 return {pcmFailureReason:error.reason,pcmFailureWindow:error.windowNumber??undefined,pcmFailureSample:error.sampleIndex??undefined};
}
export const MAX_TRACE_EVENTS=4096;
export function appendTrace(events:readonly TraceEvent[]|undefined,event:TraceEvent):TraceEvent[]{
 return [...(events??[]),event].slice(-MAX_TRACE_EVENTS);
}
export function traceHeapBytes():number|undefined{
 const bytes=(typeof performance==='undefined'?undefined:(performance as Performance&{memory?:{usedJSHeapSize?:number}}).memory?.usedJSHeapSize);
 return typeof bytes==='number'&&Number.isFinite(bytes)&&bytes>0?bytes:undefined;
}
export function traceBackend(raw:unknown):TraceBackend{
 return raw==='webgpu'||raw==='webnn'||raw==='wasm'?raw:'unknown';
}
export function traceErrorKind(error:unknown):TraceErrorKind{
 if(error instanceof FfmpegDecoderError)return error.failure==='timeout'?'timeout':error.failure==='worker'?'worker':'decoder';
 if(error&&typeof error==='object'){
  const value=error as {code?:unknown;name?:unknown};
  if(value.name==='WorkerStalledError'||value.name==='StreamDecodeStalledError')return 'timeout';
  if(value.code==='audio-validation-failed')return 'invalid-audio';
  if(value.code==='worker-failed')return 'worker';
  if(value.code==='transcribe-failed')return 'inference';
  if(value.name==='AbortError')return 'cancelled';
  if(value.name==='QuotaExceededError'||value.code==='storage-failed')return 'storage';
  if(value.name==='NetworkError'||value.code==='network-failed')return 'network';
 }
 // Do not inspect, classify or export arbitrary error.message strings:
 // they can contain source paths, filenames or captured audio/transcript data.
 return 'other';
}
export function diagnosticReport(job:Job){
 const now=Date.now();
 const events=[...(job.trace??[])].reverse();
 const last=events.find(e=>e.phase==='asr'&&(e.code==='window-attempt'||e.code==='window-result'||e.code==='window-error'));
 const activeAttempt=job.stage==='recognizing'&&last?.code==='window-attempt'?{
  window:last.window??null,attempt:last.attempt??null,backend:last.backend??null,
  startedAt:last.at,elapsedSinceAttemptEventMs:Math.max(0,now-last.at)
 }:null;
 const failure=job.failure?{
  reason:job.failure.reason,
  stage:job.failure.stage,
  backend:traceBackend(job.failure.backend),
  completedWindows:job.failure.completedWindows,
  totalWindows:job.failure.totalWindows,
  checkpointSeconds:job.failure.checkpointSeconds,
  observedExit:job.failure.observedExit
 }:null;
 return {
  schema:'iscribe.diagnostics.v1',
  generatedAt:new Date(now).toISOString(),
  activeAsrAttempt:activeAttempt,
  benchmark:job.benchmark?.runs?benchmarkReport(job):null,
  job:{
   model:job.params.model,
   language:job.params.language,
   diarizationEnabled:job.params.diarize,
   stage:job.stage,
   fileSizeBytes:job.size,
   durationSeconds:job.duration??null,
   committedWindows:job.nextWindow,
   totalWindows:expectedWindows(job.duration),
   asrComplete:job.asrComplete,
   backend:traceBackend(job.backend)
  },
  decoder:decoderReport(job.decoderIdentity),
  fullDecodeRecoveries:job.fullDecodeRecoveries??0,
  streamRecovery:job.streamRecovery?{window:job.streamRecovery.window,windowRecoveries:job.streamRecovery.windowRecoveries,totalRecoveries:job.streamRecovery.totalRecoveries}:null,
  lastFailure:failure,
  audioCheck:job.audioCheck?.status==='passed'?job.audioCheck:job.audioCheck?.status==='failed'?{status:'failed',checkedAt:job.audioCheck.checkedAt}:null,
  windowInspections:(job.windowInspections??[]).map(r=>({window:r.window,strategy:r.strategy,status:r.status,checkedAt:r.checkedAt,elapsedMs:r.elapsedMs,startSample:r.startSample,endSample:r.endSample,totalWindows:r.totalWindows,completedParts:r.completedParts,errorKind:r.errorKind,failureStage:r.failureStage,report:r.report?{pcmSamples:r.report.pcmSamples,durationSeconds:r.report.durationSeconds,windowCount:r.report.windowCount,quietWindows:r.report.quietWindows,nearClippedWindows:r.report.nearClippedWindows,peakAbsolute:r.report.peakAbsolute,quality:r.report.quality}:undefined})),
  speakerAlignment:job.diagnostics?{
   turns:job.diagnostics.turns,validTurns:job.diagnostics.validTurns??null,
   invalidTurns:job.diagnostics.invalidTurns??null,mergedTurns:job.diagnostics.mergedTurns??null,
   speakerCount:job.diagnostics.speakerCount??null,turnCoverageSeconds:job.diagnostics.turnCoverageSeconds??null,
   segments:job.diagnostics.segments,emptyText:job.diagnostics.emptyText??null,labeled:job.diagnostics.labeled??null,
   unlabeled:job.diagnostics.unlabeled,overlapMatches:job.diagnostics.overlapMatches??null,
   boundaryMatches:job.diagnostics.boundaryMatches??null,ambiguous:job.diagnostics.ambiguous??null,
   uncovered:job.diagnostics.uncovered??null,weakEvidence:job.diagnostics.weakEvidence??null,
   invalidSegments:job.diagnostics.invalidSegments??null,zeroDuration:job.diagnostics.zeroDuration
  }:null,
  events:job.trace??[],
  eventsLimit:MAX_TRACE_EVENTS,
  notice:'Лог не содержит аудио, текста записи, имени исходного файла и сообщений исключений.'
 };
}
export function downloadDiagnosticJson(report:ReturnType<typeof diagnosticReport>,filename:string):void{
 const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'});
 const url=URL.createObjectURL(blob);
 const link=document.createElement('a');link.href=url;link.download=filename;
 document.body.appendChild(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),30000);
}
