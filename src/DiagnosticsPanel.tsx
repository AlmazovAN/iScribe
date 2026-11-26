import {useMemo,useState,type ReactNode} from 'react';
import {expectedWindows} from './jobDiagnostics';
import {formatTime} from './formatTranscript';
import {benchmarkReport} from './benchmark';
import {performanceLabels} from './performance/profiles';
import {HardwareAcceptancePanel} from './HardwareAcceptancePanel';
import type {Job,WindowInspectionStrategy} from './jobs';
import {isRunning} from './jobs';
import type {TraceCode,TraceErrorKind,TraceEvent} from './jobTrace';

const labels: Record<TraceCode,string>={
 'window-inspection-start':'Проверка отдельного окна начата','window-inspection-pass':'Окно проверено','window-inspection-error':'Ошибка проверки окна','window-inspection-cancelled':'Проверка окна отменена',
 'stream-rotation-start':'Плановая ротация декодера','stream-rotation-ready':'Новый декодер готов','stream-rotation-error':'Ошибка ротации','stream-session-closed':'Сессия декодера закрыта','stream-session-close-error':'Ошибка закрытия декодера',
 'stream-split-start':'Резервное чтение частями','stream-split-part-ready':'Фрагмент готов','stream-split-ready':'PCM собран',
 'stream-recovery-start':'Восстановление декодера','stream-reopen-ready':'Декодер открыт','stream-recovered':'Декодирование восстановлено','stream-recovery-stop':'Восстановление прекращено',
 'stream-read-start':'Чтение окна','stream-samples':'Получены аудиоданные','stream-read-end':'Чтение завершено','stream-resample-start':'Ресэмплинг начат','stream-resample-end':'Ресэмплинг завершён','stream-pcm-check-start':'Проверка PCM начата','stream-pcm-check-end':'PCM проверен','checkpoint-start':'Запись контрольной точки',
 'job-start':'Обработка начата','audio-start':'Подготовка аудио','audio-ready':'Аудио подготовлено',
 'audio-check-start':'Проверка PCM начата','audio-check-pass':'PCM проверен','audio-check-error':'Ошибка проверки аудио',
 'model-start':'Подготовка модели','model-ready':'Модель готова',
 'window-start':'Подготовка окна','window-attempt':'Распознавание окна','window-result':'Окно распознано',
 'window-error':'Ошибка окна','window-retry':'Повтор распознавания','checkpoint-committed':'Контрольная точка сохранена',
 'checkpoint-error':'Ошибка записи контрольной точки','speaker-start':'Разделение говорящих начато',
 'speaker-result':'Разделение говорящих завершено','speaker-alignment':'Реплики сопоставлены с говорящими',
 'speaker-error':'Ошибка разделения говорящих','job-complete':'Обработка завершена',
 'job-error':'Ошибка обработки','job-cancelled':'Обработка отменена'
};
const errors:Record<TraceErrorKind,string>={
 worker:'сбой Worker',timeout:'тайм-аут',inference:'ошибка распознавания',network:'сетевая ошибка',
 storage:'ошибка хранилища',cancelled:'отмена','invalid-audio':'некорректное аудио',other:'прочая ошибка'
};
const date=new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
function eventDetails(event:TraceEvent){
 return [
  event.window===undefined?null:'окно '+event.window+(event.totalWindows?'/'+event.totalWindows:''),
  event.attempt===undefined?null:'попытка '+event.attempt,
  event.decoderId===undefined?null:'декодер '+event.decoderId,
  event.strategy==='split'?'частями':event.strategy==='whole'?'целиком':null,
  event.part===undefined?null:'часть '+event.part+'/'+event.totalParts,
  event.streamStage??null,
  event.backend==='unknown'?null:event.backend?.toUpperCase(),
  event.elapsedMs===undefined?null:event.elapsedMs+' мс',
  event.errorKind&&errors[event.errorKind]
 ].filter(Boolean).join(' · ');
}

export function DiagnosticsPanel({job,jobs,busy,checking,onSelect,onInspect,onInspectWindow,onLog,onBenchmark,onHardware,children}:{
 job:Job|undefined;jobs:Job[];busy:boolean;checking:boolean;
 onSelect:(id:string)=>void;onInspect:(id:string)=>void;onInspectWindow?:(id:string,window:number,strategy:WindowInspectionStrategy)=>void;onLog:(id:string)=>void;onBenchmark:(id:string)=>void;
 onHardware:(id:string)=>Promise<void>;children:ReactNode;
}){
 const [selection,setSelection]=useState<{id:string;value:string}|null>(null);
 const [logOpen,setLogOpen]=useState(false);
 const total=expectedWindows(job?.duration);
 const defaultWindow=job?Math.max(1,Math.min(job.nextWindow+1,total??Infinity)):1;
 const inputValue=selection?.id===job?.id?selection?.value??String(defaultWindow):String(defaultWindow);
 const windowNumber=Number(inputValue);
 const valid=Number.isSafeInteger(windowNumber)&&Number.isSafeInteger((windowNumber-1)*25*16000)&&windowNumber>=1&&(total===null||windowNumber<=total);
 const blocked=busy||!job||isRunning(job.stage)||job.stage==='queued'||!valid;
 const benchmark=useMemo(()=>job?.benchmark?.runs?benchmarkReport(job):null,[job]);
 const profiler=benchmark?.performanceProfiler;
 const metrics=benchmark?.timingsMs;
 const measuredStages=metrics?Object.entries(metrics).filter(([key,value])=>key!=='jobRuns'&&typeof value==='number'&&value>0).sort((a,b)=>Number(b[1])-Number(a[1])):[];
 const stageNames:Record<string,string>={decode:'подготовка аудио',pcmIntegrityCheck:'проверка PCM',modelInitialization:'инициализация модели',asrIncludingFailedAttempts:'Whisper',checkpointPersistence:'контрольные точки',speakerInference:'диаризация'};
 const timingLabels:Record<string,string>={streamOpen:'Открытие потока',fullAudioPreparation:'Подготовка полного аудио',streamDecode:'Декодирование окон',streamResample:'Ресэмплинг',metadataPersistence:'Служебное сохранение',pcmCopy:'Копирование PCM',betweenAsrAttempts:'Интервалы между попытками Whisper',workerRecovery:'Восстановление Worker',speakerPass:'Проход диаризации'};
 const available=(v:boolean|null)=>v===null?'недоступно':v?'да':'нет';
 const events=job?.trace??[];

 return <details className="panel diagnostics-panel">
  <summary>Диагностика</summary>
  <div className="diagnostics-body">
   {job&&<div className="diagnostics-record">
    <label>Запись <select value={job.id} onChange={e=>onSelect(e.target.value)}>
     {jobs.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <div className="diagnostics-actions">
     <button type="button" disabled={busy||isRunning(job.stage)||job.stage==='queued'} onClick={()=>onInspect(job.id)}>{checking?'Проверка аудио…':'Проверить аудио'}</button>
     {!!job.benchmark?.runs&&<button type="button" onClick={()=>onBenchmark(job.id)}>Бенчмарк JSON</button>}
    </div>
   </div>}
   {job&&onInspectWindow&&<section className="diagnostics-record" aria-label="Проверка отдельного окна">
    <strong>Проверка отдельного окна без Whisper</strong>
    <label>Номер окна <input type="number" min={1} max={total??undefined} step={1} value={inputValue} disabled={busy} onChange={e=>setSelection({id:job.id,value:e.target.value})}/>{total!==null&&<span> из {total}</span>}</label>
    {valid&&<p>Номинальный интервал: {formatTime((windowNumber-1)*25)} – {formatTime(Math.min((windowNumber-1)*25+30,total===null?Infinity:job.duration!))}</p>}
    <div className="diagnostics-actions">
     <button type="button" disabled={blocked} onClick={()=>onInspectWindow(job.id,windowNumber,'whole')}>Проверить целиком</button>
     <button type="button" disabled={blocked} onClick={()=>onInspectWindow(job.id,windowNumber,'split')}>Проверить частями по 5 с</button>
    </div>
    <p>Используется новый потоковый декодер. Сохранённый текст и лимит восстановления не изменяются.</p>
    {(job.windowInspections??[]).map(r=><p key={r.window+'-'+r.strategy} role={r.status==='failed'?'alert':undefined}>
     Окно {r.window} · {r.strategy==='whole'?'целиком':'частями'} · {r.status==='passed'?'пройдено':r.status==='cancelled'?'отменено':'не пройдено'} · {(r.elapsedMs/1000).toFixed(1)} с
     {r.startSample!==undefined&&r.endSample!==undefined&&<> · {formatTime(r.startSample/16000)}–{formatTime(r.endSample/16000)}</>}
     {r.report&&<> · PCM {r.report.pcmSamples} отсчётов · пик {r.report.peakAbsolute.toFixed(3)} · {r.report.quietWindows?'тихое окно':'не тихое окно'}{r.report.nearClippedWindows?' · высокий пиковый уровень':''}</>}
     {r.strategy==='split'&&<> · частей готово: {r.completedParts}</>}
     {r.failureStage&&<> · стадия: {r.failureStage}</>}{r.errorKind&&<> · {errors[r.errorKind]}</>}
    </p>)}
   </section>}
   {job&&<div className="diagnostics-metrics">
    {job.audioCheck?.status==='passed'&&<p>PCM проверен: {job.audioCheck.report.windowCount} окон · {job.audioCheck.report.quietWindows} тихих · {job.audioCheck.report.nearClippedWindows} с пиковыми уровнями · пик {job.audioCheck.report.peakAbsolute.toFixed(3)}</p>}
    {job.audioCheck?.status==='failed'&&<p role="alert">Проверка аудио: {job.audioCheck.problem}</p>}
    {benchmark&&<p aria-label="Измерения производительности">Бенчмарк: {benchmark.measuredCommittedWindows} окон · RTF ASR: {benchmark.asrRtf??'—'} · p95 окна: {benchmark.asrWindowMs.p95??'—'} мс · запись контрольных точек: {benchmark.timingsMs.checkpointPersistence??'—'} мс · возобновлений: {benchmark.resumedRuns}{benchmark.mainThreadHeap.observedPeakBytes!==null?' · оценка JS heap: '+(benchmark.mainThreadHeap.observedPeakBytes/1e6).toFixed(1)+' МБ':''}</p>}
    {profiler&&<details aria-label="Performance Profiler"><summary>Performance Profiler</summary>
     <p>Логические процессоры: {profiler.device.logicalProcessors??'недоступно'} · RAM (оценка браузера): {profiler.device.deviceMemoryGiB??'недоступно'} Гб · WebGPU API: {available(profiler.device.webGpuApi)} · WebNN API: {available(profiler.device.webNnApi)}</p>
     <p>WASM SIMD: {available(profiler.device.wasmSimd)} · предпосылки многопоточности: {available(profiler.device.wasmThreadPrerequisites)} · настроено потоков: {profiler.device.configuredWasmThreads??'недоступно'} · фактические потоки: недоступно</p>
     <p>Попытки ASR: WebGPU {profiler.backendAttempts.webgpu} · WebNN {profiler.backendAttempts.webnn} · WASM {profiler.backendAttempts.wasm} · неизвестно {profiler.backendAttempts.unknown}. Запрос: авто {profiler.requestedBackendAttempts.auto} · WASM {profiler.requestedBackendAttempts.wasm} · WebGPU {profiler.requestedBackendAttempts.webgpu} · WebNN {profiler.requestedBackendAttempts.webnn} · неизвестно {profiler.requestedBackendAttempts.unknown}.</p>
     <p>RTF измеренных запусков: {benchmark?.measuredRunRtf??'—'} · наибольшая из измеренных стадий: {measuredStages.length?stageNames[measuredStages[0][0]]:'недоступно'}</p>
     {Object.entries(profiler.timingsMs).map(([key,timing])=><p key={key}>{timingLabels[key]}: {timing?timing.totalMs+' мс ('+timing.count+' изм.)':'недоступно'}</p>)}
     <p>Интервалы могут перекрываться. Загрузка CPU/GPU, полная RAM/VRAM, время передачи в Worker и фактическое число потоков недоступны; измеряются внешними средствами. Наличие API не подтверждает работоспособность модели.</p>
    </details>}
    {benchmark?.resourceManagement&&<details aria-label="Resource Manager"><summary>Resource Manager</summary>
     <p>Запрошено: {performanceLabels[benchmark.resourceManagement.lastPolicy.requested]} · применено: {performanceLabels[benchmark.resourceManagement.lastPolicy.effective]}</p>
     <p>Окон допущено: экономичная {benchmark.resourceManagement.windowCounts.eco}, средняя {benchmark.resourceManagement.windowCounts.medium}, максимальная {benchmark.resourceManagement.windowCounts.max}. Паузы: {benchmark.resourceManagement.pauseCount} · {benchmark.resourceManagement.pauseMs} мс.</p>
     <p>Целевые параметры: WASM до {benchmark.resourceManagement.lastPolicy.targetWasmThreads} потоков · буфер до {benchmark.resourceManagement.lastPolicy.targetPrefetchWindows} окон.</p>
     <p>{benchmark.resourceManagement.lastPolicy.reasons.includes('recovery-cap')?'Режим ограничен после восстановления Worker/GPU. ':''}{benchmark.resourceManagement.lastPolicy.reasons.includes('thread-prerequisites')?'Многопоточность не подтверждена или standalone ограничен одним потоком. ':''}{benchmark.resourceManagement.lastPolicy.reasons.includes('memory-hint')?'Целевой буфер ограничен по оценке памяти. ':''}Действуют паузы, выбор проверенного бэкенда в начале задания и настройка потоков WASM. Предварительная подготовка применяется для потокового аудио в пределах профиля.</p>
    </details>}
    {benchmark?.storageUiOptimization&&<details aria-label="Storage & UI Optimization"><summary>Storage &amp; UI Optimization</summary>
     <p>Промежуточных записей объединено со следующими обязательными сохранениями: {benchmark.storageUiOptimization.deferredMetadataWrites} · пропущено частых обновлений прогресса: {benchmark.storageUiOptimization.suppressedProgressUpdates}.</p>
     <p>Контрольные точки, ошибки и резервирование восстановления не откладываются. Счётчики не являются замером числа перерисовок React или задержки IndexedDB.</p>
    </details>}
    {benchmark?.memoryOptimization&&<details aria-label="Memory Optimization"><summary>Memory Optimization</summary>
     <p>Новых буферов ASR: {benchmark.memoryOptimization.payloadAllocations} · повторно использовано: {benchmark.memoryOptimization.payloadReuses} · отсоединено при успешной передаче: {benchmark.memoryOptimization.detachedPayloads}.</p>
     <p>Скопировано PCM: {Math.round(benchmark.memoryOptimization.payloadCopyBytes/1000)} кб · наибольший буфер передачи: {Math.round(benchmark.memoryOptimization.peakPayloadBytes/1000)} кб.</p>
     <p>Освобождений модели: {benchmark.memoryOptimization.idleModelReleases} · ошибок освобождения: {benchmark.memoryOptimization.releaseFailures}. Эти счётчики не измеряют полное потребление RAM/VRAM.</p>
    </details>}
    {benchmark?.audioPipeline&&<details aria-label="Audio Pipeline"><summary>Audio Pipeline</summary>
     <p>Окон запланировано: {benchmark.audioPipeline.scheduled} · использовано: {benchmark.audioPipeline.consumed} · готовы к моменту запроса: {benchmark.audioPipeline.readyHits} · ошибки: {benchmark.audioPipeline.failed}.</p>
     <p>Максимальная глубина очереди: {benchmark.audioPipeline.peakQueued} · ожидание буфера: {benchmark.audioPipeline.waitMs} мс · подготовка использованных окон: {benchmark.audioPipeline.preparedMs} мс.</p>
     <p>Время подготовки может перекрываться с распознаванием. Глубина очереди не измеряет полную память декодера.</p>
    </details>}
    {benchmark?.wasmThreads&&<details aria-label="Потоки WASM"><summary>Потоки WASM</summary>
     <p>Последняя попытка: запрошено {benchmark.wasmThreads.last.requested} · подтверждено Worker (настройка ONNX) {benchmark.wasmThreads.last.configured??'недоступно'} · реально активных потоков: недоступно.</p>
     <p>Попыток WASM: {benchmark.wasmThreads.attempts} · без подтверждения настройки: {benchmark.wasmThreads.unconfirmed}.</p>
     <p>После сбоя восстановление на WASM ограничено одним потоком до конца задания. Монолитный HTML также ограничен одним потоком.</p>
    </details>}
    {benchmark?.backendCalibration&&<details aria-label="Сравнение бэкендов"><summary>Сравнение бэкендов</summary>
     <p>Исходный: {benchmark.backendCalibration.baseline.toUpperCase()} · выбран: {benchmark.backendCalibration.chosen.toUpperCase()} · фрагмент: {benchmark.backendCalibration.sampleSeconds.toFixed(1)} с.</p>
     {benchmark.backendCalibration.samples.map(s=><p key={s.backend}>{s.backend.toUpperCase()}: {s.status==='passed'?'совпадение текста':s.status==='mismatch'?'текст отличается':s.status==='empty'?'нет текста':'ошибка'} · {s.inferenceMs===null?'—':s.inferenceMs.toFixed(0)+' мс'} · инициализация {s.initializationMs===null?'—':s.initializationMs.toFixed(0)+' мс'}</p>)}
     <p>Сравнение на одном фрагменте не подтверждает точность распознавания всей записи или аппаратную приёмку.</p>
    </details>}
    {job.failure&&<p aria-label="Диагностика прерывания">Последнее прерывание: {job.failure.reason==='session-ended'?'завершение предыдущей сессии':job.failure.reason==='cancelled'?'отмена пользователем':'ошибка выполнения'} · этап: {job.failure.stage} · сохранено окон: {job.failure.completedWindows}{job.failure.totalWindows!==null? ' / '+job.failure.totalWindows:''} · до {Math.round(job.failure.checkpointSeconds)} с{job.failure.durationSeconds!==null?' из '+Math.round(job.failure.durationSeconds)+' с':''} · backend: {job.failure.backend??'неизвестен'}{job.failure.observedExit==='pagehide'?' · зафиксирован выход со страницы (не обязательно перезагрузка)':''} · {job.failure.message}</p>}
    {job.diagnostics&&<p>Говорящие: интервалов {job.diagnostics.turns} · сегментов {job.diagnostics.segments} · без спикера {job.diagnostics.unlabeled} · точечных сегментов {job.diagnostics.zeroDuration}{job.diagnostics.overlapMatches!==undefined&&<> · пустых ASR: {job.diagnostics.emptyText??0} · по перекрытию: {job.diagnostics.overlapMatches} · границы: {job.diagnostics.boundaryMatches} · неоднозначные: {job.diagnostics.ambiguous} · вне интервалов: {job.diagnostics.uncovered} · слабое перекрытие: {job.diagnostics.weakEvidence}{job.diagnostics.invalidTurns?' · неверные интервалы: '+job.diagnostics.invalidTurns:''}</>}</p>}
   </div>}
   <details className="diagnostics-log" onToggle={e=>setLogOpen(e.currentTarget.open)}>
    <summary>Журнал логирования{events.length>0&&<span>{events.length} · {labels[events.at(-1)!.code]??events.at(-1)!.code}</span>}</summary>
    {logOpen&&(events.length>0?<ol aria-label="События выбранной записи">
     {[...events].reverse().map((event,index)=>{
      const details=eventDetails(event);
      return <li key={event.at+'-'+index}>
       <time dateTime={new Date(event.at).toISOString()}>{date.format(event.at)}</time>
       <div><strong>{labels[event.code]??event.code}</strong>{details&&<small>{details}</small>}</div>
      </li>;
     })}
    </ol>:<p>{job?'События появятся после проверки аудио или запуска распознавания.':'Выберите запись, чтобы открыть журнал.'}</p>)}
    {job&&(events.length>0||job.failure)&&<button type="button" onClick={()=>onLog(job.id)} title="Скачать журнал без аудио, текста и имени записи">Скачать журнал JSON</button>}
   </details>
   <HardwareAcceptancePanel job={job} onExport={onHardware} busy={busy}/>
   <details className="diagnostics-cache"><summary>Автономная работа и кэш</summary>{children}</details>
  </div>
 </details>;
}
