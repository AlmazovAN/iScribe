import {describe,expect,it} from 'vitest';
import {initialLedger,reserveOperation,finishOperation,assertRecoveryForward,recoveryReport,validLedger,MAX_JOB_RECOVERIES,RecoveryExhaustedError} from './recoveryManager';
describe('PIPE-05 durable recovery ledger',()=>{
 it('consumes an interrupted reservation across JSON reload and rejects the third dispatch',()=>{
  let x=reserveOperation(initialLedger(),'asr',41);
  x=reserveOperation(JSON.parse(JSON.stringify(x)),'asr',41);
  expect(x.operations.asr).toMatchObject({unit:41,attempts:2,done:false});
  expect(x.totalRecoveries).toBe(1);
  expect(()=>reserveOperation(JSON.parse(JSON.stringify(x)),'asr',41)).toThrow(RecoveryExhaustedError);
 });
 it('shares retry budget across decoder and ASR; initial healthy operations remain possible',()=>{
  let x=initialLedger(MAX_JOB_RECOVERIES-2);
  x=finishOperation(reserveOperation(reserveOperation(x,'full-decode'),'full-decode'),'full-decode');
  x=finishOperation(reserveOperation(reserveOperation(x,'stream-window',1),'stream-window',1),'stream-window',1);
  x=reserveOperation(x,'asr',1);
  expect(x.totalRecoveries).toBe(MAX_JOB_RECOVERIES);
  expect(()=>reserveOperation(x,'asr',1)).toThrow('Лимит восстановлений задания');
 });
 it('does not charge normal windows or replay committed ASR',()=>{
  let x=initialLedger();for(let i=1;i<=200;i++)x=finishOperation(reserveOperation(x,'asr',i),'asr',i);
  expect(x.totalRecoveries).toBe(0);
  expect(()=>reserveOperation(x,'asr',200)).toThrow('уже подтверждено');
 });
 it('allows explicit repeat of a completed speaker operation without refunding retries',()=>{
  let x=reserveOperation(reserveOperation(initialLedger(),'diarization'),'diarization');
  expect(()=>reserveOperation(x,'diarization')).toThrow(RecoveryExhaustedError);
  x=finishOperation(x,'diarization');
  const next=reserveOperation(x,'diarization');assertRecoveryForward(x,next);
  expect(next.operations.diarization).toEqual({unit:0,cycle:2,attempts:1,done:false});
  expect(next.totalRecoveries).toBe(1);
 });
 it('rejects invalid units and moving past an unfinished window',()=>{
  expect(()=>reserveOperation(initialLedger(),'asr',0)).toThrow();
  expect(()=>reserveOperation(initialLedger(),'full-decode',1)).toThrow();
  const x=reserveOperation(initialLedger(),'stream-window',41);
  expect(()=>reserveOperation(x,'stream-window',42)).toThrow();
  expect(()=>reserveOperation(x,'stream-window',40)).toThrow();
 });
 it('rejects stale metadata, lost ledger or a conflicting reservation',()=>{
  const x=reserveOperation(initialLedger(),'asr',1),y=reserveOperation(x,'asr',1);
  assertRecoveryForward(x,y);assertRecoveryForward(y,y);
  expect(()=>assertRecoveryForward(y,x)).toThrow();
  expect(()=>assertRecoveryForward(y,undefined)).toThrow();
  expect(()=>assertRecoveryForward(y,{...y,operations:{asr:{...y.operations.asr!,attempts:1}}})).toThrow();
  expect(()=>assertRecoveryForward(y,{...y,serial:y.serial+1,operations:{}})).toThrow();
 });
 it('can confirm a previously reserved result without another dispatch',()=>{
  const x=reserveOperation(reserveOperation(initialLedger(),'asr',1),'asr',1);
  const y=finishOperation(x,'asr',1);assertRecoveryForward(x,y);
  const z=reserveOperation(y,'asr',2);
  expect(z.totalRecoveries).toBe(1);expect(z.operations.asr?.attempts).toBe(1);
 });
 it('validates counters and exports only whitelisted numeric fields',()=>{
  expect(()=>initialLedger(11)).toThrow();
  const x=reserveOperation(initialLedger(),'asr',2);
  const extra={...x,secret:'PRIVATE',operations:{asr:{...x.operations.asr!,secret:'PRIVATE'}}};
  expect(validLedger(extra)).toBe(true);
  expect(JSON.stringify(recoveryReport(extra))).not.toContain('PRIVATE');
  expect(recoveryReport({...x,revision:9})).toBeNull();
 });
});
