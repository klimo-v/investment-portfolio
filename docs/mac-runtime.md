# Автономный runtime для macOS Apple Silicon

Оболочка Swift, версия, выпуск `.app`/DMG и приёмка обновления задачи 3
описаны в [mac-app.md](mac-app.md). Ниже сохранены контракт runtime и история
проверок задач 1, 2А и 2Б.

Состояние на 14 ноября 2026: реализовано, без коммита на ветке
`feat/system-performance` поверх `da8d4e8`. Исходные незакоммиченные
`docs/tasks/mac-phone-*.md` не изменялись.

## Сборка

```sh
pnpm install --frozen-lockfile
pnpm build:mac
```

Хост сборки: macOS arm64, pnpm 9.15.9, начальный Node для запуска скрипта.
Дальше сборка использует скачанный Node 22.22.3 darwin-arm64. Источник:
официальный `https://nodejs.org/dist/v22.22.3/node-v22.22.3-darwin-arm64.tar.gz`.
SHA-256: `0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207`.
Параметры закреплены в `scripts/mac-runtime.json`; SHA проверяется и для кэша
`tmp/mac-runtime/node.tar.gz`. При несовпадении сборка прекращается.

Результат: `/Users/krisfeminova/projects/investment-portfolio/dist/mac-arm64`.
Внутри: `runtime/node` и лицензия Node, `server/main.js`, `server/migrations`
(включая `meta/_journal.json`), Angular в `web` вместе с `3rdpartylicenses.txt`, публичный T-Invest CA в `certs`,
launcher и npm-пакеты с лицензиями. Около 243 МБ. Переносить весь каталог,
сохраняя исполнимые биты и относительные симлинки (например, `cp -a`).

Nx явно оставляет npm-зависимости внешними (`externalDependencies: 'all'`).
Скрипт извлекает фактические external require из собранного webpack-файла,
включая `@fastify/static`, `exceljs`, `tslib` и `better-sqlite3`, и копирует
транзитивные dependencies, установленные optional dependencies и peers.
Опциональные Nest-адаптеры, которые не используются, не устанавливаются.
Дерево сохраняет раздельные версии пакетов pnpm, ссылки ведут только внутрь
артефакта. `build-manifest.json` содержит версии пакетов, список externals,
поставку Node и хеш lockfile. Сборка требует совпадения установленного lockfile
`node_modules/.pnpm/lock.yaml` с репозиторным.

Финальная проверка сборки выполняет реальный `SELECT 1` через `better-sqlite3`
вложенным Node. В текущем пакете 13.0.1 загружается
`prebuilds/darwin-arm64.node`. `otool -L` показал только системные библиотеки
для Node и SQLite, без Homebrew; Mach-O minimum macOS у обоих — 11.0.
Это не заменяет проверку на самой старой поддерживаемой системе.

Angular собирается с `CI=true` и `--skip-nx-cache`: локальный LMDB-кэш Angular
на этой машине вызывал нативный SIGABRT. Production-сборка встраивает CSS
Google Fonts, поэтому при сборке нужен интернет. Файлы шрифтов браузер пока
загружает с Google; сервер и работа с локальной БД от них не зависят.
Есть предупреждение существующего initial budget: 729.31 кБ при пороге 720 кБ;
порог ошибки 800 кБ не превышен.

## Контракт запуска для Swift

Запустить `start.sh` по абсолютному пути через `Process`, без shell-склейки
аргументов. Либо вызвать `<resources>/runtime/node` с единственным аргументом
`<resources>/launch.mjs`. Рабочий каталог произвольный. Node в PATH не нужен.
Хранить PID/объект Process launcher-а; при выходе приложения послать ему SIGTERM
и дождаться завершения. `start.sh` делает exec, его PID становится PID launcher-а.
Обёртка пересылает сигнал серверу, ждёт ребёнка и сохраняет его код/сигнал выхода.
Nest завершает HTTP, а Fastify onClose закрывает SQLite.

```sh
DATA_DIR="/абсолютный/путь/Данные" PORT=3000 \
  "/абсолютный/путь/mac-arm64/start.sh" &
pid=$!
curl --fail http://127.0.0.1:3000/api/health
kill -TERM "$pid"
wait "$pid"   # при завершении сигналом допустим ненулевой код
```

| Параметр | Значение |
| --- | --- |
| Ресурсы | Определяются по расположению launcher-а; APP_ROOT и STATIC_ROOT задаются им |
| DATA_DIR | Абсолютный пользовательский каталог; default `~/Library/Application Support/Investment Portfolio` |
| DB_PATH | Default `portfolio.sqlite` внутри DATA_DIR; относительный путь — от DATA_DIR, абсолютный используется как есть |
| ENV_FILE | Default `DATA_DIR/.env`; для переопределения передавать абсолютный путь |
| PORT | Default 3000, можно передать через окружение или пользовательский .env |
| API_HOST | В установленной версии принудительно `127.0.0.1`, даже если .env задаёт другой адрес |
| NODE_EXTRA_CA_CERTS | Передавать до запуска; T-Invest CA добавляет обёртка до дочернего Node |

Окружение имеет приоритет над `.env`. Launcher загружает пользовательский `.env`
до импорта обёртки; `load-env.ts` также работает раньше графа модулей SQLite.
Если уже есть корпоративный CA, объединённый файл пишется в
`DATA_DIR/tmp/extra-ca-certs.pem`, а не в ресурсы приложения. Из репозитория
без DATA_DIR сохранены прежние defaults: корневой `.env`,
`data/portfolio.sqlite`, `tmp/extra-ca-certs.pem`.

`GET /api/health` возвращает `{"status":"ok","spa":true}` только после
успешных миграций и регистрации SPA; дополнительно выполняет SQL и проверяет
доступность index.html и читаемость локальных JS/CSS, указанных в его script/link
(включая modulepreload). При потере файла после запуска health возвращает 503.
Отсутствие файлов запуска SPA или сломанные миграции останавливают
установленную версию с ошибкой до listen. Неизвестный `/api/*` и отсутствующие
файлы статики возвращают 404, без HTML SPA-fallback.

## Выполненная приёмка

`node scripts/test-mac-runtime.mjs` / `pnpm test:mac` создаёт только временные
данные и переносит артефакт в каталог с пробелами в системном tmp.
Фактически прогонялось с временно переименованным `node_modules` репозитория
(затем восстановлен), из другого cwd и с PATH `/usr/bin:/bin`, без системного Node.

Проверено: относительные ссылки только внутри артефакта; отсутствие `.env`,
SQLite и отчётов; HTTP SPA и JS/CSS, `/dashboard`, прямой `/operations`, health,
API 404; POST/GET тестовой системы с записью в SQLite; DB_PATH и PORT из
пользовательского `.env` до открытия БД; объединение CA в пользовательских данных;
SIGTERM именно launcher-у, выход дочернего Node, освобождение порта;
23 записи журнала миграций, `integrity_check=ok`; повторный старт с той же записью.
Также проверен отказ запуска без index.html, основного JS и журнала миграций.
Удаление основного JS на работающем сервере проверяется отдельно: health — 503,
запрос JS — 404 JSON; после восстановления health — 200. Проверка статики
сравнивает MIME-тип и байты с файлами сборки, а файл лицензий — с результатом Angular.
Через `lsof` подтверждён listener только на `127.0.0.1`, несмотря на
`API_HOST=0.0.0.0` в тестовом пользовательском .env.

Последний прогон после исправления готовности SPA и упаковки лицензий: `PASS`, порт `52021`. Копия ресурсов:
`/private/var/folders/7f/x63rr1716pd7y3xh0q6nj9sw0000gn/T/portfolio standalone Z26WuP/Application Resources`.
Рядом — `User Data` и `server.log`. Папка временная, может быть удалена macOS.
Дополнительно репозиторный `scripts/run-with-certs.mjs node dist/apps/api/main.js`
прошёл health и SIGTERM с отдельным временным DATA_DIR и другим cwd.

Отдельно в браузере перенесённой сборки: дашборд отрисовал пустые показатели,
данные без предупреждений; прямой `/operations` отрисовал фильтры, таблицу и
пустое состояние. Проверены `tsc --noEmit -p apps/api/tsconfig.app.json` и
`git diff --check`. Все тестовые серверы после проверки остановлены.

## На чистом Mac

Повторить перенос и `pnpm test:mac` (либо аналогичную HTTP-приёмку вложенным Node)
на Apple Silicon без инструментов разработчика, в том числе на минимальной
поддерживаемой версии macOS. Проверить read-only ресурсы будущего .app,
права каталога Application Support, Swift Process/SIGTERM, quarantine/Gatekeeper,
подпись и notarization вложенных Mach-O. Сборка пока является каталогом ресурсов,
без Swift-проекта, подписи или инсталлятора. Реальный T-Invest TLS/импорт не
проверялся: личные токены и рабочая база для приёмки не использовались.
