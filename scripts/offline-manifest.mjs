import {createHash} from 'node:crypto';

const BUILT_ASSET=/\.(?:js|css|mjs|wasm\.gz\.bin|woff2?|png|svg|ico|webmanifest)$/i;
// Vite emits hashed script and worker names. Pin exactly the files in this
// build, not every URL visited by the user.
export function offlineAssetsFromBundle(bundle){
 const assets=new Set(['index.html']);
 for(const [name,item] of Object.entries(bundle)){
  if(name.startsWith('/')||name.includes('..')||name==='sw.js')continue;
  if((item.type==='chunk'||item.type==='asset')&&BUILT_ASSET.test(name))assets.add(name);
 }
 return [...assets].sort();
}
export function renderOfflineWorker(template,assets){
 if(!template.includes('__ISCRIBE_ASSET_LIST__')||!template.includes('__ISCRIBE_BUILD_ID__'))
  throw new Error('Offline Service Worker template placeholders missing.');
 if(!assets.includes('index.html'))throw new Error('Offline shell must cache index.html.');
 if(!assets.some(x=>x.endsWith('.js')))throw new Error('Offline shell has no bundled JavaScript.');
 if(!assets.some(x=>x.endsWith('.wasm.gz.bin')))
  throw new Error('Offline shell has no local compressed ONNX/WASM binary.');
 const buildId=createHash('sha256').update(assets.join('\n')).digest('hex').slice(0,12);
 return template.replace('__ISCRIBE_ASSET_LIST__',JSON.stringify(assets))
  .replace('__ISCRIBE_BUILD_ID__',buildId);
}
