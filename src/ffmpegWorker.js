// Classic, isolated Worker. This file is embedded as raw JS, not executed
// on the UI thread. No audio names, content, or FFmpeg logs leave the Worker.
self.onmessage=async({data:{file,coreURL,wasmURL,maxSamples}})=>{
 let core;
 try{
  self.importScripts(coreURL);
  const response=await fetch(wasmURL);
  if(!response.ok||!response.body)throw Error('FFmpeg WASM asset unavailable');
  const wasmBinary=new Uint8Array(await new Response(
   response.body.pipeThrough(new DecompressionStream('gzip'))
  ).arrayBuffer());
  core=await self.createFFmpegCore({
   wasmBinary,
   mainScriptUrlOrBlob:coreURL+'#'+btoa(JSON.stringify({wasmURL}))
  });
  core.setLogger(()=>{});
  core.FS.writeFile('/input',new Uint8Array(await file.arrayBuffer()));
  // One extra second allows the caller to distinguish too-long audio
  // from a valid one-hour recording. Never silently truncate.
  core.exec('-hide_banner','-loglevel','error','-xerror','-threads','1',
   '-i','/input','-map','0:a:0','-vn','-sn','-dn','-t',String(maxSamples/16000+1),
   '-ac','1','-ar','16000','-c:a','pcm_f32le','-f','f32le','/output');
  const status=core.ret;
  if(status!==0){self.postMessage({kind:'error',code:'decode',status});return;}
  const bytes=core.FS.readFile('/output');
  if(bytes.byteLength===0||bytes.byteLength%4!==0||bytes.byteLength/4>maxSamples){
   self.postMessage({kind:'error',code:'length'});return;
  }
  // FS ownership is not guaranteed. Transfer an independently owned buffer.
  const result=Uint8Array.from(bytes).buffer;
  self.postMessage({kind:'pcm',buffer:result},[result]);
 }catch{
  self.postMessage({kind:'error',code:'runtime'});
 }finally{
  if(core){
   for(const name of ['/input','/output'])try{core.FS.unlink(name)}catch{/* missing file */}
  }
 }
};
