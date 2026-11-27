const embeddedShell=import.meta.env.MODE==='standalone';
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
