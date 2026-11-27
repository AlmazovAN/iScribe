import {test,expect} from '@playwright/test';

test('DEC-02 real FFmpeg WORKERFS window reads, overlap, seek and close',async({page})=>{
 await page.goto('/tests/e2e/harness.html');
 const report=await page.evaluate(async()=>{
  const {openFfmpegStreamedAudio}=await import('/src/ffmpegStreamedAudio.ts');
  const rate=16000,frames=41*rate,bytes=frames*2;
  const wav=new ArrayBuffer(44+bytes),v=new DataView(wav);
  const tag=(at,value)=>{for(let i=0;i<value.length;i++)v.setUint8(at+i,value.charCodeAt(i));};
  tag(0,'RIFF');v.setUint32(4,36+bytes,true);tag(8,'WAVE');tag(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);
  v.setUint16(32,2,true);v.setUint16(34,16,true);tag(36,'data');v.setUint32(40,bytes,true);
  // Non-periodic deterministic waveform detects time-shifted seeks.
  for(let i=0;i<frames;i++)v.setInt16(44+i*2,((i*97)%20011)-10000,true);
  const file=new File([wav],'synthetic.wav',{type:'audio/wav'});
  // The Worker must not use a full-file ArrayBuffer copy. The actual
  // WORKERFS implementation is exercised even for this small fixture.
  const source=await openFfmpegStreamedAudio(file);
  let result;
  try{
   const first=await source.read({start:0,end:30*rate,first:true,last:false});
   const second=await source.read({start:25*rate,end:41*rate,first:false,last:true});
   const retry=await source.read({start:25*rate,end:30*rate,first:false,last:false});
   let overlapError=0,retryError=0,referenceError=0;
   for(let i=0;i<5*rate;i++){
    overlapError=Math.max(overlapError,Math.abs(first[25*rate+i]-second[i]));
    retryError=Math.max(retryError,Math.abs(retry[i]-second[i]));
   }
   for(let i=0;i<second.length;i++)
    referenceError=Math.max(referenceError,Math.abs(second[i]-v.getInt16(44+(25*rate+i)*2,true)/32768));
   result={length:source.length,first:first.length,second:second.length,retry:retry.length,overlapError,retryError,referenceError};
  }finally{source.close()}
  let rejected=false;
  try{await source.read({start:0,end:1,first:true,last:false})}catch{rejected=true}
  return {...result,rejected};
 });
 expect(report.length).toBe(656000);
 expect(report.first).toBe(480000);expect(report.second).toBe(256000);expect(report.retry).toBe(80000);
 expect(report.overlapError).toBeLessThan(0.00001);
 expect(report.retryError).toBeLessThan(0.00001);
 expect(report.referenceError).toBeLessThan(0.00001);
 expect(report.rejected).toBe(true);
});

test('DEC-02 FFmpeg rejects invalid source without legacy fallback',async({page})=>{
 await page.goto('/tests/e2e/harness.html');
 const report=await page.evaluate(async()=>{
  const {openFfmpegStreamedAudio}=await import('/src/ffmpegStreamedAudio.ts');
  try{const source=await openFfmpegStreamedAudio(new File(['not audio'],'bad.mp3'));source.close();return 'unexpected success';}
  catch(error){return String(error.message);}
 });
 expect(report).toContain('FFmpeg:');
 expect(report).not.toContain('unexpected success');
});
