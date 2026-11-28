import {expect,it} from 'vitest';
import {normalizeWords,compareWords} from './pipe09-compare.mjs';
it('normalizes Russian and English without reporting words',()=>{
 expect(normalizeWords('Привет, WORLD! 42')).toEqual(['привет','world','42']);
 expect(compareWords(normalizeWords('один два три'),normalizeWords('один три'))).toEqual({referenceWords:3,candidateWords:2,edits:1,wer:1/3});
});
it('computes zero, insertion/substitution and empty-candidate WER',()=>{
 expect(compareWords(['a','b'],['a','b']).wer).toBe(0);
 expect(compareWords(['a','b'],['a','c','d']).edits).toBe(2);
 expect(compareWords(['a','b'],[]).wer).toBe(1);
 expect(compareWords(['a'],['a','b','c']).wer).toBe(2);
});
it('rejects empty reference and excessive work',()=>{
 expect(()=>compareWords([],['a'])).toThrow();
 expect(()=>compareWords(Array(15000).fill('a'),Array(15000).fill('a'))).toThrow();
 expect(()=>normalizeWords('a '.repeat(15001))).toThrow();
});
