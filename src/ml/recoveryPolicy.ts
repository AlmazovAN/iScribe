import {StreamDecodeStalledError} from './activityWatchdog';
import {canRetryFfmpeg} from '../decoderDiagnostics';
// Retry only inference/worker failures, never user cancellation, local storage
// errors or model/decode/download failures. One initial attempt plus one retry.
import {MAX_OPERATION_ATTEMPTS} from '../recoveryManager';
export const MAX_ASR_WINDOW_ATTEMPTS=MAX_OPERATION_ATTEMPTS;
type CodedError={code?:unknown;message?:unknown};
const NON_RETRYABLE=/\b(abort(?:ed)?|cancel(?:led)?|quota|storage|indexeddb|no.backend|model.load|network|fetch|decode|out.of.memory|allocation|permission|unavailable)\b/i;
const TRANSIENT=/\b(worker(?:\s+\w+){0,3}\s+(?:failed|crashed|terminated|exited)|gpu\s+(?:device\s+)?lost|device\s+lost|context\s+lost)\b/i;
export function isRetryableAsrError(error:unknown):boolean {
 if(!error||typeof error!=='object')return false;
 const {code,message,name}=(error as CodedError&{name?:unknown});
 if(name==='AbortError'||name==='QuotaExceededError'||name==='NetworkError'||code==='aborted'||code==='storage-failed'||code==='checkpoint-integrity'||code==='audio-validation-failed'||code==='recovery-exhausted'||code==='worker-disposal-failed')return false;
 const text=typeof message==='string'?message:'';
 if(NON_RETRYABLE.test(text))return false;
 if(code==='worker-failed'||code==='transcribe-failed'||code==='gpu-device-lost'||code==='webgpu-device-lost')return true;
 return typeof code!=='string'&&TRANSIENT.test(text);
}
export function shouldRetryAsrWindow(error:unknown,attempt:number):boolean {
 return Number.isInteger(attempt)&&attempt>=1&&attempt<MAX_ASR_WINDOW_ATTEMPTS&&isRetryableAsrError(error);
}
export function preferWasmAfterFailure(backend:string):boolean {
 // A degraded GPU/NPU inference graph must never silently reuse the same
 // backend on a recovery attempt. Keep WASM if WASM itself failed.
 return backend==='webnn'||backend==='webgpu'||backend==='wasm';
}


// A single recovery reopens the decoder, with whole or split strategy.
export const MAX_STREAM_WINDOW_RECOVERIES=1;
export const STREAM_SUBWINDOW_SAMPLES=5*16000;
// Proactive rotation is a resource policy, not an automatic recovery attempt.
export const DEFAULT_STREAM_ROTATE_WINDOWS=20;
export const MAX_STREAM_JOB_RECOVERIES=5;
export type StreamRecoveryState={window:number;windowRecoveries:number;totalRecoveries:number};
export function isRetryableStreamError(error:unknown):boolean{
 return error instanceof StreamDecodeStalledError&&(error.stage==='decode'||error.stage==='resample')||canRetryFfmpeg(error,'windowed');
}
export function reserveStreamRecovery(error:unknown,window:number,previous?:StreamRecoveryState):StreamRecoveryState|null{
 return isRetryableStreamError(error)?advanceStreamRecovery(window,previous):null;
}
export function advanceStreamRecovery(window:number,previous?:StreamRecoveryState):StreamRecoveryState|null{
 if(!Number.isSafeInteger(window)||window<1)return null;
 if(previous&&(!Number.isSafeInteger(previous.window)||previous.window<1||previous.window>window||
  !Number.isSafeInteger(previous.totalRecoveries)||previous.totalRecoveries<0||
  !Number.isSafeInteger(previous.windowRecoveries)||previous.windowRecoveries<0||
  previous.windowRecoveries>previous.totalRecoveries))return null;
 const total=previous?.totalRecoveries??0;
 const used=previous?.window===window?previous.windowRecoveries:0;
 if(total>=MAX_STREAM_JOB_RECOVERIES||used>=MAX_STREAM_WINDOW_RECOVERIES)return null;
 return {window,windowRecoveries:used+1,totalRecoveries:total+1};
}
