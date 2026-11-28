// A run-local stage controller. JobRunner remains the sole owner of queue,
// cancellation, models, retry budgets and durable JobStore checkpoints.
export const PIPELINE_STAGES=['preflight','decode','pcm-gate','vad','segmentation','asr','diarization','speaker-assignment','finalize','export'] as const;
export type PipelineStage=typeof PIPELINE_STAGES[number];
export type PipelineState='running'|'completed'|'deferred'|'skipped'|'reused'|'failed'|'cancelled'|'requested'|'manual';
export type PipelineReason='per-window-validation'|'asr-already-committed'|'speakers-disabled'|'streaming-speakers-unavailable'|'vad-disabled'|'vad-streaming-unavailable'|'vad-unavailable';
export type PipelineObservation={stage:PipelineStage;state:PipelineState;reason?:PipelineReason;elapsedMs?:number};
export type PcmGateResult={mode:'full'|'windowed';samples:number};
export type ExportOutcome='requested'|'manual';
export type PipelineOutputs<Audio,Plan,Turns>={
 preflight:File;
 decode:Audio;
 'pcm-gate':PcmGateResult;
 vad:'observed'|'fallback'|'reused';
 segmentation:Plan;
 asr:void;
 diarization:Turns;
 'speaker-assignment':void;
 finalize:void;
 export:ExportOutcome;
};
type Skip=
 |{stage:'vad';reason:'vad-disabled'|'vad-streaming-unavailable'|'asr-already-committed'}
 |{stage:'segmentation'|'asr';reason:'asr-already-committed'}
 |{stage:'diarization'|'speaker-assignment';reason:'speakers-disabled'|'streaming-speakers-unavailable'};

export class PipelineOrchestrator<Audio,Plan,Turns>{
 private cursor=0;
 private active=false;
 private failed=false;
 private readonly skipped:Partial<Record<PipelineStage,PipelineReason>>={};
 constructor(private readonly signal:AbortSignal,
  private readonly observe:(event:PipelineObservation,error?:unknown)=>void,
  private readonly now:()=>number=()=>performance.now()){}
 private assertNext(stage:PipelineStage){
  if(this.active||this.failed||PIPELINE_STAGES[this.cursor]!==stage)
   throw new Error('Нарушена последовательность этапов конвейера: '+stage);
 }
 get complete(){return !this.active&&!this.failed&&this.cursor===PIPELINE_STAGES.length}
 async run<S extends PipelineStage>(stage:S,work:()=>PipelineOutputs<Audio,Plan,Turns>[S]|Promise<PipelineOutputs<Audio,Plan,Turns>[S]>):Promise<PipelineOutputs<Audio,Plan,Turns>[S]>{
  this.assertNext(stage);
  if(stage==='asr'&&this.skipped.segmentation||stage==='speaker-assignment'&&this.skipped.diarization)
   throw new Error('Входной этап был пропущен: '+stage);
  this.active=true;
  const started=this.now();
  try{
   this.observe({stage,state:'running'});
   this.signal.throwIfAborted();
   const value=await work();
   // Successful operations may return an owned decoder handle; cancellation
   // after return is checked by its caller, which owns disposal.
   let state:PipelineState='completed',reason:PipelineReason|undefined;
   if(stage==='pcm-gate'&&(value as PcmGateResult).mode==='windowed'){state='deferred';reason='per-window-validation'}
   if(stage==='vad'){if(value==='fallback'){state='skipped';reason='vad-unavailable'}else if(value==='reused')state='reused'}
   if(stage==='export')state=value==='requested'?'requested':'manual';
   this.cursor++;
   this.observe({stage,state,reason,elapsedMs:Math.max(0,this.now()-started)});
   return value;
  }catch(error){
   this.failed=true;
   this.observe({stage,state:this.signal.aborted?'cancelled':'failed',elapsedMs:Math.max(0,this.now()-started)},error);
   throw error;
  }finally{this.active=false}
 }
 skip(spec:Skip):void{
  this.assertNext(spec.stage);this.signal.throwIfAborted();
  if(spec.stage==='asr'&&this.skipped.segmentation!==spec.reason||spec.stage==='speaker-assignment'&&this.skipped.diarization!==spec.reason)
   throw new Error('Причина пропуска не совпадает с зависимым этапом: '+spec.stage);
  this.skipped[spec.stage]=spec.reason;
  this.cursor++;
  this.observe({stage:spec.stage,state:spec.stage==='asr'?'reused':'skipped',reason:spec.reason});
 }
}
