import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

test('Colab prototype queues Drive files, resumes checkpoints and survives reload',async({page,context})=>{
 const outgoing=[];
 await context.route(/https:\/\/.*(google\.com|googleusercontent\.com)/,route=>{
  outgoing.push(route.request().url());return route.abort();
 });
 await page.clock.install();
 await page.goto('/');
 await page.getByRole('button',{name:'Google Drive / Colab'}).click();
 await expect(page.getByRole('heading',{name:'Очередь Colab'})).toBeVisible();
 await page.getByRole('checkbox',{name:'Автоскачивание демо TXT'}).uncheck();
 const link=page.getByLabel('Ссылка на файл Google Drive');
 await link.fill('https://example.com/a.mp3');
 await page.getByRole('button',{name:'В очередь',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Вставьте ссылку на файл Google Drive');
 await page.getByLabel('Сценарий',{exact:true}).selectOption('failure');
 await page.getByRole('button',{name:'Добавить пример'}).click();
 await link.fill('https://drive.google.com/file/d/synthetic_example_1234/view');
 await page.getByRole('button',{name:'В очередь',exact:true}).click();
 const failure=page.locator('.colab-job').filter({hasText:'Сбой на этапе ASR'});
 const drive=page.locator('.colab-job').filter({hasText:'Файл Drive'});
 await expect(drive).toContainText('№ 2 из 2');
 await page.clock.runFor(1750*16);
 await expect(failure).toContainText('Обработка прервана');
 await expect(failure).toContainText('1 из 4 этапов');
 await expect(drive).toContainText('Готов TXT');
 const [download]=await Promise.all([
  page.waitForEvent('download'),
  drive.getByRole('button',{name:'Скачать TXT'}).click()
 ]);
 expect(await readFile(await download.path(),'utf8')).toContain('Аудио не обрабатывалось');
 await page.reload();
 await page.getByRole('button',{name:'Google Drive / Colab'}).click();
 await page.getByRole('checkbox',{name:'Автоскачивание демо TXT'}).uncheck();
 await expect(failure).toContainText('1 из 4 этапов');
 await failure.getByRole('button',{name:'Поставить в очередь'}).click();
 await page.clock.runFor(1750*8);
 await expect(failure).toContainText('Готов TXT');
 await page.clock.runFor(6*60*1000+1750*2);
 await expect(page.getByText('Среда отключена',{exact:true})).toBeVisible();
 expect(outgoing).toEqual([]);
 await page.getByRole('button',{name:'Локальный iScribe'}).click();
 await expect(page.getByRole('heading',{name:'Модель распознавания'})).toBeVisible();
});
