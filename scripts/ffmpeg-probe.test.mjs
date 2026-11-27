import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {expect,it} from 'vitest';

const worker=readFileSync(new URL('../src/ffmpegStreamWorker.js',import.meta.url),'utf8');
const valid=JSON.stringify({streams:[{sample_rate:'16000',duration:'41.000000'}],format:{duration:'41.000000'}});
function fixture({status=-1,report=valid,stderr='',stale=false}={}){
 const files=new Map(stale?[['/probe.json',valid]]:[]);
 let logger=()=>{};
 const calls=[];
 const core={
  FS:{analyzePath:path=>({exists:files.has(path)}),
   unlink:path=>files.delete(path),
   stat:path=>({size:files.get(path).length}),
   readFile:path=>files.get(path)},
  reset(){},
  setLogger(fn){logger=fn;},
  ffprobe(...args){
   calls.push(args);
   if(stderr)logger({type:'stderr',message:stderr});
   if(report!==null)files.set('/probe.json',report);
   return status;
  }
 };
 const context=createContext({self:{},fakeCore:core});
 runInContext(worker+'\ncore=fakeCore;',context);
 return {probe:()=>runInContext('probeMetadata()',context),files,calls};
}
it('accepts a fresh validated FFprobe report even when 0.12.10 returns -1',()=>{
 for(const status of [-1,0]){
  const f=fixture({status});
  expect(f.probe()).toMatchObject({streams:[{sample_rate:'16000'}]});
  expect(f.calls[0]).toContain('/probe.json');
  expect(f.calls[0]).toContain('-o');
  expect(f.files.has('/probe.json')).toBe(false);
 }
});
it('does not waive real error codes or error-level stderr',()=>{
 for(const options of [{status:1},{stderr:'error'}]){
  const f=fixture(options);
  expect(f.probe).toThrow('probe-exit');
  expect(f.files.has('/probe.json')).toBe(false);
 }
});
it('rejects missing, stale, oversized or malformed JSON even for -1',()=>{
 for(const report of [null,'','{', ' '.repeat(65537)]){
  const f=fixture({report,stale:true});
  expect(f.probe).toThrow('probe-json');
  expect(f.files.has('/probe.json')).toBe(false);
 }
});
it('rejects a JSON report without a selected audio stream',()=>{
 const f=fixture({report:'{"streams":[]}'});
 expect(f.probe).toThrow('probe-metadata');
});
