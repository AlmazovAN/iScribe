import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import type {Plugin} from 'vite';

// Versioned names are also used by the standalone packager and decoder.
// Do not use the CDN/default loader: the source audio remains local.
const coreName='assets/ffmpeg-core-0.12.10.js';
const wasmName='assets/ffmpeg-core-0.12.10.wasm.gz.bin';
const requireCore=createRequire(import.meta.url);
export function ffmpegAssets():Plugin{
 let core:Buffer|undefined,wasm:Buffer|undefined;
 const getCore=()=>core??=readFileSync(requireCore.resolve('@ffmpeg/core'));
 const getWasm=()=>wasm??=gzipSync(readFileSync(requireCore.resolve('@ffmpeg/core/wasm')),{level:9});
 return {
  name:'iscribe-ffmpeg-assets',
  configureServer(server){
   server.middlewares.use((req,res,next)=>{
    const path=req.url?.split('?')[0];
    if(path!=='/'+coreName&&path!=='/'+wasmName)return next();
    const js=path==='/'+coreName;
    res.setHeader('Content-Type',js?'text/javascript':'application/octet-stream');
    res.end(js?getCore():getWasm());
   });
  },
  generateBundle(){
   this.emitFile({type:'asset',fileName:coreName,source:getCore()});
   this.emitFile({type:'asset',fileName:wasmName,source:getWasm()});
  }
 };
}
