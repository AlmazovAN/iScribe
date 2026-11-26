// Imports only explicit allowed values. Raw report objects, file names,
// transcript data and arbitrary free text never enter the comparison export.
export const PERFORMANCE_CASES=[
 {id:'T01',label:'Tiny · 15 мин',model:'whisper-tiny',seconds:900,tolerance:90,speakers:false},
 {id:'T02',label:'Small · 15 мин',model:'whisper-small',seconds:900,tolerance:90,speakers:false},
 {id:'T03',label:'Small · 30 мин',model:'whisper-small',seconds:1800,tolerance:120,speakers:false},
 {id:'T04',label:'Small · 60 мин',model:'whisper-small',seconds:3600,tolerance:300,speakers:false},
 {id:'T05',label:'Large v3 · 15 мин (если хватает памяти)',model:'whisper-large-v3',seconds:900,tolerance:90,speakers:false},
 {id:'T06',label:'Small + спикеры · 15 мин',model:'whisper-small',seconds:900,tolerance:90,speakers:true}
] as const;
export type PerformanceCase=typeof PERFORMANCE_CASES[number]['id'];
export const GROUPS=['baseline','eco','medium','max'] as const;
export type CompareGroup=typeof GROUPS[number];
export type CompareCondition='cold'|'warm';
export type Launch='standalone'|'web';
export const EXTERNAL_KEYS=['ramPeakMb','vramPeakMb','cpuMeanPercent','gpuMeanPercent','werPercent','derPercent'] as const;
export type ExternalKey=typeof EXTERNAL_KEYS[number];
export type ExternalMetrics=Record<ExternalKey,number|null>;
export const EXTERNAL_LABELS:Record<ExternalKey,string>={ramPeakMb:'Пик RAM, МБ',vramPeakMb:'Пик VRAM, МБ',cpuMeanPercent:'CPU, среднее %',gpuMeanPercent:'GPU, среднее %',werPercent:'WER, %',derPercent:'DER, %'};
export const emptyExternal=():ExternalMetrics=>({ramPeakMb:null,vramPeakMb:null,cpuMeanPercent:null,gpuMeanPercent:null,werPercent:null,derPercent:null});
type Obj=Record<string,unknown>;
function object(value:unknown):Obj{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{}}
function numeric(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null}
function whole(value:unknown):number|null{const n=numeric(value);return n!==null&&Number.isSafeInteger(n)?n:null}
const round=(n:number)=>Math.round(n*10000)/10000;
function revision(value:unknown):string|null{return typeof value==='string'&&/^[a-f0-9]{7,40}$/i.test(value)?value.toLowerCase():null}
function backend(value:unknown):'wasm'|'webgpu'|'webnn'|'unknown'{return value==='wasm'||value==='webgpu'||value==='webnn'?value:'unknown'}
export type RunSelection={test:PerformanceCase;group:CompareGroup;condition:CompareCondition;launch:Launch;external:ExternalMetrics};
export type ComparisonRun={
 test:PerformanceCase;group:CompareGroup;condition:CompareCondition;launch:Launch;
 build:string|null;buildAtRunConfirmed:boolean;model:string;language:'ru'|'en'|null;diarization:boolean;
 durationSeconds:number|null;sourceBytes:number|null;windows:number|null;
 wallMs:number|null;asrMs:number|null;rtf:number|null;asrRtf:number|null;p95Ms:number|null;initializationMs:number|null;
 backend:'wasm'|'webgpu'|'webnn'|'unknown'|'mixed';attempts:number|null;failedAttempts:number|null;recoveries:number|null;
 external:ExternalMetrics;eligible:boolean;issues:string[];
};
export function readComparisonRun(evidence:unknown,legacyBenchmark:unknown,selection:RunSelection):ComparisonRun{
 const e=object(evidence),j=object(e.job),b=object(e.performanceBenchmark??legacyBenchmark),timings=object(b.timingsMs);
 if(e.schema!=='iscribe.hardware-evidence.v1'||b.schema!=='iscribe.benchmark.v1')throw new Error('Нужны hardware-evidence JSON и benchmark JSON одного задания.');
 const scenario=PERFORMANCE_CASES.find(c=>c.id===selection.test);
 if(!scenario||!GROUPS.includes(selection.group)||!['cold','warm'].includes(selection.condition)||!['standalone','web'].includes(selection.launch))throw new Error('Некорректный сценарий.');
 const issues:string[]=[],bad=(message:string)=>issues.push(message);
 const duration=numeric(j.sourceDurationSeconds),measured=numeric(b.measuredUniqueAudioSeconds),size=whole(j.sourceSizeBytes),windows=whole(j.expectedWindows);
 const language=j.language==='ru'||j.language==='en'?j.language:null;
 const build=revision(e.buildRevision),context=object(b.firstRunContext),runBuild=revision(context.buildRevision);
 const wallMs=numeric(timings.jobRuns),asrMs=numeric(timings.asrIncludingFailedAttempts),initializationMs=numeric(timings.modelInitialization);
 if(!build)bad('Нет SHA сборки.');
 if(j.model!==scenario.model||b.model!==scenario.model||j.diarizationRequested!==scenario.speakers||b.diarizationRequested!==scenario.speakers||!language||b.language!==language)bad('Модель, язык или спикеры не соответствуют сценарию.');
 if(duration===null||duration<=0||Math.abs(duration-scenario.seconds)>scenario.tolerance||numeric(b.durationSeconds)===null||Math.abs(Number(b.durationSeconds)-duration)>.02||size===null||size===0)bad('Не совпадает длительность или размер источника.');
 if(windows===null||windows===0||j.committedWindows!==windows||b.committedCheckpointWindows!==windows||b.measuredCommittedWindows!==windows||measured===null||duration===null||Math.abs(measured-duration)>.05||j.completedASR!==true||
 j.invalidAsrSegments!==0||!(Number(j.asrSegmentCount)>0)||b.stage!=='done'||j.persistedJobFound!==true||j.persistedCheckpointMatches!==true||j.persistedTranscriptMatches!==true||j.savedAudioPresent!==true||j.savedAudioSizeMatches!==true)bad('Нет полного подтверждённого результата одного файла.');
 if(b.runs!==1||b.resumedRuns!==0||j.resumedRuns!==0||b.failedRuns!==0)bad('Нужен новый независимый прогон без возобновления.');
 if(wallMs===null||wallMs<=0||asrMs===null||asrMs<=0||asrMs>wallMs+1||initializationMs===null)bad('Некорректные тайминги.');
 if(selection.condition==='warm'&&initializationMs!==0)bad('Тёплый прогон переинициализировал модель.');
 if(selection.condition==='cold'&&!(initializationMs!==null&&initializationMs>0))bad('Холодный прогон не содержит инициализации модели.');
 if(scenario.speakers&&(whole(j.completedSpeakerSegments)===null||j.completedSpeakerSegments!==j.asrSegmentCount||j.missingSpeakerLabels!==0))bad('Разделение говорящих не завершено полностью.');
 if(selection.group!=='baseline'){
  const r=object(b.resourceManagement),counts=object(r.requestedWindowCounts),other=GROUPS.filter(g=>g!=='baseline'&&g!==selection.group);
  if(counts[selection.group]!==windows||other.some(g=>counts[g]!==0))bad('Режим производительности менялся или не подтверждён.');
  if(!runBuild||runBuild!==build||context.launch!==selection.launch||context.mode!==selection.group||context.startCheckpoint!==0||context.calibrationRequested!==false||b.backendCalibration)bad('Контекст запуска не подтверждён или выполнялась калибровка.');
 }
 if(runBuild&&(runBuild!==build||context.launch!==selection.launch||context.modelResidentAtStart!==(selection.condition==='warm')||context.startCheckpoint!==0||context.calibrationRequested!==false))bad('Условия запуска не совпадают.');
 if(b.backendCalibration)bad('Калибровка бэкенда не является обычным прогоном.');
 const external=emptyExternal();
 for(const key of EXTERNAL_KEYS){const n=numeric(selection.external[key]);external[key]=n!==null&&((key==='cpuMeanPercent'||key==='gpuMeanPercent')&&n>100)?null:n}
 const observed=object(object(b.performanceProfiler).backendAttempts);
 const active=(['wasm','webgpu','webnn','unknown'] as const).filter(k=>(numeric(observed[k])??0)>0);
 const actual=active.length>1?'mixed':active.length===1?active[0]:backend(j.observedBackend);
 return {test:scenario.id,group:selection.group,condition:selection.condition,launch:selection.launch,
  build,buildAtRunConfirmed:!!runBuild&&runBuild===build,model:scenario.model,language,diarization:scenario.speakers,
  durationSeconds:duration,sourceBytes:size,windows,wallMs,asrMs,rtf:wallMs!==null&&duration&&duration>0?round(wallMs/duration/1000):null,
  asrRtf:asrMs!==null&&duration&&duration>0?round(asrMs/duration/1000):null,
  p95Ms:numeric(object(b.asrWindowMs).p95),initializationMs,backend:actual,attempts:whole(b.attempts),failedAttempts:whole(b.failedAttempts),
  recoveries:whole(b.workerRecoveries),external,eligible:issues.length===0,issues};
}
export function median(values:readonly (number|null)[]):number|null{
 const sorted=values.filter((v):v is number=>v!==null&&Number.isFinite(v)).sort((a,b)=>a-b);
 if(!sorted.length)return null;
 const n=sorted.length;return n%2?sorted[Math.floor(n/2)]:(sorted[n/2-1]+sorted[n/2])/2;
}
export function workloadKey(r:ComparisonRun):string{return JSON.stringify([r.test,r.condition,r.launch,r.model,r.language,r.diarization,r.durationSeconds,r.sourceBytes,r.windows])}
export function summarizeComparison(runs:readonly ComparisonRun[],test:PerformanceCase,condition:CompareCondition,launch:Launch,operatorSameSource:boolean){
 const relevant=runs.filter(r=>r.test===test&&r.condition===condition&&r.launch===launch);
 const baseline=relevant.filter(r=>r.group==='baseline'&&r.eligible);
 const anchor=baseline[0];
 const oneWorkload=!!anchor&&relevant.filter(r=>r.eligible).every(r=>workloadKey(r)===workloadKey(anchor));
 const oneBaseline=!!anchor&&baseline.every(r=>r.build===anchor.build);
 const candidateBuilds=new Set(relevant.filter(r=>r.eligible&&r.group!=='baseline').map(r=>r.build));
 const sameCandidateBuild=candidateBuilds.size===1&&!candidateBuilds.has(anchor?.build??null);
 const comparable=operatorSameSource&&oneWorkload&&oneBaseline&&sameCandidateBuild;
 const baselineMs=median(baseline.map(r=>r.wallMs));
 const rows=GROUPS.map(group=>{
  const all=relevant.filter(r=>r.group===group),good=all.filter(r=>r.eligible),wall=median(good.map(r=>r.wallMs));
  const improvement=group!=='baseline'&&comparable&&baseline.length>=3&&good.length>=3&&baselineMs!==null&&baselineMs>0&&wall!==null?round((baselineMs-wall)/baselineMs*100):null;
  const external=emptyExternal();
  for(const key of EXTERNAL_KEYS)external[key]=median(good.map(r=>r.external[key]));
  return {group,attempted:all.length,eligible:good.length,wallMs:wall,rtf:median(good.map(r=>r.rtf)),asrRtf:median(good.map(r=>r.asrRtf)),
   p95Ms:median(good.map(r=>r.p95Ms)),external,externalCounts:Object.fromEntries(EXTERNAL_KEYS.map(k=>[k,good.filter(r=>r.external[k]!==null).length])),
   backends:[...new Set(good.map(r=>r.backend))],improvementPercent:improvement};
 });
 return {test,condition,launch,comparable,rows,
  verdict:'HARDWARE ACCEPTANCE NOT VERIFIED' as const,
  limitation:'Comparison is descriptive, not device attestation. Operator must verify identical source/device, browser, power and cache conditions. Three independent runs per group are minimum; failed/ineligible runs remain counted. Baseline without run context relies on operator verification of build. WER/DER and external resource observations are manual.'};
}
