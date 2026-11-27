import {collectDeviceHints,type DeviceHints} from './profiler';
import {AdaptivePrefetch} from './adaptivePrefetch';
import {DEFAULT_PERFORMANCE_MODE} from './profiles';
import {resolveResourcePolicy} from './resourcePolicy';
import {isPerformanceMode,type PerformanceMode,type ResourcePolicy} from './types';
export const RESOURCE_MODE_KEY='iscribe:performance-mode:v1';
type ModeStorage=Pick<Storage,'getItem'|'setItem'>;
function browserStorage():ModeStorage|null{
 try{return typeof localStorage==='undefined'?null:localStorage}catch{return null}
}
export class ResourceManager{
 private mode:PerformanceMode=DEFAULT_PERFORMANCE_MODE;
 private cap:PerformanceMode='max';
 private hints:DeviceHints;
 private readonly adaptive=new AdaptivePrefetch();
 constructor(private readonly storage:ModeStorage|null=browserStorage(),hints:DeviceHints=collectDeviceHints()){
  this.hints=hints;
  try{const saved=storage?.getItem(RESOURCE_MODE_KEY);if(isPerformanceMode(saved))this.mode=saved}catch{/* Storage optional. */}
 }
 get selected():PerformanceMode{return this.mode}
 select(mode:PerformanceMode):void{
  if(!isPerformanceMode(mode))return;
  if(this.mode!==mode)this.adaptive.reset();
  this.mode=mode;
  try{this.storage?.setItem(RESOURCE_MODE_KEY,mode)}catch{/* Keep session preference. */}
 }
 beginRun():void{this.adaptive.reset();this.cap='max';this.hints=collectDeviceHints()}
 // Only existing retryable worker/GPU failure handling invokes this. It does
 // not add retries or interpret unknown failures as proof of memory pressure.
 restrictAfterRecovery():void{this.cap=this.cap==='max'?'medium':'eco'}
 observePrefetch(ready:boolean,waitMs:number):void{
  this.adaptive.observe(resolveResourcePolicy(this.mode,this.hints,this.cap).targetPrefetchWindows,ready,waitMs);
 }
 policy():ResourcePolicy{
  const base=resolveResourcePolicy(this.mode,this.hints,this.cap);
  const target=this.adaptive.target(base.targetPrefetchWindows);
  return {...base,targetPrefetchWindows:target,prefetchAdaptation:this.adaptive.snapshot(),
   reasons:target!==base.targetPrefetchWindows?[...base.reasons,'prefetch-adaptive']:base.reasons};
 }
}
export function waitAtBoundary(ms:number,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();
 if(ms<=0)return Promise.resolve();
 return new Promise<void>((resolve,reject)=>{
  const finish=()=>{signal.removeEventListener('abort',abort);resolve()};
  const timer=setTimeout(finish,ms);
  const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason??new DOMException('Aborted','AbortError'))};
  signal.addEventListener('abort',abort,{once:true});
 });
}
