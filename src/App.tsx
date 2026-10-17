import EngineWorker from './ml/worker?worker';
export function App(){return <main><h1>iScribe</h1><p>Локальная расшифровка русской речи. Проект в разработке.</p><button onClick={()=>new EngineWorker().terminate()}>Проверить создание Worker</button></main>}
