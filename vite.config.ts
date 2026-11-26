import {defineConfig} from 'vite';
import {gzipSync,gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {offlineAssetsFromBundle,renderOfflineWorker} from './scripts/offline-manifest.mjs';
import {standaloneHtml} from './scripts/standalone-html';
let revision='unavailable';
try{revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{/* Source archive without git metadata. */}
export default defineConfig(({mode})=>{
 const standalone=mode==='standalone';
 return {
 base:'./',
 publicDir:standalone?false:'public',
 define:{
  __ISCRIBE_BUILD_SHA__:JSON.stringify(revision),
  __ISCRIBE_NOTICES_URL__:standalone?'globalThis.__iscribeAssets.notices':JSON.stringify('./THIRD_PARTY_NOTICES.txt')
 },
 // Chromium requires a classic Worker for Blob URLs opened from file://.
 worker:{
  format:standalone?'iife':'es',
  plugins:()=>standalone?[{
   name:'iscribe-standalone-worker-url',
   resolveImportMeta(property){
    if(property==='url')return 'self.location.href';
   }
  }]:[]
 },
 experimental:{
  renderBuiltUrl(filename,{hostType}){
   if(standalone&&hostType==='js')return {runtime:'globalThis.__iscribeAssets['+JSON.stringify(filename)+']'};
  }
 },
 plugins:standalone?[standaloneHtml()]:[{
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
}]
 };
});
