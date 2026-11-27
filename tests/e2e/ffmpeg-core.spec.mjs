import {test,expect} from '@playwright/test';

test('DEC-01 real FFmpeg decodes a synthetic stereo WAV to mono 16 kHz PCM',async({page})=>{
 await page.goto('/tests/e2e/harness.html');
 const result=await page.evaluate(async()=>{
  const {decodeFfmpegAudio}=await import('/src/ffmpegDecoder.ts');
  const rate=48000,frames=4800,channels=2,bytes=frames*channels*2;
  const wav=new ArrayBuffer(44+bytes),v=new DataView(wav);
  const tag=(at,value)=>{for(let i=0;i<value.length;i++)v.setUint8(at+i,value.charCodeAt(i));};
  tag(0,'RIFF');v.setUint32(4,36+bytes,true);tag(8,'WAVE');tag(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);
  v.setUint32(24,rate,true);v.setUint32(28,rate*channels*2,true);
  v.setUint16(32,channels*2,true);v.setUint16(34,16,true);tag(36,'data');v.setUint32(40,bytes,true);
  for(let i=0;i<frames;i++)for(let c=0;c<channels;c++)v.setInt16(44+(i*channels+c)*2,Math.round(10000*Math.sin(i*2*Math.PI*440/rate)),true);
  const pcm=await decodeFfmpegAudio(new File([wav],'synthetic.wav',{type:'audio/wav'}));
  return {length:pcm.length,peak:Math.max(...pcm.map(Math.abs)),finite:pcm.every(Number.isFinite)};
 });
 expect(result.length).toBe(1600);expect(result.finite).toBe(true);
 expect(result.peak).toBeGreaterThan(0.1);expect(result.peak).toBeLessThan(0.6);
});
test('DEC-01 real FFmpeg rejects invalid compressed input',async({page})=>{
 await page.goto('/tests/e2e/harness.html');
 const result=await page.evaluate(async()=>{
  const {decodeFfmpegAudio}=await import('/src/ffmpegDecoder.ts');
  try{await decodeFfmpegAudio(new File(['not an audio stream'],'synthetic.mp3'));return 'unexpected success';}
  catch(error){return String(error.message);}
 });
 expect(result.toLowerCase()).toContain('не удалось декодировать');
});
