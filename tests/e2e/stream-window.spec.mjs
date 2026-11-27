import {test,expect} from '@playwright/test';

test('real browser decodes window 41 directly without diagnostic UI',async({page})=>{
 await page.goto('/tests/e2e/harness.html');
 const result=await page.evaluate(async()=>{
  const {openStreamedAudio}=await import('/src/streamedAudio.ts');
  const rate=16000,n=1030*rate,b=new ArrayBuffer(44+n*2),v=new DataView(b);
  const str=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i))};
  str(0,'RIFF');v.setUint32(4,b.byteLength-8,true);str(8,'WAVEfmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);
  v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,n*2,true);
  for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.round(8192*Math.sin(2*Math.PI*440*i/rate)),true);
  const file=new File([b],'synthetic.wav',{type:'audio/wav'}),start=16000000,end=16480000;
  const first=await openStreamedAudio(file);let whole;
  try{whole=await first.read({start,end,first:false,last:true})}finally{first.close()}
  const second=await openStreamedAudio(file);let count=0;
  try{for(let part=0;part<6;part++){const a=start+part*80000;count+=(await second.read({start:a,end:a+80000,first:false,last:part===5},undefined,undefined,true)).length}}finally{second.close()}
  return {whole:whole.length,split:count};
 });
 expect(result).toEqual({whole:480000,split:480000});
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
