# iScribe — передача этапа 1

Дата: 2026-10-17. Репозиторий: https://github.com/AlmazovAN/iScribe

## Результат и уровень готовности

Реализован код IS-01…IS-08. Это техническая интеграция, **не принятый по реальному аудио MVP**.
Локальные typecheck, lint, 16 unit tests и production build — PASS.
GitHub CI каждого PR содержит npm ci, typecheck, lint, tests и production build.
Публикация Sites подтверждена native deployment result со статусом succeeded:
https://iscribe-alexander.politebook7.chatgpt.site
Сайт доступен владельцу; может потребоваться вход в тот же аккаунт ChatGPT.
Публикация не доказывает работоспособность inference.

GitHub Pages не включалась: GitHub connector не предоставляет настройку Pages,
а browser session не авторизована. Для Pages подготовлен отдельный ручной workflow;
ссылка almazovan.github.io/iScribe не объявляется действующей.

## PR и проверяемая история

| Этап | PR | Merge SHA | CI | Browser/ML |
|---|---|---|---|---|
| IS-01 | [PR #1](https://github.com/AlmazovAN/iScribe/pull/1) | `c348bfdce0c0b13e650b89d7184f95f9468471e1` | PASS | NOT TESTED |
| IS-02 | [PR #2](https://github.com/AlmazovAN/iScribe/pull/2) | `fc97a74f896b37efe4beacb5ac5603db4e22c6a7` | PASS | NOT TESTED |
| IS-03 | [PR #3](https://github.com/AlmazovAN/iScribe/pull/3) | `b8223dfcebf94dbb95b977917d1ca672a9f92dc1` | PASS | NOT TESTED |
| IS-04 | [PR #4](https://github.com/AlmazovAN/iScribe/pull/4) | `cd4bd920f53cba5c791df15c5cebb6e2bca343cb` | PASS | NOT TESTED |
| IS-05 | [PR #5](https://github.com/AlmazovAN/iScribe/pull/5) | `f03a5aed292892df491a30d1f261c832052b8619` | PASS | NOT TESTED |
| IS-06 | [PR #6](https://github.com/AlmazovAN/iScribe/pull/6) | `616745476624cead193507bebb5097cb02fb7452` | PASS | NOT TESTED |
| IS-07 | [PR #7](https://github.com/AlmazovAN/iScribe/pull/7) | `b86bfe66240ed42417d363afa4733832de7d4bb9` | PASS | NOT TESTED |
| IS-08 | [PR #8](https://github.com/AlmazovAN/iScribe/pull/8) | См. merge commit в PR после финальной проверки | См. Checks последнего SHA | NOT TESTED |

База финального PR: `b86bfe66240ed42417d363afa4733832de7d4bb9`.
Итоговый SHA main и merge SHA IS-08 находятся в merged PR #8 и финальном отчёте чата;
документ включён в сам IS-08 и не может содержать собственный будущий merge SHA.
Все ветки создавались последовательно от актуальной main; обязательные проверки
не обходились. Другие пользовательские GitHub-репозитории не изменялись.

## Как пользоваться в Windows

1. Откройте ссылку сайта в актуальном Chrome/Edge/Opera.
2. Для первого испытания отключите «Разделять говорящих» и скачайте Tiny.
3. Дождитесь сообщения об активной модели и фактическом backend.
4. Выберите MP3/WAV с русской речью длительностью 20–60 секунд.
5. Нажмите «Начать обработку», затем проверьте текст и скачайте TXT.
6. Для диаризации скачайте обе модели говорящих одной кнопкой. После этого
   снова выберите Whisper, включите разделение и обработайте двухголосую запись.

Ничего устанавливать и запускать локальный сервер не требуется. Аудио и текст
живут в браузере; ASR-сервера нет. Сеть получает приложение, runtime и модели.
Не закрывайте вкладку. Работа в фоне и на длинных записях не гарантирована.

## Архитектура и воспроизводимость

- Vite + React + TypeScript strict; Web Worker; язык ru и задача transcribe.
- @yourdevice/engine 0.1.1 с локальными SHA-256-проверяемыми патчами.
- Transformers.js 4.3.1; ONNX Runtime Web 1.31.0-dev.20260914-8d85527a0.
- Whisper Tiny / Small / полная Large v3. Base и Turbo в UI отсутствуют.
- ASR: upstream backend fallback; UI отображает фактически инициализированный backend.
- Pyannote segmentation + WeSpeaker embeddings: одинаковые q8/WASM веса для
  preload и обработки; preload без фиктивного аудио, последовательное освобождение.
- При смене Whisper предыдущий Worker завершается. Перед диаризацией Whisper
  освобождается upstream-механизмом; графы говорящих освобождаются после неё.
- Кеш Whisper подтверждается манифестом успешного init и наличием каждого файла;
  кеш говорящих проверяет config, processor и точный q8 ONNX каждой модели.
- Production WASM транспортируется gzip-сжатым (статический лимит хостинга 25 МиБ);
  распаковка побайтово проверяется при build. Веса и их формат не менялись.
- В git нет ONNX-весов, пользовательского аудио и секретов. Лицензии и атрибуция:
  public/THIRD_PARTY_NOTICES.txt. Подробности: docs/ML_FEASIBILITY.md.

Для повторной сборки: npm ci → npm run typecheck → npm run lint → npm test → npm run build.
.npmrc отключает lifecycle scripts, потому что нативный onnxruntime-node не используется.
prepare:engine запускается явно перед dev/typecheck/test/build и отказывает при неизвестном
хеше зависимости. Не обновляйте lockfile без пересмотра патчей и ML-проверок.

Сборка dist использует относительный base и подходит для корня сайта и /iScribe/.
Site project_id: `appgprj_6ad39dadb2ac8191baf7667eee64ad10`.
Исходный проект остаётся в GitHub; Sites хранит отдельный статический deployment.
Для обновления сохранять Site identity, повторно собрать dist из проверенного SHA,
выполнить штатный source/package/deploy workflow Sites. Не создавать новый Site.

## Матрица приёмки

| Проверка | Статус | Основание / что осталось |
|---|---|---|
| Unit, typecheck, lint, build | PASS | 16 тестов; production ML Worker и runtime собираются |
| Статическая публикация | PASS | Native deployment succeeded с указанным URL |
| A: реальная русская речь | NOT TESTED | Нужен WAV/MP3 20–60 с в браузере |
| B: два говорящих | NOT TESTED | Нужна запись 1–3 мин со сменами двух голосов |
| C: короткие реплики | NOT TESTED | «Да», «Угу», перебивания; проверить ошибки объединения |
| D: повторное использование кеша | NOT TESTED | Unit lifecycle PASS; реальные веса и трафик не проверены |
| L: полная Large v3 | NOT TESTED | Регистрация и dtype unit PASS; реального inference нет |
| E: TXT и Windows | NOT TESTED | Formatter/UTF-8 BOM/CRLF unit PASS; скачивание и Блокнот не проверены |
| F: Network приватность | NOT TESTED | По коду нет аудио-upload; нужен Network capture при обработке |
| G: ноутбук 8 ГБ | NOT TESTED | Нужен Windows 11, Ryzen 5500U/Radeon, замер RAM/времени |
| Browser UI/accessibility | NOT TESTED | Поддерживаемый control-browser в среде не доступен |

## Известные ограничения

Large v3 — экспериментальная, не Turbo. До загрузки пользователь подтверждает
несколько ГБ трафика и высокий расход памяти. На 8 ГБ возможен отказ или закрытие
вкладки; модель нельзя объявлять принятой без Gate L/G. Tiny/Small не зависят от неё.
Ошибки диаризации upstream best-effort могут вернуть текст без меток: UI помечает
его частичным, formatter использует SPEAKER_UNKNOWN. Полученные labels не означают
доказанную правильность кластеризации. Границу говорящего внутри ASR-сегмента не угадываем.

Лимиты: файл 128 МБ, один час, 256 МБ декодированных каналов. Browser decode может
израсходовать RAM до проверки длины. Отмена встроенного decode не прерывает его
синхронную работу; результат игнорируется. Worker-задачи завершаются terminate.
Кеш может быть очищен браузером. Полный offline/PWA и стабильность фоновой обработки
не входят в подтверждённые возможности этого выпуска.

Этапы 2–3 (IS-09…IS-19) не начинались. Следующее действие — Gate A на коротком
реальном файле, затем B/D/F/G; дальнейшая разработка только по новому поручению.

