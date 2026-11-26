import {checkWhisperCache,checkWhisperWasmCache,checkSpeakerCache,speakerRepos} from './ml/cache';
import {repos,type WhisperId} from './ml/manager';

export type ShellReport={
 shellComplete:boolean;wasmCached:boolean;missing:number;assetCount:number;buildId:string;
};
export type OfflineReadiness={
 connection:'online'|'offline';
 registration:'unsupported'|'missing'|'installing'|'active'|'error';
 shell:ShellReport|null;
 modelCached:boolean;
 wasmProfileCached:boolean;
 speakerFilesCached:boolean;
 preliminaryReady:boolean;
};
const embeddedShell=import.meta.env.MODE==='standalone';
const UNKNOWN:ShellReport|null=null;
const SW_MESSAGE_TIMEOUT_MS=4000;
function swScope():URL{
 // Vite base='./' works both at the origin root and under a subdirectory.
 return new URL(import.meta.env.BASE_URL,document.baseURI);
}
export async function registerOfflineShell():Promise<boolean>{
 if(embeddedShell||import.meta.env.DEV||typeof navigator==='undefined'||!('serviceWorker' in navigator))return false;
 try{
  const scope=swScope();
  await navigator.serviceWorker.register(new URL('sw.js',scope).href,{
   scope:scope.href,updateViaCache:'none'
  });
  return true;
 }catch{return false}
}
export function queryOfflineShell(worker:Pick<ServiceWorker,'postMessage'>):Promise<ShellReport|null>{
 return new Promise(resolve=>{
  if(typeof MessageChannel==='undefined'){resolve(null);return}
  const channel=new MessageChannel();
  let settled=false;
  const finish=(result:ShellReport|null)=>{
   if(settled)return;settled=true;
   clearTimeout(timeout);
   channel.port1.close();channel.port2.close();
   resolve(result);
  };
  const timeout=setTimeout(()=>finish(null),SW_MESSAGE_TIMEOUT_MS);
  channel.port1.onmessage=(event:MessageEvent<unknown>)=>{
   const data=event.data;
   if(!data||typeof data!=='object'||!('type' in data)||data.type!=='iscribe:offline-probe-result')return;
   const value=data as Record<string,unknown>;
   if(typeof value.shellComplete!=='boolean'||typeof value.wasmCached!=='boolean'||
      typeof value.missing!=='number'||typeof value.assetCount!=='number'||
      typeof value.buildId!=='string')return;
   finish({shellComplete:value.shellComplete,wasmCached:value.wasmCached,
    missing:value.missing,assetCount:value.assetCount,buildId:value.buildId});
  };
  try{worker.postMessage({type:'iscribe:offline-probe'},[channel.port2])}
  catch{finish(null)}
 });
}
export async function inspectOfflineReadiness(model:WhisperId,diarize:boolean):Promise<OfflineReadiness>{
 const connection=typeof navigator!=='undefined'&&navigator.onLine===false?'offline':'online';
 const support=typeof navigator!=='undefined'&&'serviceWorker' in navigator&&typeof caches!=='undefined';
 let registration:OfflineReadiness['registration']=support?'missing':'unsupported';
 let shell=UNKNOWN;
 if(support&&!embeddedShell&&!import.meta.env.DEV){
  try{
   const active=await navigator.serviceWorker.getRegistration(swScope().href);
   if(active){
    registration=active.active?'active':'installing';
    if(active.active)shell=await queryOfflineShell(active.active);
   }
  }catch{registration='error'}
 }
 const [modelCached,wasmProfileCached,segmentation,embedding]=await Promise.all([
  checkWhisperCache(repos[model]),
  checkWhisperWasmCache(repos[model]),
  checkSpeakerCache(speakerRepos.segmentation),
  checkSpeakerCache(speakerRepos.embedding)
 ]);
 const speakerFilesCached=segmentation&&embedding;
 return {connection,registration,shell,modelCached,wasmProfileCached,speakerFilesCached,
  preliminaryReady:(embeddedShell||!!shell?.shellComplete&&shell.wasmCached)&&wasmProfileCached&&(!diarize||speakerFilesCached)};
}
