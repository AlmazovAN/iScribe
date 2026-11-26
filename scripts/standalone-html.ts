import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import type {Plugin} from 'vite';

export function standaloneHtml():Plugin{
 return {
  name:'iscribe-standalone-html',
  generateBundle:{
   order:'post',
   handler(_options,bundle){
    const page=bundle['index.html'];
    if(page?.type!=='asset'||typeof page.source!=='string')this.error('Missing built HTML');
    const entryTag=/<script type="module"[^>]* src="\.\/([^"]+)"><\/script>/;
    const entryName=page.source.match(entryTag)?.[1];
    const entry=entryName&&bundle[entryName];
    if(!entry||entry.type!=='chunk'||entry.imports.length||entry.dynamicImports.length)
     this.error('Standalone HTML requires a single application entry chunk');
    const urls:Record<string,string>={};
    let worker:string|undefined;
    let wasm:string|undefined;
    for(const [name,file] of Object.entries(bundle)){
     if(name==='index.html'||name===entryName||name.endsWith('.css'))continue;
     if(name.endsWith('.wasm')&&file.type==='asset'){
      if(wasm)this.error('Unexpected additional WASM asset');
      wasm=name;
      urls[name]=gzipSync(file.source,{level:9}).toString('base64');
     }else if(/^assets\/worker-[^/]+\.js$/.test(name)){
      if(worker||file.type!=='asset')this.error('Unexpected Worker bundle');
      worker=name;
      urls[name]=Buffer.from(file.source).toString('base64');
     }else if(!/^assets\/ort-wasm-simd-threaded\.asyncify-[^/]+\.mjs$/.test(name)){
      // Vite can emit the web loader asset even when the standalone Worker uses the bundled loader.
      this.error('Unsupported standalone asset: '+name);
     }
    }
    if(!worker||!wasm)
     this.error('Missing embedded Worker or ONNX Runtime');
    const notices=readFileSync(new URL('../public/THIRD_PARTY_NOTICES.txt',import.meta.url)).toString('base64');
    const bootstrap=`<script type="module">
const decode=value=>Uint8Array.from(atob(value),byte=>byte.charCodeAt(0));
const blobUrl=(data,type)=>URL.createObjectURL(new Blob(data,{type}));
const assets=Object.create(null);
const embedded=${JSON.stringify(urls)};
try {
 const wasm=${JSON.stringify(wasm)}, worker=${JSON.stringify(worker)};
 assets.notices=blobUrl([decode("${notices}")],"text/plain;charset=utf-8");
 const compressed=new Blob([decode(embedded[wasm])]);
 const binary=await new Response(compressed.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
 assets[wasm]=blobUrl([binary],"application/wasm");
 assets[worker]=blobUrl(["globalThis.__iscribeAssets="+JSON.stringify(assets)+";\\n",decode(embedded[worker])],"text/javascript");
 globalThis.__iscribeAssets=assets;
 globalThis.__iscribeWasmBinary=binary;
 await import(blobUrl([decode("${Buffer.from(entry.code).toString('base64')}")],"text/javascript"));
} catch(error) {
 document.getElementById("root").textContent="Не удалось запустить iScribe. Откройте файл в актуальном Chrome или Edge.";
 console.error(error);
}
</script>`;
    const html=page.source.replace(entryTag,()=>bootstrap)
     .replace(/<link rel="stylesheet"[^>]* href="\.\/([^"]+)"[^>]*>/g,(_tag,name:string)=>{
      const css=bundle[name];
      if(css?.type!=='asset'||typeof css.source!=='string'||/url\s*\(/i.test(css.source))
       this.error('Unsupported standalone stylesheet: '+name);
      return '<style>'+css.source.replace(/<\/style/gi,'<\\/style')+'</style>';
     });
    if(!html.includes('<style>')||/<(?:link|script)\b[^>]*(?:href|src)=/i.test(html))
     this.error('Standalone HTML still has external entry assets');
    for(const name of Object.keys(bundle))delete bundle[name];
    this.emitFile({type:'asset',fileName:'iScribe.html',source:html});
   }
  }
 };
}
