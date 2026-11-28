// PIPE-01: local, diagnostic-only browser FFmpeg matrix. No production changes.
import {createRequire} from 'node:module';
import {readFile,stat,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const RATE=16000,MAX_FULL=3600*RATE,MAX_BYTES=500*1024*1024;
export const MODES=['A','B','C','D'];
export function buildArgs(mode,window=null){
 if(!MODES.includes(mode)||mode==='D'&&window)throw new Error('unsupported-mode');
 if(window&&(!Number.isSafeInteger(window.start)||window.start<0||!Number.isSafeInteger(window.count)||window.count<1||window.count>30*RATE||!Number.isSafeInteger(window.start+window.count)))throw new Error('invalid-window');
 const args=['-hide_banner','-loglevel','error'];
 if(mode==='A')args.push('-xerror');
 args.push('-threads','1');
 const warm=window?Math.max(0,window.start-RATE):0,skip=window?window.start-warm:0;
 if(warm>0)args.push('-ss',(warm/RATE).toFixed(7));
 args.push('-protocol_whitelist','file','-i','/source/input','-map','0:a:0','-vn','-sn','-dn');
 if(window)args.push('-af','aresample=16000,atrim=start_sample='+skip+':end_sample='+(skip+window.count)+',asetpts=PTS-STARTPTS');
 if(mode==='D')args.push('-af','aresample=16000:async=1:min_hard_comp=0.01:first_pts=0');
 args.push('-t',window?(window.count/RATE).toFixed(7):'3601','-ac','1','-ar','16000');
 args.push('-c:a',mode==='C'?'pcm_s16le':'pcm_f32le','-f',mode==='C'?'s16le':'f32le','/output');
 return args;
}
export function pcmStats(bytes,mode,maxSamples,exactSamples=null){
 const width=mode==='C'?2:4;
 if(bytes.byteLength===0||bytes.byteLength%width!==0)throw new Error('pcm-length');
 const count=bytes.byteLength/width;
 if(count>maxSamples||exactSamples!==null&&count!==exactSamples)throw new Error('pcm-coverage');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let min=Infinity,max=-Infinity,sum=0,zeros=0,overRange=0;
 for(let i=0;i<count;i++){
  const v=width===2?view.getInt16(i*width,true)/32768:view.getFloat32(i*width,true);
  if(!Number.isFinite(v))throw new Error('pcm-nonfinite');
  min=Math.min(min,v);max=Math.max(max,v);sum+=v*v;
  if(v===0)zeros++;if(Math.abs(v)>1)overRange++;
 }
 return {samples:count,seconds:count/16000,min,max,rms:Math.sqrt(sum/count),zeros,overRange};
}
function workerMain(){
 self.onmessage=async({data:{file,wasm,args,mode,maxSamples,exactSamples}})=>{
  const errors=globalThis.createFfmpegErrorCollector();
  let core,status=null,phase='init';
  const t0=performance.now();
  try{
   core=await self.createFFmpegCore({wasmBinary:new Uint8Array(await wasm.arrayBuffer())});
   const initMs=performance.now()-t0,fs=core.FS;
   phase='mount';
   if(!fs.filesystems?.WORKERFS)throw new Error('workerfs');
   fs.mkdir('/source');fs.mount(fs.filesystems.WORKERFS,{blobs:[{name:'input',data:file}]},'/source');
   core.setLogger(errors.observe);
   phase='decode';
   const started=performance.now();
   core.exec(...args);status=core.ret;
   const decodeMs=performance.now()-started;
   if(status!==0){self.postMessage({outcome:'decode-error',exitCode:Number.isInteger(status)?status:null,initMs,decodeMs,...errors.snapshot()});return;}
   phase='pcm';
   const bytes=fs.readFile('/output');
   const pcm=pcmStats(bytes,mode,maxSamples,exactSamples);
   self.postMessage({outcome:'decoded',exitCode:0,initMs,decodeMs,...errors.snapshot(),pcm});
  }catch(error){
   const code=['pcm-length','pcm-coverage','pcm-nonfinite','workerfs'].includes(error?.message)?error.message:phase+'-error';
   self.postMessage({outcome:code,exitCode:Number.isInteger(status)?status:null,...errors.snapshot()});
  }finally{
   if(core){try{core.FS.unlink('/output')}catch{/* absent */}try{core.FS.unmount('/source')}catch{/* absent */}}
  }
 };
}
function makeWav(){
 // 1 second, 16 kHz, mono PCM16; known integer waveform, no speech.
 const data=Buffer.alloc(44+RATE*2);
 data.write('RIFF',0);data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);
 data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);
 data.writeUInt32LE(RATE,24);data.writeUInt32LE(RATE*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);
 data.write('data',36);data.writeUInt32LE(RATE*2,40);
 for(let i=0;i<RATE;i++)data.writeInt16LE(Math.round(10000*Math.sin(i*2*Math.PI*440/RATE)),44+i*2);
 return data;
}
function parse(argv){
 const selfTest=argv[0]==='--self-test',file=selfTest?null:argv[0];
 if(!selfTest&&(!file||file.startsWith('--')))throw new Error('usage');
 const windows=[];let expected=null;
 for(const arg of argv.slice(1)){
  if(arg.startsWith('--window=')){
   const raw=arg.slice(9).split(':');
   if(raw.length!==2||raw.some(x=>!/^\d+(\.\d+)?$/.test(x)))throw new Error('usage');
   const [start,count]=raw.map(x=>Math.round(Number(x)*RATE));
   const w={start,count};buildArgs('A',w);windows.push(w);
  }else if(arg.startsWith('--expected-seconds=')){
   const raw=arg.slice(19);expected=Number(raw);
   if(!/^\d+(\.\d+)?$/.test(raw)||!Number.isFinite(expected)||expected<=0||expected>3600)throw new Error('usage');
  }else throw new Error('usage');
 }
 if(windows.length>20||windows.length&&expected!==null||selfTest&&(windows.length||expected!==null))throw new Error('usage');
 return {selfTest,file,windows,expected};
}
async function run(){
 const options=parse(process.argv.slice(2)),requireCore=createRequire(import.meta.url);
 const corePath=requireCore.resolve('@ffmpeg/core'),wasmPath=requireCore.resolve('@ffmpeg/core/wasm');
 const classifier=await readFile(new URL('../src/ffmpegErrorClassifier.js',import.meta.url),'utf8');
 const workerSource=classifier+';\n'+pcmStats.toString()+';\n('+workerMain.toString()+')();';
 let temp,browser;
 try{
  let file=options.file;
  if(options.selfTest){temp=await mkdtemp(join(tmpdir(),'iscribe-pipe01-'));file=join(temp,'test.wav');await writeFile(file,makeWav());}
  const size=(await stat(file)).size;
  if(size<1||size>MAX_BYTES||!options.windows.length&&size>128*1024*1024)throw new Error('size-limit');
  const {chromium}=await import('@playwright/test');
  browser=await chromium.launch();
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*',route=>route.abort()); // no network access, no private uploads
  const page=await context.newPage();
  await page.setContent('<input id="audio" type="file"><input id="core" type="file"><input id="wasm" type="file">');
  await page.locator('#audio').setInputFiles(resolve(file));
  await page.locator('#core').setInputFiles(corePath);
  await page.locator('#wasm').setInputFiles(wasmPath);
  const routes=options.selfTest?[null,{start:0,count:RATE}]:options.windows.length?options.windows:[null];
  const results=[];
  for(const window of routes){
   const group=[];
   for(const mode of window?MODES.slice(0,3):MODES){
    const row=await page.evaluate(async({source,args,mode,maxSamples,exactSamples})=>{
     const file=document.querySelector('#audio').files[0];
     const core=await document.querySelector('#core').files[0].text();
     const wasm=document.querySelector('#wasm').files[0];
     const url=URL.createObjectURL(new Blob([core,';\n',source],{type:'text/javascript'}));
     let worker;
     try{
      worker=new Worker(url);
      return await new Promise(resolve=>{
       const timer=setTimeout(()=>resolve({outcome:'timeout'}),600000);
       const finish=value=>{clearTimeout(timer);resolve(value);};
       worker.onmessage=e=>finish(e.data);worker.onerror=()=>finish({outcome:'worker-error'});worker.onmessageerror=()=>finish({outcome:'protocol-error'});
       worker.postMessage({file,wasm,args,mode,maxSamples,exactSamples});
      });
     }finally{worker?.terminate();URL.revokeObjectURL(url);}
    },{source:workerSource,args:buildArgs(mode,window),mode,maxSamples:window?window.count:MAX_FULL,exactSamples:window?window.count:null});
    const expected=window?window.count:options.selfTest?RATE:options.expected===null?null:Math.round(options.expected*RATE);
    group.push({mode,...row,expectedSamples:expected,driftSamples:expected!==null&&row.pcm?row.pcm.samples-expected:null});
   }
   const strict=group[0].pcm;
   for(const item of group)item.deltaFromStrictSamples=strict&&item.pcm?item.pcm.samples-strict.samples:null;
   results.push({route:window?'windowed-sample':'full',window,variants:group});
  }
  const result={schema:1,core:'@ffmpeg/core 0.12.10',browser:browser.version(),sourceBytes:size,selfTest:options.selfTest,results,notes:['Decode only; no ASR or production recovery acceptance','D is timestamp-compensated command only, not PR76 eligibility policy','Window sample is not a full streaming-route acceptance']};
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  // Diagnostic outcomes are reported individually; self-test fails if healthy
  // fixture does not decode in every mode or expected length differs.
  if(options.selfTest&&results.some(g=>g.variants.some(v=>v.outcome!=='decoded'||v.driftSamples!==0||v.pcm.rms<0.1||v.pcm.rms>0.4||v.errorLines!==0)))process.exitCode=1;
 }finally{try{await browser?.close()}finally{if(temp)await rm(temp,{recursive:true,force:true});}}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 run().catch(()=>{process.stderr.write('PIPE-01: comparison could not run. Check local dependencies, Chromium, file size/path and arguments. No private error details exported.\n');process.exitCode=1;});
}
