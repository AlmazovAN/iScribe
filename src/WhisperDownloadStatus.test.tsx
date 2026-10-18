import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {WhisperDownloadStatus} from './WhisperDownloadStatus';
it('does not call bytes processed during model init a network download',()=>{
 const html=renderToStaticMarkup(<WhisperDownloadStatus name="Whisper Small" cached active={false} download={{phase:'initializing',cachedBefore:true,loadedBytes:337500000}}/>);
 expect(html).toContain('Файлы найдены · инициализация');
 expect(html).toContain('не сетевой трафик');
 expect(html).not.toContain('Скачивание:');
});
it('reports actual HTTP fetch invocations without asserting bytes transferred',()=>{
 const html=renderToStaticMarkup(<WhisperDownloadStatus name="Whisper Small" cached active={false} download={{phase:'loading',cachedBefore:true,httpRequests:2,loadedBytes:100000000}}/>);
 expect(html).toContain('HTTP-запросы файлов модели');
 expect(html).toContain('Запросов: 2');
 expect(html).toContain('HTTP-кэша браузера');
});
it('distinguishes running model from verified disk cache',()=>{
 const html=renderToStaticMarkup(<WhisperDownloadStatus name="Whisper Small" cached={false} active download={{phase:'ready',cachedAfter:false}}/>);
 expect(html).toContain('Готова к работе · кэш не подтверждён');
});
