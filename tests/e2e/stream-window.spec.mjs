import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

// Generated PCM WAV, not a user recording. Real Mediabunny and Web Audio
// decode/resample; no real Whisper model or GPU benchmark is involved.
function wav(seconds,rate){
 const samples=seconds*rate,bytes=Buffer.alloc(44+samples*2);
 bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
 bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
 bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(8192*Math.sin(2*Math.PI*440*i/rate)),44+i*2);
 return bytes;
}
test('real browser WAV decoding at window 41, both strategies and durable JSON',async({page})=>{
 await page.goto('/tests/e2e/harness.html');
 await expect(page.getByRole('button',{name:'Выбрать файлы'})).toBeEnabled();
 // 1030 s at 16 kHz: 41 windows, last one exactly 30 seconds.
 await page.locator('input[type="file"]').setInputFiles({name:'synthetic-1030s.wav',mimeType:'audio/wav',buffer:wav(1030,16000)});
 await expect(page.locator('.file-row')).toHaveCount(1);
 await page.locator('.diagnostics-panel > summary').click();
 const probe=page.getByRole('region',{name:'Проверка отдельного окна'});
 await probe.getByRole('spinbutton',{name:'Номер окна'}).fill('41');
 await expect(probe).toContainText('16:40 – 17:10');
 await probe.getByRole('button',{name:'Проверить целиком'}).click();
 await expect(probe).toContainText('Окно 41 · целиком · пройдено',{timeout:60000});
 await probe.getByRole('button',{name:'Проверить частями по 5 с'}).click();
 await expect(probe).toContainText('Окно 41 · частями · пройдено',{timeout:60000});
 await expect(probe).toContainText('частей готово: 6');
 await page.locator('.diagnostics-log > summary').click();
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Скачать журнал JSON'}).click()]);
 const raw=await readFile(await download.path(),'utf8'),report=JSON.parse(raw);
 expect(report.job).toMatchObject({committedWindows:0,asrComplete:false,stage:'waiting'});
 expect(report.streamRecovery).toBeNull();
 expect(report.windowInspections).toHaveLength(2);
 for(const r of report.windowInspections){
  expect(r).toMatchObject({window:41,status:'passed',startSample:16000000,endSample:16480000,report:{pcmSamples:480000,quietWindows:0,nearClippedWindows:0}});
  expect(r.report.peakAbsolute).toBeCloseTo(.25,2);
 }
 expect(report.events.filter(e=>e.phase==='asr')).toHaveLength(0);
 expect(raw).not.toContain('synthetic-1030s.wav');
 expect(await page.evaluate(()=>localStorage.getItem('iscribe-e2e:transcribeCount'))).toBeNull();
 await page.reload();
 await page.locator('.diagnostics-panel > summary').click();
 await expect(page.getByRole('region',{name:'Проверка отдельного окна'})).toContainText('Окно 41 · частями · пройдено');
});
test('real browser resamples WAV from 48 kHz; split and whole have exact length and similar PCM',async({page})=>{
 await page.goto('/tests/e2e/harness.html');
 const result=await page.evaluate(async()=>{
  const {openStreamedAudio}=await import('/src/streamedAudio.ts');
  const rate=48000,n=rate*35,b=new ArrayBuffer(44+n*2),v=new DataView(b);
  const str=(offset,s)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i))};
  str(0,'RIFF');v.setUint32(4,b.byteLength-8,true);str(8,'WAVEfmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
  str(36,'data');v.setUint32(40,n*2,true);
  for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.round(8192*Math.sin(2*Math.PI*440*i/rate)),true);
  const file=new File([b],'synthetic.wav',{type:'audio/wav'});
  const first=await openStreamedAudio(file),events=[];
  let whole;
  try{whole=await first.read({start:0,end:480000,first:true,last:false},e=>{events.push(e.code)})}
  finally{first.close()}
  const second=await openStreamedAudio(file),joined=new Float32Array(480000);
  try{
   for(let part=0;part<6;part++){
    const start=part*80000,end=start+80000;
    const pcm=await second.read({start,end,first:part===0,last:false},undefined,undefined,true);
    if(pcm.length!==80000)throw new Error('short fragment');
    joined.set(pcm,start);
   }
  }finally{second.close()}
  let sum=0,peak=0;
  for(let i=0;i<joined.length;i++){const d=joined[i]-whole[i];sum+=d*d;peak=Math.max(peak,Math.abs(joined[i]))}
  return {length:whole.length,splitLength:joined.length,events,rmsDifference:Math.sqrt(sum/joined.length),peak};
 });
 expect(result).toMatchObject({length:480000,splitLength:480000});
 expect(result.events).toContain('stream-resample-start');expect(result.events).toContain('stream-resample-end');
 expect(result.peak).toBeCloseTo(.25,2);
 // No claim of bit-identical seams; this is a controlled sine-wave check.
 expect(result.rmsDifference).toBeLessThan(.01);
});
