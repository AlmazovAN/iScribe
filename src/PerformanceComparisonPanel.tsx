import {useState,useMemo} from 'react';
import {PERFORMANCE_CASES,GROUPS,EXTERNAL_KEYS,EXTERNAL_LABELS,emptyExternal,readComparisonRun,summarizeComparison,type ComparisonRun,type PerformanceCase,type CompareGroup,type CompareCondition,type Launch,type ExternalKey,type ExternalMetrics} from './performance/hardwareBenchmark';
const labels:Record<CompareGroup,string>={baseline:'До оптимизации',eco:'Экономичная',medium:'Средняя',max:'Максимальная'};
const maxReportBytes=4*1024*1024;
async function readJson(file:File):Promise<unknown>{
 if(file.size>maxReportBytes)throw new Error('JSON больше 4 МБ.');
 return JSON.parse(await file.text()) as unknown;
}
function suffix(file:File,kind:'hardware_evidence'|'benchmark'){
 const match=file.name.match(new RegExp('^iscribe_'+kind+'_([a-f0-9]{8})\\.json$','i'));
 return match?.[1]?.toLowerCase()??null;
}
function fmt(n:number|null,digits=2){return n===null?'—':n.toLocaleString('ru-RU',{maximumFractionDigits:digits})}
export function PerformanceComparisonPanel({busy}:{busy:boolean}){
 const [test,setTest]=useState<PerformanceCase>('T02'),[group,setGroup]=useState<CompareGroup>('baseline');
 const [condition,setCondition]=useState<CompareCondition>('cold'),[launch,setLaunch]=useState<Launch>('standalone');
 const [evidence,setEvidence]=useState<File|null>(null),[legacy,setLegacy]=useState<File|null>(null);
 const [manual,setManual]=useState<Partial<Record<ExternalKey,string>>>({});
 const [records,setRecords]=useState<{key:string;run:ComparisonRun}[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const [sameSource,setSameSource]=useState(false);
 const runs=useMemo(()=>records.map(x=>x.run),[records]);
 const summary=useMemo(()=>summarizeComparison(runs,test,condition,launch,sameSource),[runs,test,condition,launch,sameSource]);
 async function add(){
  if(!evidence||loading||busy)return;
  setLoading(true);setError('');
  try{
   const key=suffix(evidence,'hardware_evidence');
   if(!key)throw new Error('Выберите исходную выгрузку iscribe_hardware_evidence_XXXXXXXX.json без переименования.');
   if(records.some(r=>r.key===key))throw new Error('Этот идентификатор задания уже добавлен. Для каждого прогона создайте новое задание.');
   if(legacy&&suffix(legacy,'benchmark')!==key)throw new Error('Идентификаторы выгрузок не совпадают.');
   const external:ExternalMetrics=emptyExternal();
   for(const k of EXTERNAL_KEYS){
    const value=manual[k]?.trim();if(!value)continue;
    const n=Number(value);
    if(!Number.isFinite(n)||n<0||((k==='cpuMeanPercent'||k==='gpuMeanPercent')&&n>100))throw new Error('Некорректный показатель: '+EXTERNAL_LABELS[k]);
    external[k]=n;
   }
   const run=readComparisonRun(await readJson(evidence),legacy?await readJson(legacy):null,{test,group,condition,launch,external});
   setRecords(old=>old.some(r=>r.key===key)?old:[...old,{key,run}]);setSameSource(false);setManual({});
  }catch(e){setError(e instanceof Error?e.message:'Не удалось прочитать отчёт.')}
  finally{setLoading(false)}
 }
 function download(){
  const blob=new Blob([JSON.stringify({schema:'iscribe.performance-comparison.v1',verdict:'HARDWARE ACCEPTANCE NOT VERIFIED',runs,summary},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='iscribe_performance_comparison.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
 }
 return <details className="hardware-acceptance">
  <summary>PERF-09 · Сравнение производительности</summary>
  <p>Локально добавьте отдельные JSON каждого прогона. Для старой сборки нужны две выгрузки одного задания; новая включает Benchmark в hardware JSON. Файлы не отправляются в сеть. Сравнение не подтверждает аппаратную приёмку.</p>
  <div className="diagnostics-record">
   <label>Сценарий производительности <select value={test} onChange={e=>{setTest(e.target.value as PerformanceCase);setSameSource(false)}} disabled={loading}>{PERFORMANCE_CASES.map(c=><option key={c.id} value={c.id}>{c.id} · {c.label}</option>)}</select></label>
   <label>Группа <select value={group} onChange={e=>setGroup(e.target.value as CompareGroup)} disabled={loading}>{GROUPS.map(g=><option key={g} value={g}>{labels[g]}</option>)}</select></label>
   <label>Запуск <select value={condition} onChange={e=>{setCondition(e.target.value as CompareCondition);setSameSource(false)}} disabled={loading}><option value="cold">Холодный (веса уже в кэше)</option><option value="warm">Тёплый (модель уже активна)</option></select></label>
   <label>Среда <select value={launch} onChange={e=>{setLaunch(e.target.value as Launch);setSameSource(false)}} disabled={loading}><option value="standalone">Монолитный HTML</option><option value="web">Web / локальный сервер</option></select></label>
   <label>Hardware JSON <input type="file" accept=".json,application/json" disabled={loading} onChange={e=>setEvidence(e.target.files?.[0]??null)}/></label>
   <label>Benchmark JSON (старая сборка) <input type="file" accept=".json,application/json" disabled={loading} onChange={e=>setLegacy(e.target.files?.[0]??null)}/></label>
   <details><summary>Внешние замеры (необязательно)</summary>{EXTERNAL_KEYS.map(k=><label key={k}>{EXTERNAL_LABELS[k]} <input type="number" min={0} step="any" max={k==='cpuMeanPercent'||k==='gpuMeanPercent'?100:undefined} value={manual[k]??''} disabled={loading} onChange={e=>setManual(old=>({...old,[k]:e.target.value}))}/></label>)}</details>
   <button type="button" className="secondary" disabled={!evidence||busy||loading||records.length>=120} onClick={()=>void add()}>Добавить прогон</button>
   {error&&<p role="alert">{error}</p>}
  </div>
  {runs.length>0&&<>
   <p>Добавлено прогонов: {runs.length}. Данные сравнения находятся в памяти вкладки; скачайте JSON перед закрытием.</p>
   <label><input type="checkbox" checked={sameSource} onChange={e=>setSameSource(e.target.checked)}/> Подтверждаю одинаковый источник, устройство, версию браузера, режим питания, состояние кэша и условия для выбранной группы испытаний.</label>
   <div style={{overflowX:'auto'}}><table><thead><tr><th>Группа</th><th>Прогоны</th><th>Медиана, с</th><th>RTF</th><th>P95 ASR, мс</th><th>RAM / VRAM, МБ</th><th>WER / DER, %</th><th>Сокращение времени, %</th></tr></thead><tbody>
    {summary.rows.map(r=><tr key={r.group}><td>{labels[r.group]}<small> {r.backends.join(', ')}</small></td><td>{r.eligible}/{r.attempted}</td><td>{fmt(r.wallMs===null?null:r.wallMs/1000)}</td><td>{fmt(r.rtf,4)}</td><td>{fmt(r.p95Ms)}</td><td>{fmt(r.external.ramPeakMb)} / {fmt(r.external.vramPeakMb)}</td><td>{fmt(r.external.werPercent)} / {fmt(r.external.derPercent)}</td><td>{fmt(r.improvementPercent)}</td></tr>)}
   </tbody></table></div>
   <p>Сокращение времени отображается только при сопоставимых условиях и минимум трёх пригодных прогонах в каждой сравниваемой группе. Непригодные прогоны не скрываются.</p>
   <details><summary>Все прогоны и замечания</summary>{records.map((r,i)=><div key={r.key}><p>{i+1}. {r.run.test} · {labels[r.run.group]} · {r.run.condition} · {r.run.build?.slice(0,7)??'нет SHA'} · {r.run.eligible?'пригоден для расчёта':'непригоден'}. {r.run.issues.join(' ')}{!r.run.buildAtRunConfirmed?' Версия в момент запуска не подтверждена; требуется ручная сверка.':''}</p><button type="button" disabled={loading} onClick={()=>{setRecords(old=>old.filter(x=>x.key!==r.key));setSameSource(false)}}>Убрать из сравнения</button></div>)}</details>
   <button type="button" className="secondary" onClick={download}>Скачать сравнительный протокол JSON</button>
  </>}
 </details>;
}
