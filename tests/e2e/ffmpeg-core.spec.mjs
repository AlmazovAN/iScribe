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
  catch(error){return {message:String(error.message),details:error.diagnostic?.details,errorLines:error.diagnostic?.errorLines};}
 });
 expect(result.message.toLowerCase()).toContain('не удалось декодировать');
 expect(result.errorLines).toBeGreaterThan(0);
 expect(result.details.length).toBeGreaterThan(0);
});

// Generated locally: FFmpeg 7.1.5 sine=440 Hz, 16kHz, 0.25s,
// libmp3lame 24k, no Xing/ID3. No user audio. Native reference 5184 PCM samples.
test('DEC-FIX real compressed MP3 decodes through the strict FFmpeg path',async({page})=>{
 await page.goto('/tests/e2e/harness.html');
 const result=await page.evaluate(async(encoded)=>{
  const {decodeFfmpegAudio}=await import('/src/ffmpegDecoder.ts');
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  try{const pcm=await decodeFfmpegAudio(new File([bytes],'synthetic.mp3',{type:'audio/mpeg'}));
   return {samples:pcm.length,finite:pcm.every(Number.isFinite),peak:Math.max(...pcm.map(Math.abs))};
  }catch(error){return {failure:error.failure,exitCode:error.exitCode,diagnostic:error.diagnostic};}
 },"//M4xAATuGaMP08YAAvW27cK9Xq9Xq9Xs79+rE4hioay3ibibjjIQaBoIYrGR4CAPg+D5/KOy5/lHTnT5zl/Ocv7un3ZQEwfPrD4IBiUAYPvkwQOZd/dy4Pg+D6AERSMBgQCAQCAAAANKWG///M4xBAZKY6tv5mgAv/faU/d+lSNNQwUMPp1kQemBEKFzIhUDFMQUFk4BiIgW9Gos4UEKCIb/jmjmk0RYi3/kyOaOaTRFiLf/mJdJkyLxeMf/8ul1IyMkQVZ/lgqCoiCoK3//+yRYyCZ41+G//M4xAoXUHocAd9AAADYBEYByBFGBYgExgWAImYPIJwmYlB+xp/4poYcmHjGE1A75gzAX6YAaCnmBPAG5gDQAWSgACFTvNxAkaruhWUuR/n9/Jq/0/bt/ptT/1e9C9dq1SAF///5P6oMWZMh//M4xAsVyHYcEs/4ZBMmIzvzAHwHIwEYDvMDHC1jEunSIyikO8MCiAzTKYiONXEzafzLoQBQpL9MlgacuVT21di59M/67Sn639n3/0/7SlyOu3bu3N6rPuQq///ldyFdqhHAHAASGDommIhG//M4xBIWEHYYAO/6gBkSjZpxmhjK7+4ZrYIoGDTgupnCcpq1AxkOUBjKC4KCwv2tRx3cjFOGdq7VTme/l7kXovau1Hya/o/XYm/tX5zoVaqwvPoqg/X/2hYwWADC4AAIHhoVQwnzIYCDPkIT//M4xBgYiNoUoO/mho0E4y7MF8NjIAqjCiwPEwLkFBMBGDvjACQUwUASwToDQIlw1yAFQtnu9evXvp689+q5M/uSv3p2re3aq/f5a5F+5vT8iuxLnFP11f//+wwMvej8DQAYwB4AkMBCASDA//M4xBQVsHYkAV9IABMC7MEbBjTC0xNExXFSBMt4BiDBtAQgwIgDqMB+BtDAUgJQwKoBeMAqAFiIAMTHXe64jJw9/9v//f////tT//97dqmwIIIIMIID//yzhaz2dextphgggYEYn9GwMVjg//M4xBwcEd6AVZugAB9MYXj4xYDDtQvabAZRODj5UAUbAMDyT/wt/C5sd4s//xKZEyHjNk//+UyDlc6Rc3//zpfN0S+bo///l83RL5uxfN3f/Lh4HwGHhO7//WHiY00lxpUhFKOS3f/gfswE//M4xAoVIHbBv8MQAszLszMYUBAjVVVVUCFPBUFQWfBUFQ7gqC2JQVBrBUFn4K0xKCwNPgqDQNPEoLA0HYKg0DT4LA0DWIgaPYiBrUDR7LA1xEe1A1yx5UxBTUUzLjEwMFVVVVVVVVVVVVVV");
 expect(result).toMatchObject({samples:5184,finite:true});
 expect(result.peak).toBeGreaterThan(0.01);
});
