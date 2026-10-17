import {expect,it,vi} from 'vitest';
import {gzipSync} from 'node:zlib';
import {compressedWasmFetch,type RuntimeFetch} from './runtimeFetch';
it('decompresses the matching runtime only and preserves ordinary model fetches',async()=>{
 const bytes=Uint8Array.of(0,97,115,109,1,0,0,0);const zipped=new Uint8Array(gzipSync(bytes));
 const original=vi.fn<RuntimeFetch>(async()=>new Response(zipped));const url='https://example.test/assets/runtime.wasm';const fetcher=compressedWasmFetch(original,url);
 expect(new Uint8Array(await (await fetcher(url)).arrayBuffer())).toEqual(bytes);expect(original.mock.calls[0][0]).toBe(url+'.gz.bin');
 const model='https://huggingface.co/model/config.json';await fetcher(model);expect(original.mock.calls[1][0]).toBe(model);
});
