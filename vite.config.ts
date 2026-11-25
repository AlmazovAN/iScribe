import {defineConfig} from 'vite';
import {gzipSync,gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {offlineAssetsFromBundle,renderOfflineWorker} from './scripts/offline-manifest.mjs';
export default defineConfig({base:'./',worker:{format:'es'},plugins:[{
 name:'compressed-wasm-transport',
 generateBundle(_options,bundle){
  for(const [name,asset] of Object.entries(bundle)){
   if(asset.type!=='asset'||!name.endsWith('.wasm'))continue;
   const bytes=typeof asset.source==='string'?Buffer.from(asset.source):Buffer.from(asset.source);
   const compressed=gzipSync(bytes,{level:9});
   if(!gunzipSync(compressed).equals(bytes))throw new Error('WASM compression integrity check failed');
   this.emitFile({type:'asset',fileName:name+'.gz.bin',source:compressed});delete bundle[name];
  }
 }
},{
 name:'offline-shell-worker',
 apply:'build',
 generateBundle(_options,bundle){
  const assets=offlineAssetsFromBundle(bundle);
  const template=readFileSync(new URL('./scripts/offline-service-worker.js',import.meta.url),'utf8');
  const source=renderOfflineWorker(template,assets);
  this.emitFile({type:'asset',fileName:'sw.js',source});
 }
}]});
