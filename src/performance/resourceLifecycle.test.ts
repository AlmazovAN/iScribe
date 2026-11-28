import {afterEach,expect,it,vi} from 'vitest';
import {IdleModelLease,IDLE_MODEL_LEASE_MS,WorkerRetirement,shouldReleaseBeforeJob} from './resourceLifecycle';
afterEach(()=>vi.useRealTimers());
it('releases incompatible, unused and heavy models before the next decode',()=>{
 expect(shouldReleaseBeforeJob('medium','whisper-small','whisper-tiny',false)).toBe(true);
 expect(shouldReleaseBeforeJob('medium','whisper-small','whisper-small',true)).toBe(true);
 expect(shouldReleaseBeforeJob('eco','whisper-small','whisper-small',false)).toBe(true);
 expect(shouldReleaseBeforeJob('max','whisper-large-v3','whisper-large-v3',false)).toBe(true);
 expect(shouldReleaseBeforeJob('max','whisper-small','whisper-small',false)).toBe(false);
 expect(shouldReleaseBeforeJob('eco',null,'whisper-small',false)).toBe(false);
});
it('expires one idle lease exactly once',()=>{
 vi.useFakeTimers();const lease=new IdleModelLease(),release=vi.fn();
 lease.schedule(release);vi.advanceTimersByTime(IDLE_MODEL_LEASE_MS-1);expect(release).not.toHaveBeenCalled();
 vi.advanceTimersByTime(1);vi.advanceTimersByTime(IDLE_MODEL_LEASE_MS);expect(release).toHaveBeenCalledOnce();
});
it('cancels the previous idle lease before active work or replacement',()=>{
 vi.useFakeTimers();const lease=new IdleModelLease(),a=vi.fn(),b=vi.fn();
 lease.schedule(a,10);lease.schedule(b,20);vi.advanceTimersByTime(10);expect(a).not.toHaveBeenCalled();
 lease.cancel();vi.advanceTimersByTime(100);expect(b).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('retires the same Worker at most once through the owner',()=>{
 const owner=new WorkerRetirement(),worker={terminate:vi.fn()};
 owner.terminate(worker);owner.terminate(worker);owner.terminate(null);
 expect(worker.terminate).toHaveBeenCalledOnce();expect(owner.blocked).toBe(false);owner.assertUsable();
});
it('latches unconfirmed retirement even if a later termination call succeeds',()=>{
 const owner=new WorkerRetirement(),worker={terminate:vi.fn().mockImplementationOnce(()=>{throw new Error('native failure')})};
 expect(()=>owner.terminate(worker)).toThrow('Не подтверждено');
 expect(owner.blocked).toBe(true);expect(()=>owner.assertUsable()).toThrow('Не подтверждено');
 owner.terminate(worker);expect(owner.blocked).toBe(true);expect(()=>owner.assertUsable()).toThrow();
});
