import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const baseline='a'.repeat(40),candidate='b'.repeat(40);
function reports(group,wallMs){
 const build=group==='baseline'?baseline:candidate;
 const benchmark={schema:'iscribe.benchmark.v1',model:'whisper-small',language:'ru',diarizationRequested:false,durationSeconds:871,committedCheckpointWindows:35,measuredCommittedWindows:35,measuredUniqueAudioSeconds:871,stage:'done',runs:1,resumedRuns:0,failedRuns:0,attempts:35,failedAttempts:0,workerRecoveries:0,timingsMs:{jobRuns:wallMs,asrIncludingFailedAttempts:wallMs/2,modelInitialization:100},asrWindowMs:{p95:100},
  ...(group==='baseline'?{}:{firstRunContext:{buildRevision:build,launch:'standalone',mode:group,modelResidentAtStart:false,calibrationRequested:false,startCheckpoint:0},resourceManagement:{requestedWindowCounts:{eco:0,medium:35,max:0}}})};
 const evidence={schema:'iscribe.hardware-evidence.v1',buildRevision:build,job:{model:'whisper-small',language:'ru',diarizationRequested:false,sourceDurationSeconds:871,sourceSizeBytes:33300000,expectedWindows:35,committedWindows:35,completedASR:true,asrSegmentCount:25,invalidAsrSegments:0,resumedRuns:0,persistedJobFound:true,persistedCheckpointMatches:true,persistedTranscriptMatches:true,savedAudioPresent:true,savedAudioSizeMatches:true,observedBackend:'wasm'},privateText:'SYNTHETIC PRIVATE TEXT'};
 return {benchmark,evidence:group==='baseline'?evidence:{...evidence,performanceBenchmark:benchmark}};
}
function json(name,data){return {name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))}}
test('imports independent synthetic baseline/candidate reports, rejects duplicates, exports only comparison fields',async({page})=>{
 await page.goto('/tests/e2e/harness.html');
 await expect(page.getByRole('button',{name:'Выбрать файлы'})).toBeEnabled();
 await page.locator('.diagnostics-panel > summary').click();
 await page.locator('.hardware-acceptance > summary').first().click();
 const panel=page.locator('.performance-comparison');
 await panel.locator(':scope > summary').click();
 const hardware=panel.getByLabel('Hardware JSON',{exact:true}),legacy=panel.getByLabel('Benchmark JSON (старая сборка)',{exact:true});
 const add=panel.getByRole('button',{name:'Добавить прогон'});
 async function importRun(group,n,wall){
  const suffix=n.toString(16).padStart(8,'0'),f=reports(group,wall);
  await panel.getByLabel('Группа',{exact:true}).selectOption(group);
  await hardware.setInputFiles(json('iscribe_hardware_evidence_'+suffix+'.json',f.evidence));
  if(group==='baseline')await legacy.setInputFiles(json('iscribe_benchmark_'+suffix+'.json',f.benchmark));
  await add.click();
  await expect(panel.getByText('Добавлено прогонов: '+n+'.',{exact:false})).toBeVisible();
  await expect(add).toBeDisabled();
 }
 for(let n=1;n<=3;n++)await importRun('baseline',n,20000);
 for(let n=4;n<=6;n++)await importRun('medium',n,10000);
 await panel.getByRole('checkbox',{name:/Подтверждаю одинаковый источник/}).check();
 const medium=panel.getByRole('row').filter({hasText:'Средняя'});
 await expect(medium.getByRole('cell').last()).toHaveText('50');
 const repeated=reports('medium',10000);
 await hardware.setInputFiles(json('iscribe_hardware_evidence_00000006.json',repeated.evidence));
 await add.click();await expect(panel.getByRole('alert')).toContainText('уже добавлен');
 const [download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Скачать сравнительный протокол JSON'}).click()]);
 const raw=await readFile(await download.path(),'utf8'),result=JSON.parse(raw);
 expect(result.verdict).toBe('HARDWARE ACCEPTANCE NOT VERIFIED');
 expect(result.runs).toHaveLength(6);
 expect(result.summary.rows.find(r=>r.group==='medium')).toMatchObject({eligible:3,improvementPercent:50});
 expect(raw).not.toContain('SYNTHETIC PRIVATE TEXT');
 expect(raw).not.toContain('00000006');
});
