const MANIFEST_CACHE='iscribe-model-manifests-v1';
const MODEL_CACHE='transformers-cache';
export type CacheManifest={version:1;repo:string;urls:string[]};
export function completeSet(urls:readonly string[],repo:string):boolean {
 const paths=urls.filter(u=>u.includes(`/${repo}/resolve/`));
 return ['config.json','tokenizer_config.json','tokenizer.json','preprocessor_config.json'].every(f=>paths.some(u=>u.endsWith('/'+f))) && ['encoder_model','decoder_model_merged'].every(f=>paths.some(u=>u.includes('/onnx/'+f)&&u.endsWith('.onnx')));
}
export async function recordWhisperCache(repo:string):Promise<boolean>{
 try{
  const cache=await caches.open(MODEL_CACHE);
  const urls=(await cache.keys()).map(r=>r.url).filter(u=>u.includes(`/${repo}/resolve/`));
  if(!completeSet(urls,repo))return false;
  const manifests=await caches.open(MANIFEST_CACHE);
  await manifests.put(new Request(new URL('cache-manifest/'+encodeURIComponent(repo),location.href)),new Response(JSON.stringify({version:1,repo,urls} satisfies CacheManifest)));
  return await checkWhisperCache(repo);
 }catch{return false}
}
export async function checkWhisperCache(repo:string):Promise<boolean>{
 try{
  const manifests=await caches.open(MANIFEST_CACHE);
  const response=await manifests.match(new URL('cache-manifest/'+encodeURIComponent(repo),location.href).href);
  if(!response)return false;
  const manifest:unknown=await response.json();
  if(!manifest || typeof manifest!=='object' || !('version' in manifest) || manifest.version!==1 || !('repo' in manifest)||manifest.repo!==repo || !('urls' in manifest) || !Array.isArray(manifest.urls)||!manifest.urls.every(u=>typeof u==='string'))return false;
  const urls=manifest.urls as string[];
  if(!completeSet(urls,repo))return false;
  const cache=await caches.open(MODEL_CACHE);
  for(const url of urls)if(!(await cache.match(url))?.ok)return false;
  return true;
 }catch{return false}
}
