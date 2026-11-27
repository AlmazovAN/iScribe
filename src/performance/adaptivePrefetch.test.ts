import {expect,it} from 'vitest';
import {AdaptivePrefetch} from './adaptivePrefetch';
it('trials one window after three consecutive ready observations and never exceeds ceiling',()=>{
 const a=new AdaptivePrefetch();
 a.observe(2,true,0);a.observe(2,true,0);expect(a.target(2)).toBe(2);
 a.observe(2,false,100);a.observe(2,true,0);expect(a.target(2)).toBe(2);
 a.observe(2,true,0);a.observe(2,true,0);expect(a.target(2)).toBe(1);
 expect(a.target(1)).toBe(1);expect(a.target(0)).toBe(0);
});
it('rolls back after two meaningful consecutive misses and locks until reset',()=>{
 const a=new AdaptivePrefetch();for(let i=0;i<3;i++)a.observe(2,true,0);
 a.observe(2,false,24);a.observe(2,false,25);expect(a.target(2)).toBe(1);
 a.observe(2,true,0);a.observe(2,false,30);expect(a.target(2)).toBe(1);
 a.observe(2,false,30);expect(a.target(2)).toBe(2);
 for(let i=0;i<10;i++)a.observe(2,true,0);
 expect(a.snapshot().phase).toBe('restored-two');expect(a.target(2)).toBe(2);
 a.reset();expect(a.snapshot().phase).toBe('observe');
});
it('ignores lower ceilings and invalid observations',()=>{
 const a=new AdaptivePrefetch();for(let i=0;i<4;i++)a.observe(1,true,0);
 expect(a.target(2)).toBe(2);
 a.observe(2,true,0);a.observe(2,true,0);a.observe(2,true,NaN);a.observe(2,true,0);
 expect(a.target(2)).toBe(2);
});
