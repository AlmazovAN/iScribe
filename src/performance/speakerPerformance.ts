import type {WasmThreadConfiguration} from './wasmThreads';
export type SpeakerStage='preparation'|'speech-search'|'speaker-search';
export type SpeakerPassObservation={
 version:1;requestedBackend:'wasm';dtype:'q8';threads:WasmThreadConfiguration;
 audioSeconds:number;status:'running'|'passed'|'failed';
 transfer:'transferred'|'cloned'|null;
 progressEvents:number;preparationToFirstSpeechMs:number|null;
 firstSpeechToFirstSpeakerMs:number|null;firstSpeakerToEndMs:number|null;totalMs:number|null;
};
export function createSpeakerObservation(requested:number,audioSamples:number):SpeakerPassObservation{
 return {version:1,requestedBackend:'wasm',dtype:'q8',threads:{requested,configured:null},audioSeconds:audioSamples/16000,
  status:'running',transfer:null,progressEvents:0,preparationToFirstSpeechMs:null,firstSpeechToFirstSpeakerMs:null,firstSpeakerToEndMs:null,totalMs:null};
}
export function speakerStage(status:string):SpeakerStage|null{
 if(status==='Подготовка моделей говорящих')return 'preparation';
 if(status==='Поиск речи')return 'speech-search';
 if(status==='Разделение говорящих')return 'speaker-search';
 return null;
}
export class SpeakerPassMeter{
 readonly observation:SpeakerPassObservation;
 private firstSpeech:number|null=null;
 private firstSpeaker:number|null=null;
 constructor(requested:number,samples:number,private started:number){
  this.observation=createSpeakerObservation(requested,samples);
 }
 progress(status:string,now:number){
  this.observation.progressEvents++;
  const stage=speakerStage(status),elapsed=Math.max(0,now-this.started);
  if(stage==='speech-search'&&this.firstSpeech===null){
   this.firstSpeech=elapsed;this.observation.preparationToFirstSpeechMs=elapsed;
  }
  if(stage==='speaker-search'&&this.firstSpeaker===null){
   this.firstSpeaker=elapsed;
   if(this.firstSpeech!==null)this.observation.firstSpeechToFirstSpeakerMs=Math.max(0,elapsed-this.firstSpeech);
  }
 }
 finish(passed:boolean,now:number){
  const elapsed=Math.max(0,now-this.started);
  this.observation.status=passed?'passed':'failed';this.observation.totalMs=elapsed;
  if(this.firstSpeaker!==null)this.observation.firstSpeakerToEndMs=Math.max(0,elapsed-this.firstSpeaker);
 }
}
export type SpeakerPerformance={version:1;passes:number;failedPasses:number;lastPass:SpeakerPassObservation|null;alignmentMs:number;alignmentQueries:number;alignmentCandidates:number};
export function emptySpeakerPerformance():SpeakerPerformance{return {version:1,passes:0,failedPasses:0,lastPass:null,alignmentMs:0,alignmentQueries:0,alignmentCandidates:0}}
export function speakerPerformanceReport(value:SpeakerPerformance|undefined){
 if(!value)return null;
 const p=value.lastPass;
 return {version:1,passes:value.passes,failedPasses:value.failedPasses,alignmentMs:Math.round(value.alignmentMs*100)/100,alignmentQueries:value.alignmentQueries,alignmentCandidates:value.alignmentCandidates,
  lastPass:p?{requestedBackend:p.requestedBackend,dtype:p.dtype,threads:{requested:p.threads.requested,configured:p.threads.configured},audioSeconds:p.audioSeconds,status:p.status,transfer:p.transfer,progressEvents:p.progressEvents,
   preparationToFirstSpeechMs:p.preparationToFirstSpeechMs,firstSpeechToFirstSpeakerMs:p.firstSpeechToFirstSpeakerMs,firstSpeakerToEndMs:p.firstSpeakerToEndMs,totalMs:p.totalMs}:null,
  limitation:'Intervals are host-observed progress milestones, not exact individual model inference times. WASM/q8 is the pinned engine policy, not provider telemetry. Active thread count, embedding batch behavior, RAM and GPU use are not measured.'};
}
