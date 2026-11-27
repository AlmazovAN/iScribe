import {describe,expect,it} from 'vitest';
import {chooseAudioDecoder,legacyAudioDecoder,ffmpegAudioDecoder} from './audioDecoderProvider';
import {decodeFfmpegAudio,readFfmpegPcm,ffmpegWorkerAssets} from './ffmpegDecoder';
import {MAX_PCM_SAMPLES} from './audioValidation';
import {STREAM_AUDIO_BYTES} from './audio';
describe('DEC-01: FFmpeg decoder contract',()=>{
 it('defaults to FFmpeg and preserves an explicit legacy comparison path',()=>{
  expect(chooseAudioDecoder('')).toBe(ffmpegAudioDecoder);
  expect(chooseAudioDecoder('?decoder=other')).toBe(ffmpegAudioDecoder);
  expect(chooseAudioDecoder('?decoder=legacy')).toBe(legacyAudioDecoder);
  expect(chooseAudioDecoder('?decoder=ffmpeg')).toBe(ffmpegAudioDecoder);
 });
 it('keeps PCM samples unchanged',()=>{
  const pcm=new Float32Array([0,-0.5,0.25,1]);
  expect(Array.from(readFfmpegPcm(pcm.buffer))).toEqual(Array.from(pcm));
 });
 it('rejects empty or misaligned PCM',()=>{
  expect(()=>readFfmpegPcm(new ArrayBuffer(0))).toThrow();
  expect(()=>readFfmpegPcm(new ArrayBuffer(3))).toThrow();
 });
 it('does not open a Worker for an already cancelled job',async()=>{
  const abort=new AbortController();abort.abort();
  await expect(decodeFfmpegAudio(new File(['a'],'a.mp3'),abort.signal)).rejects.toMatchObject({name:'AbortError'});
 });
 it('does not decode large files into a full PCM buffer',async()=>{
  const file={name:'a.mp3',size:STREAM_AUDIO_BYTES+1} as File;
  await expect(decodeFfmpegAudio(file)).rejects.toThrow('потоковый режим');
 });
 it('keeps the existing one-hour PCM contract',()=>expect(MAX_PCM_SAMPLES).toBe(57600000));
});

it('packages a classic worker with inline core and structured-cloned compressed WASM',async()=>{
 const core=new Blob(['var createFFmpegCore=()=>{};']),wasm=new Blob(['compressed']);
 const assets=ffmpegWorkerAssets('self.onmessage=()=>{};',{core,wasm});
 expect(await assets.script.text()).toContain('var createFFmpegCore=()=>{};;\nself.onmessage=()=>{};');
 expect(assets.input).toEqual({wasmBlob:wasm});
 expect(()=>ffmpegWorkerAssets('worker',{core:new Blob([]),wasm})).toThrow('ресурсы FFmpeg');
});
