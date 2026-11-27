// Windowed FFmpeg CLI, not a continuous libav decoding session.
// WORKERFS exposes the original immutable Blob to Emscripten on demand.
// Never copy the complete source into MEMFS, never upload media or logs.
const RATE=16000, MAX_WINDOW=30*RATE, TAIL_BEFORE=15*RATE, TAIL_LIMIT=45*RATE;
const INPUT='/source/input',OUTPUT='/window.pcm';
let core,length=0,sourceRate=0,busy=false;
function execute(fn){
 core.reset();
 try{return fn()}finally{core.reset()}
}
function removeOutput(){
 if(core.FS.analyzePath(OUTPUT).exists)core.FS.unlink(OUTPUT);
}
function decode(start,count,id,allowShort=false){
 const warm=Math.max(0,start-RATE),skip=start-warm;
 let lastProgress=0;
 core.setLogger(()=>{});
 core.setProgress(event=>{
  const time=Number(event.time);
  // Only monotonic media output is a heartbeat, not incoming messages.
  if(Number.isFinite(time)&&time>lastProgress&&time<=count/RATE*1e6+1e6){
   lastProgress=time;self.postMessage({id,kind:'progress',time});
  }
 });
 removeOutput();
 try{
  const args=['-hide_banner','-loglevel','error','-xerror','-threads','1'];
  if(warm>0)args.push('-ss',(warm/RATE).toFixed(7));
  args.push('-protocol_whitelist','file','-i',INPUT,'-map','0:a:0','-vn','-sn','-dn',
   '-af','aresample=16000,atrim=start_sample='+skip+':end_sample='+(skip+count)+',asetpts=PTS-STARTPTS',
   '-t',(count/RATE).toFixed(7),'-ac','1','-ar','16000','-c:a','pcm_f32le','-f','f32le',OUTPUT);
  const status=execute(()=>core.exec(...args));
  if(status!==0)throw Object.assign(new Error('decode'),{exitCode:status});
  const bytes=core.FS.readFile(OUTPUT);
  const samples=bytes.byteLength/4;
  if(!Number.isSafeInteger(samples)||samples<=0||samples>count||(!allowShort&&samples!==count))
   throw new Error('coverage');
  // readFile returns independent bytes; keep ownership explicit.
  return Uint8Array.from(bytes).buffer;
 }finally{core.setProgress(()=>{});removeOutput()}
}
// core 0.12.10 has a known ffprobe success-status bug (#817).
// Only accept -1 when a fresh, complete, validated report exists and no
// error-level message was emitted. Do not waive FFmpeg decode exit codes.
function probeMetadata(){
 const output='/probe.json',fs=core.FS;
 let hadError=false,status;
 if(fs.analyzePath(output).exists)fs.unlink(output);
 core.setLogger(event=>{if(event.type==='stderr'&&event.message?.trim())hadError=true;});
 try{
  status=execute(()=>core.ffprobe('-v','error','-protocol_whitelist','file','-select_streams','a:0',
   '-show_entries','stream=duration,start_time,sample_rate:format=duration,start_time','-of','json','-o',output,INPUT));
  if((status!==0&&status!==-1)||hadError)
   throw Object.assign(new Error('probe-exit'),{exitCode:status});
  if(!fs.analyzePath(output).exists||fs.stat(output).size<=0||fs.stat(output).size>65536)
   throw Object.assign(new Error('probe-json'),{exitCode:status});
  let metadata;
  try{metadata=JSON.parse(fs.readFile(output,{encoding:'utf8'}))}
  catch{throw Object.assign(new Error('probe-json'),{exitCode:status})}
  if(!metadata||!Array.isArray(metadata.streams)||metadata.streams.length!==1||
    !metadata.streams[0]||typeof metadata.streams[0]!=='object')
   throw Object.assign(new Error('probe-metadata'),{exitCode:status});
  return metadata;
 }finally{
  core.setLogger(()=>{});
  if(fs.analyzePath(output).exists)fs.unlink(output);
 }
}
// Standalone supplies the core inline and a compressed Blob. Web supplies
// pinned same-origin URLs. Never depend on file:// cross-context Blob fetch.
async function initializeCore({coreURL,wasmURL,wasmBlob}){
 let wasmBinary;
 try{
  if(wasmBlob instanceof Blob){
   if(typeof self.createFFmpegCore!=='function')throw new Error('missing core');
   wasmBinary=new Uint8Array(await new Response(wasmBlob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }else{
   self.importScripts(coreURL);
   const response=await fetch(wasmURL);
   if(!response.ok||!response.body)throw new Error('missing wasm');
   wasmBinary=new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
 }catch{throw new Error('asset')}
 try{
  return await self.createFFmpegCore(wasmBlob instanceof Blob?{wasmBinary}:{
   wasmBinary,mainScriptUrlOrBlob:coreURL+'#'+btoa(JSON.stringify({wasmURL}))
  });
 }catch{throw new Error('initialize')}
}
async function open({file,coreURL,wasmURL,wasmBlob},id){
 core=await initializeCore({coreURL,wasmURL,wasmBlob});
 const fs=core.FS,workerfs=fs.filesystems?.WORKERFS;
 if(!workerfs)throw new Error('workerfs');
 fs.mkdir('/source');
 fs.mount(workerfs,{blobs:[{name:'input',data:file}]},'/source');
 const metadata=probeMetadata();
 const stream=metadata.streams?.[0],format=metadata.format;
 sourceRate=Number(stream?.sample_rate);
 const positive=value=>Number.isFinite(Number(value))&&Number(value)>0;
 const estimate=Number(positive(stream?.duration)?stream.duration:format?.duration);
 // Seeking is relative to container start. Refuse ambiguous delayed tracks
 // instead of silently shifting the existing audio timeline.
 const audioOrigin=Number(stream?.start_time),containerOrigin=Number(format?.start_time);
 if(Number.isFinite(audioOrigin)&&Number.isFinite(containerOrigin)&&Math.abs(audioOrigin-containerOrigin)>0.01)
  throw new Error('timeline');
 const estimatedSamples=Math.round(estimate*RATE);
 if(!Number.isSafeInteger(estimatedSamples)||estimatedSamples<=0||
    Math.ceil(estimatedSamples/(25*RATE))>file.size||
    !Number.isInteger(sourceRate)||sourceRate<8000||sourceRate>384000)
  throw new Error('probe-metadata');
 // Container duration can include encoder padding or be an estimate (VBR).
 // Decode a bounded tail to find EOF on the selected audio track. Never
 // pad a short window or treat a fully filled tail budget as proven EOF.
 const tailStart=Math.max(0,estimatedSamples-TAIL_BEFORE);
 const tail=decode(tailStart,TAIL_LIMIT,id,true);
 const tailSamples=tail.byteLength/4;
 if(tailSamples>=TAIL_LIMIT)throw new Error('duration');
 length=tailStart+tailSamples;
 if(!Number.isSafeInteger(length)||length<=0||Math.ceil(length/(25*RATE))>file.size)
  throw new Error('duration');
 return {length,sourceRate};
}
const knownErrors=new Set(['runtime','asset','initialize','workerfs','decode','coverage','probe','probe-exit','probe-json','probe-metadata','timeline','duration','window','protocol']);
self.onmessage=async({data:request})=>{
 const {id,kind}=request;
 if(busy){self.postMessage({id,kind:'error',code:'protocol'});return;}
 busy=true;
 try{
  if(kind==='open'&&!core){
   const metadata=await open(request,id);
   self.postMessage({id,kind:'opened',...metadata});
  }else if(kind==='read'&&core&&length){
   const {start,end}=request;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end>length||end<=start||end-start>MAX_WINDOW)
    throw new Error('window');
   const buffer=decode(start,end-start,id);
   self.postMessage({id,kind:'pcm',buffer},[buffer]);
  }else throw new Error('protocol');
 }catch(error){
  const code=knownErrors.has(error?.message)?error.message:'runtime';
  const exitCode=Number.isInteger(error?.exitCode)&&error.exitCode>=-255&&error.exitCode<=255?error.exitCode:undefined;
  self.postMessage({id,kind:'error',code,exitCode});
 }finally{busy=false}
};
