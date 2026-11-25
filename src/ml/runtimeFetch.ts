export type RuntimeFetch=(input:string|URL,init?:RequestInit)=>Promise<Response>;
// Transformers.js requests this exact WASM URL through env.fetch, then supplies
// the decoded binary to ORT. Models and all other requests pass through intact.
export function compressedWasmFetch(original:RuntimeFetch,wasmURL:string):RuntimeFetch{
 return async(input,init)=>{
  if(new URL(String(input),wasmURL).href!==wasmURL)return original(input,init);
  const response=await original(wasmURL+'.gz.bin',init);
  if(!response.ok)return response;
  if(!response.body)throw new Error('Пустой файл ONNX Runtime.');
  if(typeof DecompressionStream==='undefined')throw new Error('Браузер не поддерживает распаковку runtime. Обновите Chrome или Edge.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip')),{headers:{'Content-Type':'application/wasm'}});
 };
}

// Preserve the deployed JSON validation fix. Range responses may be incomplete
// by design and must be returned untouched to Transformers.js.
export function validatedModelFetch(original:RuntimeFetch):RuntimeFetch{
 return async(input,init)=>{
  const response=await original(input,init);
  if(!response.ok||init?.method?.toUpperCase()==='HEAD'||response.status===206||new Headers(init?.headers).has('Range'))return response;
  let url:URL;try{url=new URL(String(input))}catch{return response}
  if(url.hostname==='huggingface.co'&&url.pathname.includes('/resolve/')&&url.pathname.endsWith('.json')){
   try{await response.clone().json()}catch{throw new Error(`Не удалось прочитать полный JSON модели: ${url.href} (HTTP ${response.status}). Проверьте доступ к Hugging Face и повторите загрузку.`)}
  }
  return response;
 };
}

// Count HTTP fetch invocations only. HTTP cache and service workers can satisfy
// fetch without transferring bytes; do not call this a network byte counter.
export function observedWhisperHttpFetch(original:RuntimeFetch,onRequest:(repo:string)=>void):RuntimeFetch{
 return async(input,init)=>{
  try{
   const u=new URL(String(input));
   const match=u.hostname==='huggingface.co'&&u.protocol==='https:'
    ?u.pathname.match(/^\/(onnx-community\/whisper-[^/]+)\/resolve\/[^/]+\//):null;
   if(match&&(init?.method??'GET').toUpperCase()!=='HEAD')onRequest(match[1]);
  }catch{/* Keep the underlying fetch semantics unchanged. */}
  return original(input,init);
 };
}


// Cache-first only while explicitly offline; when connectivity is available,
// let Transformers.js handle its own requests and versioned model caching.
// A failed online request may also fall back to an *exact* cached response.
// Never fabricate Range/206 replies from whole-file cached weights.
export function offlineModelFetch(original:RuntimeFetch):RuntimeFetch{
 return async(input,init)=>{
  let url:URL;
  try{url=new URL(String(input))}catch{return original(input,init)}
  const eligible=url.protocol==='https:'&&url.hostname==='huggingface.co'&&
    url.pathname.startsWith('/onnx-community/')&&url.pathname.includes('/resolve/');
  if(!eligible||(init?.method??'GET').toUpperCase()!=='GET'||
     new Headers(init?.headers).has('Range'))return original(input,init);
  const cached=async()=>{
   if(typeof caches==='undefined')return null;
   try{
    const hit=await (await caches.open('transformers-cache')).match(url.href);
    return hit?.ok?hit:null;
   }catch{return null}
  };
  if(typeof navigator!=='undefined'&&navigator.onLine===false){
   const hit=await cached();
   if(hit)return hit;
   throw new Error('Нет сети и в локальном кэше отсутствует файл модели: '+url.pathname.split('/').at(-1));
  }
  try{return await original(input,init)}
  catch(error){return await cached()??Promise.reject(error)}
 };
}
