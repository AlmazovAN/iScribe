import {expect,it} from 'vitest';
import {mixMono,validateFile,MAX_FILE_BYTES} from './audio';
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
