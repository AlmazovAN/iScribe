import {expect,it} from 'vitest';
import {mixMono,mixMonoInto,validateFile,MAX_FILE_BYTES,STREAM_AUDIO_BYTES,usesStreamedAudio} from './audio';
it('averages channels without changing sample positions or mutating input',()=>{
 const left=Float32Array.of(1,0,-1),right=Float32Array.of(0,1,1);
 expect([...mixMono([left,right])]).toEqual([.5,.5,0]);expect([...left]).toEqual([1,0,-1]);
});
it('rejects malformed input channels',()=>{expect(()=>mixMono([])).toThrow();expect(()=>mixMono([Float32Array.of(1),Float32Array.of(1,2)])).toThrow()});
it('rejects empty, oversized and unsupported files',()=>{
 expect(()=>validateFile({name:'note.wav',size:0})).toThrow();
 expect(()=>validateFile({name:'note.mp3',size:MAX_FILE_BYTES+1})).toThrow();
 expect(()=>validateFile({name:'note.exe',size:10})).toThrow();
 expect(()=>validateFile({name:'NOTE.WAV',size:100})).not.toThrow();
});


it('normalizes a browser MP3 decode error rather than running ASR',async()=>{
 const {vi}=await import('vitest');
 const {decodeAudio}=await import('./audio');
 const close=vi.fn(async()=>{});
 vi.stubGlobal('AudioContext',class{
  decodeAudioData=async()=>{throw new DOMException('unsupported content','EncodingError')};
  close=close;
 });
 try{
  await expect(decodeAudio(new File(['bad compressed bytes'],'broken.mp3'))).rejects.toThrow('Браузер не смог декодировать');
  expect(close).toHaveBeenCalledOnce();
 }finally{vi.unstubAllGlobals()}
});
it('rejects a decoder that returns invalid channel count or zero PCM samples',async()=>{
 const {vi}=await import('vitest');
 const {decodeAudio}=await import('./audio');
 vi.stubGlobal('AudioContext',class{
  decodeAudioData=async()=>({duration:1,length:0,numberOfChannels:1,sampleRate:16000});
  close=async()=>{};
 });
 try{
  await expect(decodeAudio(new File(['bad'],'invalid.mp3'))).rejects.toThrow('Декодер вернул некорректные параметры');
 }finally{vi.unstubAllGlobals()}
});


it('reuses the decoder channel buffer for 16 kHz mono instead of copying the full PCM',async()=>{
 const {vi}=await import('vitest');
 const {decodeAudio}=await import('./audio');
 const samples=new Float32Array(16000);
 samples[100]=0.4;
 const close=vi.fn(async()=>{});
 vi.stubGlobal('AudioContext',class{
  decodeAudioData=async()=>({duration:1,length:samples.length,numberOfChannels:1,sampleRate:16000,getChannelData:()=>samples});
  close=close;
 });
 try{
  const result=await decodeAudio(new File(['compressed input'],'mono.mp3'));
  expect(result).toBe(samples);
  expect(result[100]).toBeCloseTo(0.4);
  expect(close).toHaveBeenCalledOnce();
 }finally{vi.unstubAllGlobals()}
});

it('accepts audio up to 500 MiB and streams only above 128 MiB',()=>{
 expect(MAX_FILE_BYTES).toBe(500*1024*1024);
 expect(()=>validateFile({name:'meeting.mp3',size:MAX_FILE_BYTES})).not.toThrow();
 expect(usesStreamedAudio(STREAM_AUDIO_BYTES)).toBe(false);
 expect(usesStreamedAudio(STREAM_AUDIO_BYTES+1)).toBe(true);
});

it('mixes directly into the resampling buffer with identical Float32 accumulation',()=>{
 const channels=[Float32Array.of(.1,.2,-.3),Float32Array.of(.4,-.2,.6),Float32Array.of(.9,-.3,.1)];
 const target=new Float32Array(3).fill(99);
 mixMonoInto(channels,target);expect([...target]).toEqual([...mixMono(channels)]);
 expect(()=>mixMonoInto(channels,channels[0])).toThrow();
});
it.each([1,2])('uses one source AudioBuffer for non-16 kHz resampling (%s channels)',async count=>{
 const {vi}=await import('vitest');
 const {decodeAudio}=await import('./audio');
 const data=[new Float32Array(48000).fill(.25),new Float32Array(48000).fill(.75)];
 const decoded={duration:1,length:48000,numberOfChannels:count,sampleRate:48000,getChannelData:(i:number)=>data[i]};
 const mono=new Float32Array(48000),result=new Float32Array(16000);
 const buffer={getChannelData:()=>mono},createBuffer=vi.fn(()=>buffer),close=vi.fn(async()=>{});
 const source={buffer:null as unknown,connect:vi.fn(),start:vi.fn(),disconnect:vi.fn()};
 vi.stubGlobal('AudioContext',class{decodeAudioData=async()=>decoded;close=close});
 vi.stubGlobal('OfflineAudioContext',class{
  destination={};createBuffer=createBuffer;createBufferSource=()=>source;startRendering=async()=>({getChannelData:()=>result});
 });
 try{
  expect(await decodeAudio(new File(['audio'],'resample.wav'))).toBe(result);
  expect(source.buffer).toBe(count===1?decoded:buffer);
  expect(createBuffer).toHaveBeenCalledTimes(count===1?0:1);
  if(count===2)expect(mono[123]).toBe(.5);
  expect(source.disconnect).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
 }finally{vi.unstubAllGlobals()}
});
