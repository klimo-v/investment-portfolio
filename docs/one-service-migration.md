# План: упростить запуск приложения

## Context

Сегодня запуск — два процесса в двух терминалах (`pnpm start` → :4200 и `pnpm start:api`
→ :3000), связанные dev-прокси, плюс набор неявных условий:

- рантайм-пути **относительны CWD** — `.env` ([load-env.ts](apps/api/src/load-env.ts)),
  `data/portfolio.sqlite` ([db-path.ts:9](apps/api/src/db/db-path.ts:9)),
  `certs/russian_trusted_root_ca.pem` (npm-скрипт), `./apps/api/src/db/migrations`
  ([migrate.ts:14](apps/api/src/db/migrate.ts:14)). API работает только если запущен из корня workspace;
- миграции не применяются при старте — надо не забыть `pnpm db:migrate` вручную;
- API не раздаёт SPA, CORS прибит к `http://localhost:4200` ([main.ts:17](apps/api/src/main.ts:17)),
  поэтому два порта обязательны;
- production-режима не существует вовсе.

**Задача сейчас:** пользоваться приложением на своём Mac — быстро, без терминала.
**Задача потом:** тот же продукт на сервере с регистрацией пользователей.

### Выбранный подход и почему он расширяем

Ключевая мысль: разделить **«пользоваться»** и **«разрабатывать»**.

- *Пользоваться* — один процесс на одном порту, поднятый в фоне при логине; приложение
  открывается как закладка http://localhost:3000. Ничего не собирается, ничего не ждём.
- *Разрабатывать* — нынешний dev-режим с hot reload, только запускаемый одной командой.

Расширяемость получается бесплатно: «один процесс, раздающий и API, и SPA, с путями,
не зависящими от CWD, и миграциями на старте» — это **ровно тот артефакт, который потом
кладётся в Docker и уезжает на сервер**. Этап 2 не переделывает Этап 1, а упаковывает его.

**Десктоп-обёртка (Tauri/Electron) не выбрана**: под цель «у каждого своя регистрация»
эту работу пришлось бы выбросить, и это не «1–2 дня» из [docs/04-roadmap.md](docs/04-roadmap.md) —
вся логика в NestJS, значит внутрь пришлось бы класть sidecar Node-процесс с нативным
`better-sqlite3` и собирать его под каждую ОС. Локальный фоновый сервис даёт то же удобство
(иконка/закладка, всё локально, интернет только за котировками) без этой цены.

⚠️ Отмечаю на будущее: авторизации в API нет вообще — ни guard-ов, ни сессий, ни таблицы
`users`. Пока всё слушает localhost — это нормально. Выставлять наружу без гейта нельзя
(см. Этап 2).

---

## Этап 1 — Локальный запуск в один клик (делаем сейчас)

### 1.1 Prod-режим: один процесс, один порт

`@fastify/static` уже заложен в `externals`
([webpack.config.js:31](apps/api/webpack.config.js:31)), но не установлен — добавить в зависимости.

В [main.ts](apps/api/src/main.ts):
- `app.useStaticAssets({ root: <browser-билд>, wildcard: false })`, корень — от `__dirname`,
  переопределяется `STATIC_ROOT`; включать только когда статика реально есть, чтобы
  dev-режим не менялся;
- SPA-fallback: не-`/api` GET без файла → `index.html` (роутер клиентский, `<base href="/">` уже есть);
- CORS-origin вынести в `CORS_ORIGIN` (по умолчанию — нынешний `http://localhost:4200`);
  в prod-режиме same-origin, CORS не нужен;
- `new FastifyAdapter({ bodyLimit: … })` — сейчас адаптер создаётся без опций, действует
  дефолт Fastify 1 MiB, а импорт xlsx приходит base64 в теле JSON
  ([import.service.ts:363](apps/api/src/app/modules/import/import.service.ts:363)). Поднять до ~20 МБ.

Фронт не трогаем: все вызовы — относительные `/api/...`, хардкода хоста нет (проверено
по `apps/web/src/app/entities/*/*.api.ts`), поэтому в prod прокси просто не нужен.

### 1.2 Пути не зависят от CWD

- [db-path.ts](apps/api/src/db/db-path.ts): относительный `DB_PATH` резолвить от `DATA_DIR`,
  а не от `process.cwd()`; `mkdirSync`-логика сохраняется;
- [load-env.ts](apps/api/src/load-env.ts): `.env` резолвить абсолютно, отсутствие файла
  по-прежнему не фатально;
- `NODE_EXTRA_CA_CERTS` (сертификат Минцифры) задавать в скрипте запуска абсолютным путём —
  сейчас это POSIX-префикс `VAR=… cmd` в `package.json`, привязанный к CWD.

Без этого приложение не запускается ниоткуда, кроме корня workspace, — а фоновый сервис
и любой ярлык стартуют с другим CWD.

### 1.3 Миграции применяются на старте

Сейчас [migrate.ts](apps/api/src/db/migrate.ts) — отдельный tsx-скрипт, указывающий в `src/`.

- в `NxAppWebpackPlugin` добавить `assets: [{ input: 'src/db/migrations', output: 'migrations' }]`
  (сейчас `assets: []`);
- вызывать `migrate()` в начале `bootstrap()` на singleton-соединении из
  [client.ts](apps/api/src/db/client.ts) (оно открывается на верхнем уровне модуля —
  порядок импортов в `main.ts` это уже учитывает); `migrationsFolder` — от `__dirname`;
- `pnpm db:migrate` остаётся для dev.

### 1.4 Скрипты запуска

```
pnpm dev        # разработка: web+api параллельно в одном терминале, hot reload
pnpm build:app  # сборка web + api в dist/
pnpm start:app  # запуск собранного: node dist/apps/api/main.js, один порт 3000
```

`pnpm dev` — через `nx run-many -t serve --parallel=2` (nx уже умеет, новых зависимостей
не надо). `start:api` и `start` оставить как есть, чтобы ничего не сломать.

### 1.5 Фоновый автозапуск на Mac + ярлык

`scripts/install-service.sh` ставит launchd-агент (`~/Library/LaunchAgents/…portfolio.plist`):
`RunAtLoad` + `KeepAlive`, рабочая директория и env (`DATA_DIR`, `NODE_EXTRA_CA_CERTS`,
`TBANK_TOKEN` из `.env`) заданы явно, логи в `~/Library/Logs/`.

Итог повседневного использования: приложение всегда живёт в фоне, открывается закладкой
http://localhost:3000 (или ярлыком «Add to Dock» из Chrome — выглядит как отдельное приложение).

Плюс `pnpm app:update` = `build:app` + `launchctl kickstart -k` — обновить после `git pull`.
Скрипт удаления сервиса — там же.

### 1.6 Документация

Раздел «Запуск» в [README.md](README.md): два режима (пользоваться / разрабатывать),
установка сервиса, обновление, где лежит БД, как сделать бэкап. Обновить `.env.example`.

Бэкап: `data/` — обычная папка, но включён WAL ([client.ts](apps/api/src/db/client.ts)),
поэтому копировать `.sqlite` на живой базе нельзя — маленький скрипт через `VACUUM INTO`.

---

## Этап 2 — Переезд на сервер (когда понадобится, код не переписывается)

Артефакт Этапа 1 уже самодостаточен, остаётся упаковать:

1. **Dockerfile** (multi-stage, `node:22-bookworm-slim` — не alpine, `better-sqlite3` под musl
   проблемный) + `docker-compose.yml`: том `./data:/data`, `restart: unless-stopped`.
   Для списка runtime-зависимостей включить `generatePackageJson: true` в prod-сборке —
   он раньше работал, образец лежит в `dist/apps/api/package.json`.
2. **Где хостить** (решение обратимое, откладывается): мини-ПК/старый ноут дома, NAS с Docker,
   или VPS в РФ (~200–500 ₽/мес). Важно: T-Invest и MOEX стабильнее отвечают с российского IP,
   а Render/Railway/Fly.io дают эфемерную ФС — SQLite там требует платного диска.
   Vercel/Netlify не подходят в принципе.
3. **Доступ снаружи** — Tailscale (бесплатно, без белого IP и проброса портов) до тех пор,
   пока нет авторизации. Публичный URL — только вместе с гейтом (Caddy + HTTPS + basic-auth).

## Этап 3 — Регистрация и мультипользовательность

Отдельный крупный этап: авторизация (Better Auth или сессии Nest), `user_id` во все
7 таблиц [schema.ts](apps/api/src/db/schema.ts), пересмотр уникальности снимков
(`portfolio_snapshots` сейчас ключуется одной лишь датой — однопользовательское допущение),
при росте — PostgreSQL. Сейчас под это специально ничего не строим (YAGNI); Этапы 1–2
ему не мешают: путь БД уже через env, схема изолирована в Drizzle, расчёты в `libs/core`
не знают ни о пользователях, ни о транспорте.

---

## Файлы

Изменяются: [apps/api/src/main.ts](apps/api/src/main.ts),
[apps/api/src/db/db-path.ts](apps/api/src/db/db-path.ts),
[apps/api/src/load-env.ts](apps/api/src/load-env.ts),
[apps/api/webpack.config.js](apps/api/webpack.config.js),
[package.json](package.json), [.env.example](.env.example), [README.md](README.md).

Создаются: `scripts/install-service.sh`, `scripts/uninstall-service.sh`, скрипт бэкапа.

Не трогаем: `apps/web/**`, `libs/**`, схему БД. Отдельно отмечу:
[index.html](apps/web/src/index.html) тянет Roboto и Material Icons с `fonts.googleapis.com` —
без интернета иконки поедут; self-hosting шрифтов вынесу как опциональный пункт, не блокер.

## Проверка

1. `pnpm lint && pnpm test` — регрессий нет.
2. Dev-режим жив: `pnpm dev` поднимает оба процесса, hot reload работает, :4200 проксирует на :3000.
3. `pnpm build:app && pnpm start:app` → http://localhost:3000 отдаёт SPA; deep-link
   (например `/operations`) с прямой перезагрузкой страницы не даёт 404.
4. Запуск из **другой** директории (`cd ~ && node …/dist/apps/api/main.js`) работает —
   БД, `.env` и сертификат находятся.
5. Миграции применились сами: временно указать `DATA_DIR` на пустую папку, проверить логи.
6. `scripts/install-service.sh` → приложение доступно после `launchctl kickstart`,
   переживает logout/login; `app:update` подхватывает новую сборку.
7. В UI: список операций, дашборд, `POST /api/quotes/refresh` (MOEX/ЦБ/Binance),
   `GET /api/import/tbank/status` при заданном `TBANK_TOKEN` — подтверждает, что сертификат
   Минцифры подхватился в фоновом сервисе.
8. Импорт xlsx ~5 МБ — проверка нового `bodyLimit`.

Шаги 2–8 выполняете вы по чек-листу; UI кликами я не проверяю
(см. [feedback_no_self_verify_browser](/Users/krisfeminova/.claude/projects/-Users-krisfeminova-projects-investment-portfolio/memory/feedback_no_self_verify_browser.md)).