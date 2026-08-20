# Спецификация I-4: корпоративный форк OpenCode — вход по SSO, витрина коннекторов, умолчания, сборки

Ревизия 1.4, 2026-08-20 (ревизия 1.3 — 2026-08-20, ревизия 1.2 — 2026-08-20,
ревизия 1.1 — 2026-08-20, базовая ревизия 1 — 2026-08-19).
Ветка `corp/i4-sso-connectors`. База — upstream `anomalyco/opencode` v1.17.9.

## Ревизия 1.4 (2026-08-20) — ИЗМЕНЕНИЕ КОНТРАКТА ПО `BUG-I1-002`

> **Это изменение контракта, а не уточнение формулировок.** Спецификация переставала соответствовать
> реальности: корпоративный LiteLLM при SSO не возвращает адрес электронной почты, поэтому Hub не
> знает email пользователя и присылает поле `email` отсутствующим или `null`. Прежняя редакция §3.1,
> §3.2, S-A6, S-A10, S-A11a описывала email как всегда присутствующую строку; реализация форка
> (`packages/opencode/src/corp/schema.ts`) объявила его обязательным и не допускающим `null`, из-за
> чего ready-ответ Hub отбрасывался целиком с ошибкой `hub_invalid_response`, вход не завершался,
> а уже выданный ключ терялся безвозвратно (сессия входа на Hub к этому моменту удалена).
> Воспроизведено на живом стенде дважды (`opencode-mcp-hub/bugs/BUG-I1-002.json`).

Источник: `BUG-I1-002` (severity `critical`, живая проверка входа 2026-08-20).

| Что | Изменение | Состояние кода |
|---|---|---|
| **§3.1** (таблица `/cli/poll`) | В ready-ответе объект пользователя — `user:{user_id, email?}`: обязателен только `user_id`, `email` может отсутствовать или быть `null` | схема требует строку — **подлежит исправлению** |
| **§3.2** (`GET /api/me`) | `{user_id, email?, key_kind, created_at}`: `email` необязателен и допускает `null` | схема требует строку — **подлежит исправлению** |
| **S-A1** (корп-роут `/corp/login/poll/:login_id`) | В ready-ответе наружу — `user:{user_id, email?}` | требует правки вместе со схемой |
| **S-A13** *(новое правило)* | Email пользователя — необязательное поле: контракт, обязанность клиента принимать ответ без email, и правило отображения «нет email → показываем `user_id`» для экрана входа, `corp login`, `corp status` и заголовка витрины | **не реализовано** |
| **S-A6** (шаг 4), **S-A10**, **S-A11**, **S-A11a** | Формулировки «печатает `user.email`» заменены на отображение по S-A13; в таблицу S-A11a добавлена строка для неизвестного email | требует правки кода |
| **S-V2** (уточнено) | Правило «ответ, не соответствующий схеме, отбрасывается целиком» сохраняется, но отсутствие `email` и `email: null` схеме **соответствуют** и отбрасыванием не являются | требует правки схемы |
| **D-19** *(новое решение)* | Hub не обязан присылать email; источник истины о пользователе — `user_id` | — |
| **AC-127 … AC-131** *(новые критерии)* | Приём ready с `email: null`, приём ready без поля `email`, отображение `user_id` на экране входа и в `corp login`, в `corp status`, в заголовке витрины | новые |

Не изменено в этой ревизии: правила витрины (S-V1, S-V3…S-V13), TUI (S-T*), Desktop/web (S-D*),
локализация (S-I*), сборка и CI (S-B*), тесты (S-Q*) — кроме прямо перечисленного выше.
Ни один существующий идентификатор `S-*`/`AC-*` не переименован и не удалён; ни один порог
и ни одно требование, не относящееся к email, не ослаблены.

---

## Ревизия 1.3 (2026-08-20) — ИЗМЕНЕНИЕ ТРЕБОВАНИЙ ЗАКАЗЧИКА

> **Это изменение требований, а не уточнение формулировок.** В отличие от ревизий 1.1 и 1.2, здесь
> меняется требуемое поведение системы: спецификация начинает требовать то, чего в коде сейчас нет.
> Реализация ветки на текущем HEAD расходится со спецификацией в двух местах (S-D2a/S-D2b и S-D4a) —
> расхождения помечены ниже как **подлежащие исправлению в коде**, поэтому ревизия 1.3 требует нового
> цикла реализации, тестирования и ревью.

Источник: заказчик (Мирослав), 2026-08-20. Ожидаемый пользовательский путь целиком:
скачал приложение → при первом входе **сразу** проходит корпоративную авторизацию → ключ модели
создаётся автоматически и модель подключается → в разделе **Home**, в боковой панели, **прямо над
пунктом «Настройки»**, постоянно виден пункт **«Коннекторы»**, открывающий витрину.

| Что | Изменение | Состояние кода |
|---|---|---|
| **S-D2** (переписано) | Витрина доступна тремя равноправными путями: постоянный пункт навигации (S-D2a/S-D2b), слэш-команда `/connectors`, палитра команд. Прежняя редакция S-D2 объясняла только выбор «диалог вместо URL-маршрута» и не требовала постоянного пункта навигации | путь (б) и (в) реализованы, путь (а) **отсутствует** |
| **S-D2a** *(новое правило)* | Развёрнутая боковая панель Home: строка «Коннекторы» с иконкой и подписью в том же нижнем блоке, что «Настройки»/«Помощь», **непосредственно над «Настройками»**; видна только при `enabled=true` от `GET /corp/status` | **не реализовано** — `packages/app/src/pages/home.tsx` (F33) корп-код не содержит вовсе |
| **S-D2b** *(новое правило)* | Свёрнутая иконочная панель: иконка «Коннекторы» **над шестерёнкой** с тултипом, те же условия видимости | **не реализовано** — `packages/app/src/pages/layout/sidebar-shell.tsx` (F34) корп-код не содержит вовсе |
| **S-D4** (уточнено) + **S-D4a** *(новое правило)* | Первый запуск: при `enabled=true` и `authenticated=false` экран входа по корпоративному SSO **открывается автоматически** один раз за запуск приложения; блок Getting Started остаётся запасным путём, но перестаёт быть единственным | **не реализовано** — сейчас единственное предложение войти это кнопка в Getting Started, которая при умолчаниях невидима (F36) |
| **S-A7** (уточнено) | Для Desktop/web «first-run» больше не означает «блок Getting Started»: условие сформулировано через ответ `GET /corp/status` и правило S-D4a | требует правки кода вместе с S-D4a |
| **S-I1** (дополнено) | Новый ключ локализации `corp.sidebar.connectors` (RU «Коннекторы», EN «Connectors») в обоих словарях | ключа нет |
| **S-Q9** (дополнено) | Тесты пункта навигации (обе панели, оба состояния корп-режима) и решения об автооткрытии входа | тестов нет |
| **D-4** (дополнено) | Решение «диалог, а не URL-маршрут» остаётся в силе, но больше **не** служит обоснованием отсутствия постоянного пункта навигации | — |
| **D-16, D-17, D-18** *(новые решения)* | Постоянный пункт навигации; имя иконки `mcp` и её добавление в набор v2; однократное автооткрытие экрана входа | — |
| **AC-124, AC-125, AC-126** *(новые критерии)* | Пункт в развёрнутой панели, иконка в свёрнутой панели, видимое сразу предложение войти | новые |

Не изменено в этой ревизии: контракты Hub (§3), корп-роуты (S-A1…S-A5), витрина как таковая (S-V*),
TUI (S-T*), сборка и CI (S-B*). Ни один существующий идентификатор `S-*`/`AC-*` не переименован и не
удалён; ни один порог не ослаблен.

---

## Ревизия 1.2 (2026-08-20)

Точечная документационная правка по `opencode-mcp-hub/reports/review-i4-2.json` (findings с
`assignee: spec`). Поведение системы **не меняется**: обе правки описывают уже реализованное и покрытое
тестами (AC-30, S-D8); идентификаторы `S-*`/`AC-*` не переименованы и не удалены, пороги и требования
не ослаблены. Код и тесты не затрагиваются, повторное ревью кода не требуется.

| Что | Изменение |
|---|---|
| **S-A1**, **S-A2**, **S-A9** | В таблицу корп-роутов добавлена строка `DELETE /corp/login/poll/:login_id` → `{cancelled}` (отмена входа, S-A9). Таблица объявлена инвентарём группы и по ней сверяются `packages/sdk/openapi.json` и SDK (`corp.login.cancel`) — реализованный роут не должен отсутствовать в инвентаре. В S-A2 дописано, что отмена удаляет запись из Map вместе с `poll_secret` и идемпотентна (`{cancelled:false}` для неизвестного `login_id`); в S-A9 добавлена ссылка на роут. |
| **S-A6** (шаг 2) | Названо, **кто** открывает браузер: серверная часть при обработке `POST /corp/login/start`, тем же механизмом, что MCP-OAuth (F15, S-D8); клиент браузер не открывает. Ссылка и код на экране — запасной путь и показываются **всегда**: клиентского признака «не удалось открыть» не существует. Прежняя формулировка «(открывается в браузере автоматически)» не называла исполнителя, из-за чего ручной прогон AC-24 (сценарий М-7) не мог отличить клиентское открытие от серверного. |

Требование автооткрытия `browser_url` (must_fix №3 ревью цикла 1) сохраняется — оно закрыто
реализацией, а не правкой спецификации. **AC-файл в этой ревизии не менялся**: AC-24 («браузер открыт
автоматически») остаётся верным и теперь однозначен через правило S-A6, на которое ссылается.

---

## Ревизия 1.1 (2026-08-20)

Точечная правка формулировок по итогам ревью `opencode-mcp-hub/reports/review-i4-1.json`
(раздел `ac_resolutions`) и раздела «Неоднозначности критериев» отчёта тестирования
`opencode-mcp-hub/reports/test-report-i4.md`. Правки **не меняют требуемое поведение системы**: ни одно
правило не ослаблено, ни один существующий идентификатор (`S-*`, `AC-*`) не переименован и не удалён.
Устраняются только расхождения между текстом критериев и правилами, на которые эти критерии ссылаются.

| Что | Изменение |
|---|---|
| **S-A11** | Раскрыт точный построчный контракт вывода `opencode corp status` (§5.3): формулировки строк перестают быть неявной договорённостью между CLI, тестами и дымовой проверкой CI. Причина — `BUG-I4-001` (расхождение регистра в `grep` дымовой проверки). Правило про код выхода не менялось. |
| **AC-33** | Цитируемые строки приведены к контракту S-A11 (`Доступность Hub: доступен (ok)`, `Корпоративный ключ: нет`); зафиксирован способ проверки — по подстрокам, из одного источника строк. |
| **AC-35** | Сценарий приведён к S-A11: при наличии ключа и недоступном Hub код выхода `0` (диагностическая команда не падает из-за временной недоступности сервера). Ужесточающее покрытие сохранено новым **AC-122**. |
| **AC-122** *(новый)* | Негативный сценарий: ключа нет → код выхода `1` (правило S-A11 «`1` иначе» остаётся проверяемым). |
| **AC-94** | Сценарий переписан на локаль вне списка поддерживаемых (`sw-KE`): корп-умолчание `ru` применяется только когда ни один поддерживаемый matcher не совпал. Прежняя формулировка (`fr-FR` → `ru`) противоречила S-I2, на который сама ссылалась. |
| **AC-123** *(новый)* | Приоритет `navigator.languages` при поддерживаемой локали (`fr-FR` → `fr`) — вторая половина правила S-I2 теперь тоже покрыта. |

Не изменено в этой ревизии: **S-A6 / AC-24** (автозапуск браузера на экране входа Desktop/web,
must_fix №3 ревью) — вопрос остаётся за ревью; спецификация продолжает требовать автооткрытие
`browser_url`.

---

Входы: требование `opencode-mcp-hub/examples/req-i4-opencode-fork.md` (F-01…F-13),
контекст продукта `opencode-mcp-hub/docs/req-mvp.md` rev 0.2 (§1.1, §6.1),
карта исходников `opencode-mcp-hub/docs/opencode-source-map.md`,
контракты Hub — `opencode-mcp-hub-i3/spec.md` (I-1 R-L*/R-A*/R-C*, I-3 R-O*/R-B*/R-P*),
каталог `opencode-mcp-hub/catalog.yaml`.

Пометки: **[проверено]** — прочитано в коде форка на текущем HEAD ветки (пути ниже абсолютны от корня
репозитория `opencode`); **[проверить]** — гипотеза, подтверждается при реализации/интеграции.

---

## 1. Назначение и границы

### 1.1. Назначение

Корпоративная сборка OpenCode, в которой сотрудник:

1. при первом запуске входит через корпоративный SSO одним экраном (браузер + код + выбор команды),
   получает постоянный ключ LiteLLM и работающую модель без ручной настройки;
2. открывает витрину коннекторов (TUI, Desktop, `opencode web`) — в Desktop/web постоянным пунктом
   «Коннекторы» в боковой панели Home (над «Настройками»), слэш-командой `/connectors` или из палитры
   команд (S-D2) — видит карточки корпоративных MCP-серверов из Hub и подключает нужный «в 2 клика»
   (OAuth в браузере);
3. управляет правами и отключением из той же витрины;
4. получает корпоративные умолчания (адрес Hub, провайдер, лимиты, `autoupdate:false`) из бинарника.

Наши изменения — минимальный, отделимый набор коммитов с префиксом `corp:` поверх upstream.

### 1.2. В объёме

- Корпоративный слой конфигурации из build-констант (S-C*).
- Вход по SSO: серверные корп-роуты, экраны TUI и Desktop/web, CLI `opencode corp login|status` (S-A*).
- Витрина коннекторов: клиент Hub, кэш каталога, модель состояния, действия (S-V*), экраны TUI (S-T*)
  и Desktop/web (S-D*).
- Русский по умолчанию: словари `packages/app/src/i18n/{ru,en}.ts` + минимальный словарь TUI (S-I*).
- Сборки CLI и Desktop, версия `upstream+-magnit.N`, CI, `corp/upstream-sync` (S-B*).
- Тесты рядом с модулями, моки HTTP к Hub, smoke сборки (S-Q*).

### 1.3. Вне объёма

- Реализация Hub, LiteLLM, ТЭГ-MCP (итерации I-1/I-3, отдельные репозитории).
- Установщики, CA-bundle, портал раздачи (R-13 req-mvp).
- Подпись сборок (Apple Developer ID / Authenticode) — решение ИБ, вне репозитория (открытый вопрос §4.3
  требования, см. §9, D-9).
- Локализация TUI целиком (только наши экраны).
- Замена/переписывание upstream-диалога `/mcps` — он продолжает работать как есть.

---

## 2. Факты о коде форка [проверено]

Все пути — от `/Users/miroslavshishenkov/Documents/opencode`.

### 2.1. TUI (`packages/tui`)

- **F1.** Команды и слэш-имена — `packages/tui/src/app.tsx`: константа `appBindingCommands`
  (строки ~100–131, список имён вида `mcp.list`, `provider.connect`, `opencode.status`) и фабрика
  `appCommands = createMemo(() => [...])` (строка ~545 и далее). Элемент команды — объект
  `{ name, title, category, slashName?, slashAliases?, hidden?, suggested?, run() }`; `run()` обычно
  делает `dialog.replace(() => <Dialog… />)`. Команда `mcp.list` (`title: "Toggle MCPs"`,
  `slashName: "mcps"`) — строки ~672–680; `provider.connect` (`slashName: "connect"`,
  `suggested: !connected()`) — строки ~724–732.
- **F2.** First-run «нет провайдера» — `packages/tui/src/app.tsx`, строки ~525–535:
  ```
  createEffect(on(() => sync.status === "complete" && sync.data.provider.length === 0,
    (isEmpty, wasEmpty) => { if (!isEmpty || wasEmpty) return; dialog.replace(() => <DialogProviderList />) }))
  ```
  Это единственная точка автозапуска экрана подключения провайдера в TUI.
- **F3.** Диалог MCP — `packages/tui/src/component/dialog-mcp.tsx` (85 строк): список из `sync.data.mcp`,
  `description` = сырой статус, `footer` = `Status()` (`✓ Enabled` / `○ Disabled` / `⋯ Loading`),
  единственное действие `dialog.mcp.toggle` → `local.mcp.toggle(name)` → `sdk.client.mcp.status()` →
  `sync.set("mcp", …)`. Ни OAuth, ни запись конфига здесь нет.
- **F4.** Тумблер — `packages/tui/src/context/local.tsx`, строки ~504–519: `mcp.isEnabled` = статус
  `connected`; `mcp.toggle` = `connected → sdk.client.mcp.disconnect({name})`, иначе
  `sdk.client.mcp.connect({name})`. Конфиг не пишется — **изменение только runtime**.
- **F5.** Методы аутентификации провайдера в TUI берутся из `sync.data.provider_auth[providerID]`
  (`packages/tui/src/context/sync.tsx`, строка 516: `sdk.client.provider.auth(...)`), диспетчеризация —
  `packages/tui/src/component/dialog-provider.tsx`, строки 148–216: при отсутствии методов подставляется
  `[{type:"api", label:"API key"}]`; `type:"oauth"` → `sdk.client.provider.oauth.authorize` →
  `CodeMethod` или `AutoMethod`; `type:"api"` → `ApiMethod` (ввод ключа) → `sdk.client.auth.set({providerID,
  auth:{type:"api", key}})` (строки 396–403).
- **F6.** `AutoMethod` (`dialog-provider.tsx`, строки 233–303) рисует **только** ссылку
  (`props.authorization.url`), текст `instructions` и строку «Waiting for authorization...», а в `onMount`
  один раз вызывает `sdk.client.provider.oauth.callback(...)`. Промежуточного взаимодействия с
  пользователем между `authorize()` и `callback()` в этом экране нет.

### 2.2. Desktop/web (`packages/app`, `packages/desktop`)

- **F7.** Диалог MCP — `packages/app/src/components/dialog-select-mcp.tsx`: `statusLabels` (строки 9–15)
  сопоставляют статусы ключам i18n `mcp.status.*`; список + `Switch`; ошибки для `failed` и
  `needs_client_registration`.
- **F8.** Тумблер — `packages/app/src/context/global-sync/mcp.ts` (`toggleMcp`): маршрутизация по статусу
  `connected→disconnect`, `needs_auth→authenticate`, `disabled|failed|needs_client_registration→connect`,
  затем `refresh`. Вызов — `packages/app/src/context/mcp.ts` (`useMcpToggle`, tanstack mutation).
- **F9.** Команды — `packages/app/src/context/command.tsx`: `register(key, cb)` (строки ~394–400),
  элемент `{ id, title, description?, category?, keybind?, slash?, onSelect(source) }`, каталог
  персистится в `command.catalog.v1` (строки 251–262). Сессионные команды —
  `packages/app/src/pages/session/use-session-commands.tsx` (`mcpCmds()`, `mcp.toggle`, `slash: "mcp"`,
  `keybind: "mod+;"`, строки ~531–539; `chooseMcp()` строки 258–261). Глобальные — `layout.tsx`
  (`command.register("layout", …)` строка 993).
- **F10.** `layout.tsx`: `connectProvider()` (строки ~1205–1211) лениво импортирует
  `@/components/dialog-select-provider`; блок Getting Started (строки ~2295–2320) виден при
  `providers.all().size > 0 && providers.paid().length === 0` и содержит кнопку с `onClick={connectProvider}`.
- **F11.** Маршруты приложения — `packages/app/src/app.tsx`, строки 451–460: `/`, `/:dir`,
  `/:dir/session/:id?`, `/new-session`. Статического сегмента верхнего уровня, кроме `/new-session`, нет;
  `/:dir` — динамический сегмент, покрывающий любой одиночный путь.
- **F12.** Desktop — Electron: `packages/desktop/package.json` (`package:mac|win|linux` →
  `electron-builder --config electron-builder.config.ts`), `packages/desktop/electron-builder.config.ts`
  (`artifactName: "opencode-desktop-${os}-${arch}.${ext}"`, строка 43; `appId` по каналу из
  `process.env.OPENCODE_CHANNEL`, строки 30–40).
- **F33.** Раздел Home — `packages/app/src/pages/home.tsx`, маршрут `/` (F11) внутри визуального
  `Layout`. Собственная боковая колонка — компонент `HomeProjectColumn` (`<aside>`, строки ~437–522);
  её нижний блок `<div class="mt-4 flex min-w-0 flex-col gap-1">` (строки 502–519) содержит ровно две
  кнопки: «Настройки» (`IconV2 name="settings-gear" size="small"`, `onClick={props.openSettings}`,
  подпись `sidebar.settings`) и «Помощь» (`IconV2 name="help"`, `onClick={props.openHelp}`, подпись
  `sidebar.help`). Классы строки и подписи — константы `HOME_PROJECT_NAV_ROW` и
  `HOME_PROJECT_NAV_LABEL` (строки 56–57). Обработчики приходят пропсами из `Home` (строки 362–363),
  где уже есть `useCommand()` (строка 135), `useDialog()` и `useLanguage()`. Корп-кода в файле нет.
- **F34.** Свёрнутая иконочная панель — `packages/app/src/pages/layout/sidebar-shell.tsx`, компонент
  `SidebarContent`: рельса `w-16` (`data-component="sidebar-rail"`), её нижний блок (строки 92–110) —
  `IconButton icon="settings-gear"` внутри `TooltipKeybind` (`settingsLabel`, `settingsKeybind`,
  `onOpenSettings`) и `IconButton icon="help"` внутри `Tooltip` (`helpLabel`, `onOpenHelp`). Компонент
  презентационный: все подписи и обработчики приходят пропсами из `layout.tsx` (строки ~2384–2408), он
  же рендерится для мобильного выдвижного меню (`sidebarContent(true)`). `IconButton` использует
  **legacy**-набор иконок `@opencode-ai/ui/icon`. Корп-кода в файле нет.
- **F35.** Наборов иконок два. Legacy — `packages/ui/src/components/icon.tsx` (~100 имён, среди них
  `mcp`, `link`, `providers`, `settings-gear`, `help`). Набор v2 — `packages/ui/src/v2/components/icon.tsx`,
  ровно 16 имён: `edit`, `folder-add-left`, `grid-plus`, `help`, `sidebar-right`, `status`,
  `status-active`, `magnifying-glass`, `menu`, `plus`, `settings-gear`, `chevron-down`, `close`,
  `xmark-small`, `outline-chevron-down`, `outline-dots`. Имени для коннекторов/MCP в наборе v2 нет, а
  неизвестное имя компонент **молча** подменяет на `plus` (`iconName()` в `Icon`) — опечатка или
  отсутствующий глиф не дают ни ошибки типов (`name: keyof typeof icons | (string & {})`), ни ошибки
  в рантайме.
- **F36.** Фактическое состояние первого запуска Desktop/web: `layout.sidebar.opened` по умолчанию
  `false` (`packages/app/src/context/layout.tsx`, строка ~254, значение персистится); панель с блоком
  Getting Started живёт внутри `nav[data-component="sidebar-nav-desktop"]` с классом `hidden xl:block`
  (не существует при ширине окна < 1280 px), при закрытой панели помечается `inert`/`aria-hidden` и
  перекрывается основной областью (`--main-left: 4rem`, основная область `z-20` над `nav` `z-10`), а
  кнопка «Не сейчас» скрывает блок навсегда (`store.gettingStartedDismissed`). `GET /corp/status`
  отдаёт `authenticated = (запись auth-store magnit_prod существует)`
  (`server/routes/instance/httpapi/handlers/corp.ts`, строки 190–199).

### 2.3. Сервер (внутри бинарника)

- **F13.** HTTP API MCP — `packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts`,
  `McpPaths` (строки 32–39): `GET /mcp`, `POST /mcp`, `POST /mcp/:name/auth`,
  `POST /mcp/:name/auth/callback`, `POST /mcp/:name/auth/authenticate`, `DELETE /mcp/:name/auth`,
  `POST /mcp/:name/connect`, `POST /mcp/:name/disconnect`.
- **F14.** Статусы MCP — `packages/opencode/src/mcp/index.ts`, строки 95–119:
  `connected | disabled | failed{error} | needs_auth | needs_client_registration{error}`.
- **F15.** `MCP.authenticate` (строки ~813–869) = `startAuth` → `open(authorizationUrl)` (при неудаче
  событие `BrowserOpenFailed`) → `McpOAuthCallback.waitForCallback` → сверка `oauthState` → `finishAuth`.
  `startAuth` (строки ~748–812) берёт `oauth` из конфига сервера: `clientId`, `clientSecret`, `scope`,
  `redirectUri`/`callbackPort`; при отсутствии `clientId` работает автообнаружение и DCR.
- **F16.** OAuth callback — `packages/opencode/src/mcp/oauth-provider.ts`: `OAUTH_CALLBACK_PORT = 19876`,
  `OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"`, по умолчанию
  `http://127.0.0.1:19876/mcp/oauth/callback`. Токены — `packages/opencode/src/mcp/auth.ts`,
  `Global.Path.data/mcp-auth.json`, права `0o600`.
- **F17.** `MCP.connect` (строка ~610) = `createAndStore(name, {...mcp, enabled:true})` — правит только
  `s.config` в памяти; `disconnect` (строка ~615) закрывает клиент и ставит `{status:"disabled"}`.
  **Персиста конфига нет.**
- **F18.** Схема `mcp.<name>` (v1, пользовательский конфиг) — `packages/core/src/v1/config/mcp.ts`:
  `Remote = { type:"remote", url, enabled?, headers?, oauth?: OAuth|false, timeout? }`,
  `OAuth = { clientId?, clientSecret?, scope?, callbackPort?, redirectUri? }` (**camelCase**).
- **F19.** Имя MCP-инструмента для `permission`/`tools` — `packages/opencode/src/mcp/index.ts` (строка
  ~646): `key = McpCatalog.sanitize(clientName) + "_" + McpCatalog.sanitize(mcpTool.name)`, где
  `packages/opencode/src/mcp/catalog.ts` строка 110: `sanitize = (v) => v.replace(/[^a-zA-Z0-9_-]/g, "_")`.
  Дефис **сохраняется**: alias `gitlab-platform` даёт `gitlab-platform_create_issue`. Это закрывает
  открытый вопрос §4.2 требования (см. §9, D-8).
- **F20.** Слои конфигурации — `packages/opencode/src/config/config.ts`, `loadInstanceState` (строка ~313):
  `let result: Info = {}` → цикл по auth-записям `type:"wellknown"` (строки 355–394: `<url>/.well-known/opencode`,
  затем `remote_config` с заголовками) → `merge(Global.Path.config, global)` → `Flag.OPENCODE_CONFIG` →
  файлы проекта. Каждый следующий `merge` перекрывает предыдущий, поэтому **слой, добавленный до цикла
  well-known, имеет наименьший приоритет**.
- **F21.** Запись конфига — там же: `update` (строка ~623) пишет `<instance dir>/config.json`;
  `updateGlobal` (строка ~636) пишет `globalConfigFile()` = первый существующий из
  `opencode.jsonc | opencode.json | config.json` в `Global.Path.config` (строка ~139), для `.jsonc` —
  точечный патч `patchJsonc` (строка ~149), затем `invalidate()`; возвращает `{ info, changed }`.
- **F22.** Auth-store — `packages/opencode/src/auth/index.ts`: `Global.Path.data/auth.json`, права `0o600`,
  варианты записи `Oauth | Api{type:"api", key, metadata?} | WellKnown{type:"wellknown", key, token}`;
  `Auth.set(providerID, info)`. HTTP: `sdk.client.auth.set` (используется TUI, F5).
- **F23.** Plugin API — `packages/plugin/src/index.ts`: `Hooks = { dispose, event, config, tool, auth,
  provider, "chat.message", "chat.params", "chat.headers", "permission.ask", "command.execute.before",
  "tool.execute.before", "shell.env", "tool.execute.after", "experimental.chat.messages.transform" }`.
  **Хука для регистрации HTTP-маршрутов сервера нет.** `AuthHook.methods[].type = "oauth"|"api"`;
  `AuthOAuthResult = { url, instructions } & ({method:"auto", callback()} | {method:"code", callback(code)})`
  (строки 163–204) — промежуточных шагов диалога контракт не предусматривает.
  Реализация — `packages/opencode/src/provider/auth.ts`: `methods()` собирает хуки плагинов,
  `authorize()` вызывает `method.authorize(inputs)` и кладёт результат в `pending`, `callback()` вызывает
  `match.callback()` и при `"key" in result` делает `auth.set(providerID, {type:"api", key, metadata?})`
  (строки 200–210).
- **F24.** Флаги — `packages/core/src/flag/flag.ts`: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
  `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_CLIENT` и др.
- **F25.** Build-константы — `packages/opencode/script/build.ts`, блок `define` (строки ~189–197):
  `FFF_LIBC`, `OPENCODE_VERSION`, `OPENCODE_MODELS_DEV`, `OTUI_TREE_SITTER_WORKER_PATH`,
  `OPENCODE_WORKER_PATH`, `OPENCODE_CHANNEL`, `OPENCODE_LIBC`. Способ потребления —
  `packages/core/src/installation/version.ts`:
  ```
  declare const OPENCODE_VERSION: string
  export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
  ```
  Там же (строки ~205–215) — smoke-тест `dist/<name>/bin/opencode --version` для текущей платформы.
- **F26.** CLI — `packages/opencode/src/index.ts` (строки 81–103) собирает команды через `.command(X)`;
  образец группы — `packages/opencode/src/cli/cmd/mcp.ts`: `McpCommand = cmd({ command: "mcp", builder:
  (y) => y.command(McpAddCommand)…demandCommand() })`, подкоманды через `effectCmd`. Персист конфига там же:
  `addMcpToConfig` (строки ~423–439) — `modify(text, ["mcp", name], mcpConfig)` + `applyEdits`.
- **F27.** Пути — `packages/core/src/global.ts`: `Path.data = xdgData/opencode`, `Path.config =
  xdgConfig/opencode`, `Path.cache`, `Path.state`.

### 2.4. i18n

- **F28.** `packages/app/src/context/language.tsx`: `Locale` — union из 18 значений, включая `ru`;
  словари грузятся лениво (`loaders`, строки ~106–125), базовый — `en`; выбор локали:
  `const warm = readStoredLocale() ?? detectLocale()` (строка ~195), `detectLocale()` перебирает
  `navigator.languages` по `localeMatchers` и **возвращает `"en"`, если ничего не совпало** (строки ~163–176);
  `normalizeLocale(value)` возвращает `"en"` для неизвестного значения (строка ~178).
- **F29.** `packages/app/src/i18n/ru.ts` — 944 строки против 1046 в `en.ts` (не полный).
  `packages/app/src/i18n/parity.test.ts` — **не** тест полного паритета ключей: он проверяет ровно два
  ключа (`command.session.previous.unseen`, `command.session.next.unseen`) во всех не-английских словарях.
  Формулировка требования F-09 «тест паритета ключей проходит» относится именно к этому тесту.
- **F30.** В `packages/tui/src` словарей и i18n нет — строки захардкожены («Toggle MCPs», «✓ Enabled»).

### 2.5. Тесты и сборка

- **F31.** `packages/opencode/package.json` и `packages/tui/package.json`: `"test": "bun test --timeout
  30000 --only-failures"`; `packages/app/package.json`: `"test": "bun run test:unit && bun run
  test:virtualizer"`. `turbo.json` содержит задачи `opencode#test`, `@opencode-ai/app#test`,
  `@opencode-ai/ui#test` и общий `typecheck`.
- **F32.** Корень: `packageManager: "bun@1.3.14"`, `"typecheck": "bun turbo typecheck"`,
  `"test"` в корне запрещён (`echo 'do not run tests from root' && exit 1`).

---

## 3. Контракты взаимодействия с Hub

Клиент обращается к Hub **только с серверной стороны бинарника OpenCode** (см. D-1). Базовый адрес —
`hubUrl` (§4, S-C2). Аутентификация `/api/*` и `/remote-config` — `Authorization: Bearer <ключ провайдера
magnit_prod из auth-store>`.

### 3.1. Вход (I-1, R-L*)

| Вызов | Запрос | Ответы, которые обрабатывает клиент |
|---|---|---|
| `POST {hub}/cli/start` | `{client: "opencode/<версия> <os>-<arch>"}` | 200 `{login_id, poll_secret, browser_url, user_code, expires_in}`; 429 `rate_limited` (+`Retry-After`); 502 `litellm_unavailable`; 400 `invalid_request` |
| `GET {hub}/cli/poll/{login_id}` | заголовок `X-Hub-Poll-Secret: <poll_secret>` | 200 `{status:"pending"}` / `{status:"team_selection_required", teams:[{team_id, team_alias}]}` / `{status:"ready", key, key_kind:"persistent"\|"jwt", user:{user_id, email?}, team_id, expires_in?}`; 403 `forbidden`; 404 `login_expired`; 502 `litellm_unavailable` \| `litellm_invalid_response` |
| `POST {hub}/cli/poll/{login_id}/team` | `{team_id}` + `X-Hub-Poll-Secret` | 200 `{status:"pending"}`; 400 `invalid_request` \| `invalid_team`; 403; 404; 409 `team_selection_not_required` |

`poll_secret` **никогда** не покидает серверную часть бинарника (в UI не отдаётся, в логи не пишется).

В объекте `user` обязателен только `user_id`: поле `email` может отсутствовать или быть `null`
(S-A13, D-19). Ready-ответ без email — валидный ответ, который клиент принимает и по которому
сохраняет ключ (S-A3).

### 3.2. Каталог и подключения (I-1 R-A*, I-3 R-W*/R-B*)

| Вызов | Ответ, используемый витриной |
|---|---|
| `GET {hub}/api/me` | `{user_id, email?, key_kind, created_at}` — для `opencode corp status` и заголовка витрины; `email` необязателен и допускает `null` (S-A13) |
| `GET {hub}/api/catalog` | `{version, servers:[{alias, title, description, owner, contact, docs_url, status, mode, mcp_url, permission_model, auth_kind, connection:{status, preset, updated_at}}]}` |
| `GET {hub}/api/me/connections` | `[{alias, status, preset, groups, created_at, updated_at}]` |
| `PUT {hub}/api/me/connections/{alias}/permissions` | тело `{preset, groups?}` → 200 `{alias, status, preset, groups}`; 400/401/404 |
| `DELETE {hub}/api/me/connections/{alias}` | 200 `{alias, status:"not_connected"}`; 401/404 |

`connection.status ∈ {not_connected, connected, needs_reauth}`; `server.status ∈ {beta, ga, deprecated}`;
`mode ∈ {native, facade}`; `mcp_url` для `facade` уже равен `<hub>/mcp/<alias>` (Hub подставляет сам).
`permission_model` — `{kind:"header_groups", groups:[{id,title,preset}], always:[…]}` или
`{kind:"consent"|"tool_filter", presets:{…}}`; поле `header` наружу не отдаётся.

### 3.3. OAuth к MCP-серверу (I-3 R-O*)

Подключение выполняется **штатным MCP-OAuth-клиентом OpenCode** (F15/F16), без корп-кода в OAuth:

- `resource` — `mcp_url` карточки; обнаружение AS — `/.well-known/oauth-protected-resource/mcp/{alias}` и
  `/.well-known/oauth-authorization-server`; регистрация клиента — `POST {hub}/oauth/register` (DCR),
  далее `/oauth/authorize` (PKCE S256) и `/oauth/token`.
- Scope для `mode: facade` — `"<alias>:readonly"` либо `"<alias>:readwrite"` (I-3 R-O1/R-O5, R-18/48/49):
  именно это значение пишется в `mcp.<alias>.oauth.scope`.
- Для `mode: native` (`permission_model.kind: "consent"`, напр. `tag`) `oauth.scope` **не задаётся** —
  права выбираются на экране согласия самого сервера.
- `redirect_uri` клиента — `http://127.0.0.1:19876/mcp/oauth/callback` (F16). **[проверить]** Hub
  `POST /oauth/register` должен принимать loopback-HTTP redirect (I-3 R-O3 отвергает `invalid_redirect_uri`);
  при отказе — параметризовать `oauth.redirectUri` из корп-конфига (§4, S-C4).
- Ошибки MCP-proxy Hub приходят как JSON-RPC `error.data.reason` (`needs_reauth`) и `hint_url`
  (I-3 §17) — витрина показывает их текстом карточки.

### 3.4. Корпоративные умолчания от Hub

`GET {hub}/.well-known/opencode` и `GET {hub}/remote-config` уже поддерживаются upstream (F20) при наличии
auth-записи `type:"wellknown"`. Корп-слой (S-C*) — **дополнение** к ним с меньшим приоритетом, а не замена.

---

## 4. Правила: корпоративные умолчания и конфигурация (S-C*)

- **S-C1. Каталог `corp/`.** В корне монорепо: `corp/config/opencode.corp.json` (эталонный корп-конфиг),
  `corp/README.md`, `corp/patches.md`, `corp/docs/` (эта спецификация и критерии), `corp/build.ts`,
  `corp/upstream-sync.sh`, `corp/plugin/` (зарезервирован под корп-плагины; в I-4 содержит только
  `README.md` с обоснованием D-1). Каталог не участвует в сборке upstream-пакетов и не ломает
  `bun run typecheck`.
- **S-C2. Build-константы.** В `define` (`packages/opencode/script/build.ts`) добавляются
  `OPENCODE_CORP_HUB_URL` (строка, базовый URL Hub без хвостового `/`) и `OPENCODE_CORP_CONFIG`
  (строка — JSON корп-конфига, содержимое `corp/config/opencode.corp.json`). Значения берутся из env
  сборки `CORP_HUB_URL` и файла `corp/config/opencode.corp.json`; если env/файла нет — константы не
  определяются. Потребление — по образцу F25:
  `declare const OPENCODE_CORP_HUB_URL: string; export const CorpHubUrl = typeof OPENCODE_CORP_HUB_URL === "string" && OPENCODE_CORP_HUB_URL !== "" ? … : undefined`.
- **S-C3. Слой конфигурации.** Корп-конфиг из `OPENCODE_CORP_CONFIG` мержится в `Config` **первым** —
  до цикла auth-записей `wellknown` в `loadInstanceState` (F20). Порядок приоритета (снизу вверх):
  `корп-слой < .well-known/remote-config Hub < глобальный конфиг пользователя < OPENCODE_CONFIG <
  конфиг проекта`. Разбор корп-JSON выполняется тем же `loadConfig`, что и файловые слои; ошибка разбора —
  предупреждение в лог и пустой слой (сборка не должна падать из-за опечатки в константе).
- **S-C4. Содержимое корп-конфига.** `corp/config/opencode.corp.json` задаёт: `$schema`,
  `autoupdate: false`, `share: "disabled"`, `enabled_providers: ["magnit_prod"]`, провайдера
  `magnit_prod` (`npm: "@ai-sdk/openai-compatible"`, `name`, `options.baseURL`, `options.apiKey:
  "{env:MAGNIT_COPILOT_KEY}"`, модель `MagnitCopilot` с `limit.context`/`limit.output`), `model:
  "magnit_prod/MagnitCopilot"`. Секретов в файле нет. Файл валиден по схеме конфига OpenCode.
- **S-C5. Переопределение адреса Hub.** Действующий адрес Hub = первое непустое из:
  1) флаг команды `--hub <URL>` (только для `opencode corp *`);
  2) переменная окружения `OPENCODE_CORP_HUB_URL`;
  3) build-константа `OPENCODE_CORP_HUB_URL`.
  Если ни одно не задано — корп-функции (вход по SSO, витрина, `opencode corp *`) **выключены**:
  корп-роуты возвращают `501 {error:"corp_disabled"}`, команды `/connectors` и корп-экран входа не
  регистрируются и не подменяют upstream-поведение, постоянный пункт «Коннекторы» в боковой панели
  не рендерится (S-D2a/S-D2b), автооткрытия экрана входа нет (S-D4a).
- **S-C6. Ванильная сборка.** При отсутствии обеих build-констант и переменных окружения поведение
  бинарника побайтово эквивалентно upstream по наблюдаемому поведению: first-run открывает
  `DialogProviderList` (F2), в палитре нет корп-команд, боковая панель Desktop/web содержит только
  upstream-пункты («Настройки», «Помощь»), конфиг не содержит корп-слоя.
- **S-C7. Отсутствие записи о пользовательском конфиге.** Корп-слой никогда не пишется в файлы
  пользователя; `Config.updateGlobal` вызывается только действиями витрины (S-V7/S-V8) и только для
  ключей `mcp.<alias>`.
- **S-C8. Границы префикса `corp:`.** Каждое изменение файла upstream — отдельный коммит с заголовком
  `corp: <что и зачем>`; новый корп-код размещается в новых файлах (`packages/*/src/corp/**`,
  `corp/**`), чтобы уменьшить поверхность конфликтов при rebase. `corp/patches.md` перечисляет **все**
  изменённые файлы upstream с причиной и ссылкой на правило спецификации.

---

## 5. Правила: вход по корпоративному SSO (S-A*)

### 5.1. Серверная часть

- **S-A1. Корп-роуты.** Новая группа HTTP API `packages/opencode/src/server/routes/instance/httpapi/groups/corp.ts`
  (+ `handlers/corp.ts`), регистрируемая рядом с существующими группами:
  | Метод и путь | Тело/параметры | Ответ |
  |---|---|---|
  | `POST /corp/login/start` | — | `{login_id, user_code, browser_url, expires_in}` |
  | `GET /corp/login/poll/:login_id` | — | `{status:"pending"}` / `{status:"team_selection_required", teams:[{team_id, team_alias}]}` / `{status:"ready", user:{user_id, email?}, key_kind}` / `{status:"error", error, message}` |
  | `POST /corp/login/poll/:login_id/team` | `{team_id}` | `{status:"pending"}` / `{status:"error", …}` |
  | `DELETE /corp/login/poll/:login_id` | — | `{cancelled}` — отмена входа (S-A9); `true`, если сессия была в памяти, `false`, если её уже нет (повтор идемпотентен и не раскрывает существование чужой сессии) |
  | `GET /corp/status` | — | `{hub_url, enabled, authenticated, user?, key_kind?, catalog_version?, catalog_cached_at?, catalog_stale?}` |
  Все — за теми же middleware (`InstanceContextMiddleware`, `Authorization`), что и группы `mcp`/`config`.
- **S-A2. Прокси-семантика.** `POST /corp/login/start` вызывает Hub `POST /cli/start` (§3.1), сохраняет
  `login_id` и `poll_secret` Hub **только в памяти процесса** (Map `login_id → {poll_secret, hub_url,
  expires_at, teams?}`), а наружу отдаёт `login_id`, `user_code`, `browser_url`, `expires_in`.
  `GET /corp/login/poll/:login_id` подставляет сохранённый `poll_secret` в `X-Hub-Poll-Secret`.
  `DELETE /corp/login/poll/:login_id` удаляет запись из этого Map вместе с `poll_secret` (S-A9) и
  отвечает `{cancelled}`; для неизвестного или уже удалённого `login_id` — `{cancelled:false}` без ошибки.
  `poll_secret` не попадает ни в ответы, ни в логи, ни в события.
- **S-A3. Сохранение ключа.** При ответе Hub `ready` сервер выполняет `Auth.set("magnit_prod",
  {type:"api", key, metadata:{hub: <hub_url>, key_kind, user_id, team_id?}})` (F22), затем сбрасывает
  сессию входа из памяти и инвалидирует конфиг/провайдеров так же, как это делает upstream-флоу
  (`instance.dispose()` + `sync.bootstrap()` со стороны UI, F6). Перезапуск не требуется.
- **S-A4. Таймауты и повторы.** Клиентский опрос — раз в 2 с (соответствует дросселированию Hub, R-L10),
  общий предел — `expires_in` из `/cli/start` (при отсутствии — 600 с). Сетевая ошибка/502 от Hub не
  прекращает опрос (до 5 подряд), затем — ошибка `hub_unavailable`. `404 login_expired` и `403 forbidden`
  прекращают сессию сразу.
- **S-A5. Ошибки наружу.** Корп-роуты отдают стабильные коды: `corp_disabled`, `hub_unavailable`,
  `login_expired`, `forbidden`, `invalid_team`, `team_selection_not_required`, `rate_limited`,
  `litellm_unavailable`, `litellm_invalid_response`, `unauthorized`. Каждому соответствует русское
  сообщение в словаре (S-I*). Тексты ошибок Hub, содержащие секреты, не пересылаются: наружу идёт только
  код + наш текст + при наличии `Retry-After`.

### 5.2. Экран входа

- **S-A6. Содержимое экрана.** Корп-экран входа (общий сценарий для TUI и Desktop/web) состоит из шагов:
  1) заголовок «Вход через корпоративный SSO» и адрес Hub;
  2) после `POST /corp/login/start` — крупный `user_code`, ссылка `browser_url` и подсказка
     «Скопировать код»; состояние «Ожидание подтверждения…». Браузер по `browser_url` открывает
     **серверная часть** при обработке `POST /corp/login/start` — тем же механизмом, что и MCP-OAuth
     (F15, S-D8); клиент браузер не открывает (иначе он открылся бы дважды). Ссылка и код на экране —
     запасной путь на случай, когда браузер не открылся; клиентского признака «не удалось открыть»
     нет, поэтому ссылка и код показываются всегда;
  3) при `team_selection_required` — список команд (`team_alias`, значение — `team_id`) с выбором;
     выбор отправляется в `POST /corp/login/poll/:login_id/team`, экран возвращается к шагу 2;
  4) при `ready` — сообщение об успехе с именем пользователя (`user.email`, а при неизвестном
     email — `user.user_id`, S-A13), закрытие экрана и переход к обычной работе;
  5) при ошибке — код и русский текст, действия «Повторить» и «Отмена».
  Кнопка «Другой провайдер» на шаге 1 открывает upstream-список провайдеров без изменений.
- **S-A7. First-run.** Экран входа открывается автоматически, если одновременно: корп-функции включены
  (S-C5) и в auth-store нет записи `magnit_prod`. При наличии ключа `magnit_prod` экран не показывается.
  Точное условие зависит от клиента:
  - **TUI** — upstream-условие first-run (F2), ветвление на корп-экран по S-T3;
  - **Desktop/web** — правило S-D4a: признаки берутся из первого успешного ответа `GET /corp/status`
    (`enabled=true`, `authenticated=false`), автооткрытие однократно за запуск приложения и **не**
    связано с видимостью блока Getting Started (F10) — блок остаётся запасным путём (S-D4).
    Прежняя редакция S-A7 приравнивала first-run в Desktop/web к «блоку Getting Started», из-за чего
    требование «открыл приложение → вижу вход» выполнялось только при развёрнутой боковой панели и
    окне шире `xl` (F36). Ревизия 1.3 это условие ужесточает.
- **S-A8. Повторный вход.** Тот же экран доступен всегда: командой `corp.login` (слэш `login`,
  алиас `sso`) и при выборе провайдера `magnit_prod` в upstream-списке провайдеров. Повторный вход
  перезаписывает запись auth-store; предыдущий ключ Hub помечает устаревшим на своей стороне
  (I-1 R-L5) — клиент ничего не удаляет.
- **S-A9. Отмена.** Закрытие экрана (esc/крестик) прекращает опрос, освобождает сессию в памяти сервера
  (`DELETE /corp/login/poll/:login_id`, S-A1/S-A2 — в том числе при закрытии во время старта), ключ не
  сохраняется, состояние приложения не меняется.

### 5.3. CLI

- **S-A10. `opencode corp login [--hub URL]`.** Тот же флоу без TUI: печатает адрес и код, пытается
  открыть браузер (`open`), при неудаче печатает URL; при `team_selection_required` — нумерованный
  список команд и ввод номера (в неинтерактивном режиме — ошибка с подсказкой `--team <id>`);
  при `ready` — печатает имя пользователя (`user.email`, при неизвестном email — `user.user_id`,
  S-A13), `key_kind` и сохраняет ключ (S-A3). Код выхода `0` при успехе,
  `1` при любой ошибке.
- **S-A11. `opencode corp status [--hub URL]`.** Печатает: адрес Hub, доступность Hub
  (`GET /health` — `ok`/`недоступен`), наличие ключа `magnit_prod` (`есть`/`нет`, без самого ключа),
  пользователя (`email` и `user_id`, а при неизвестном email — только `user_id`, S-A13)
  и `key_kind` из `GET /api/me` (если ключ есть), версию каталога и время кэша
  (`catalog_version`, `catalog_cached_at`, признак `протух`). Код выхода `0`, если корп-функции включены
  и ключ есть; `1` иначе — в том числе код выхода `0`, когда ключ есть, а Hub недоступен: доступность
  Hub на код выхода не влияет (команда диагностическая и должна быть пригодна для скриптов проверки
  установки). Ключ, `poll_secret` и токены не печатаются никогда.
- **S-A11a. Построчный контракт вывода `corp status`.** Формулировки строк — часть контракта, а не
  деталь реализации: на них опираются `cli.test.ts`, дымовая проверка `corp status` в `corp-ci.yml`
  (S-B8) и критерии AC-33…AC-35, AC-122. Каждая строка печатается ровно в этом виде (регистр и
  пробелы значимы, `<…>` — подстановки):

  | Условие | Строка |
  |---|---|
  | всегда | `Hub: <url>` |
  | `GET /health` успешен | `Доступность Hub: доступен (ok)` |
  | `GET /health` не успешен | `Доступность Hub: недоступен` |
  | ключ `magnit_prod` есть | `Корпоративный ключ: есть` |
  | ключа нет | `Корпоративный ключ: нет` |
  | ключ есть, `GET /api/me` успешен, `email` известен | `Пользователь: <email> <user_id>`, далее `Тип ключа: <key_kind>` (если `key_kind` пришёл) |
  | ключ есть, `GET /api/me` успешен, `email` отсутствует или `null` | `Пользователь: <user_id>`, далее `Тип ключа: <key_kind>` (если `key_kind` пришёл) — без пустого места, скобок и слов «null»/«undefined» (S-A13) |
  | ключ есть, `GET /api/me` не успешен | `Пользователь: <текст ошибки по S-A5>` |
  | кэша каталога нет | `Каталог: кэша нет` |
  | кэш есть | `Каталог: версия <version>, кэш от <ISO-8601>` + ` (протух)` при истёкшем TTL (S-V3) |
  | ключа нет (последней строкой, в поток ошибок) | `Ключ не найден: выполните opencode corp login` |

  Изменение любой из этих строк — изменение контракта: правится одновременно здесь, в `cli.test.ts` и
  в дымовой проверке `corp-ci.yml`; проверки в тестах и CI ведутся по подстрокам из одного источника
  (константы теста), а не по независимо набранным литералам. Требование введено ревизией 1.1 после
  `BUG-I4-001` (расхождение регистра между выводом команды и `grep` дымовой проверки).
- **S-A12. Группа команд.** `CorpCommand = cmd({ command: "corp", builder: y =>
  y.command(CorpLoginCommand).command(CorpStatusCommand).demandCommand() })`, регистрация — одной
  строкой `.command(CorpCommand)` в `packages/opencode/src/index.ts` (F26). При выключенных корп-функциях
  (S-C5) команды печатают «Корпоративный режим не настроен» и завершаются с кодом `1`.

### 5.4. Пользователь: email — необязательное поле

- **S-A13. Email пользователя может быть неизвестен.** Корпоративный LiteLLM при входе через SSO не
  возвращает адрес электронной почты, поэтому Hub его не знает (в базе Hub `users.email` — `NULL`) и
  присылает поле `email` **отсутствующим или со значением `null`**. Спецификация **не требует** от Hub
  присылать email ни в одном ответе; единственный обязательный идентификатор пользователя — `user_id`
  (D-19).
  1. **Контракт.** Во всех телах, где встречается объект пользователя, — ready-ответ `GET {hub}/cli/poll/{login_id}`
     (§3.1), ready-ответ корп-роута `GET /corp/login/poll/:login_id` (S-A1), `GET {hub}/api/me` (§3.2),
     поле `user` в `GET /corp/status` (S-A1) — обязателен только `user_id`; `email` необязателен и
     допускает значение `null`.
  2. **Приём ответа.** Ready-ответ с `email: null` и ready-ответ без ключа `email` — **валидные**
     ответы: клиент обязан их принять, сохранить ключ (S-A3) и завершить вход. Отбрасывать такой ответ
     как `hub_invalid_response` запрещено. Правило S-V2 («ответ, не соответствующий схеме, отбрасывается
     целиком») остаётся в силе, но отсутствие `email` и `email: null` схеме **соответствуют**. Цена
     нарушения зафиксирована `BUG-I1-002`: к моменту ответа `ready` Hub уже удалил сессию входа и выдал
     ключ, поэтому отброшенный ответ означает безвозвратно потерянный ключ и незавершённый вход, а
     каждая повторная попытка порождает ещё один мёртвый ключ в LiteLLM.
  3. **Отображение.** Пользователь показывается по email, а при неизвестном email — по `user_id`.
     Формулировка строки и ключ словаря (S-I1/S-I4) не меняются — подставляется другое значение.
     Значения `null`/`undefined`, пустая подстановка, пустые скобки и «висящие» разделители запрещены:

     | Место | `email` известен | `email` отсутствует или `null` |
     |---|---|---|
     | экран входа при `ready`, TUI и Desktop/web (S-A6, шаг 4) | `Вход выполнен: <email>` | `Вход выполнен: <user_id>` |
     | `opencode corp login` при `ready` (S-A10) | `Вход выполнен: <email>` | `Вход выполнен: <user_id>` |
     | `opencode corp status` (S-A11a) | `Пользователь: <email> <user_id>` | `Пользователь: <user_id>` |
     | заголовок витрины `/connectors` (данные `GET /api/me`, §3.2) | `<email>` | `<user_id>` |

  4. **Границы.** Правило касается только представления и валидации email. `user_id` остаётся
     обязательным везде: ответ без `user_id` по-прежнему не соответствует схеме и отбрасывается (S-V2).
     Ключ в auth-store и его метаданные (`hub`, `key_kind`, `user_id`, `team_id?`, S-A3) не меняются —
     email в метаданные не пишется.

---

## 6. Правила: витрина коннекторов (S-V*)

### 6.1. Данные и кэш

- **S-V1. Корп-роуты витрины.** В той же группе `corp`:
  | Метод и путь | Тело | Ответ |
  |---|---|---|
  | `GET /corp/catalog?refresh=true\|false` | — | `{version, source:"hub"\|"cache", cached_at, stale, servers:[…], hub_error?}` |
  | `POST /corp/connectors/:alias/connect` | `{preset?}` | `{alias, status, error?}` |
  | `POST /corp/connectors/:alias/disconnect` | — | `{alias, status:"not_connected"}` |
  | `PUT /corp/connectors/:alias/permissions` | `{preset}` | `{alias, status, preset, reauth_required}` |
- **S-V2. Клиент Hub.** Модуль `packages/opencode/src/corp/hub.ts`: тонкая обёртка над `fetch` с базовым
  URL (S-C5), заголовками `Authorization: Bearer <ключ magnit_prod>`, `X-Request-ID` (uuid4) и таймаутом
  5 с на запрос. Ответы валидируются схемой; несоответствие схемы — ошибка `hub_invalid_response`
  (карточки не подменяются частично, ответ отбрасывается целиком). **Уточнено ревизией 1.4:**
  необязательные поля контракта отсутствием или значением `null` схему не нарушают — в частности,
  `user.email` и `me.email` (S-A13); отбрасывание ready-ответа из-за неизвестного email — дефект,
  а не срабатывание этого правила.
- **S-V3. Кэш каталога.** Успешный `GET /api/catalog` пишется в
  `Global.Path.data/corp/catalog-<sha256(hub_url).slice(0,16)>.json` с правами `0o600`, содержимым
  `{hub_url, fetched_at, version, servers}`. TTL — 24 ч. При открытии витрины всегда выполняется запрос
  к Hub; при успехе кэш перезаписывается и `source:"hub"`. При ошибке Hub:
  - есть кэш и `now - fetched_at ≤ 24 ч` → `source:"cache"`, `stale:false`, отдаются карточки + `hub_error`;
  - есть кэш и `now - fetched_at > 24 ч` → `source:"cache"`, `stale:true`, карточки отдаются, но действия
    «Подключить»/«Права» недоступны;
  - кэша нет → `servers:[]`, `source:"cache"`, `stale:true`, `hub_error` заполнен.
  `?refresh=true` не меняет логики, но обходит внутрипроцессный memo (60 с) свежести.
- **S-V4. Отсутствие ключа.** Если в auth-store нет `magnit_prod`, `GET /corp/catalog` возвращает
  `{servers:[], hub_error:"unauthorized"}`; витрина показывает состояние «Требуется вход» с действием,
  открывающим экран входа (S-A6).

### 6.2. Модель состояния карточки

- **S-V5. Источники.** Для каждого `alias` объединяются: карточка каталога Hub (`server.*` +
  `server.connection.*`, §3.2), запись `mcp.<alias>` из действующего конфига (`GET /config`) и локальный
  статус MCP (`GET /mcp`, F14).
- **S-V6. Правило вычисления статуса.** Первое подошедшее:
  | № | Условие | Статус витрины | Действия |
  |---|---|---|---|
  | 1 | `alias` отсутствует в каталоге (в т.ч. скрыт/`unconfigured`), но есть в конфиге | `unavailable` | «Отключить», «Открыть в Hub» |
  | 2 | каталог `stale` (S-V3) | статус по правилам 3–7, действия «Подключить»/«Права» заблокированы | «Открыть в Hub» |
  | 3 | локальный статус `failed` | `unavailable` (подпись — текст ошибки) | «Переподключить», «Отключить» |
  | 4 | локальный статус `needs_auth` \| `needs_client_registration`, либо `connection.status = "needs_reauth"` | `needs_auth` | «Подключить» (повторная авторизация), «Отключить» |
  | 5 | локальный статус `connected` | `connected` | «Права», «Отключить», «Открыть в Hub» |
  | 6 | `mcp.<alias>` есть в конфиге, локальный статус `disabled` | `not_connected` | «Подключить», «Открыть в Hub» |
  | 7 | иначе | `not_connected` | «Подключить», «Открыть в Hub» |
  Карточка с `server.status = "deprecated"` дополнительно получает бейдж «устаревший» независимо от
  статуса; действие «Подключить» на ней доступно только если `alias` уже есть в конфиге (переподключение).
- **S-V7. Действие «Подключить».** По alias `A` и выбранному пресету `P` (по умолчанию `readonly`):
  1. `Config.updateGlobal` (F21) с патчем
     `mcp.<A> = { type:"remote", url:<server.mcp_url>, enabled:true, oauth: { scope:"<A>:<P>" } }`
     для `mode:"facade"`; для `mode:"native"` — то же без ключа `oauth` (D-5);
  2. `POST /mcp/:A/auth/authenticate` (F13/F15) — открывает браузер и ждёт callback 19876;
  3. по завершении — `GET /mcp` и обновление карточки; при `BrowserOpenFailed` — показать URL текстом
     и предложить открыть вручную;
  4. при ошибке OAuth — карточка получает статус по S-V6 (`needs_auth`/`unavailable`), запись
     `mcp.<A>` в конфиге **остаётся** (чтобы повтор был в один клик), сообщение об ошибке показывается.
- **S-V8. Действие «Отключить».** Последовательно: `DELETE /mcp/:A/auth` → `POST /mcp/:A/disconnect` →
  `Config.updateGlobal` с патчем `mcp.<A>.enabled = false` → (если ключ есть и Hub доступен)
  `DELETE {hub}/api/me/connections/<A>`. Отказ Hub на последнем шаге не откатывает локальные шаги, но
  показывается предупреждением. Запись `mcp.<A>` из конфига не удаляется.
- **S-V9. Действие «Права».** Открывает выбор пресета из `permission_model` карточки:
  - `kind:"header_groups"` — пресеты `readonly`/`readwrite` с раскрытием состава групп
    (`groups[].title` с их `preset`, плюс `always`);
  - `kind:"consent"` / `kind:"tool_filter"` — пресеты из `presets`.
  Подтверждение: `PUT {hub}/api/me/connections/<A>/permissions {preset}`; при `mode:"facade"` также
  `Config.updateGlobal` с `mcp.<A>.oauth.scope = "<A>:<preset>"`; если ответ Hub или расширение прав
  требует повторной авторизации (`reauth_required`, I-3 R-B: `readonly → readwrite` даёт `needs_reauth`) —
  сразу запускается шаг 2 из S-V7. Для `mode:"native"` локальный `oauth.scope` не меняется, повторная
  авторизация проходит через экран согласия самого сервера. Отмена на экране прав не меняет ни конфиг,
  ни Hub.
- **S-V10. «Открыть в Hub».** Открывает в браузере `<hub>/ui/servers/<alias>` (I-3 §17); если ссылка
  недоступна (нет `hub_url`) — действие скрыто. При неудаче открытия браузера URL показывается текстом.
- **S-V11. Поиск и группировка.** Поиск — подстрока без учёта регистра по `title`, `alias`,
  `description`, `owner`. Группировка — по `owner`, порядок групп и карточек внутри группы совпадает с
  порядком каталога Hub (I-1 R-A3: «порядок серверов — как в файле»).
- **S-V12. Пустые состояния.** Три различимых состояния: «Каталог пуст» (Hub ответил, `servers:[]`),
  «Hub недоступен» (`hub_error` + нет карточек), «Требуется вход» (S-V4). Каждое — с действием
  («Обновить» / «Обновить» / «Войти»).
- **S-V13. Совместимость `/mcps`.** Upstream-диалог `/mcps` не меняется функционально; в списке рядом с
  alias показывается `title` из кэша каталога, если alias в нём есть (F-08 требования). При отсутствии
  кэша поведение — как в upstream.

---

## 7. Правила: TUI (S-T*)

- **S-T1. Команда витрины.** В `appCommands` (F1) добавляется команда
  `{ name: "corp.connectors", title: <словарь>, category: "Agent", slashName: "connectors",
  slashAliases: ["mcp-catalog"], run: () => dialog.replace(() => <DialogConnectors />) }`; имя
  `corp.connectors` добавляется в `appBindingCommands`. Команда регистрируется только при включённых
  корп-функциях (S-C5).
- **S-T2. Команда входа.** Аналогично — `{ name:"corp.login", slashName:"login", slashAliases:["sso"],
  suggested: !hasCorpKey(), run: () => dialog.replace(() => <DialogCorpLogin />) }`.
- **S-T3. First-run.** Эффект F2 дополняется ветвлением: при выполнении условий S-A7 открывается
  `<DialogCorpLogin />` вместо `<DialogProviderList />`; иначе — прежнее поведение. Диапазон правки —
  тело существующего `createEffect`, без изменения его условия.
- **S-T4. Кнопка «Другой провайдер».** `DialogCorpLogin` содержит действие, открывающее
  `<DialogProviderList />` (тот же компонент, что и upstream).
- **S-T5. Перехват провайдера `magnit_prod`.** В `createDialogProviderOptions`
  (`packages/tui/src/component/dialog-provider.tsx`, F5) в начало `onSelect` добавляется проверка:
  если `providerID === "magnit_prod"` и корп-функции включены — открыть `<DialogCorpLogin />` и выйти.
  Прочие провайдеры обрабатываются без изменений.
- **S-T6. Экран витрины.** `packages/tui/src/component/corp/dialog-connectors.tsx` строится на
  существующем `DialogSelect` (как `dialog-mcp.tsx`, F3): `title` = название карточки, `description` =
  описание + владелец, `footer` = статус витрины (S-V6) цветами темы (`success` для `connected`,
  `warning` для `needs_auth`, `textMuted` для `not_connected`, `error` для `unavailable`), поиск —
  штатный поиск `DialogSelect`. Действия по клавишам: `enter` — «Подключить»/«Переподключить»,
  `d` — «Отключить», `p` — «Права», `o` — «Открыть в Hub», `r` — обновить каталог. Баннер «Hub
  недоступен, данные от <дата>» — строкой над списком.
- **S-T7. Запуск MCP-OAuth из TUI.** Действие «Подключить» вызывает `sdk.client.mcp.auth.authenticate`
  (или корп-роут S-V1, который делает это на сервере) — в upstream TUI такого вызова нет (F3/F4),
  это новая функциональность. Во время ожидания карточка показывает «⋯ Авторизация в браузере»,
  список не блокируется целиком; параллельный запуск второго подключения запрещён (как в `dialog-mcp.tsx`).
- **S-T8. Экран входа.** `packages/tui/src/component/corp/dialog-corp-login.tsx` реализует шаги S-A6;
  выбор команды — вложенный `DialogSelect`; копирование кода — по клавише `c` (как в `AutoMethod`, F6).
- **S-T9. Отсутствие регрессии.** Команды `mcps`, `connect`, `status`, `models`, `agents` и их слэш-имена
  остаются прежними; `dialog-mcp.tsx` меняется только в части S-V13 (подпись `title`).

---

## 8. Правила: Desktop и web (S-D*)

- **S-D1. Команда витрины.** В `command.register("layout", …)` (`packages/app/src/pages/layout.tsx`, F9/F10)
  добавляется команда `{ id: "corp.connectors", title: t("corp.connectors.title"),
  description: t("corp.connectors.description"), slash: "connectors", category: t("command.category.…"),
  onSelect: openConnectors }`, где `openConnectors()` лениво импортирует
  `@/components/corp/dialog-connectors` по образцу `connectProvider()`/`openServer()`. Команда
  регистрируется только при включённых корп-функциях (S-C5).
- **S-D2. Три равноправных пути в витрину.** Витрина открывается тремя способами, ни один из которых не
  является заменой другим:
  **(а)** постоянный пункт навигации «Коннекторы» в боковой панели Home — S-D2a (развёрнутая панель) и
  S-D2b (свёрнутая иконочная панель);
  **(б)** слэш-команда `/connectors`;
  **(в)** палитра команд (та же команда `corp.connectors`, S-D1).
  Все три пути открывают один и тот же полноэкранный диалог `@/components/corp/dialog-connectors`
  (S-D6) и обязаны идти через одну точку открытия — команду `corp.connectors`
  (`command.trigger("corp.connectors")`, F9), чтобы поведение путей не разъезжалось.
  Витрина остаётся **диалогом, а не URL-маршрутом**: сегмент верхнего уровня `/:dir` (F11) перехватывает
  произвольные пути, и добавление `/connectors` в роутер потребовало бы правки порядка маршрутов
  приложения (решение D-4). Отсутствие URL-маршрута не отменяет требования постоянного пункта
  навигации: пункт — часть боковой панели, а не адресной строки.
  Условие видимости для (а) — включённые корп-функции: `enabled=true` в ответе `GET /corp/status`
  (S-C5; до первого успешного ответа и при недоступности роутов действует `STATUS_UNAVAILABLE`,
  то есть `enabled=false`). При `enabled=false` боковая панель обеих форм строго совпадает с upstream:
  ни строки, ни иконки, ни пустого узла в DOM. Признак сборки `corpBuildEnabled`
  (`packages/app/src/corp/enabled.ts`) для показа пункта **не используется** — он знает только про
  build-константу vite и не учитывает адрес Hub из окружения сервера; он допустим лишь как
  дополнительное условие, если это не меняет наблюдаемое поведение относительно `enabled`.
  Аутентификация пользователя видимость пункта **не** определяет: при `enabled=true` и
  `authenticated=false` пункт виден и открывает витрину в состоянии «Требуется вход» (S-V12).
- **S-D2a. Пункт в развёрнутой боковой панели Home.** В нижнем блоке боковой колонки Home
  (`packages/app/src/pages/home.tsx`, `HomeProjectColumn`, блок `<div class="mt-4 flex min-w-0 flex-col
  gap-1">`, F33) появляется третья строка «Коннекторы» — **первой в блоке, непосредственно над строкой
  «Настройки»**; порядок блока при включённых корп-функциях: «Коннекторы», «Настройки», «Помощь».
  Строка построена теми же средствами, что соседние: `<button type="button">` с классами
  `HOME_PROJECT_NAV_ROW`, иконка `IconV2 size="small"` и подпись в `<span class={HOME_PROJECT_NAV_LABEL}>`.
  Имя иконки — `mcp` (D-17; `IconV2` рисует `<use href="#opencode-v2-icon-mcp">`, по чему проверяется
  имя в тесте AC-124). Подпись — `language.t("corp.sidebar.connectors")` (S-I1). Клик открывает
  витрину через `command.trigger("corp.connectors")` (S-D2). Пункт не имеет состояния «выбран»: витрина
  — диалог, а не раздел навигации.
- **S-D2b. Иконка в свёрнутой иконочной панели.** В нижнем блоке рельсы `SidebarContent`
  (`packages/app/src/pages/layout/sidebar-shell.tsx`, F34) появляется `IconButton icon="mcp"`
  **над** `IconButton icon="settings-gear"`; порядок сверху вниз: «Коннекторы», шестерёнка, «Помощь».
  Кнопка обёрнута в `Tooltip` (не `TooltipKeybind`: у команды `corp.connectors` нет клавиатурной
  привязки в каталоге, `command.keybind("corp.connectors")` вернёт пустую строку) со значением
  `corp.sidebar.connectors`; то же значение — в `aria-label` (`IconButton` дополнительно проставляет
  `data-icon="mcp"`, по нему проверяется имя иконки в тесте AC-125). `SidebarContent` остаётся презентационным:
  подпись и обработчик приходят новыми пропсами из `layout.tsx`, и при `enabled=false` эти пропсы не
  передаются, а кнопка не рендерится (S-D2). Та же панель используется мобильным выдвижным меню
  (`sidebarContent(true)`) — там пункт появляется на тех же условиях.
- **S-D3. Команда и экран входа.** Аналогично: команда `corp.login` (`slash: "login"`) и диалог
  `@/components/corp/dialog-corp-login`, реализующий шаги S-A6.
- **S-D4. Getting Started.** Блок Getting Started (F10) при включённых корп-функциях и отсутствии ключа
  `magnit_prod` показывает первичной кнопкой «Войти через корпоративный SSO» (`onClick=openCorpLogin`), а
  «Подключить провайдера» — вторичной. Условие видимости самого блока не меняется. Этот блок —
  **запасной** путь ко входу: он живёт в панели, которая по умолчанию свёрнута, скрыта при ширине окна
  меньше `xl` и убирается кнопкой «Не сейчас» (F36), поэтому сам по себе он не выполняет требование
  «открыл приложение → вижу вход»; за это требование отвечает S-D4a.
- **S-D4a. Экран входа при первом запуске виден сразу.** Desktop/web открывает диалог `corp.login`
  (S-D3) **автоматически**, без ввода команд и без действий пользователя, когда одновременно:
  (1) первый успешный ответ `GET /corp/status` после запуска приложения содержит `enabled=true` и
  `authenticated=false`; (2) в этот момент не показан другой диалог; (3) в текущем запуске приложения
  автооткрытие ещё не происходило. Автооткрытие срабатывает не более одного раза за запуск процесса
  (признак хранится в памяти и не персистится) и **не зависит** от маршрута (`/` или `/:dir`), от
  состояния боковой панели, от ширины окна и от `store.gettingStartedDismissed`.
  Закрытие диалога (Esc/крестик, S-A9) не приводит к повторному автооткрытию до перезапуска
  приложения; дальнейшие входы доступны через Getting Started (S-D4), палитру и слэш `/login` (S-D3),
  перехват провайдера (S-D5) и кнопку «Войти» в витрине (S-V12).
  При `enabled=false` (ванильный режим, S-C6) или `authenticated=true` автооткрытия нет и поведение
  приложения совпадает с upstream. Решение об автооткрытии выносится чистой функцией
  (`packages/app/src/corp/first-run.ts`), чтобы быть проверяемым модульным тестом (S-Q9).
- **S-D5. Перехват провайдера.** В `dialog-select-provider.tsx` / `dialog-connect-provider.tsx` выбор
  провайдера `magnit_prod` при включённых корп-функциях открывает корп-экран входа вместо ввода API-ключа.
- **S-D6. Витрина.** `packages/app/src/components/corp/dialog-connectors.tsx` строится на `Dialog` +
  `List` (как `dialog-select-mcp.tsx`, F7): поиск (`search.placeholder`), группировка по владельцу,
  карточка = `title`, `description`, `owner`, бейдж статуса (S-V6), бейдж «устаревший», подпись пресета;
  действия — кнопки «Подключить», «Отключить», «Права», «Открыть в Hub». Баннер «Hub недоступен» и
  пустые состояния — по S-V12.
- **S-D7. Обновление данных.** Действия витрины выполняются мутациями поверх корп-роутов; после каждой —
  инвалидация `GET /mcp` и `GET /corp/catalog` (тем же механизмом, что `useMcpToggle` → `refresh`, F8).
- **S-D8. Electron.** Открытие браузера для OAuth и `browser_url` выполняется серверной частью (F15) либо
  штатным механизмом Desktop; корп-код не открывает внешние ссылки в окне приложения.
- **S-D9. `opencode web`.** Тот же UI `packages/app`, отдельных правок не требует; корп-роуты доступны с
  того же сервера.

---

## 9. Правила: локализация (S-I*)

- **S-I1. Ключи корп-текстов в `packages/app`.** Все наши строки добавляются в `packages/app/src/i18n/en.ts`
  и `packages/app/src/i18n/ru.ts` под префиксом `corp.` (`corp.login.*`, `corp.connectors.*`,
  `corp.sidebar.*`, `corp.status.*`, `corp.error.*`, `corp.preset.*`). Ключи в обоих словарях совпадают
  полностью. Подпись постоянного пункта навигации (S-D2a/S-D2b) — отдельный ключ
  `corp.sidebar.connectors`: RU «Коннекторы», EN «Connectors». Он не переиспользует
  `corp.connectors.title` («Коннекторы» / «Connectors»), потому что заголовок диалога и подпись пункта
  меню — разные тексты с разной судьбой; паритет словарей и требование «значение в `ru.ts` не равно
  значению в `en.ts`» (S-I3) распространяются на него как на любой другой ключ `corp.*`.
- **S-I2. Русский по умолчанию.** В `packages/app/src/context/language.tsx` (F28) значения по умолчанию
  `detectLocale()` и `normalizeLocale()` возвращают `"ru"` вместо `"en"`, если корп-функции включены;
  явный выбор пользователя (`localStorage`/cookie `oc_locale`) и совпадение с `navigator.languages`
  имеют приоритет. При выключенных корп-функциях — прежнее поведение (`"en"`).
- **S-I3. Тест словарей.** Существующий `packages/app/src/i18n/parity.test.ts` (F29) продолжает
  проходить; дополнительно наш тест проверяет, что множества ключей с префиксом `corp.` в `en.ts` и
  `ru.ts` совпадают и что ни одно значение в `ru.ts` не равно значению `en.ts` (нет забытых переводов).
- **S-I4. Словарь TUI.** Новый файл `packages/tui/src/corp/i18n.ts` — плоский объект
  `{ ru: {…}, en: {…} }` и функция `t(key)`; язык выбирается из `OPENCODE_CORP_LANG` (`ru`/`en`), иначе
  `ru` при включённых корп-функциях, иначе `en`. Используется **только** нашими экранами; upstream-строки
  TUI не трогаем.
- **S-I5. Полнота.** Все пользовательские тексты корп-экранов (заголовки, статусы, действия, ошибки
  S-A5, пустые состояния S-V12) есть в обоих языках; в коде нет захардкоженных русских строк вне словарей.

---

## 10. Правила: сборка, CI, синхронизация с upstream (S-B*)

- **S-B1. Версия.** Версия корп-сборки = `<версия upstream>-magnit.<N>` (например `1.17.9-magnit.1`), где
  `N` берётся из `corp/version` или env `CORP_BUILD` (по умолчанию `1`). Значение подставляется в
  `OPENCODE_VERSION` (F25) и в `version` пакетов Desktop при сборке; исходные `package.json` upstream не
  правятся вручную.
- **S-B2. `corp/build.ts`.** Один вход: `bun run corp/build.ts [--targets …] [--desktop] [--skip-cli]`.
  Собирает CLI (`packages/opencode/script/build.ts`) для `darwin-arm64`, `darwin-x64`, `linux-x64`,
  `win32-x64`, кладёт `dist/opencode-<os>-<arch>/bin/opencode` и zip-архив каждого,
  печатает sha256 артефактов. Перед сборкой проверяет и передаёт `OPENCODE_CORP_HUB_URL` и
  `OPENCODE_CORP_CONFIG` (S-C2); при отсутствии `CORP_HUB_URL` — предупреждение «собирается ванильная
  сборка» и продолжение (S-C6).
- **S-B3. Desktop.** `corp/build.ts --desktop` вызывает `bun --cwd packages/desktop package:mac`
  (mac-arm64) и `package:win` (win-x64) с тем же `OPENCODE_CHANNEL` и версией S-B1. Windows-сборка
  выполняется на Windows-стенде или в CI; на macOS команда `--desktop --win` завершается понятной
  ошибкой, а не молчаливым пропуском.
- **S-B4. Публикация.** Артефакты публикуются в GitHub Releases приватного форка тегом
  `v<версия S-B1>`; в описании релиза — список артефактов и их sha256. Скрипт не публикует
  автоматически без явного флага `--publish`.
- **S-B5. `corp/upstream-sync.sh`.** Шаги: `git fetch upstream --tags` → проверка чистого рабочего дерева →
  `git rebase <тег>` рабочей ветки → `bun install` → `bun run typecheck` → `bun --cwd packages/opencode test`
  и `bun --cwd packages/tui test` (наши тесты) → отчёт: список конфликтов (если rebase остановился),
  список изменённых upstream-файлов из `corp/patches.md`, которые затронул апдейт. Ненулевой код выхода
  при конфликте, падении typecheck или тестов. Скрипт ничего не пушит.
- **S-B6. `corp/patches.md`.** Таблица: файл upstream → правило спецификации → причина → коммит.
  Обновляется в том же коммите, что и правка upstream-файла (проверяется правилом ревью, а также
  тестом S-Q7).
- **S-B7. CI на PR в `main`.** GitHub Actions: `bun install` → `bun run typecheck` → тесты пакетов
  `opencode`, `tui`, `app` → сборка CLI для `darwin-arm64`, `linux-x64`, `win32-x64` → smoke
  (`opencode --version` для сборки текущей ОС, F25). Ошибка любого шага валит PR.
- **S-B8. CI по тегу.** По тегу `v*-magnit.*` дополнительно собирается Desktop (mac-arm64 на macOS-раннере,
  win-x64 на Windows-раннере) и создаётся черновик GitHub Release с артефактами.
- **S-B9. Подпись.** Подпись Windows Authenticode и macOS Developer ID/notarization в I-4 не
  выполняется: конфигурация `electron-builder` не меняется, `script/sign-windows.ps1` остаётся
  upstream-логикой (срабатывает только в GitHub Actions на win32). **[проверить]** — решение ИБ,
  открытый вопрос §4.3 требования.

---

## 11. Правила: тесты (S-Q*)

- **S-Q1. Размещение.** Тесты лежат рядом с модулями (`*.test.ts` в тех же каталогах) и запускаются
  существующими скриптами пакетов (`bun test`, F31). Корневой `bun test` не используется (F32).
- **S-Q2. Клиент Hub.** Модульные тесты `packages/opencode/src/corp/hub.test.ts` с моками HTTP (без сети):
  успешные ответы `/cli/start`, `/cli/poll`, `/api/catalog`, `/api/me`, `/api/me/connections`,
  `PUT/DELETE /api/me/connections/*`; ветки `pending`, `team_selection_required`, `ready`;
  ошибки 400/401/403/404/409/429/502; тело, не соответствующее схеме; таймаут и сетевая ошибка;
  проверка заголовков (`Authorization`, `X-Hub-Poll-Secret`) и того, что `poll_secret` не попадает в
  ответы наружу.
- **S-Q3. Флоу входа.** Тесты `packages/opencode/src/corp/login.test.ts`: полный путь
  `start → pending → team_selection_required → team → pending → ready` с записью в auth-store (мок
  `Auth.set`); ветка одной команды; `login_expired`; `forbidden`; отмена сессии; отсутствие ключа в логах;
  ready-ответ с `email: null` и ready-ответ без поля `email` — оба принимаются, ключ сохраняется (S-A13).
- **S-Q4. Витрина.** Тесты `packages/opencode/src/corp/connectors.test.ts`: таблица S-V6 (по одному
  случаю на строку), `connect` пишет ожидаемый патч конфига для `facade` и для `native`, `disconnect`
  выполняет три локальных шага и переживает отказ Hub, «Права» формируют корректный `oauth.scope`
  и признак `reauth_required`.
- **S-Q5. Кэш.** Тесты `packages/opencode/src/corp/catalog-cache.test.ts` с подменяемыми часами: запись и
  чтение, свежий кэш (< 24 ч), протухший (> 24 ч, `stale:true`), отсутствие кэша, повреждённый файл
  (трактуется как отсутствие), права файла `0o600`, изоляция кэшей разных `hub_url`.
- **S-Q6. Корп-слой конфига.** Тесты рядом с `packages/opencode/src/corp/config.ts`: корп-слой ниже
  `.well-known` и ниже глобального конфига; отсутствие констант = отсутствие слоя; невалидный JSON не
  роняет загрузку.
- **S-Q7. Реестр правок.** Тест `corp/patches.test.ts` (запускается в пакете `opencode`): множество
  upstream-файлов, изменённых относительно базового тега (`git diff --name-only <base>`), совпадает с
  множеством файлов, перечисленных в `corp/patches.md`. **[проверить]** — базовый тег берётся из
  `corp/upstream-base`.
- **S-Q8. Smoke.** В CI: собранный бинарник отвечает на `--version` (строка вида `1.17.9-magnit.N`) и на
  `opencode corp status --hub <адрес мока>` печатает адрес Hub и «ключ: нет» с кодом выхода `1`,
  а с подложенным auth-store — «ключ: есть» с кодом `0`.
- **S-Q9. UI.** Тесты словарей (S-I3) и unit-тест функции вычисления статуса карточки, вынесенной в
  чистый модуль (`packages/opencode/src/corp/status.ts`), общий для TUI и app. Дополнительно
  (ревизия 1.3): (а) тесты постоянного пункта навигации — рендер нижнего блока боковой панели Home и
  рельсы `SidebarContent` в обоих состояниях корп-режима (`enabled=true|false`) с проверкой наличия,
  порядка относительно «Настроек» и вызова открытия витрины; выполняются в пакете `app`
  (`bun test --preload ./happydom.ts`, F31); (б) unit-тест чистой функции решения об автооткрытии входа
  (`packages/app/src/corp/first-run.ts`, S-D4a) по таблице входов: `enabled`/`authenticated`/«диалог уже
  открыт»/«автооткрытие уже было».

---

## 12. Принятые решения по неоднозначностям

- **D-1. Plugin-hook `auth` недостаточен для входа по SSO.** Причины из кода: (а) контракт
  `AuthOAuthResult` (F23) — только `authorize() → {url, instructions}` и один `callback()`, без
  промежуточного шага; выбор команды при `team_selection_required` (I-1 R-L3, где правило «первая по
  умолчанию» **запрещено**) выразить нечем; (б) TUI-экран `AutoMethod` (F6) вызывает `callback()` один
  раз в `onMount` и не умеет ничего спросить; (в) плагин не может добавить HTTP-маршрут (F23), а браузерный
  UI (`packages/app`) не может ходить в Hub напрямую — CORS в Hub не включён (I-1 R-A7). Поэтому вход
  реализуется корп-роутами (S-A1) и корп-экранами (S-A6) с минимальными патчами `app.tsx` (S-T3),
  `dialog-provider.tsx` (S-T5), `layout.tsx` (S-D4) и диалогов провайдера в `packages/app` (S-D5).
  `corp/plugin/` сохраняется как место для будущих хуков (`config`, `tool`), в I-4 не подключается.
- **D-2. Все обращения к Hub — через серверную часть бинарника.** Единая точка для ключа, кэша, таймаутов
  и сокрытия `poll_secret`; UI (TUI и app) знает только корп-роуты.
- **D-3. Ключ провайдера хранится как `api`-запись `magnit_prod`** (`Auth.set`, F22), а не как
  `wellknown`: `wellknown` предназначен для автозагрузки удалённого конфига и требует пары `key/token`;
  корп-слой умолчаний мы даём build-константами (S-C3), а `.well-known` Hub остаётся доступным
  дополнительно и продолжает работать по upstream-логике.
- **D-4. Витрина — полноэкранный диалог, а не URL-маршрут `/connectors`** (S-D2), из-за динамического
  сегмента `/:dir` в роутере приложения (F11). Слэш-команда `/connectors` и пункт палитры сохраняются.
  **Уточнено ревизией 1.3:** решение касается только адресации (диалог вместо маршрута) и **не**
  является обоснованием отсутствия постоянного пункта навигации. Формулировка «для пользователя вход в
  витрину выглядит так же, как задумано» оказалась неверной: заказчик ожидает видимый пункт меню,
  а слэш-команда и палитра требуют знания команды. Постоянный пункт добавляется правилами S-D2a/S-D2b
  и открывает тот же диалог.
- **D-5. `oauth.scope` пишем только для `mode: "facade"`** — Hub как AS объявляет
  `scopes_supported = ["<alias>:readonly","<alias>:readwrite"]` (I-3 R-O1/R-O5). Для `mode:"native"`
  (`permission_model.kind:"consent"`) scope не задаём: права выбираются экраном согласия сервера, а
  публичное представление каталога не отдаёт scopes целевой системы (I-1 R-C6).
- **D-6. Пресет по умолчанию — `readonly`** (I-1 `catalog.yaml` `defaults.permission_presets.readonly.default:
  true`, I-3 R-49: scope по умолчанию `<alias>:readonly`).
- **D-7. `enabled` персистится через `Config.updateGlobal`** (F21), а не через `POST /mcp/:name/connect`
  (F17 — только runtime). Пишем в глобальный конфиг пользователя, а не в конфиг проекта.
- **D-8. Имена MCP-инструментов для `permission`/`tools` — `<alias>_<tool>` с сохранением дефисов в
  alias** (F19): `sanitize` заменяет только символы вне `[A-Za-z0-9_-]`. Закрывает открытый вопрос §4.2
  требования; Hub в `remote-config` должен формировать маски в этом же виде (например
  `gitlab-platform_*`). **[проверить]** — согласовать с реализацией Hub.
- **D-9. Подпись сборок — вне объёма I-4** (S-B9), открытый вопрос §4.3 требования остаётся за ИБ;
  спецификация не блокируется.
- **D-10. Ванильный режим — первоклассный сценарий** (S-C5/S-C6): все корп-возможности выключаются одним
  условием (нет адреса Hub), что даёт дешёвую проверку «не сломали upstream» и упрощает rebase.
- **D-11. Статус `failed` отображается как `unavailable` с текстом ошибки** (S-V6, строка 3): человек
  зафиксировал четыре значения статуса витрины, а `failed` семантически ближе к «недоступен», чем к
  «требуется авторизация».
- **D-12. Кэш каталога не заменяет запрос**: витрина всегда пытается сходить в Hub, кэш — только
  деградация (S-V3). TTL 24 ч управляет не «когда обновлять», а «когда данные считать протухшими».

Решения ревизии 1.1 (2026-08-20):

- **D-13. Код выхода `corp status` считается от состояния клиента, а не от доступности Hub** (S-A11):
  при наличии ключа и недоступном Hub команда печатает `Доступность Hub: недоступен` и завершается
  кодом `0`. Иначе диагностическую команду нельзя использовать в скриптах проверки установки — падение
  означало бы «установка сломана», хотя сломана лишь сеть до Hub. Отсутствие ключа по-прежнему даёт
  код `1` (AC-35 + AC-122). Прежняя формулировка AC-35 («код выхода 1 при недоступном Hub») противоречила
  S-A11 и исправлена, поведение не менялось.
- **D-14. Совпадение с `navigator.languages` приоритетнее корп-умолчания `ru`** (S-I2): `ru` применяется
  только как fallback, когда явного выбора нет и ни одна поддерживаемая локаль браузера не совпала.
  `fr` входит в список поддерживаемых, поэтому `fr-FR` даёт `fr`, а не `ru`; корп-умолчание проверяется
  на локали вне списка (`sw-KE`). Прежняя формулировка AC-94 требовала обратного и противоречила
  правилу, на которое ссылалась; исправлен критерий, а не правило и не реализация (AC-94 + AC-123).
- **D-15. Пользовательские строки CLI, на которые смотрят тесты и CI, — часть контракта** (S-A11a):
  совпадение по подстроке допустимо как способ проверки, но сама подстрока фиксируется в спецификации
  и берётся тестом и дымовой проверкой из одного источника. Иначе повторяется `BUG-I4-001`, где строка
  в `grep` CI разошлась с выводом команды по регистру и совпадение по подстроке перестало работать.

Решения ревизии 1.4 (2026-08-20, изменение контракта по `BUG-I1-002`):

- **D-19. Email пользователя — необязательное поле, единственный обязательный идентификатор — `user_id`**
  (S-A13). Альтернатива «обязать Hub всегда присылать email» отвергнута как физически невыполнимая:
  email приходит в Hub только из ответа корпоративного LiteLLM при SSO, а тот его не отдаёт — Hub
  не может подставить значение, которого не знает, а подстановка заглушки («—», пустая строка,
  скопированный `user_id` в поле `email`) сделала бы поле недостоверным и скрыла бы отсутствие данных
  от вызывающей стороны. Альтернатива «клиент принимает ответ, но показывает пустое место» отвергнута:
  строки вида `Пользователь:` или `Вход выполнен: null` неотличимы от сбоя. Поэтому контракт объявляет
  `email` необязательным, а интерфейс при его отсутствии показывает `user_id` — значение, которое всегда
  есть и однозначно идентифицирует пользователя в Hub и LiteLLM. Строгость проверок при этом не
  снижается: ответ без `user_id` по-прежнему отбрасывается (S-V2).

Решения ревизии 1.3 (2026-08-20, изменение требований заказчика):

- **D-16. Витрина получает постоянный пункт навигации, а не только команду** (S-D2, S-D2a, S-D2b).
  Заказчик задаёт путь «Home → боковая панель → Коннекторы» как основной; слэш-команда и палитра
  остаются, но обнаруживаемости не дают. Место — нижний блок боковой панели (рядом с «Настройками» и
  «Помощью»), а не список проектов: витрина — не проект и не сессия, а раздел уровня приложения.
  Позиция «непосредственно над Настройками» зафиксирована требованием и проверяется критериями
  AC-124/AC-125 как порядок элементов, а не как «где-то в блоке».
  Видимость определяется ответом сервера `GET /corp/status` (`enabled`), а не build-константой веб-UI:
  `packages/app` собирается vite отдельно, `corpBuildEnabled` не знает адреса Hub из окружения сервера
  (см. `packages/app/src/corp/enabled.ts`), а BUG-I4-002 уже показал цену расхождения этих признаков.
- **D-17. Иконка пункта — `mcp`; в набор v2 её нужно добавить.** В свёрнутой панели используется
  legacy-набор (`IconButton`, F34), где имя `mcp` уже есть, — берём его. В развёрнутой панели Home
  используется набор v2 (`IconV2`, F33), где подходящего имени нет вовсе: доступны только 16 имён
  (F35), из них ни `plug`, ни `link`, ни `grid`. Поэтому **требуется добавить в
  `packages/ui/src/v2/components/icon.tsx` глиф `mcp`** — тот же путь, что в legacy-наборе
  (`viewBox "0 0 20 20"`, как у `sidebar-right`/`status`/`close` в том же наборе), имя обязано совпадать
  с legacy (`mcp`), чтобы обе панели показывали одну иконку. Обходные варианты отвергнуты:
  `grid-plus` означает «добавить», а не «коннекторы»; смешивать legacy-`Icon` внутри блока из
  `IconV2`-строк — расхождение в размере и толщине штриха (viewBox 20 против 16). Отдельно важно, что
  `IconV2` молча подменяет неизвестное имя на `plus` (F35): без добавления глифа ошибки не будет, а
  пользователь увидит плюс — поэтому AC-124 проверяет именно отрисованное имя иконки.
- **D-18. Первый запуск: экран входа открывается сам, однократно за запуск** (S-D4a, S-A7).
  Требование «скачал → сразу проходит корпоративную авторизацию» нельзя закрыть кнопкой в блоке
  Getting Started: панель по умолчанию свёрнута, скрыта при узком окне и снимается кнопкой «Не сейчас»
  (F36) — путь «открыл приложение → вижу вход» тогда не выполняется и не проверяется однозначно.
  Выбран модальный экран входа (тот же, что у команды `corp.login`), потому что он не зависит от
  раскладки боковой панели и уже реализован. Ограничения выбраны так, чтобы автооткрытие не стало
  навязчивым: только при `enabled=true && authenticated=false`, только когда другой диалог не показан,
  не более одного раза за запуск процесса, с обычным закрытием по Esc. Признак «уже открывали» живёт в
  памяти и не персистится: после перезапуска пользователь без ключа снова увидит предложение войти —
  без ключа приложение всё равно не работоспособно в корп-режиме.

---

## 13. Открытые вопросы требования (§4) — состояние

| № | Вопрос | Состояние |
|---|---|---|
| 1 | Достаточно ли plugin-hook `auth` для first-run | **Закрыт**: недостаточен, обоснование D-1 (F6, F23, I-1 R-L3, I-1 R-A7) |
| 2 | Формат имён MCP-инструментов (`alias_tool` vs `alias-tool`) | **Закрыт по коду**: `sanitize(alias) + "_" + sanitize(tool)`, дефисы в alias сохраняются (F19, D-8). Требуется согласование с Hub — **[проверить]** |
| 3 | Подпись сборок | **Параметризован**: вне объёма I-4, S-B9, D-9 — **[проверить]** (решение ИБ) |

Прочие **[проверить]** этой спецификации: приём Hub loopback-HTTP `redirect_uri` при DCR (§3.3);
базовый тег для теста реестра правок (S-Q7).
