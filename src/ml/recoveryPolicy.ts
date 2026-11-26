import {StreamDecodeStalledError} from './activityWatchdog';
// Retry only inference/worker failures, never user cancellation, local storage
// errors or model/decode/download failures. Three attempts per audio window.
export const MAX_ASR_WINDOW_ATTEMPTS=3;
type CodedError={code?:unknown;message?:unknown};
const NON_RETRYABLE=/\b(abort(?:ed)?|cancel(?:led)?|quota|storage|indexeddb|no.backend|model.load|network|fetch|decode|out.of.memory|allocation|permission|unavailable)\b/i;
const TRANSIENT=/\b(worker(?:\s+\w+){0,3}\s+(?:failed|crashed|terminated|exited)|gpu\s+(?:device\s+)?lost|device\s+lost|context\s+lost)\b/i;
export function isRetryableAsrError(error:unknown):boolean {
 if(!error||typeof error!=='object')return false;
 const {code,message}=(error as CodedError);
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


// First recovery reopens the decoder; the second uses bounded subwindows.
export const MAX_STREAM_WINDOW_RECOVERIES=2;
export const STREAM_SUBWINDOW_SAMPLES=5*16000;
export const MAX_STREAM_JOB_RECOVERIES=5;
export type StreamRecoveryState={window:number;windowRecoveries:number;totalRecoveries:number};
export function reserveStreamRecovery(error:unknown,window:number,previous?:StreamRecoveryState):StreamRecoveryState|null{
 if(!(error instanceof StreamDecodeStalledError)||(error.stage!=='decode'&&error.stage!=='resample'))return null;
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
