import {describe,expect,it,vi} from 'vitest';
import {PipelineOrchestrator,PIPELINE_STAGES,type PipelineObservation} from './pipelineOrchestrator';

function setup(){
 const events:PipelineObservation[]=[],controller=new AbortController();
 const pipeline=new PipelineOrchestrator<Float32Array,{windows:number},number[]>(controller.signal,e=>events.push(e));
 return {pipeline,events,controller};
}
type Pipeline=ReturnType<typeof setup>['pipeline'];
async function prepare(p:Pipeline,mode:'full'|'windowed'='full'){
 const file=await p.run('preflight',()=>new File(['a'],'sample.wav'));
 expect(file.size).toBe(1);
 const audio=await p.run('decode',()=>new Float32Array(2));
 await p.run('pcm-gate',()=>({mode,samples:audio.length}));
}
async function asr(p:Pipeline){
 const plan=await p.run('segmentation',()=>({windows:1}));
 await p.run('asr',()=>{expect(plan.windows).toBe(1)});
}
describe('PIPE-03 stage control',()=>{
 it('runs all real stages in dependency order and records a download request, not a saved file',async()=>{
  const {pipeline:p,events}=setup();
  await prepare(p);await asr(p);
  const turns=await p.run('diarization',()=>[1,2]);
  await p.run('speaker-assignment',()=>{expect(turns).toEqual([1,2])});
  await p.run('finalize',()=>{});
  await p.run('export',()=> 'requested');
  expect(p.complete).toBe(true);
  expect(events.filter(e=>e.state==='running').map(e=>e.stage)).toEqual([...PIPELINE_STAGES]);
  expect(events.at(-1)).toMatchObject({stage:'export',state:'requested'});
 });
 it('defers stream validation, skips unavailable speakers and reports manual export fallback',async()=>{
  const {pipeline:p,events}=setup();await prepare(p,'windowed');await asr(p);
  p.skip({stage:'diarization',reason:'streaming-speakers-unavailable'});
  p.skip({stage:'speaker-assignment',reason:'streaming-speakers-unavailable'});
  await p.run('finalize',()=>{});await p.run('export',()=> 'manual');
  expect(events).toEqual(expect.arrayContaining([
   expect.objectContaining({stage:'pcm-gate',state:'deferred',reason:'per-window-validation'}),
   {stage:'diarization',state:'skipped',reason:'streaming-speakers-unavailable'},
   {stage:'speaker-assignment',state:'skipped',reason:'streaming-speakers-unavailable'}
  ]));
  expect(events.at(-1)).toMatchObject({stage:'export',state:'manual'});
  expect(p.complete).toBe(true);
 });
 it('reports ASR reuse only on the explicit committed-text path',async()=>{
  const {pipeline:p,events}=setup();await prepare(p);
  p.skip({stage:'segmentation',reason:'asr-already-committed'});
  p.skip({stage:'asr',reason:'asr-already-committed'});
  expect(events.at(-1)).toEqual({stage:'asr',state:'reused',reason:'asr-already-committed'});
  expect(events.some(e=>e.stage==='asr'&&e.state==='running')).toBe(false);
 });
 it('stops dependent work after failure without retrying',async()=>{
  const {pipeline:p,events}=setup();await p.run('preflight',()=>new File(['x'],'a.wav'));
  const failure=new Error('decoder failed'),decode=vi.fn(()=>{throw failure});
  await expect(p.run('decode',decode)).rejects.toBe(failure);
  const gate=vi.fn(()=>({mode:'full' as const,samples:1}));
  await expect(p.run('pcm-gate',gate)).rejects.toThrow('последовательность');
  expect(decode).toHaveBeenCalledOnce();expect(gate).not.toHaveBeenCalled();
  expect(events.at(-1)).toMatchObject({stage:'decode',state:'failed'});
  expect(p.complete).toBe(false);
 });
 it('honors cancellation and never starts the cancelled operation',async()=>{
  const {pipeline:p,events,controller}=setup();controller.abort();
  const work=vi.fn(()=>new File(['x'],'a.wav'));
  await expect(p.run('preflight',work)).rejects.toMatchObject({name:'AbortError'});
  expect(work).not.toHaveBeenCalled();expect(events.at(-1)).toMatchObject({stage:'preflight',state:'cancelled'});
 });
 it('rejects concurrent, out-of-order and duplicate execution',async()=>{
  const {pipeline:p}=setup();
  await expect(p.run('decode',()=>new Float32Array(1))).rejects.toThrow('последовательность');
  let finish!:(f:File)=>void;
  const first=p.run('preflight',()=>new Promise<File>(resolve=>{finish=resolve}));
  await expect(p.run('preflight',()=>new File(['x'],'b.wav'))).rejects.toThrow('последовательность');
  finish(new File(['x'],'a.wav'));await first;
  await expect(p.run('preflight',()=>new File(['x'],'c.wav'))).rejects.toThrow('последовательность');
 });
 it('rejects inconsistent dependent stage skipping and missing input',async()=>{
  const {pipeline:p}=setup();await prepare(p);
  p.skip({stage:'segmentation',reason:'asr-already-committed'});
  await expect(p.run('asr',()=>{})).rejects.toThrow('Входной этап');
  p.skip({stage:'asr',reason:'asr-already-committed'});
  p.skip({stage:'diarization',reason:'speakers-disabled'});
  expect(()=>p.skip({stage:'speaker-assignment',reason:'streaming-speakers-unavailable'})).toThrow('Причина пропуска');
  await expect(p.run('speaker-assignment',()=>{})).rejects.toThrow('Входной этап');
 });
});
