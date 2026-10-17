import {expect,it,vi} from 'vitest';
vi.mock('./worker?worker',()=>({default:class{constructor(){throw new Error('worker unavailable')}}}));
import {ModelManager} from './manager';
it('releases the operation lock when Worker creation throws, allowing retry',async()=>{
 const manager=new ModelManager();
 await expect(manager.prepare('whisper-tiny')).rejects.toThrow('worker unavailable');
 await expect(manager.prepare('whisper-tiny')).rejects.toThrow('worker unavailable');
 await expect(manager.preloadSpeakers()).rejects.toThrow('worker unavailable');
 await expect(manager.preloadSpeakers()).rejects.toThrow('worker unavailable');
});
