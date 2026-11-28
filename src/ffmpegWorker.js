// Classic, isolated Worker. This file is embedded as raw JS, not executed
// on the UI thread. No audio names, content, or FFmpeg logs leave the Worker.
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
self.onmessage=async({data:{file,coreURL,wasmURL,wasmBlob,maxSamples,frameRecovery}})=>{
 let core;
 const errors=globalThis.createFfmpegErrorCollector();
 try{
  core=await initializeCore({coreURL,wasmURL,wasmBlob});
  core.setLogger(errors.observe);
  const fs=core.FS,workerfs=fs.filesystems?.WORKERFS;
  if(!workerfs){self.postMessage({kind:'error',code:'workerfs'});return;}
  fs.mkdir('/source');fs.mount(workerfs,{blobs:[{name:'input',data:file}]},'/source');
  // One extra second allows the caller to distinguish too-long audio
  // from a valid one-hour recording. Never silently truncate.
  const args=['-hide_banner','-loglevel','error'];
  if(frameRecovery!==true)args.push('-xerror');
  args.push('-threads','1','-protocol_whitelist','file','-i','/source/input','-map','0:a:0','-vn','-sn','-dn','-t',String(maxSamples/16000+1));
  // Timestamp compensation can insert/trim samples, not reconstruct speech.
  if(frameRecovery===true)args.push('-af','aresample=16000:async=1:min_hard_comp=0.01:first_pts=0');
  args.push('-ac','1','-ar','16000','-c:a','pcm_f32le','-f','f32le','/output');
  core.exec(...args);
  const status=core.ret;
  if(status!==0){self.postMessage({kind:'error',code:'decode',status,...errors.snapshot()});return;}
  const bytes=core.FS.readFile('/output');
  if(bytes.byteLength===0||bytes.byteLength%4!==0||bytes.byteLength/4>maxSamples){
   self.postMessage({kind:'error',code:'length'});return;
  }
  // FS ownership is not guaranteed. Transfer an independently owned buffer.
  const result=Uint8Array.from(bytes).buffer;
  self.postMessage({kind:'pcm',buffer:result,...(frameRecovery===true?errors.snapshot():{})},[result]);
 }catch(error){
  const code=error?.message==='asset'||error?.message==='initialize'?error.message:'runtime';
  self.postMessage({kind:'error',code,...errors.snapshot()});
 }finally{
  if(core){
   try{core.FS.unlink('/output')}catch{/* missing file */}
   try{core.FS.unmount('/source')}catch{/* not mounted */}
  }
 }
};
