const MANIFEST_CACHE='iscribe-model-manifests-v1';
const MODEL_CACHE='transformers-cache';
export type CacheProfile='wasm-q8'|'accelerated-fp16-q4'|'accelerated-fp32-q4'|'full-fp32';
export type CacheManifest={version:2;repo:string;revision:string;profile:CacheProfile;urls:string[]};
const BASE=['config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json'] as const;
// Cache confirmation is profile-specific. Never combine an encoder from one
// dtype/revision with a decoder from another dtype/revision.
const PROFILES:Record<CacheProfile,readonly [string,string]>={
 'wasm-q8':['onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx'],
 'accelerated-fp16-q4':['onnx/encoder_model_fp16.onnx','onnx/decoder_model_merged_q4.onnx'],
 'accelerated-fp32-q4':['onnx/encoder_model.onnx','onnx/decoder_model_merged_q4.onnx'],
 'full-fp32':['onnx/encoder_model.onnx','onnx/decoder_model_merged.onnx']
};
export type CacheInspection={cached:boolean;profile?:CacheProfile;revision?:string;urls?:string[]};
function filesByRevision(urls:readonly string[],repo:string){
 const revisions=new Map<string,Map<string,string>>();
 for(const raw of urls){
  try{
   const url=new URL(raw);
   // Some transformers installations use other HTTPS mirrors. The model path,
   // not an arbitrary substring, must match the requested repository.
   if(url.protocol!=='https:'&&url.protocol!=='http:')continue;
   const prefix='/'+repo+'/resolve/';
   if(!url.pathname.startsWith(prefix))continue;
   const rest=url.pathname.slice(prefix.length);
   const slash=rest.indexOf('/');
   if(slash<1)continue;
   const revision=rest.slice(0,slash),file=rest.slice(slash+1);
   if(!file)continue;
   if(!revisions.has(revision))revisions.set(revision,new Map());
   revisions.get(revision)!.set(file,raw);
  }catch{/* Ignore malformed cache URLs. */}
 }
 return revisions;
}
export function selectWhisperCache(urls:readonly string[],repo:string):CacheInspection{
 for(const [revision,files] of filesByRevision(urls,repo)){
  if(!BASE.every(file=>files.has(file)))continue;
  for(const [profile,weights] of Object.entries(PROFILES) as [CacheProfile,readonly [string,string]][]){
   if(!weights.every(file=>files.has(file)))continue;
   const chosen=[...BASE,...weights].map(file=>files.get(file)!);
   return {cached:true,revision,profile,urls:chosen};
  }
 }
 return {cached:false};
}
export function completeSet(urls:readonly string[],repo:string):boolean {
 return selectWhisperCache(urls,repo).cached;
}
export async function inspectWhisperCache(repo:string):Promise<CacheInspection>{
 try{
  const cache=await caches.open(MODEL_CACHE);
  // Scan the actual cache, not only a possibly outdated v1 manifest. This
  // preserves cached weights when upgrading from previous iScribe releases.
  const selected=selectWhisperCache((await cache.keys()).map(request=>request.url),repo);
  if(!selected.cached||!selected.urls)return {cached:false};
  for(const url of selected.urls){
   const response=await cache.match(url);
   if(!response?.ok)return {cached:false};
   const declared=response.headers.get('content-length');
   if(declared!==null&&Number(declared)===0)return {cached:false};
  }
  return selected;
 }catch{return {cached:false}}
}
export async function checkWhisperCache(repo:string):Promise<boolean>{
 return (await inspectWhisperCache(repo)).cached;
}
export async function recordWhisperCache(repo:string):Promise<boolean>{
 const inspection=await inspectWhisperCache(repo);
 if(!inspection.cached||!inspection.urls||!inspection.profile||!inspection.revision)return false;
 try{
  const manifests=await caches.open(MANIFEST_CACHE);
  const record:CacheManifest={version:2,repo,revision:inspection.revision,profile:inspection.profile,urls:inspection.urls};
  await manifests.put(new Request(new URL('cache-manifest/'+encodeURIComponent(repo),location.href)),new Response(JSON.stringify(record)));
 }catch{/* The actual Transformers cache is still valid if metadata writes fail. */}
 return true;
}
export const speakerRepos={segmentation:'onnx-community/pyannote-segmentation-3.0',embedding:'onnx-community/wespeaker-voxceleb-resnet34-LM'} as const;
export async function checkSpeakerCache(repo:string):Promise<boolean>{
 try{
  const cache=await caches.open(MODEL_CACHE);const prefix=`/${repo}/resolve/main/`;
  const urls=(await cache.keys()).map(r=>r.url).filter(u=>u.includes(prefix));
  for(const file of ['config.json','preprocessor_config.json','onnx/model_quantized.onnx']){
   const url=urls.find(u=>u.endsWith('/'+file));if(!url||!(await cache.match(url))?.ok)return false;
  }
  return true;
 }catch{return false}
}
