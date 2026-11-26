import {expect,it} from 'vitest';
import {ProgressGate,shouldPersistStreamEvent,storageUiReport,emptyStorageUi} from './storageUiPolicy';
it('persists resample start and periodic samples; defers completion observations',()=>{
 expect(shouldPersistStreamEvent('stream-resample-start',1,0,false)).toBe(true);
 expect(shouldPersistStreamEvent('stream-samples',14999,0,false)).toBe(false);
 expect(shouldPersistStreamEvent('stream-samples',15000,0,false)).toBe(true);
 expect(shouldPersistStreamEvent('stream-read-end',15000,0,false)).toBe(false);
 expect(shouldPersistStreamEvent('stream-resample-end',15000,0,false)).toBe(false);
 expect(shouldPersistStreamEvent('stream-read-end',1,0,true)).toBe(true);
});
it('limits progress within a stage without delaying a new stage or reset',()=>{
 const gate=new ProgressGate();
 expect(gate.allow('a',0)).toBe(true);
 expect(gate.allow('a',249)).toBe(false);
 expect(gate.allow('a',250)).toBe(true);
 expect(gate.allow('b',251)).toBe(true);
 expect(gate.allow('b',252)).toBe(false);
 gate.reset();expect(gate.allow('b',252)).toBe(true);
 expect(storageUiReport(undefined)).toBeNull();
 expect(storageUiReport(emptyStorageUi())).toMatchObject({deferredMetadataWrites:0,suppressedProgressUpdates:0});
});
