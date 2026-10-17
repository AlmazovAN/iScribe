import {expect,it} from 'vitest';
import {mapSpeakers} from './speakers';
it('aggregates fragmented real overlap per voice instead of choosing one longest turn',()=>{
 expect(mapSpeakers([{start:0,end:10,text:'Реплика'}],[{start:0,end:3,speaker:'A'},{start:3,end:7,speaker:'B'},{start:7,end:10,speaker:'A'}])[0].speaker).toBe('A');
});
it('handles point segments, boundaries, silence and ambiguous ties without invented labels',()=>{
 const turns=[{start:1,end:2,speaker:'A'},{start:2,end:3,speaker:'B'}];
 const result=mapSpeakers([{start:1.5,end:1.5,text:'a'},{start:2,end:2,text:'b'},{start:4,end:5,text:'gap'},{start:1,end:3,text:'tie'}],turns);
 expect(result.map(s=>s.speaker)).toEqual(['A','B',undefined,undefined]);
});
