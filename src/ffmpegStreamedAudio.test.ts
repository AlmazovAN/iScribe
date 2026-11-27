import {describe,expect,it} from 'vitest';
import {validateFfmpegWindow,validateFfmpegWindowPcm,FFMPEG_MAX_WINDOW_SAMPLES,openFfmpegStreamedAudio} from './ffmpegStreamedAudio';
import {chooseAudioDecoder} from './audioDecoderProvider';
import {openStreamedAudio} from './streamedAudio';

describe('DEC-02: FFmpeg bounded windows',()=>{
 it('selects both legacy and FFmpeg routes explicitly',()=>{
  expect(chooseAudioDecoder('').openStream).toBe(openFfmpegStreamedAudio);
  expect(chooseAudioDecoder('?decoder=legacy').openStream).toBe(openStreamedAudio);
  expect(chooseAudioDecoder('?decoder=ffmpeg').openStream).toBe(openFfmpegStreamedAudio);
 });
 it('accepts 30-second and short recovery windows beyond one hour',()=>{
  const start=64*60*16000;
  for(const size of [FFMPEG_MAX_WINDOW_SAMPLES,80000,1])
   expect(()=>validateFfmpegWindow({start,end:start+size,first:false,last:true},start+size)).not.toThrow();
 });
 it('rejects reversed, out-of-range and oversized windows',()=>{
  for(const [start,end,length] of [[-1,2,2],[5,4,5],[0,2,1],[0,480001,480001],[0,1.5,2]])
   expect(()=>validateFfmpegWindow({start,end,first:true,last:false},length)).toThrow();
 });
 it('rejects missing samples without zero-padding',()=>{
  expect(()=>validateFfmpegWindowPcm(new Float32Array([1,0]).buffer,3)).toThrow();
 });
 it('rejects NaN and Infinity, but preserves silence and finite unclamped samples',()=>{
  for(const invalid of [NaN,Infinity,-Infinity])
   expect(()=>validateFfmpegWindowPcm(new Float32Array([0,invalid]).buffer,2)).toThrow();
  expect(Array.from(validateFfmpegWindowPcm(new Float32Array([0,1.25,-1.25]).buffer,3))).toEqual([0,1.25,-1.25]);
 });
 it('does not open a worker on cancellation',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(openFfmpegStreamedAudio(new File(['x'],'a.wav'),controller.signal)).rejects.toMatchObject({name:'AbortError'});
 });
});
