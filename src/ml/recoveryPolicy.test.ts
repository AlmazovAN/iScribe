import {expect,it} from 'vitest';
import {MAX_ASR_WINDOW_ATTEMPTS,isRetryableAsrError,shouldRetryAsrWindow,preferWasmAfterFailure} from './recoveryPolicy';
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
 expect(preferWasmAfterFailure('webgpu')).toBe(true);
 expect(preferWasmAfterFailure('webnn')).toBe(true);
 expect(preferWasmAfterFailure('wasm')).toBe(true);
 expect(preferWasmAfterFailure('Не инициализировано')).toBe(false);
});
