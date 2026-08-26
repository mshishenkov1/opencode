# corp/ — корпоративный слой OpenCode (Magnit)

Закрытый форк `anomalyco/opencode`. Ветка `corp/i4-sso-connectors`, база — upstream `v1.17.9`.

Всё, что добавлено сверх upstream, лежит здесь и в каталогах `packages/*/src/corp/**`.
Правки самих файлов upstream минимальны и перечислены в [`patches.md`](./patches.md).

## Что даёт корпоративная сборка

1. **Вход по SSO одним экраном** — браузер + код + выбор команды; постоянный ключ LiteLLM
   сохраняется в auth-store как запись провайдера `magnit_prod` (S-A*).
2. **Витрина коннекторов** `/connectors` — карточки корпоративных MCP-серверов из Hub, подключение
   «в 2 клика» через штатный MCP-OAuth OpenCode, управление правами и отключение (S-V*, S-T*, S-D*).
3. **Корпоративные умолчания из бинарника** — адрес Hub, провайдер, модель, `autoupdate:false`
   (S-C*), с наименьшим приоритетом: пользовательский и проектный конфиг их перекрывают.
4. **Русский язык по умолчанию** в Desktop/web и на корп-экранах TUI (S-I*).

## Состав каталога

| Путь | Назначение |
|---|---|
| `config/opencode.corp.json` | Эталонный корп-конфиг; попадает в бинарник как build-константа `OPENCODE_CORP_CONFIG` |
| `docs/spec.md` | Спецификация I-4 (74 правила, факты F1–F32, решения D-1…D-12) |
| `docs/acceptance-criteria.yaml` | Критерии приёмки AC-01…AC-121 |
| `build.ts` | Сборка CLI и Desktop с корп-константами и версией `<upstream>-magnit.<N>` |
| `upstream-sync.sh` | Rebase на новый тег upstream + typecheck + тесты + отчёт по `patches.md` |
| `patches.md` | Реестр правок upstream-файлов |
| `plugin/` | Зарезервировано под корп-плагины (в I-4 пусто, см. D-1) |
| `version` | Номер `N` корп-сборки (`1.17.9-magnit.<N>`) |
| `upstream-base` | Базовый тег upstream для `upstream-sync.sh` и реестра правок |

## Ванильный режим

Корпоративные возможности включаются **одним** условием — известен адрес Hub (S-C5):

1. флаг `--hub <URL>` (только для команд `opencode corp *`);
2. переменная окружения `OPENCODE_CORP_HUB_URL`;
3. build-константа `OPENCODE_CORP_HUB_URL` (задаётся при сборке из env `CORP_HUB_URL`).

Если адрес неизвестен — корп-роуты отвечают `501 {"error":"corp_disabled"}`, корп-команды и корп-экраны
не регистрируются, first-run открывает upstream-список провайдеров. Поведение бинарника совпадает
с upstream (S-C6).

## Сборка

```sh
# корпоративная сборка CLI под все целевые платформы
CORP_HUB_URL=https://hub.magnit.ru CORP_BUILD=1 bun run corp/build.ts

# только текущая платформа
CORP_HUB_URL=https://hub.magnit.ru bun run corp/build.ts --targets darwin-arm64

# Desktop (mac-arm64 на macOS, win-x64 на Windows-стенде или в CI)
CORP_HUB_URL=https://hub.magnit.ru bun run corp/build.ts --desktop --skip-cli

# отладочная сборка Desktop под именем «OpenCode Dev» и с отдельным идентификатором
CORP_HUB_URL=https://hub.magnit.ru bun run corp/build.ts --desktop --skip-cli --channel dev
```

Версия сборки — `<версия upstream>-magnit.<N>`, где `N` берётся из `corp/version` или env `CORP_BUILD`.
Скрипт печатает sha256 каждого артефакта. Публикация в GitHub Releases — только с явным `--publish`.

Без `CORP_HUB_URL` скрипт печатает предупреждение и собирает ванильную сборку.

### Источники обновлений

Оба адреса приходят из окружения сборки и в репозитории не хранятся; без адреса обновление
не выполняется вовсе — «нет адреса» означает «нет обновления», а не «спросить у апстрима» (D-24, D-34).

| Переменная | Что задаёт | Без неё |
|---|---|---|
| `CORP_DESKTOP_UPDATE_URL` | фид автообновления Desktop (`publish` канала `magnit`, build-константа `OPENCODE_CORP_UPDATE_URL`) — S-B11 | `app-update.yml` в бандл не попадает, апдейтер выключен целиком |
| `CORP_CLI_UPDATE_URL` | источник явного `opencode upgrade` (build-константа `OPENCODE_CORP_CLI_UPDATE_URL`) — S-B14 | `opencode upgrade` не делает ни одного сетевого запроса: печатает, что обновление выполняется централизованно, и завершается кодом `1` |

Целевая версия CLI берётся из `GET <CORP_CLI_UPDATE_URL>/latest` (JSON `{version}`), артефакт — из
`<CORP_CLI_UPDATE_URL>/<версия>/opencode-<os>-<arch>.zip`. `api.github.com`, `registry.npmjs.org`,
`formulae.brew.sh`, `community.chocolatey.org` и `raw.githubusercontent.com` не участвуют ни на одном
шаге. Каталог кеша обновлений Desktop у канала `magnit` свой — `opencode-magnit-desktop-updater`
(S-B13): он выводится из `extraMetadata.name`, а не из `appId` или `productName`.

### Канал сборки (`--channel`)

`--channel <канал>` (или env `OPENCODE_CHANNEL`) уходит в сборку как `OPENCODE_CHANNEL`.
**По умолчанию `latest`** — канал раздачи. Раньше канал не задавался явно (`magnit`), и Desktop
молча собирался как отладочный «OpenCode Dev».

| `--channel` | Канал Desktop | Имя приложения | Идентификатор | Веб-UI |
|---|---|---|---|---|
| `latest` (по умолчанию) | `magnit` | `OpenCode Magnit` | `ai.opencode.desktop.magnit` | режим раздачи, без бейджа DEV |
| `magnit` | `magnit` | `OpenCode Magnit` | `ai.opencode.desktop.magnit` | режим раздачи, без бейджа DEV |
| `dev` | `dev` | `OpenCode Dev` | `ai.opencode.desktop.dev` | dev-режим |
| `beta` | `beta` | `OpenCode Beta` | `ai.opencode.desktop.beta` | dev-режим |

У CLI и Desktop канал раздачи называется по-разному: `latest` у `@opencode-ai/script`, `magnit` у
`electron-builder`. `corp/build.ts` переводит `latest` → `magnit` для шагов Desktop. Неизвестный
канал — ошибка сборки, а не молчаливый откат в `dev` (BUG-I4-003).

Смена канала меняет каталог данных Desktop-приложения и имя файла БД CLI (`opencode.db` для
`latest`), поэтому канал задаётся явно и не меняется от сборки к сборке.

Публикация из `electron-builder` запрещена (`--publish never`): релиз собирает только `--publish`
этого скрипта (S-B4). Автообновление CLI выключено корп-умолчанием `autoupdate: false` (S-C3);
явный `opencode upgrade` ходит только на `CORP_CLI_UPDATE_URL`, а без него отказывает (S-B14).

Автообновление Desktop включено только при заданном `CORP_DESKTOP_UPDATE_URL` (S-B11):
`UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && !!UPDATE_URL`. Без переменной блок
`publish` канала `magnit` не появляется, `app-update.yml` в бандл не попадает и обновлений нет
вовсе. Фид ванильного апстрима в корпоративный бандл не попадает: это проверяет
`corp/verify-desktop-bundle.ts` (AC-149, AC-153).

### Что делает `--desktop`

`bun run prebuild` (иконки и metainfo канала + сборка встроенного сервера `script/build-node.ts`) →
`bun run build` (electron-vite: main, preload, веб-UI) → `package:mac` / `package:win`. Первые два шага
обязательны: electron-builder только упаковывает готовый `out/` и без них падает на
«Application entry file out/main/index.js was not found». Артефакты — в `packages/desktop/dist`.

Архитектуры macOS задаются флагами `--arm64` и `--x64`; без них собирается архитектура раннера.
Обе архитектуры собираются **одним** вызовом: electron-builder пишет один фид `magnit-mac.yml` со
списком `files` для arm64 и x64. Два раздельных вызова дали бы два фида, из которых на сервере
останется последний.

### Цепочка релиза (S-B16)

```
upstream-sync.yml  → мерж «corp: слить upstream <тег>» в corp/**
corp-release.yml   → N = 1 при смене версии upstream, иначе N+1 → тег v<upstream>-magnit.<N>
corp-ci.yml (тег)  → build-cli + build-desktop (mac arm64+x64, проверка бандлов и фида)
                   → publish (внутренний сервер) + release (черновик GitHub Release, резерв)
```

Раскладка внутреннего сервера (`--publish --publish-to internal`, адрес записи —
`CORP_ARTIFACTS_ENDPOINT`, учётные данные — `CORP_ARTIFACTS_TOKEN` либо
`CORP_ARTIFACTS_USER`/`CORP_ARTIFACTS_PASSWORD`):

| Объект | Адрес |
|---|---|
| Фид Desktop | `<CORP_DESKTOP_UPDATE_URL>/magnit-mac.yml` |
| Артефакты Desktop | `<CORP_DESKTOP_UPDATE_URL>/<имя файла>` (плоско) |
| Версия CLI | `<CORP_CLI_UPDATE_URL>/latest` — JSON `{"version": "…"}` |
| Архив CLI | `<CORP_CLI_UPDATE_URL>/<версия>/opencode-<os>-<arch>.zip` |

Порядок выкладки: **сначала артефакты, потом фиды**. Клиент, опросивший фид в момент выкладки,
обязан получить либо старую версию целиком, либо новую целиком.

Windows-сборки Desktop в матрице тегов нет (решение заказчика, ревизия 1.10). Конфигурация NSIS в
`electron-builder.config.ts` не тронута: Windows вернётся флагом, а не восстановлением кода.

Корп-константы попадают в Desktop так же, как в CLI: `CORP_HUB_URL` и `corp/config/opencode.corp.json`
— в бандл встроенного сервера (`packages/opencode/script/build-node.ts`), `VITE_OPENCODE_CORP_HUB_URL`
— в веб-UI, версия S-B1 — через `OPENCODE_VERSION` и аргумент `-c.extraMetadata.version`
electron-builder (сам `packages/desktop/package.json` не правится).

## Локальная дымовая проверка

```sh
# поднять мок Hub и прогнать вход/статус/каталог без обращения к реальным системам
bun run corp/smoke.ts
```

Скрипт поднимает HTTP-мок Hub на `127.0.0.1` (маршруты `/cli/*`, `/api/*`, `/health`), запускает
`opencode corp status --hub …` и `opencode corp login --hub …` в изолированных `XDG_*`-каталогах
и проверяет коды выхода и вывод.

## Синхронизация с upstream

```sh
bun run --bun ./corp/upstream-sync.sh v1.18.0
```

Скрипт делает `git fetch upstream --tags`, проверяет чистое рабочее дерево, ребейзит ветку на тег,
ставит зависимости, гоняет `bun run typecheck` и тесты пакетов `opencode`/`tui`/`app` и печатает,
какие из перечисленных в `patches.md` файлов затронул апдейт. Ничего не пушит.

## Тесты

```sh
cd packages/opencode && bun test src/corp
cd packages/app && bun test
```
