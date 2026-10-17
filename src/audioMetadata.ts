// Metadata only: no PCM decode and no additional ML session.
export function audioDuration(file:File):Promise<number|undefined>{
 return new Promise(resolve=>{
  const audio=document.createElement('audio'),url=URL.createObjectURL(file);
  let settled=false;
  const finish=(duration?:number)=>{if(settled)return;settled=true;clearTimeout(timer);audio.removeAttribute('src');audio.load();URL.revokeObjectURL(url);resolve(duration)};
  const timer=setTimeout(()=>finish(),10000);
  audio.preload='metadata';audio.onloadedmetadata=()=>finish(Number.isFinite(audio.duration)&&audio.duration>0?audio.duration:undefined);audio.onerror=()=>finish();audio.src=url;
 });
}
