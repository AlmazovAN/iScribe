import {test,expect} from '@playwright/test';
test('isolated loopback distribution exposes shared memory in page and Worker',async({page})=>{
 const response=await page.goto('http://127.0.0.1:4175/');
 expect(response.headers()['cross-origin-opener-policy']).toBe('same-origin');
 expect(response.headers()['cross-origin-embedder-policy']).toBe('require-corp');
 await expect(page.getByRole('button',{name:'Выбрать файлы'})).toBeEnabled();
 const result=await page.evaluate(async()=>{
  const url=URL.createObjectURL(new Blob(['postMessage({isolated:self.crossOriginIsolated,shared:typeof SharedArrayBuffer==="function"})'],{type:'text/javascript'}));
  const worker=new Worker(url);
  try{
   const observation=await new Promise((resolve,reject)=>{
    worker.onmessage=e=>resolve(e.data);worker.onerror=reject;
   });
   return {pageIsolated:crossOriginIsolated,pageShared:typeof SharedArrayBuffer==='function',worker:observation};
  }finally{worker.terminate();URL.revokeObjectURL(url)}
 });
 expect(result).toEqual({pageIsolated:true,pageShared:true,worker:{isolated:true,shared:true}});
});
