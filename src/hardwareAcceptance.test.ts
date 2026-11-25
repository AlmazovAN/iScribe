import {expect,it} from 'vitest';
import {createJob} from './jobs';
import {createHardwareEvidence,HARDWARE_GATES} from './hardwareAcceptance';
import {emptyBenchmark} from './benchmark';

function sample(){
 const f=new File(['SECRET PRIVATE AUDIO'],'PRIVATE-MEETING-SECRET.mp3',{type:'audio/mpeg'});
 const job=createJob(f,{model:'whisper-small',language:'ru',diarize:true});
 const segments=[{start:2,end:3,text:'CONFIDENTIAL TRANSCRIPT'}];
 const full={...job,duration:871,nextWindow:35,asrComplete:true,stage:'done' as const,
  segments,speakerSegments:[{...segments[0],speaker:'SECRET SPEAKER'}],
  diagnostics:{turns:1,unlabeled:0,segments:1,zeroDuration:0,turnCoverageSeconds:870},
  backend:'webgpu',
  benchmark:{...emptyBenchmark(),runs:2,resumedRuns:1,committedWindows:35,uniqueAudioSeconds:871,asrAttemptMs:1000},
  trace:[{at:123,phase:'asr' as const,code:'window-error' as const,backend:'webgpu' as const,window:1},
   {at:124,phase:'asr' as const,code:'window-attempt' as const,backend:'wasm' as const,window:1}]
 };
 return {full,f};
}
it('even a perfect mock-looking 871s / 35-window job NEVER passes an actual hardware gate',()=>{
 const {full,f}=sample();
 const report=createHardwareEvidence(full,structuredClone(full),f,{
  browserOnlineHint:false,webgpuApiAvailable:true,siteStorageUsageBytes:2048,siteStorageQuotaBytes:4096
 });
 expect(report).toMatchObject({
  schema:'iscribe.hardware-evidence.v1',
  provenance:'unattested-browser-job',
  verdict:'HARDWARE ACCEPTANCE NOT VERIFIED',
  job:{sourceDurationSeconds:871,committedWindows:35,expectedWindows:35,
   savedAudioPresent:true,savedAudioSizeMatches:true,persistedTranscriptMatches:true,
   resumedRuns:1,traceGpuErrors:1,traceWasmAttempts:1}
 });
 expect(report.gates).toHaveLength(HARDWARE_GATES.length);
 expect(report.gates.every(g=>g.hardwareAcceptance==='NOT TESTED')).toBe(true);
 expect(report.gates.find(g=>g.id==='HW-1')?.evidence).toBe('consistent');
 expect(report.gates.find(g=>g.id==='HW-3')?.evidence).toBe('incomplete');
 expect(report.gates.find(g=>g.id==='HW-4')?.evidence).toBe('not-observable');
 const serialized=JSON.stringify(report);
 for(const privateValue of ['PRIVATE-MEETING-SECRET','SECRET PRIVATE AUDIO','CONFIDENTIAL TRANSCRIPT','SECRET SPEAKER'])
  expect(serialized).not.toContain(privateValue);
});
it('rejects stale or missing IndexedDB checkpoint and missing original audio without disclosing details',()=>{
 const {full,f}=sample();
 const saved={...full,nextWindow:34,segments:[{start:2,end:3,text:'ALTERED SECRET'}]};
 const bad=createHardwareEvidence(full,saved,undefined);
 expect(bad.job).toMatchObject({persistedCheckpointMatches:false,persistedTranscriptMatches:false,
  savedAudioPresent:false,savedAudioSizeMatches:false});
 expect(bad.gates.find(g=>g.id==='HW-1')?.evidence).toBe('incomplete');
 const noText=createHardwareEvidence(full,{...full,segments:[]},f);
 expect(noText.job.persistedTranscriptMatches).toBe(false);
 expect(noText.gates.every(g=>g.hardwareAcceptance==='NOT TESTED')).toBe(true);
});
it('does not invent GPU support, storage size or memory values from non-finite hints',()=>{
 const {full,f}=sample();
 const report=createHardwareEvidence(full,full,f,{browserOnlineHint:true,webgpuApiAvailable:false,
  siteStorageUsageBytes:Number.NaN,siteStorageQuotaBytes:-10});
 expect(report.browserHints).toEqual({browserOnlineHint:true,webgpuApiAvailable:false,
  siteStorageUsageBytes:null,siteStorageQuotaBytes:null});
 expect(report.job.asrRtf).toBeCloseTo(0.00115,5);
 expect(report.gates.find(g=>g.id==='HW-6')?.evidence).toBe('not-observable');
});
it('does not treat the wrong model or uncommitted work as reference hardware evidence',()=>{
 const {full,f}=sample();
 const tiny={...full,params:{...full.params,model:'whisper-tiny' as const}};
 expect(createHardwareEvidence(tiny,tiny,f).gates.find(g=>g.id==='HW-1')?.evidence).toBe('incomplete');
 const pending={...full,nextWindow:2,asrComplete:false,stage:'interrupted' as const};
 expect(createHardwareEvidence(pending,pending,f).gates.find(g=>g.id==='HW-1')?.evidence).toBe('incomplete');
});
