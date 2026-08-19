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
```

Версия сборки — `<версия upstream>-magnit.<N>`, где `N` берётся из `corp/version` или env `CORP_BUILD`.
Скрипт печатает sha256 каждого артефакта. Публикация в GitHub Releases — только с явным `--publish`.

Без `CORP_HUB_URL` скрипт печатает предупреждение и собирает ванильную сборку.

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
