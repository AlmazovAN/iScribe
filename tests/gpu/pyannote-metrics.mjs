export const SAMPLES=160000,CLASSES=7,RUNS=3;
export function syntheticWindow(index){
 const pcm=new Float32Array(SAMPLES);
 for(let i=0;i<pcm.length;i++){
  const t=i/16000;
  const envelope=(i%24000)<16000?0.12:0;
  pcm[i]=envelope*(Math.sin(2*Math.PI*(170+index*31)*t)+0.3*Math.sin(2*Math.PI*440*t));
 }
 return pcm;
}
export function compareFrames(a,b){
 if(!(a instanceof Float32Array)||!(b instanceof Float32Array)||!a.length||a.length!==b.length||a.length%CLASSES)return null;
 let maxAbs=0,totalAbs=0,agree=0;
 for(let i=0;i<a.length;i+=CLASSES){
  let x=0,y=0;
  for(let j=0;j<CLASSES;j++){
   const u=a[i+j],v=b[i+j];
   if(!Number.isFinite(u)||!Number.isFinite(v))return null;
   const d=Math.abs(u-v);maxAbs=Math.max(maxAbs,d);totalAbs+=d;
   if(u>a[i+x])x=j;
   if(v>b[i+y])y=j;
  }
  if(x===y)agree++;
 }
 const frames=a.length/CLASSES;
 return {frames,frameAgreement:agree/frames,maxAbs,meanAbs:totalAbs/a.length};
}
export function median(values){
 if(!values.length||values.some(v=>!Number.isFinite(v)||v<0))return null;
 const s=[...values].sort((a,b)=>a-b),mid=Math.floor(s.length/2);
 return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;
}
