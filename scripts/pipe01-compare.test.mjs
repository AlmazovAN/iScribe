import {describe,it,expect} from 'vitest';
import {buildArgs,pcmStats} from './pipe01-compare.mjs';

describe('PIPE-01 diagnostic decoder matrix',()=>{
 it('changes only the intended full-route options between A, B and C',()=>{
  const a=buildArgs('A'),b=buildArgs('B'),c=buildArgs('C'),d=buildArgs('D');
  expect(a.filter(x=>x!=='-xerror')).toEqual(b);
  expect(c.map(x=>x==='pcm_s16le'?'pcm_f32le':x==='s16le'?'f32le':x)).toEqual(b);
  expect(d).toContain('aresample=16000:async=1:min_hard_comp=0.01:first_pts=0');
  expect(d).not.toContain('-xerror');
 });
 it('keeps bounded warm-seek and absolute sample trim identical across window variants',()=>{
  const w={start:400000,count:480000},a=buildArgs('A',w),b=buildArgs('B',w);
  expect(a.filter(x=>x!=='-xerror')).toEqual(b);
  expect(a).toContain('24.0000000');
  expect(a).toContain('aresample=16000,atrim=start_sample=16000:end_sample=496000,asetpts=PTS-STARTPTS');
  expect(()=>buildArgs('D',w)).toThrow('unsupported-mode');
  expect(()=>buildArgs('B',{start:-1,count:1})).toThrow('invalid-window');
  expect(()=>buildArgs('A',{start:0,count:480001})).toThrow('invalid-window');
 });
 it('converts signed little-endian PCM16 exactly like WhisperX',()=>{
  const bytes=new Uint8Array(8),v=new DataView(bytes.buffer);
  [-32768,-16384,0,32767].forEach((x,i)=>v.setInt16(i*2,x,true));
  const stats=pcmStats(bytes,'C',4,4);
  expect(stats).toMatchObject({samples:4,min:-1,max:32767/32768,zeros:1,overRange:0});
 });
 it('rejects invalid PCM, incomplete windows and overlong full output',()=>{
  const bytes=new Uint8Array(8),v=new DataView(bytes.buffer);
  v.setFloat32(0,0.5,true);v.setFloat32(4,NaN,true);
  expect(()=>pcmStats(bytes,'A',2)).toThrow('pcm-nonfinite');
  expect(()=>pcmStats(bytes,'B',1)).toThrow('pcm-coverage');
  expect(()=>pcmStats(bytes,'B',3,3)).toThrow('pcm-coverage');
  expect(()=>pcmStats(new Uint8Array(3),'C',4)).toThrow('pcm-length');
 });
});
