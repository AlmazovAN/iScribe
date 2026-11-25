import 'fake-indexeddb/auto';
import {expect,it,vi} from 'vitest';
vi.mock('./ml/worker?worker',()=>({default:class{}}));
import {JobRunner} from './jobRunner';
import {JobStore} from './jobStore';
import type {ModelManager} from './ml/manager';
import type {HardwareEvidenceReport} from './hardwareAcceptance';

function setup(){
 const store=new JobStore('pr30-'+crypto.randomUUID());
 const fake={
  active:null as string|null,
  onProgress:(status:string,percent:number|null)=>{void status;void percent},
  prepare:vi.fn(async(id:string)=>{fake.active=id;return {cached:true,backend:'webgpu'}}),
  recover:vi.fn(async(id:string)=>{fake.active=id;return {cached:true,backend:'wasm'}}),
  transcribe:vi.fn(async()=>[{start:3,end:4,text:'very private user transcript'}]),
  diarize:vi.fn(async()=>[{start:0,end:60,speaker:'A'}]),
  cancel:vi.fn(()=>{})
 };
 const hardwareDownload=vi.fn((_report:HardwareEvidenceReport,_filename:string)=>{void _report;void _filename});
 const runner=new JobRunner({store,manager:fake as unknown as ModelManager,
  decode:async()=>new Float32Array(60*16000),
  download:()=>{},downloadHardware:hardwareDownload});
 return {store,runner,fake,hardwareDownload};
}
async function finished(runner:JobRunner){await vi.waitFor(()=>expect(runner.snapshot().busy).toBe(false))}
it('reads original local file and durable text before exporting a redacted hardware report',async()=>{
 const {store,runner,hardwareDownload}=setup();
 await runner.init();
 await runner.add([new File(['PRIVATE AUDIO FILE'],'SENSITIVE-CALL.mp3')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 runner.enqueue(id);await finished(runner);
 await runner.exportHardwareEvidence(id);
 expect(hardwareDownload).toHaveBeenCalledTimes(1);
 const [report,filename]=hardwareDownload.mock.calls[0];
 expect(report).toMatchObject({
  schema:'iscribe.hardware-evidence.v1',verdict:'HARDWARE ACCEPTANCE NOT VERIFIED',
  job:{persistedJobFound:true,savedAudioPresent:true,persistedCheckpointMatches:true,
   persistedTranscriptMatches:true,committedWindows:3,completedASR:true}
 });
 expect(filename).not.toContain('SENSITIVE');
 const text=JSON.stringify(report);
 expect(text).not.toContain('SENSITIVE-CALL');
 expect(text).not.toContain('PRIVATE AUDIO');
 expect(text).not.toContain('very private');
 // Manually corrupt local state and check the report never misrepresents it.
 const stored=(await store.get(id,false))!;
 await store.save({...stored,status:'saved',nextWindow:3});
 expect(report.gates.every(g=>g.hardwareAcceptance==='NOT TESTED')).toBe(true);
});

it('refuses export while the job is actively processing to avoid a stale snapshot',async()=>{
 const {runner,fake,hardwareDownload}=setup();
 await runner.init();
 await runner.add([new File(['a'],'active.wav')],{model:'whisper-small',language:'ru',diarize:false});
 const id=runner.snapshot().jobs.at(-1)!.id;
 let release:(value:{start:number;end:number;text:string}[])=>void=()=>{};
 fake.transcribe.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}));
 runner.enqueue(id);
 await vi.waitFor(()=>expect(fake.transcribe).toHaveBeenCalledTimes(1));
 await expect(runner.exportHardwareEvidence(id)).rejects.toThrow('Завершите');
 expect(hardwareDownload).not.toHaveBeenCalled();
 release([{start:3,end:4,text:'ok'}]);
 await finished(runner);
 await expect(runner.exportHardwareEvidence(id)).resolves.toBeUndefined();
});
