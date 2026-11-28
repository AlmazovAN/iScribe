import type {Job} from './jobs';
import {expectedWindows} from './jobDiagnostics';
import {traceBackend} from './jobTrace';
import {benchmarkReport} from './benchmark';
declare const __ISCRIBE_BUILD_SHA__:string;

// All seven hardware gates remain unverified until a real-device operator
// reviews them. Browser state and synthetic tests can provide *evidence* but
// cannot authenticate the physical device, audio or ML model implementation.
export const HARDWARE_GATES=[
 {id:'HW-1',label:'Реальный Whisper Small: 14:31, 35 окон и TXT'},
 {id:'HW-2',label:'Перезагрузка после контрольной точки и продолжение'},
 {id:'HW-3',label:'Фактическая потеря GPU и восстановление WASM'},
 {id:'HW-4',label:'Распознавание без интернета на сохранённых моделях'},
 {id:'HW-5',label:'Реальная диаризация и оценка качества меток'},
 {id:'HW-6',label:'RAM, память Worker/GPU и длинные записи'},
 {id:'HW-7',label:'Три холодных и три тёплых прогона'}
] as const;
export type HardwareGateId=typeof HARDWARE_GATES[number]['id'];
export type HardwareEvidenceStatus='consistent'|'incomplete'|'not-observable';
export type HardwareGateReport={
 id:HardwareGateId;
 label:string;
 evidence:HardwareEvidenceStatus;
 hardwareAcceptance:'NOT TESTED';
 reason:string;
};
export type HardwareObservedContext={
 // Connectivity and API presence are hints, NOT proof of functioning hardware.
 browserOnlineHint:boolean|null;
 webgpuApiAvailable:boolean|null;
 siteStorageUsageBytes:number|null;
 siteStorageQuotaBytes:number|null;
};
export type HardwareEvidenceReport={
 schema:'iscribe.hardware-evidence.v1';
 generatedAt:string;
 buildRevision:string;
 provenance:'unattested-browser-job';
 verdict:'HARDWARE ACCEPTANCE NOT VERIFIED';
 browserHints:HardwareObservedContext;
 job:{
  model:Job['params']['model'];
  language:Job['params']['language'];
  diarizationRequested:boolean;
  sourceSizeBytes:number;
  sourceDurationSeconds:number|null;
  expectedWindows:number|null;
  committedWindows:number;
  completedASR:boolean;
  asrSegmentCount:number;
  invalidAsrSegments:number;
  savedAudioPresent:boolean;
  savedAudioSizeMatches:boolean;
  persistedJobFound:boolean;
  persistedCheckpointMatches:boolean;
  persistedTranscriptMatches:boolean;
  completedSpeakerSegments:number|null;
  missingSpeakerLabels:number|null;
  speakerCoverageSeconds:number|null;
  observedBackend:'webgpu'|'webnn'|'wasm'|'unknown';
  resumedRuns:number;
  measuredWindows:number;
  asrRtf:number|null;
  workerRecoveries:number;
  traceGpuErrors:number;
  traceWasmAttempts:number;
 };
 performanceBenchmark?:ReturnType<typeof benchmarkReport>;
 gates:HardwareGateReport[];
 warnings:string[];
};
const round=(n:number|null,places=3)=>n!==null&&Number.isFinite(n)?Number(n.toFixed(places)):null;
const validNumber=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
function transcriptMatches(current:Job,durable:Job):boolean{
 const a=current.segments,b=durable.segments;
 return a.length===b.length&&a.every((s,i)=>{
  const t=b[i];
  return !!t&&s.start===t.start&&s.end===t.end&&s.text===t.text;
 });
}
export function createHardwareEvidence(
 job:Job,stored:Job|undefined,source:Pick<File,'size'>|undefined,
 hints:HardwareObservedContext={browserOnlineHint:null,webgpuApiAvailable:null,
  siteStorageUsageBytes:null,siteStorageQuotaBytes:null}
):HardwareEvidenceReport{
 const expected=expectedWindows(job.duration,job.windowPlan);
 const sourceDuration=validNumber(job.duration);
 const invalid=job.segments.filter(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||
  s.start<0||s.end<s.start||typeof s.text!=='string').length;
 const matchesCheckpoint=!!stored&&stored.nextWindow===job.nextWindow&&stored.asrComplete===job.asrComplete;
 const matchesTranscript=!!stored&&transcriptMatches(job,stored);
 const hasAudio=!!source;
 const sizeMatch=!!source&&source.size===job.size;
 const isReference=job.params.model==='whisper-small'&&job.params.language==='ru'&&
  sourceDuration!==null&&Math.abs(sourceDuration-871)<=2&&expected===35;
 const durable=matchesCheckpoint&&matchesTranscript&&hasAudio&&sizeMatch;
 const completed=durable&&job.asrComplete&&job.nextWindow===expected&&
  job.segments.some(s=>s.text.trim())&&invalid===0;
 const trace=job.trace??[];
 const gpuErrors=trace.filter(e=>e.code==='window-error'&&
  (e.backend==='webgpu'||e.backend==='webnn')).length;
 const wasmAttempts=trace.filter(e=>e.code==='window-attempt'&&e.backend==='wasm').length;
 const b=job.benchmark;
 const successfulWindows=b?.committedWindows??0;
 // No checked box, cached model or network hint can turn an unverified
 // hardware gate into a PASS. The operator must inspect the real device.
 const gates:HardwareGateReport[]=[
  {id:'HW-1',label:HARDWARE_GATES[0].label,
   evidence:isReference&&completed?'consistent':'incomplete',
   hardwareAcceptance:'NOT TESTED',
   reason:isReference&&completed?'Сохранённый результат структурно соответствует 14:31 и 35 окнам; подлинность источника/модели не проверена.':'Не подтверждён полный сохранённый результат Whisper Small на эталонной записи.'},
  {id:'HW-2',label:HARDWARE_GATES[1].label,
   evidence:b?.resumedRuns&&durable?'consistent':'incomplete',
   hardwareAcceptance:'NOT TESTED',
   reason:b?.resumedRuns&&durable?'Был повторный запуск с сохранённым checkpoint; причина предыдущей остановки неизвестна.':'Нет подтверждённого восстановления после контрольной точки.'},
  {id:'HW-3',label:HARDWARE_GATES[2].label,
   evidence:gpuErrors>0&&wasmAttempts>0&&b?.workerRecoveries?'consistent':'incomplete',
   hardwareAcceptance:'NOT TESTED',
   reason:'Типизированный журнал показывает лишь попытки; фактическая потеря GPU и перенос вычислений требуют проверки на устройстве.'},
  {id:'HW-4',label:HARDWARE_GATES[3].label,
   evidence:'not-observable',hardwareAcceptance:'NOT TESTED',
   reason:'Состояние сети в момент выгрузки не доказывает полностью офлайн-распознавание.'},
  {id:'HW-5',label:HARDWARE_GATES[4].label,
   evidence:job.params.diarize&&job.diagnostics&&job.speakerSegments?'consistent':'incomplete',
   hardwareAcceptance:'NOT TESTED',
   reason:'Число меток не подтверждает их точность; необходимо сравнение с размеченным аудио.'},
  {id:'HW-6',label:HARDWARE_GATES[5].label,
   evidence:'not-observable',hardwareAcceptance:'NOT TESTED',
   reason:'JS heap не включает всю RAM, Worker/WASM или видеопамять; необходим внешний мониторинг.'},
  {id:'HW-7',label:HARDWARE_GATES[6].label,
   evidence:'not-observable',hardwareAcceptance:'NOT TESTED',
   reason:'Несколько запусков в одном задании не различают холодные и тёплые независимые прогоны.'}
 ];
 return {
  schema:'iscribe.hardware-evidence.v1',
  generatedAt:new Date().toISOString(),
  buildRevision:typeof __ISCRIBE_BUILD_SHA__==='string'?__ISCRIBE_BUILD_SHA__:'unavailable',
  provenance:'unattested-browser-job',
  verdict:'HARDWARE ACCEPTANCE NOT VERIFIED',
  browserHints:{
   browserOnlineHint:typeof hints.browserOnlineHint==='boolean'?hints.browserOnlineHint:null,
   webgpuApiAvailable:typeof hints.webgpuApiAvailable==='boolean'?hints.webgpuApiAvailable:null,
   siteStorageUsageBytes:validNumber(hints.siteStorageUsageBytes),
   siteStorageQuotaBytes:validNumber(hints.siteStorageQuotaBytes)
  },
  job:{
   model:job.params.model,language:job.params.language,
   diarizationRequested:job.params.diarize,sourceSizeBytes:job.size,
   sourceDurationSeconds:round(sourceDuration),expectedWindows:expected,
   committedWindows:job.nextWindow,completedASR:job.asrComplete,
   asrSegmentCount:job.segments.length,invalidAsrSegments:invalid,
   savedAudioPresent:hasAudio,savedAudioSizeMatches:sizeMatch,
   persistedJobFound:!!stored,persistedCheckpointMatches:matchesCheckpoint,
   persistedTranscriptMatches:matchesTranscript,
   completedSpeakerSegments:job.speakerSegments?.length??null,
   missingSpeakerLabels:job.diagnostics?.unlabeled??null,
   speakerCoverageSeconds:validNumber(job.diagnostics?.turnCoverageSeconds),
   observedBackend:traceBackend(job.backend),
   resumedRuns:b?.resumedRuns??0,measuredWindows:successfulWindows,
   asrRtf:round(b&&b.uniqueAudioSeconds>0?b.asrAttemptMs/(b.uniqueAudioSeconds*1000):null,5),
   workerRecoveries:b?.workerRecoveries??0,
   traceGpuErrors:gpuErrors,traceWasmAttempts:wasmAttempts
  },
  ...(job.benchmark?.runs?{performanceBenchmark:benchmarkReport(job)}:{}),
  gates,
  warnings:[
   'Этот файл содержит структурные наблюдения в браузере, но не подтверждает реальные веса Whisper, GPU, источник аудио или устройство.',
   'Прогоны Playwright и Vitest с имитацией ML способны создать такой же структурно правильный отчёт. Аппаратная приёмка требует отдельного осмотра.',
   'Для закрытия HW-1...HW-7 нужен подписанный/согласованный протокол реальных испытаний с версией сборки и проверкой TXT.',
   'Не прикладывайте исходное аудио, стенограмму, персональные пути и полные логи браузера к публичному GitHub.'
  ]
 };
}
export async function browserEvidenceHints():Promise<HardwareObservedContext>{
 let siteStorageUsageBytes:null|number=null,siteStorageQuotaBytes:null|number=null;
 try{
  const estimate=await navigator.storage?.estimate?.();
  siteStorageUsageBytes=validNumber(estimate?.usage);
  siteStorageQuotaBytes=validNumber(estimate?.quota);
 }catch{/* Unsupported or denied: leave unknown. */}
 return {
  browserOnlineHint:typeof navigator!=='undefined'&&typeof navigator.onLine==='boolean'?navigator.onLine:null,
  webgpuApiAvailable:typeof navigator!=='undefined'&&'gpu' in navigator,
  siteStorageUsageBytes,siteStorageQuotaBytes
 };
}
export function downloadHardwareEvidence(report:HardwareEvidenceReport,filename:string):void{
 const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'});
 const url=URL.createObjectURL(blob);
 const element=document.createElement('a');
 element.href=url;element.download=filename;
 document.body.appendChild(element);element.click();element.remove();
 setTimeout(()=>URL.revokeObjectURL(url),30000);
}
