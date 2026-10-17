import {expect,it} from 'vitest';
import {EngineClient} from '@yourdevice/engine';
it('exports the engine client',()=>expect(typeof EngineClient).toBe('function'));
