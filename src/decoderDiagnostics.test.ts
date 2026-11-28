import {describe,expect,it} from 'vitest';
import {FfmpegDecoderError,canRetryFfmpeg,decoderIdentity,resolveJobDecoder,ffmpegFailure,ffmpegFailureFields,decoderReport,safeFfmpegDetails} from './decoderDiagnostics';
import {reserveStreamRecovery} from './ml/recoveryPolicy';
import {diagnosticReport,traceErrorKind} from './jobTrace';
import {createJob} from './jobs';

describe('DEC-03: bounded decoder recovery and provenance',()=>{
 it('pins experimental decoder even when later URL selects legacy',()=>{
  const existing=decoderIdentity('ffmpeg','windowed');
  expect(resolveJobDecoder(existing,true,'legacy','windowed')).toEqual(existing);
 });
 it('keeps historical checkpoints on legacy and applies opt-in only to new jobs',()=>{
  expect(resolveJobDecoder(undefined,true,'ffmpeg','full').kind).toBe('legacy');
  expect(resolveJobDecoder(undefined,false,'ffmpeg','full').kind).toBe('ffmpeg');
 });
 it('rejects mismatched route and revision without moving checkpoint',()=>{
  const identity=decoderIdentity('ffmpeg','windowed');
  expect(()=>resolveJobDecoder(identity,true,'ffmpeg','full')).toThrow();
  expect(()=>resolveJobDecoder({...identity,revision:'old'},true,'ffmpeg','windowed')).toThrow();
 });
 it('retries only transient decode errors, with bounded coverage recovery in window mode',()=>{
  for(const failure of ['worker','timeout'] as const){
   const error=new FfmpegDecoderError(failure,'decode');
   expect(canRetryFfmpeg(error,'full')).toBe(true);
   expect(canRetryFfmpeg(error,'windowed')).toBe(true);
  }
  const short=new FfmpegDecoderError('coverage','decode');
  expect(canRetryFfmpeg(short,'full')).toBe(false);
  const a=reserveStreamRecovery(short,41),b=reserveStreamRecovery(short,41,a!);
  expect(a).toEqual({window:41,windowRecoveries:1,totalRecoveries:1});
  expect(b).toEqual({window:41,windowRecoveries:2,totalRecoveries:2});
  expect(reserveStreamRecovery(short,41,b!)).toBeNull();
  expect(reserveStreamRecovery(short,42,{window:41,windowRecoveries:2,totalRecoveries:5})).toBeNull();
  for(const failure of ['decode','runtime','asset','initialize','protocol','probe','probe-exit','probe-json','probe-metadata','length','duration','timeline','workerfs','window'] as const)
   expect(reserveStreamRecovery(new FfmpegDecoderError(failure,'decode'),1)).toBeNull();
  expect(canRetryFfmpeg(new FfmpegDecoderError('worker','open'),'windowed')).toBe(false);
 });
 it('exports fixed decoder failure codes and never raw details',()=>{
  const error=new FfmpegDecoderError('decode','decode',1);
  expect(traceErrorKind(error)).toBe('decoder');
  expect(ffmpegFailure('SECRET stderr')).toBe('runtime');
  expect(ffmpegFailureFields(error)).toEqual({decoderFailure:'decode',decoderFailureStage:'decode',decoderExitCode:1});
  expect(decoderReport({...decoderIdentity('ffmpeg','full'),revision:'PRIVATE PATH'})).toBeNull();
  const job=createJob(new File(['private audio'],'secret.mp3'),{model:'whisper-small',language:'ru',diarize:false});
  const report=diagnosticReport({...job,decoderIdentity:decoderIdentity('ffmpeg','windowed'),fullDecodeRecoveries:1,
   audioCheck:{status:'failed',checkedAt:0,problem:'PRIVATE RAW ERROR'}});
  expect(report.decoder?.kind).toBe('ffmpeg');
  expect(report.fullDecodeRecoveries).toBe(1);
  expect(JSON.stringify(report)).not.toContain('PRIVATE RAW ERROR');
  expect(JSON.stringify(report)).not.toContain('secret.mp3');
 });
});

it('allows only known decoder stderr categories and bounded numeric counters',()=>{
 const diagnostic=safeFfmpegDetails(['damaged-frame','PRIVATE PATH','damaged-frame'],2);
 expect(diagnostic).toEqual({details:['damaged-frame'],errorLines:2});
 expect(safeFfmpegDetails(['io'],10001)).toBeUndefined();
 expect(ffmpegFailureFields(new FfmpegDecoderError('decode','decode',1,diagnostic))).toMatchObject({
  decoderDetails:['damaged-frame'],decoderErrorLines:2,decoderExitCode:1
 });
});
