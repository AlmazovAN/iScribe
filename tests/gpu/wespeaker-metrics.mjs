export const ITEMS=8,FRAMES=198,MELS=80,RUNS=3;
export const BATCHES=[1,2,4,8];
export function features(start,batch){
 if(!BATCHES.includes(batch)||!Number.isInteger(start)||start<0||start+batch>ITEMS)throw new Error('Invalid batch');
 const values=new Float32Array(batch*FRAMES*MELS);
 for(let b=0;b<batch;b++)for(let f=0;f<FRAMES;f++)for(let m=0;m<MELS;m++){
  const i=start+b;
  values[(b*FRAMES+f)*MELS+m]=Math.sin(f*0.07+m*0.11+i*0.67)+0.4*Math.cos(f*0.13-m*0.21+i*0.32);
 }
 return values;
}
export function cosine(a,b){
 if(!a?.length||a.length!==b?.length)return null;
 let ab=0,aa=0,bb=0;
 for(let i=0;i<a.length;i++){
  if(!Number.isFinite(a[i])||!Number.isFinite(b[i]))return null;
  ab+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];
 }
 if(aa<=0||bb<=0||!Number.isFinite(aa*bb))return null;
 return Math.max(-1,Math.min(1,ab/Math.sqrt(aa*bb)));
}
export function compareEmbeddings(a,b){
 if(a.length!==ITEMS||b.length!==ITEMS)return null;
 let minCosine=1,maxPairDrift=0;
 for(let i=0;i<ITEMS;i++){
  const sim=cosine(a[i],b[i]);if(sim===null)return null;
  minCosine=Math.min(minCosine,sim);
  for(let j=0;j<i;j++){
   const x=cosine(a[i],a[j]),y=cosine(b[i],b[j]);
   if(x===null||y===null)return null;
   maxPairDrift=Math.max(maxPairDrift,Math.abs(x-y));
  }
 }
 return {minCosine,maxPairDrift};
}
export function median(values){
 if(!values.length||values.some(v=>!Number.isFinite(v)||v<0))return null;
 const s=[...values].sort((a,b)=>a-b),mid=Math.floor(s.length/2);
 return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;
}
