import {expect,it} from 'vitest';
import {offlineAssetsFromBundle,renderOfflineWorker} from './offline-manifest.mjs';
it('pre-caches exact hashed app/worker/runtime assets, never user audio',()=>{
 const assets=offlineAssetsFromBundle({
  'assets/main-ab12.js':{type:'chunk'},
  'assets/worker-12ab.js':{type:'chunk'},
  'assets/main-8.css':{type:'asset'},
  'assets/ort-wasm-simd.wasm.gz.bin':{type:'asset'},
  'assets/diagram.svg':{type:'asset'},
  'private/recording.mp3':{type:'asset'},
  'docs/transcript.txt':{type:'asset'},
  'sw.js':{type:'asset'}
 });
 expect(assets).toContain('index.html');
 expect(assets).toContain('assets/main-ab12.js');
 expect(assets).toContain('assets/worker-12ab.js');
 expect(assets).toContain('assets/ort-wasm-simd.wasm.gz.bin');
 expect(assets).not.toContain('private/recording.mp3');
 expect(assets).not.toContain('docs/transcript.txt');
 expect(assets).not.toContain('sw.js');
 const template="const BUILD_ID='__ISCRIBE_BUILD_ID__';const ASSETS=__ISCRIBE_ASSET_LIST__;";
 const compiled=renderOfflineWorker(template,assets);
 expect(compiled).toContain('assets/ort-wasm-simd.wasm.gz.bin');
 expect(compiled).not.toContain('__ISCRIBE_BUILD_ID__');
 expect(compiled).not.toContain('__ISCRIBE_ASSET_LIST__');
});
it('fails the build if local compressed WASM runtime is not included',()=>{
 expect(()=>renderOfflineWorker('__ISCRIBE_ASSET_LIST__ __ISCRIBE_BUILD_ID__',['index.html','assets/app.js']))
  .toThrow('ONNX/WASM');
});
