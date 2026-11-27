// One conservative trial per run. This controller never raises the profile
// ceiling, changes the model, or interprets host readiness as GPU telemetry.
export type PrefetchPhase='observe'|'trial-one'|'restored-two';
export class AdaptivePrefetch{
 private phase:PrefetchPhase='observe';
 private readyStreak=0;
 private missStreak=0;
 reset(){this.phase='observe';this.readyStreak=0;this.missStreak=0}
 observe(ceiling:0|1|2,ready:boolean,waitMs:number){
  if(ceiling!==2||!Number.isFinite(waitMs)||waitMs<0){
   this.readyStreak=0;this.missStreak=0;return;
  }
  if(this.phase==='observe'){
   this.readyStreak=ready?this.readyStreak+1:0;
   if(this.readyStreak>=3){this.phase='trial-one';this.missStreak=0}
  }else if(this.phase==='trial-one'){
   // Ignore promise scheduling noise; two consecutive meaningful waits
   // restore the original depth for the remainder of this run.
   this.missStreak=!ready&&waitMs>=25?this.missStreak+1:0;
   if(this.missStreak>=2)this.phase='restored-two';
  }
 }
 target(ceiling:0|1|2):0|1|2{return ceiling===2&&this.phase==='trial-one'?1:ceiling}
 snapshot(){return {phase:this.phase,readyStreak:this.readyStreak,missStreak:this.missStreak}}
}
