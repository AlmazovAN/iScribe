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
