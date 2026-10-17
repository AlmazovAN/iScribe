import {defineConfig} from 'vite';
import {gzipSync,gunzipSync} from 'node:zlib';
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
}]});
