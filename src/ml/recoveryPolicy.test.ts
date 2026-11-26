import {StreamDecodeStalledError} from './activityWatchdog';
import {expect,it} from 'vitest';
import {MAX_ASR_WINDOW_ATTEMPTS,MAX_STREAM_JOB_RECOVERIES,reserveStreamRecovery,isRetryableAsrError,shouldRetryAsrWindow,preferWasmAfterFailure} from './recoveryPolicy';
it('bounds inference restarts to two retries per window',()=>{
 const fault={code:'worker-failed',message:'worker crashed'};
 expect(MAX_ASR_WINDOW_ATTEMPTS).toBe(3);
 expect(shouldRetryAsrWindow(fault,1)).toBe(true);
 expect(shouldRetryAsrWindow(fault,2)).toBe(true);
 expect(shouldRetryAsrWindow(fault,3)).toBe(false);
 expect(shouldRetryAsrWindow(fault,0)).toBe(false);
});
it('never repeats cancellation, storage, download or severe memory errors',()=>{
 for(const error of [
  {code:'aborted',message:'aborted by user'},
  {code:'transcribe-failed',message:'out of memory'},
  {code:'transcribe-failed',message:'network unavailable'},
  {code:'model-load-failed',message:'model error'},
  new Error('Ошибка локального сохранения.'),
 ])expect(isRetryableAsrError(error)).toBe(false);
});
it('retries known failed Worker/inference errors and prefers WASM over GPU',()=>{
 expect(isRetryableAsrError({code:'worker-failed',message:'worker unavailable'})).toBe(false);
 expect(isRetryableAsrError({code:'worker-failed',message:'Worker died unexpectedly'})).toBe(true);
 expect(isRetryableAsrError({code:'transcribe-failed',message:'unknown inference failure'})).toBe(true);
 expect(isRetryableAsrError({code:'gpu-device-lost',message:'GPU device lost'})).toBe(true);
 expect(isRetryableAsrError({code:'webgpu-device-lost',message:'WebGPU device lost'})).toBe(true);
 expect(isRetryableAsrError({code:'gpu-device-lost',message:'out of memory'})).toBe(false);
 expect(preferWasmAfterFailure('webgpu')).toBe(true);
 expect(preferWasmAfterFailure('webnn')).toBe(true);
 expect(preferWasmAfterFailure('wasm')).toBe(true);
 expect(preferWasmAfterFailure('Не инициализировано')).toBe(false);
});


it('allows only one fresh stream decoder per window and five per job',()=>{
 const fault=new StreamDecodeStalledError();
 let state=reserveStreamRecovery(fault,41);
 expect(state).toEqual({window:41,windowRecoveries:1,totalRecoveries:1});
 expect(reserveStreamRecovery(fault,41,state!)).toBeNull();
 for(let window=42;window<=45;window++)state=reserveStreamRecovery(fault,window,state!);
 expect(state?.totalRecoveries).toBe(MAX_STREAM_JOB_RECOVERIES);
 expect(reserveStreamRecovery(fault,46,state!)).toBeNull();
});
it('never retries opening, PCM, cancellation, storage or arbitrary errors',()=>{
 for(const error of [new StreamDecodeStalledError('open'),new StreamDecodeStalledError('pcm-check'),new Error('storage'),new Error('decode'),new DOMException('aborted','AbortError')])
  expect(reserveStreamRecovery(error,41)).toBeNull();
 expect(reserveStreamRecovery(new StreamDecodeStalledError('resample'),41)).not.toBeNull();
});
