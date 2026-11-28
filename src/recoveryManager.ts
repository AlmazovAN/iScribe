// Durable reservation ledger. A reservation is consumed before dispatch,
// including interrupted attempts. Success does not refund a retry.
export const MAX_OPERATION_ATTEMPTS=2;
export const MAX_JOB_RECOVERIES=10;
export const RECOVERY_OPERATIONS=['full-decode','stream-open','stream-window','asr','diarization'] as const;
export type RecoveryOperation=typeof RECOVERY_OPERATIONS[number];
export type AttemptRecord={unit:number;cycle:number;attempts:number;done:boolean};
export type RecoveryLedger={revision:1;serial:number;totalRecoveries:number;operations:Partial<Record<RecoveryOperation,AttemptRecord>>};
export class RecoveryExhaustedError extends Error{
 readonly code='recovery-exhausted';
 constructor(readonly operation:RecoveryOperation,readonly limit:'operation'|'job'){
  super(limit==='job'?'Лимит восстановлений задания исчерпан. Сохранённый текст доступен.':'Лимит двух попыток операции исчерпан. Сохранённый текст доступен; для нового запуска добавьте запись как новое задание.');
  this.name='RecoveryExhaustedError';
 }
}
const integer=(n:unknown,min:number,max=Number.MAX_SAFE_INTEGER):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=min&&n<=max;
export function validLedger(value:unknown):value is RecoveryLedger{
 if(!value||typeof value!=='object')return false;
 const v=value as RecoveryLedger;
 if(v.revision!==1||!integer(v.serial,0)||!integer(v.totalRecoveries,0,MAX_JOB_RECOVERIES)||!v.operations||typeof v.operations!=='object'||Array.isArray(v.operations))return false;
 return Object.entries(v.operations).every(([key,r])=>RECOVERY_OPERATIONS.includes(key as RecoveryOperation)&&r&&integer(r.unit,0)&&integer(r.cycle,1)&&integer(r.attempts,1,MAX_OPERATION_ATTEMPTS)&&typeof r.done==='boolean');
}
function checked(ledger:RecoveryLedger):RecoveryLedger{
 if(!validLedger(ledger))throw new Error('Некорректный журнал попыток восстановления.');
 return ledger;
}
export function initialLedger(historicalRetries=0):RecoveryLedger{
 return checked({revision:1,serial:0,totalRecoveries:historicalRetries,operations:{}});
}
export function reserveOperation(ledger:RecoveryLedger,operation:RecoveryOperation,unit=0):RecoveryLedger{
 checked(ledger);
 if(!integer(unit,0))throw new Error('Некорректный идентификатор операции восстановления.');
 const old=ledger.operations[operation];
 if(old&&old.unit>unit)throw new Error('Нельзя вернуться к предыдущему окну восстановления.');
 // A completed full decode, stream read/open or speaker pass can be needed
 // again by explicit resume/reprocessing. ASR may never replay a committed unit.
 if(old&&old.unit===unit&&old.done&&operation==='asr')throw new Error('Окно ASR уже подтверждено.');
 const same=old?.unit===unit&&!old.done;
 const attempts=same?old.attempts+1:1;
 if(attempts>MAX_OPERATION_ATTEMPTS)throw new RecoveryExhaustedError(operation,'operation');
 if(attempts>1&&ledger.totalRecoveries>=MAX_JOB_RECOVERIES)throw new RecoveryExhaustedError(operation,'job');
 const record={unit,cycle:old?.unit===unit?(same?old.cycle:old.cycle+1):1,attempts,done:false};
 return checked({...ledger,serial:ledger.serial+1,totalRecoveries:ledger.totalRecoveries+(attempts>1?1:0),operations:{...ledger.operations,[operation]:record}});
}
export function finishOperation(ledger:RecoveryLedger,operation:RecoveryOperation,unit=0):RecoveryLedger{
 checked(ledger);const old=ledger.operations[operation];
 if(!old||old.unit!==unit||old.done)throw new Error('Нет активной зарезервированной операции.');
 return checked({...ledger,serial:ledger.serial+1,operations:{...ledger.operations,[operation]:{...old,done:true}}});
}
// Protect against stale metadata, rollback and forged counter reductions.
// Web Locks remain the job-owner exclusion mechanism.
export function assertRecoveryForward(old:RecoveryLedger|undefined,next:RecoveryLedger|undefined):void{
 if(next&&!validLedger(next)||old&&!validLedger(old))throw new Error('Некорректный журнал попыток восстановления.');
 if(!old)return;
 if(!next||next.serial<old.serial||next.totalRecoveries<old.totalRecoveries)throw new Error('Журнал попыток восстановления изменился. Обновите страницу.');
 if(next.serial===old.serial){
  if(JSON.stringify(old)!==JSON.stringify(next))throw new Error('Конфликт журнала попыток восстановления.');
  return;
 }
 for(const op of RECOVERY_OPERATIONS){
  const before=old.operations[op],after=next.operations[op];
  if(!before)continue;
  if(!after||after.unit<before.unit||after.unit===before.unit&&(after.cycle<before.cycle||after.cycle===before.cycle&&(after.attempts<before.attempts||before.done&&!after.done)))
   throw new Error('Нельзя сбросить сохранённые попытки восстановления.');
  if(after.unit===before.unit&&after.cycle>before.cycle&&!before.done)throw new Error('Нельзя начать новый цикл незавершённой операции.');
 }
}
