import type {BackendId,TranscriptSegment} from '@yourdevice/engine';
import type {WhisperId} from '../ml/manager';
import type {DeviceHints} from './profiler';
import type {PerformanceMode} from './types';
declare const __ISCRIBE_BUILD_SHA__:string;
const revision=typeof __ISCRIBE_BUILD_SHA__==='string'&&__ISCRIBE_BUILD_SHA__!=='unavailable'?__ISCRIBE_BUILD_SHA__:null;
const KEY='iscribe:backend-calibration:v1';
const MAX_AGE_MS=7*24*60*60*1000;
export const BACKEND_CALIBRATION_SAMPLE_LIMIT=15*16000;
export const BACKEND_CALIBRATION_STAGE_MS=120_000;
export type CalibrationSample={backend:BackendId;status:'passed'|'mismatch'|'empty'|'failed';inferenceMs:number|null;initializationMs:number|null};
export type BackendCalibration={version:1;sampleSeconds:number;baseline:BackendId;chosen:BackendId;samples:CalibrationSample[];elapsedMs:number;selection:'compared'|'baseline-only'|'no-reference'};
type SavedChoice={backend:BackendId;at:number};
type ModeStorage=Pick<Storage,'getItem'|'setItem'>;
function browserStorage():ModeStorage|null{try{return typeof localStorage==='undefined'?null:localStorage}catch{return null}}
export function isBackend(value:unknown):value is BackendId{return value==='wasm'||value==='webgpu'||value==='webnn'}
export function candidates(baseline:BackendId,hints:DeviceHints):BackendId[]{
 // Engine initialization is the real capability test, not API presence.
 return [...new Set<BackendId>([baseline,...(hints.webGpuApi===true?['webgpu' as const]:[]),...(hints.webNnApi===true?['webnn' as const]:[]),'wasm'])];
}
export function normalizedText(segments:readonly TranscriptSegment[]):string{
 return segments.map(s=>s.text).join(' ').normalize('NFC').replace(/\s+/gu,' ').trim();
}
export function chooseBackend(baseline:BackendId,samples:readonly CalibrationSample[]):BackendId{
 const reference=samples.find(s=>s.backend===baseline&&s.status==='passed');
 if(!reference||reference.inferenceMs===null||reference.inferenceMs<=0)return baseline;
 const valid=samples.filter(s=>s.status==='passed'&&s.inferenceMs!==null&&Number.isFinite(s.inferenceMs)&&s.inferenceMs>0);
 const best=[...valid].sort((a,b)=>a.inferenceMs!-b.inferenceMs!)[0];
 // Avoid replacing a stable baseline for measurement noise.
 return best&&best.inferenceMs!<reference.inferenceMs*0.9?best.backend:baseline;
}
export function resourceFailure(error:unknown):boolean{
 if(!error||typeof error!=='object')return false;
 const e=error as {code?:unknown;message?:unknown};
 return e.code==='out-of-memory'||e.code==='allocation-failed'||(typeof e.message==='string'&&/out.of.memory|allocation.failed|not enough memory/i.test(e.message));
}
export class BackendPolicy{
 private choices:Record<string,SavedChoice>={};
 constructor(private storage:ModeStorage|null=browserStorage(),private build:string|null=revision,private now:()=>number=Date.now){
  if(!build)return;
  try{
   const raw=JSON.parse(storage?.getItem(KEY)??'null') as {build?:unknown;choices?:Record<string,unknown>}|null;
   if(raw?.build!==build||!raw.choices)return;
   for(const [key,value] of Object.entries(raw.choices)){
    if(!/^(whisper-tiny|whisper-small|whisper-large-v3):(ru|en)$/.test(key)||!value||typeof value!=='object')continue;
    const c=value as SavedChoice;
    if(isBackend(c.backend)&&Number.isFinite(c.at)&&c.at<=this.now()&&this.now()-c.at<=MAX_AGE_MS)this.choices[key]={backend:c.backend,at:c.at};
   }
  }catch{/* Optional local storage. */}
 }
 private key(model:WhisperId,language:'ru'|'en'){return model+':'+language}
 private save(){if(this.build)try{this.storage?.setItem(KEY,JSON.stringify({build:this.build,choices:this.choices}))}catch{/* Session only. */}}
 preferred(model:WhisperId,language:'ru'|'en',mode:PerformanceMode,hints:DeviceHints):BackendId|undefined{
  if(mode==='eco')return undefined; // Speed is not evidence of energy efficiency.
  const key=this.key(model,language),choice=this.choices[key];
  if(!choice)return undefined;
  if(this.now()-choice.at>MAX_AGE_MS||this.now()<choice.at){delete this.choices[key];this.save();return undefined}
  if((choice.backend==='webgpu'&&hints.webGpuApi!==true)||(choice.backend==='webnn'&&hints.webNnApi!==true))return undefined;
  return choice.backend;
 }
 remember(model:WhisperId,language:'ru'|'en',backend:BackendId){this.choices[this.key(model,language)]={backend,at:this.now()};this.save()}
 invalidate(model:WhisperId,language:'ru'|'en',backend:unknown){
  const key=this.key(model,language);if(this.choices[key]?.backend===backend){delete this.choices[key];this.save()}
 }
}
export function calibrationReport(value:BackendCalibration|undefined){
 if(!value)return null;
 return {version:1,sampleSeconds:value.sampleSeconds,baseline:value.baseline,chosen:value.chosen,selection:value.selection,elapsedMs:value.elapsedMs,
  samples:value.samples.slice(0,3).map(s=>({backend:s.backend,status:s.status,inferenceMs:s.inferenceMs,initializationMs:s.initializationMs})),
  limitation:'Single local speech sample, warm-up plus two measured passes; median of two is their mean. Exact normalized text agreement is a guard, not a WER or hardware acceptance test. Backend-specific engine dtype is unchanged; energy and GPU utilization are not measured.'};
}
