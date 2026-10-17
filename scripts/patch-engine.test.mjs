import {it,expect} from 'vitest';
import {patchedContent} from './patch-engine.mjs';
import {readFileSync} from 'node:fs';
it('accepts only an exact original/patched dependency and is idempotent',()=>{
 const specs=JSON.parse(readFileSync(new URL('./engine-patches.json',import.meta.url),'utf8'));
 for(const spec of specs){const current=readFileSync(new URL('../node_modules/@yourdevice/engine/'+spec.file,import.meta.url),'utf8');expect(patchedContent(current,spec)).toBe(current);expect(()=>patchedContent('unknown source',spec)).toThrow(/refused/)}
});
