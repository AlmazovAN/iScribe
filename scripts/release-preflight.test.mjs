import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyReleasePackage} from './release-preflight.mjs';
const fixtures=[];
afterEach(()=>{for(const path of fixtures.splice(0))rmSync(path,{recursive:true,force:true})});
function example(){
 const root=mkdtempSync(join(tmpdir(),'iscribe-preflight-'));
 fixtures.push(root);
 mkdirSync(join(root,'assets'));
 writeFileSync(join(root,'index.html'),'<html lang="ru"><script type="module" src="./assets/index-a.js"></script><link rel="stylesheet" href="./assets/style-a.css"></html>');
 writeFileSync(join(root,'sw.js'),"const cache='iscribe-shell-v1';const e='iscribe:offline-probe';const a=['assets/ort-wasm-simd.wasm.gz.bin'];");
 writeFileSync(join(root,'THIRD_PARTY_NOTICES.txt'),'Model and runtime licenses');
 writeFileSync(join(root,'assets','index-a.js'),'console.log("app")');
 writeFileSync(join(root,'assets','style-a.css'),'body{margin:0}');
 writeFileSync(join(root,'assets','ort-wasm-simd.wasm.gz.bin'),'fake compressed fixture');
 return root;
}
it('accepts self-contained Vite application shell with local WASM and licenses, never marks hardware as verified',()=>{
 const result=verifyReleasePackage(example());
 expect(result).toMatchObject({status:'PASS',testType:'package-integrity-only',
  offlineShell:true,hardwareAcceptance:'NOT TESTED',wasm:1,js:1});
});
it('blocks a release if local ONNX WASM or Service Worker integrity probe is missing',()=>{
 const root=example();
 unlinkSync(join(root,'assets','ort-wasm-simd.wasm.gz.bin'));
 expect(()=>verifyReleasePackage(root)).toThrow('Missing bundled ONNX WASM runtime');
 const next=example();
 writeFileSync(join(next,'sw.js'),'broken');
 expect(()=>verifyReleasePackage(next)).toThrow('Missing versioned Service Worker');
});
it('blocks broken index entrypoint, missing licenses and accidental test harness shipping',()=>{
 const root=example();
 writeFileSync(join(root,'index.html'),'<html lang="ru"><script src="./assets/missing.js"></script></html>');
 expect(()=>verifyReleasePackage(root)).toThrow('absent asset');
 const second=example();
 writeFileSync(join(second,'THIRD_PARTY_NOTICES.txt'),'');
 expect(()=>verifyReleasePackage(second)).toThrow('Third-party notices are empty');
 const third=example();
 mkdirSync(join(third,'tests','e2e'),{recursive:true});
 writeFileSync(join(third,'tests','e2e','harness.html'),'mock ML');
 expect(()=>verifyReleasePackage(third)).toThrow('test harness');
});
