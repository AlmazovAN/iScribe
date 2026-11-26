import {readFileSync,readdirSync,statSync} from 'node:fs';
import {relative,resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

function assetNames(dist){
 const files=[];
 function visit(dir){
  for(const entry of readdirSync(dir,{withFileTypes:true})){
   const abs=join(dir,entry.name);
   if(entry.isDirectory())visit(abs);
   else if(entry.isFile())files.push(relative(dist,abs).split(sep).join('/'));
  }
 }
 visit(dist);
 return files;
}
// Build preflight checks the *actual* built bundle, not the codebase.
// It explicitly is NOT real Whisper/GPU or hardware acceptance.
export function verifyReleasePackage(dist=resolve('dist')){
 const files=assetNames(dist);
 const present=new Set(files);
 const errors=[];
 const must=['index.html','sw.js','THIRD_PARTY_NOTICES.txt'];
 for(const name of must)if(!present.has(name))errors.push('Missing '+name);
 const js=files.filter(name=>/^assets\/.*\.js$/.test(name));
 const css=files.filter(name=>/^assets\/.*\.css$/.test(name));
 const wasm=files.filter(name=>name.endsWith('.wasm.gz.bin'));
 if(!js.length)errors.push('Missing built application/Worker JS');
 if(!css.length)errors.push('Missing built CSS');
 if(!wasm.length)errors.push('Missing bundled ONNX WASM runtime');
 if(present.has('tests/e2e/harness.html'))errors.push('Synthetic ML test harness must not be published');
 if(errors.length)throw new Error(errors.join('; '));
 const index=readFileSync(join(dist,'index.html'),'utf8');
 const sw=readFileSync(join(dist,'sw.js'),'utf8');
 const notices=readFileSync(join(dist,'THIRD_PARTY_NOTICES.txt'),'utf8');
 if(!index.includes('lang="ru"'))errors.push('Missing Russian document language');
 if(!notices.trim())errors.push('Third-party notices are empty');
 if(!sw.includes('iscribe-shell-')||!sw.includes('iscribe:offline-probe'))
  errors.push('Missing versioned Service Worker or offline integrity probe');
 if(!wasm.every(name=>sw.includes(name)))errors.push('Service Worker omits ONNX WASM runtime');
 const links=[...index.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map(match=>match[1].slice(2));
 if(!links.some(name=>name.endsWith('.js')))errors.push('index.html has no bundled JS entrypoint');
 if(links.some(name=>!present.has(name)))errors.push('index.html refers to absent asset');
 if(files.some(name=>name.startsWith('tests/')||name.startsWith('src/')))
  errors.push('Development/test source included in production distribution');
 const sizes=files.map(name=>statSync(join(dist,name)).size);
 if(sizes.some(size=>size<=0))errors.push('One or more bundle files are empty');
 if(errors.length)throw new Error(errors.join('; '));
 return {status:'PASS',testType:'package-integrity-only',
  files:files.length,js:js.length,css:css.length,wasm:wasm.length,
  offlineShell:true,notices:true,hardwareAcceptance:'NOT TESTED'};
}
export function verifyStandalonePackage(dist=resolve('dist')){
 const files=assetNames(dist);
 if(files.length!==1||files[0]!=='iScribe.html')
  throw new Error('Expected only iScribe.html in the standalone distribution');
 const html=readFileSync(join(dist,'iScribe.html'),'utf8');
 if(!html.includes('<style>')||!html.includes('<script type="module">')||
    !html.includes('application/wasm')||!html.includes('assets.notices=')||
    /<(?:link|script)\b[^>]*(?:href|src)=/i.test(html))
  throw new Error('Incomplete standalone HTML or external entry assets');
 return {status:'PASS',testType:'package-integrity-only',files:1,hardwareAcceptance:'NOT TESTED'};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const outcome=process.argv[2]==='--standalone'?verifyStandalonePackage():verifyReleasePackage(process.argv[2]?resolve(process.argv[2]):resolve('dist'));process.stdout.write(JSON.stringify(outcome)+'\n')}
 catch(error){process.stderr.write('Release preflight failed: '+String(error)+'\n');process.exitCode=1}
}
