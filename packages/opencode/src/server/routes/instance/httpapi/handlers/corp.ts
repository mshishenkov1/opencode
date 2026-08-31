import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import * as CorpCatalog from "@/corp/catalog"
import * as CorpCatalogCache from "@/corp/catalog-cache"
import * as CorpConfig from "@/corp/config"
import * as CorpConnections from "@/corp/connections"
import * as CorpConnectors from "@/corp/connectors"
import * as CorpCredentials from "@/corp/credentials"
import * as CorpDirect from "@/corp/direct"
import * as CorpDiagnostics from "@/corp/diagnostics"
import * as CorpErrors from "@/corp/errors"
import * as CorpHub from "@/corp/hub"
import * as CorpLogin from "@/corp/login"
import * as CorpLogout from "@/corp/logout"
import * as CorpSchema from "@/corp/schema"
import * as CorpStatus from "@/corp/status"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { CORP_PROVIDER_ID, corpUserEmail } from "@opencode-ai/core/corp/constants"
import { Global } from "@opencode-ai/core/global"
import { InstanceStore } from "@/project/instance-store"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import open from "open"
import path from "path"
import { InstanceHttpApi } from "../api"
import {
  CorpAuthMethodUnavailableError,
  CorpBadRequestError,
  CorpDirectUnavailableError,
  CorpDisabledError,
  CorpHubError,
  CorpInvalidRequestError,
  CorpNotFoundError,
  CorpStorageUnavailableError,
} from "../groups/corp"

/**
 * Обработчики корп-роутов (S-A1…S-A5, S-V1…S-V10).
 *
 * Все обращения к Hub выполняются здесь, на серверной стороне бинарника (D-2). Ключ провайдера и
 * `poll_secret` наружу не отдаются и в логи не пишутся.
 */

/**
 * Пользователь в ответах корп-роутов (S-A1, S-A13).
 *
 * Hub может прислать `email` отсутствующим или `null` — наружу неизвестный email отдаётся отсутствием
 * поля: клиентам не приходит ни `null`, ни пустая строка, показывать им нечего кроме `user_id`.
 */
function publicUser(user: CorpSchema.HubUser): CorpSchema.HubUser {
  const email = corpUserEmail(user)
  return { user_id: user.user_id, ...(email === undefined ? {} : { email }) }
}

/**
 * Файлы глобального конфига пользователя — единственные, которые правит `Config.updateGlobal` (F21).
 * Порядок повторяет порядок слоёв загрузки; список закрыт и совпадает с тем, что читает диагностика.
 */
const GLOBAL_CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"] as const

/**
 * Лежит ли файл в глобальном конфиге пользователя (S-C11 п.4).
 *
 * Всё остальное — конфиг проекта и `OPENCODE_CONFIG` — слои, которые приложение не редактирует.
 * Проверяется и каталог, и имя: файл рядом с глобальным конфигом, но с другим именем, приложение
 * тоже не правит.
 */
function isGlobalConfigFile(file: string) {
  const resolved = path.resolve(file)
  return GLOBAL_CONFIG_FILES.some((name) => resolved === path.resolve(Global.Path.config, name))
}

/**
 * Адрес без строки запроса — то, что попадает в лог при отказе целевой системы (S-V26 п.6).
 * Ни тела ответа, ни значения токена, ни параметров запроса в логе не бывает.
 */
function urlWithoutQuery(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return undefined
  }
}

/** Свежесть внутрипроцессного memo каталога (S-V3). */
const CATALOG_MEMO_MS = 60_000

/**
 * Memo каталога на процесс сервера.
 *
 * Ключ — рабочий каталог инстанса, workspace и адреса источников каталога: карточки зависят от
 * конфига и локальных статусов MCP конкретного инстанса (S-V5), а один процесс обслуживает
 * несколько рабочих каталогов (InstanceContextMiddleware). Общий ключ отдал бы второму каталогу
 * карточки, посчитанные для первого.
 */
const memo = new Map<string, { at: number; view: CorpSchema.CatalogView }>()

/**
 * Поколение memo: счётчик сбросов (BLK-5, вторая половина).
 *
 * Снимок обязан быть не только сброшен действием, но и **не записан обратно** ответом, который
 * читался ДО этого действия. Витрина считается долго (запрос в Hub — до пяти секунд по
 * `CorpHub.REQUEST_TIMEOUT_MS`), а действие над карточкой доходит за миллисекунды.
 *
 * Наблюдение зондом (Hub задержан на первом `GET /api/catalog`, действие выполнено внутри
 * задержки): витрина, начатая до `PUT /corp/connectors/:alias/permissions {preset}`, привозит из
 * Hub `connection.preset` ДО смены и — прежней редакцией — кладёт это в memo уже ПОСЛЕ того, как
 * действие снимок сбросило. Следующее открытие витрины отдавало `readonly` при `readwrite` в Hub;
 * с проверкой поколения — `readwrite`. Сброс, сделанный действием, иначе просто терялся.
 *
 * Поколение снимается в начале обработчика и сверяется перед записью; разошлось — результат
 * отдаётся клиенту (он свежее кэша), но в memo не кладётся.
 */
let memoEpoch = 0

/**
 * Действующие корпоративные адреса (S-C5, S-C10 п.1–3).
 *
 * Их два и они независимы: `hub` — вход по SSO, фасад и записи подключений; `catalog` — статический
 * список карточек. Корп-функции включены, если задан **любой** (D-40).
 *
 * `identity` — адрес, которым именуются локальные артефакты пользователя (файл признака подключений
 * S-V15): адрес Hub, а в сборке без Hub — адрес каталога. Он всегда определён.
 */
interface Addresses {
  hub?: string
  catalog?: string
  identity: string
}

/** Результат выбора источника каталога (S-C10 п.3). */
interface LoadedCatalog {
  source: "hub" | "static" | "cache"
  version: string
  servers: CorpSchema.CatalogServer[]
  dropped: CorpSchema.Dropped[]
  cachedAt?: number
  stale: boolean
  /** Ошибка последнего опрошенного сетевого источника (S-V3): её показывает баннер витрины. */
  error?: CorpErrors.Code
}

export const corpHandlers = HttpApiBuilder.group(InstanceHttpApi, "corp", (handlers) =>
  Effect.gen(function* () {
    const authSvc = yield* Auth.Service
    const configSvc = yield* Config.Service
    const mcpSvc = yield* MCP.Service
    /**
     * Хранилище инстансов — для инвалидации провайдеров после смены ключа (см. `invalidateProviders`).
     * Берётся здесь, вместе с остальными службами группы, а не внутри обработчика: тогда это
     * требование слоя, как у `Auth`/`Config`/`MCP`, а не требование каждого запроса.
     */
    const instanceStore = yield* InstanceStore.Service

    /**
     * **Единственный** источник конфига корп-роутов (BLK-4/MAJ-E ревью `review-i4-rev113-4`).
     *
     * `configSvc.get()` — это **не кэш с инвалидацией**, а per-directory СНИМОК слитого конфига:
     * `Config.loadInstanceState` кладётся в `InstanceState`/`ScopedCache` с `capacity: Infinity` и
     * TTL `Duration.infinity` (`effect/instance-state.ts`), ключ — рабочий каталог, снимается
     * только `registerDisposer` при disposal инстанса. `Config.updateGlobal` этот снимок **не
     * обновляет**: `Config.invalidate()` делает ровно `invalidateGlobal`, то есть трогает лишь
     * TTL-кэш `getGlobal()`. Инстанс корп-роуты не диспозят никогда — `markInstanceForDisposal`
     * зовут только `PATCH /config` и `handlers/instance.ts`. Значит снимок замерзает на **первом**
     * обращении за жизнь инстанса и **структурно неспособен** показать хотя бы одну запись
     * корп-роутов: открытая до подключения витрина материализует его раньше любой записи.
     *
     * Отсюда правило, которое здесь и держится: **признак, по которому корп-роут принимает
     * решение или который он показывает как состояние ПОСЛЕ записи, обязан браться из источника,
     * который эта запись обновляет.** Корп-роуты пишут ровно один слой — глобальный
     * (`configSvc.updateGlobal`), и ровно его TTL-кэш `updateGlobal` инвалидирует. Поэтому
     * источник здесь один — `getGlobal()`, и `configSvc.get()` в корп-обработчике не употребляется
     * нигде (сторож — греп по этому файлу).
     *
     * Цена названа честно: личные слои (`opencode.json` проекта, `OPENCODE_CONFIG`) сюда не
     * входят. Для разделов, о которых спрашивают корп-роуты, это верно по существу, а не
     * компромисс: `mcp.<alias>` и `permission.<alias>_*` пишет и гасит сам корп-код в глобальном
     * файле, «Отключить»/«Убрать из списка» правят его же, а рукописная запись `mcp.<alias>` в
     * личном слое — это конфликт, о котором отдельно предупреждает `CorpDiagnostics` (S-C9 п.2), а
     * не запись, которой корп-роут вправе распоряжаться. Там, где неизвестность всё же остаётся,
     * она деградирует в сторону запрета (S-V28 п.10б) — и это утверждение теперь держится
     * охранником, а не надеждой на соседей.
     *
     * MAJ-H (errata 1.13.6, §13 п.11). Прежняя редакция этого абзаца говорила: «отсутствующая в
     * глобальном слое запись `oauthDisarmed` не закрывает, но её закрывают три другие стороны», —
     * и это было **ложью**, опровергнутой зондом на настоящих роутах. У alias, чья запись
     * `mcp.<alias>` живёт **только в личном слое** (или не существует вовсе), не срабатывает ни
     * одна из трёх: `directConnected` ложен (учётных данных нет), `server` определён (карточка в
     * каталоге есть), `nativeConnectDisabled` ложен (`facade` при заданном Hub). Браузерный шаг
     * запускался, а не запускался он лишь потому, что `MCP.startAuth` читает СЛИТЫЙ конфиг, где
     * личный слой перекрывает глобальный, — то есть держался **чужой** охранник, чего S-V28 п.5 не
     * допускает. Закрыто пятой стороной того же охранника (`entry === undefined`) и запретом
     * патчу прав создавать запись (`CorpConnectors.permissionsPatch`).
     */
    const liveConfig = Effect.fnUntraced(function* () {
      return yield* configSvc.getGlobal()
    })

    const hubUrl = () => CorpConfig.corpHubUrl()
    const catalogUrl = () => CorpConfig.corpCatalogUrl()

    /**
     * Инвалидация провайдеров после смены ключа `magnit_prod` в auth-store (S-A3, S-A14 п.4, S-C11 п.4).
     *
     * `Config.invalidate()` сбрасывает **только** кэш конфига, и одного его мало. Список провайдеров
     * и их ключи живут не в конфиге, а в состоянии инстанса (`InstanceState` в `provider/provider.ts`):
     * ключ читается из auth-store **один раз**, когда состояние строится, и после этого живой процесс
     * держит его столько, сколько живёт инстанс. Вход в уже запущенном приложении оставлял поэтому
     * состояние «ключа нет»: запрос уходил в LiteLLM без заголовка `Authorization` и возвращался
     * ошибкой «No api key passed in» — притом что ключ уже лежал в auth-store (BUG-I12-002).
     *
     * Способ — тот же, которым upstream отвечает на смену учётных данных (F6): дизпоуз инстансов.
     * Дизпоузятся **все**, а не только текущий: запись auth-store одна на процесс, а состояние
     * провайдеров — на каждый рабочий каталог, и дизпоуз одного оставил бы соседние окна с тем же
     * отказом. Ровно поэтому upstream-флоу в Desktop после `auth.set` зовёт `global.dispose()`.
     * Событие `global.disposed` доводит вторую половину флоу — оболочка перечитывает состояние сама,
     * и перезапуск не требуется (S-A3, S-C4b).
     *
     * Отказ дизпоуза не отменяет действия, ради которого его позвали (вход, выход, возврат
     * провайдера): он уходит в лог предупреждением, а не в ответ роута.
     */
    const invalidateProviders = Effect.fnUntraced(function* () {
      yield* Effect.provideService(
        disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }),
        InstanceStore.Service,
        instanceStore,
      )
    })

    /**
     * Требование Hub (S-C5): вход по SSO и ветки, идущие через Hub-фасад.
     *
     * Ревизия 1.11 (S-C10 п.7) сузила область этой проверки: витрина и каталог через неё больше не
     * проходят — им достаточно любого источника (`requireCatalog`). Здесь остались только швы, у
     * которых без Hub нет ни данных, ни адресата: вход, `{preset}` и подключение `user_token`.
     */
    const requireHub = Effect.fnUntraced(function* () {
      const url = hubUrl()
      if (!url) return yield* new CorpDisabledError({ error: "corp_disabled" })
      return url
    })

    /**
     * Требование каталога (S-C10 п.2): корп-функции включены, если задан **любой** адрес.
     *
     * Витрина, действия над локальным состоянием и разрешения вида `permission_groups` работают в
     * сборке без Hub: каталог не требует ни ключа, ни сессии, ни аудита (D-40).
     */
    const requireCatalog = Effect.fnUntraced(function* () {
      const hub = hubUrl()
      const catalog = catalogUrl()
      const identity = hub ?? catalog
      if (!identity) return yield* new CorpDisabledError({ error: "corp_disabled" })
      const addresses: Addresses = {
        ...(hub === undefined ? {} : { hub }),
        ...(catalog === undefined ? {} : { catalog }),
        identity,
      }
      return addresses
    })

    /** Ключ провайдера `magnit_prod` из auth-store (D-3); наружу не отдаётся. */
    const corpKey = Effect.fnUntraced(function* () {
      const record = yield* authSvc.get(CORP_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
      return record?.type === "api" ? record.key : undefined
    })

    /** Ключ memo каталога: инстанс (рабочий каталог + workspace) и оба адреса источников. */
    const memoKey = Effect.fnUntraced(function* (addr: Addresses) {
      const instance = yield* InstanceRef
      const workspace = yield* WorkspaceRef
      return [instance?.directory ?? "", workspace ?? "", addr.hub ?? "", addr.catalog ?? ""].join("\u0000")
    })

    /**
     * Сбрасывает memo витрины после действия, меняющего то, что витрина показывает
     * (S-V3, S-V7…S-V9, S-A3, S-A14; правило S-V28 п.10ж).
     *
     * Сбрасываются **все** записи процесса, а не запись текущего инстанса. Причина — наблюдение, а
     * не осторожность: карточки считаются по состоянию, которое у процесса ОДНО на всех, а memo
     * ключуется рабочим каталогом. Запись `magnit_prod` в auth-store одна на процесс; глобальный
     * конфиг (`configSvc.updateGlobal`, разделы `mcp` и `permission`) — один файл на пользователя;
     * файлы признака подключений и учётных данных лежат в `Global.Path.data`. Подключение,
     * выполненное в одном рабочем каталоге, наблюдаемо меняет витрину другого — а прежний
     * `memo.delete(memoKey(addr))` снимал снимок только того каталога, из которого пришёл запрос,
     * и соседнее окно ещё минуту показывало карточку «не подключён» при `configured: true` в
     * конфиге. Это тот же довод, которым `invalidateProviders` дизпоузит ВСЕ инстансы, а не текущий.
     *
     * Сброс остаётся привязан к действиям: чтения (`GET /corp/catalog`, `GET /corp/status`) его не
     * зовут, и окно свежести на повторном открытии витрины работает как прежде.
     */
    const dropMemo = Effect.fnUntraced(function* () {
      memo.clear()
      memoEpoch += 1
    })

    /** Источники каталога в порядке проб (S-C10 п.3): статический адрес, затем Hub. */
    const sourcesOf = (addr: Addresses) =>
      CorpCatalog.sources({
        ...(addr.catalog === undefined ? {} : { catalogUrl: addr.catalog }),
        ...(addr.hub === undefined ? {} : { hubUrl: addr.hub }),
      })

    /**
     * Кэш каталога в порядке источников (S-C10 п.3, S-V3): файл ключуется адресом того источника,
     * из которого каталог получен, поэтому и читается он в том же порядке, в каком пробуются
     * источники. Кэша чужого адреса тут просто нет — записи прежнего стенда не «оживают».
     */
    const readCache = Effect.fnUntraced(function* (addr: Addresses) {
      for (const source of sourcesOf(addr)) {
        const cached = yield* Effect.promise(() => CorpCatalogCache.read(source.url))
        if (cached) return cached
      }
      return undefined
    })

    // --- Вход (S-A2…S-A5) ---

    const loginStart = Effect.fn("CorpHttpApi.loginStart")(function* () {
      const url = yield* requireHub()
      const hub = CorpHub.make({ hubUrl: url })
      const started = yield* Effect.promise(() => hub.cliStart(CorpHub.clientDescriptor(InstallationVersion)))
      if (!started.ok) {
        // S-A5: наружу уходит только стабильный код (+ Retry-After), текст Hub не пересылается.
        return yield* new CorpHubError({
          error: started.code,
          ...(started.retryAfter === undefined ? {} : { retry_after: started.retryAfter }),
        })
      }
      const session = CorpLogin.store.create({
        loginId: started.data.login_id,
        pollSecret: started.data.poll_secret,
        hubUrl: url,
        expiresIn: started.data.expires_in,
      })
      // S-A6 шаг 2, S-D8: браузер открывает серверная часть — тем же механизмом, что MCP-OAuth (F15).
      // Экран входа всё равно показывает `browser_url` и код: если открыть не удалось, вход
      // продолжается вручную по ссылке.
      yield* Effect.promise(() =>
        open(started.data.browser_url)
          .then(() => undefined)
          .catch(() => undefined),
      )
      return CorpLogin.publicView(session, started.data.user_code, started.data.browser_url)
    })

    /** Общая обработка ответа Hub на опрос: сохранение ключа при `ready` (S-A3). */
    const handlePoll = Effect.fnUntraced(function* (
      session: CorpLogin.Session,
      result: CorpHub.Result<CorpSchema.CliPoll>,
    ) {
      if (!result.ok) {
        let code: CorpErrors.Code = result.code
        if (code === "hub_unavailable" || code === "litellm_unavailable") {
          session.hubErrors += 1
          // S-A4: сетевая ошибка и 502 не прекращают опрос — до пяти подряд.
          if (session.hubErrors < CorpLogin.MAX_CONSECUTIVE_HUB_ERRORS) return { status: "pending" as const }
          // Бюджет исчерпан: наружу всегда hub_unavailable, независимо от последнего кода Hub.
          code = "hub_unavailable"
          CorpLogin.store.drop(session.loginId)
        }
        if (code === "login_expired" || code === "forbidden") CorpLogin.store.drop(session.loginId)
        return {
          status: "error" as const,
          error: code,
          message: `hub responded with ${code}`,
          ...(result.retryAfter === undefined ? {} : { retry_after: result.retryAfter }),
        }
      }
      session.hubErrors = 0
      const data = result.data
      if (data.status === "pending") return { status: "pending" as const }
      if (data.status === "team_selection_required") {
        session.teams = data.teams
        return { status: "team_selection_required" as const, teams: data.teams }
      }
      yield* authSvc
        .set(CORP_PROVIDER_ID, {
          type: "api",
          key: data.key,
          metadata: CorpLogin.authMetadata({
            hubUrl: session.hubUrl,
            keyKind: data.key_kind,
            userId: data.user.user_id,
            ...(data.team_id === undefined ? {} : { teamId: data.team_id }),
          }),
        })
        .pipe(Effect.orDie)
      CorpLogin.store.drop(session.loginId)
      // S-A3: конфиг и провайдеры инвалидируются так же, как это делает upstream-флоу (F6), —
      // перезапуск не требуется. Одного `configSvc.invalidate()` для этого мало: ключи провайдеров
      // читаются из auth-store при построении состояния инстанса и кэша конфига не касаются, а
      // значит живой процесс остался бы в состоянии «ключа нет» (S-C4b, BUG-I12-002).
      yield* configSvc.invalidate()
      yield* invalidateProviders()
      // BLK-5: снимок каталога снимается тем же действием, которое сменило ключ. Карточки витрины
      // считаются ПО КЛЮЧУ — Hub отвечает каталогом и подключениями того пользователя (и той
      // команды), чьим ключом сделан запрос, — а memo живёт минуту и запись ключа его не касалась.
      // Наблюдение: витрина, открытая до повторного входа (или до выбора другой команды через
      // `POST /corp/login/poll/:id/team`, идущий сюда же), ещё минуту показывала каталог ПРЕЖНЕГО
      // ключа. Место — здесь, в общей ветке `ready`, а не в `loginPoll`: ключ пишется тут, и обе
      // ветки входа приходят сюда.
      yield* dropMemo()
      return { status: "ready" as const, user: publicUser(data.user), key_kind: data.key_kind }
    })

    const loginPoll = Effect.fn("CorpHttpApi.loginPoll")(function* (ctx: { params: { loginID: string } }) {
      yield* requireHub()
      const session = CorpLogin.store.get(ctx.params.loginID)
      if (!session)
        return {
          status: "error" as const,
          error: "login_expired" as CorpErrors.Code,
          message: "login session is unknown or expired",
        }
      const hub = CorpHub.make({ hubUrl: session.hubUrl })
      const result = yield* Effect.promise(() => hub.cliPoll(session.loginId, session.pollSecret))
      return yield* handlePoll(session, result)
    })

    const loginTeam = Effect.fn("CorpHttpApi.loginTeam")(function* (ctx: {
      params: { loginID: string }
      payload: { team_id: string }
    }) {
      yield* requireHub()
      const session = CorpLogin.store.get(ctx.params.loginID)
      if (!session)
        return {
          status: "error" as const,
          error: "login_expired" as CorpErrors.Code,
          message: "login session is unknown or expired",
        }
      const hub = CorpHub.make({ hubUrl: session.hubUrl })
      const result = yield* Effect.promise(() => hub.cliTeam(session.loginId, session.pollSecret, ctx.payload.team_id))
      return yield* handlePoll(session, result)
    })

    /** S-A9: закрытие экрана входа освобождает сессию (вместе с `poll_secret`) в памяти сервера. */
    const loginCancel = Effect.fn("CorpHttpApi.loginCancel")(function* (ctx: { params: { loginID: string } }) {
      yield* requireHub()
      const known = CorpLogin.store.get(ctx.params.loginID) !== undefined
      CorpLogin.store.drop(ctx.params.loginID)
      return { cancelled: known }
    })

    // --- Выход (S-A14) ---

    /**
     * S-A14 «Выйти»: отзыв ключа на стороне Hub (best effort) и безусловное удаление у себя.
     *
     * Гейт — `requireCatalog`, а не `requireHub`: в сборке без Hub (S-C10) выход доступен, просто
     * шага отзыва в нём нет (S-A14 п.6). Обе части выполняет общий с CLI модуль — порядок «отзыв до
     * удаления» описан ровно в одном месте.
     */
    const logout = Effect.fn("CorpHttpApi.logout")(function* () {
      yield* requireCatalog()
      const url = hubUrl()
      const outcome = yield* CorpLogout.perform({ auth: authSvc, ...(url === undefined ? {} : { hubUrl: url }) })
      // S-A14 п.8: в лог уходит факт и исход, но ни ключ, ни его часть, ни заголовок авторизации.
      // Код `revoke_error` пишется в лог **как пришёл** (S-A14 п.1, S-I1): пользователю
      // показывается наш текст по закрытому набору причин, и неизвестный код виден только здесь.
      yield* Effect.logInfo("corp logout", {
        key_removed: outcome.keyRemoved,
        hub: outcome.hub,
        ...(outcome.hubError === undefined ? {} : { hub_error: outcome.hubError }),
        ...(outcome.revokeError === undefined ? {} : { revoke_error: outcome.revokeError }),
      })
      if (outcome.removeError !== undefined)
        yield* Effect.logError("corp logout: запись auth-store не удалена", { error: outcome.removeError })
      // S-A14 п.4: конфиг и провайдеры инвалидируются тем же способом, что при входе (S-A3), —
      // перезапуск не нужен, обращение к модели сразу даёт состояние «ключа нет» (S-C4b).
      if (outcome.keyRemoved) yield* configSvc.invalidate()
      // Та же инвалидация провайдеров, что при входе (S-A3): кэш конфига их состояния не касается.
      // Отдельным условием, а не общим блоком, — порядок «инвалидация только после успешного
      // удаления» проверяется на исходнике текстом (AC-279).
      if (outcome.keyRemoved) yield* invalidateProviders()
      // BLK-5: тем же условием — снимок каталога. Витрина после выхода обязана показывать
      // «Требуется вход» (S-V4), а её карточки посчитаны по ключу, которого больше нет.
      // Наблюдение: без этой строки `GET /corp/catalog` сразу после выхода отдавал ПОЛНЫЙ каталог
      // с тем же `cached_at`, что до выхода, и «Требуется вход» появлялось только по истечении
      // окна свежести (или по `?refresh=true`). Ключа не было — снимать нечего, и снимок не
      // трогается: условие то же, что у инвалидации конфига.
      if (outcome.keyRemoved) yield* dropMemo()
      return CorpLogout.toResult(outcome)
    })

    // --- Статус (S-A11) и возврат провайдера (S-C11) ---

    /** Рабочий каталог инстанса — точка отсчёта слоёв конфига (S-C3). */
    const instanceDirectory = Effect.fnUntraced(function* () {
      const instance = yield* InstanceRef
      return instance?.directory ?? process.cwd()
    })

    /**
     * Признак «корп-провайдер выключен личным конфигом» и файл, где это записано (S-C9, S-C11 п.1).
     *
     * Считает тот же `CorpDiagnostics.inspect`, что и `opencode corp status`: второй копии разбора
     * слоёв конфига не заводится. Отсутствие поля — обычное состояние, а не «неизвестно».
     */
    const providerDisabled = Effect.fnUntraced(function* () {
      const directory = yield* instanceDirectory()
      const report = yield* Effect.promise(() =>
        CorpDiagnostics.inspect({ directory }).catch(() => CorpDiagnostics.EMPTY),
      )
      return report.providerDisabled
    })

    /**
     * S-C11 п.4 «Включить»: снимает `magnit_prod` с `disabled_providers` глобального конфига.
     *
     * Правится только тот слой, который приложение и так правит (S-C7): решение принимается по
     * **глобальному** слою — если действующая запись пришла не из него, действие не выполняется
     * вовсе, а ответ называет файл и причину. Молча править не свой слой — та же ошибка, что молча
     * править чужой конфиг.
     */
    const providerEnable = Effect.fn("CorpHttpApi.providerEnable")(function* () {
      yield* requireCatalog()
      const disabled = yield* providerDisabled()
      // Провайдер не выключен — править нечего, и это не ошибка.
      if (disabled === undefined) return { changed: false, reason: "not_disabled" as const }

      const globalConfig = yield* liveConfig()
      const patch = CorpConfig.enableProviderPatch(globalConfig.disabled_providers)
      if (patch === undefined || !isGlobalConfigFile(disabled.file))
        return { changed: false, provider_disabled: disabled, reason: "foreign_layer" as const }

      yield* configSvc.updateGlobal(patch)
      // S-C11 п.4: провайдер доступен без перезапуска — та же инвалидация, что при входе (S-A3).
      // Список провайдеров строится по `disabled_providers` один раз на инстанс, поэтому кэша
      // конфига здесь так же недостаточно, как при входе.
      yield* configSvc.invalidate()
      yield* invalidateProviders()
      // Снимок каталога здесь НЕ сбрасывается — и это проверено наблюдением, а не рассуждением:
      // `disabled_providers` не участвует ни в одном поле `CatalogView` и ни в одном поле карточки,
      // а признак «провайдер выключен» витрина берёт из `GET /corp/status`, который снимка не имеет
      // вовсе. Ответ витрины до «Включить» и её ответ с `?refresh=true` после — побайтно один и тот
      // же. Сбрасывать снимок «на всякий случай» значило бы платить походом в Hub за действие,
      // которое витрину не меняет.
      // Состояние пересчитывается заново: предупреждение исчезает потому, что исчезло состояние.
      const after = yield* providerDisabled()
      return { changed: true, ...(after === undefined ? {} : { provider_disabled: after }) }
    })

    const status = Effect.fn("CorpHttpApi.status")(function* () {
      const url = hubUrl()
      const catalog = catalogUrl()
      const key = yield* corpKey()
      // S-C10 п.2: выключено только при отсутствии обоих адресов; сборка без Hub, но с каталогом
      // остаётся корпоративной, и `hub_url` в её ответе просто отсутствует.
      if (!url && !catalog) return { enabled: false, authenticated: false }
      const cached = yield* readCache({
        ...(url === undefined ? {} : { hub: url }),
        ...(catalog === undefined ? {} : { catalog }),
        identity: url ?? catalog!,
      })
      // S-C11 п.1: признак и файл считает сервер и отдаёт одним полем — витрина, экран входа и TUI
      // берут его отсюда и сами слои конфига не разбирают.
      const disabled = yield* providerDisabled()
      const base: CorpSchema.CorpStatus = {
        ...(url === undefined ? {} : { hub_url: url }),
        enabled: true,
        authenticated: key !== undefined,
        ...(disabled === undefined ? {} : { provider_disabled: disabled }),
        ...(cached === undefined
          ? {}
          : {
              catalog_version: cached.version,
              catalog_cached_at: cached.fetchedAt,
              catalog_stale: CorpCatalogCache.isStale(cached, Date.now()),
            }),
      }
      if (!url || !key) return base
      const hub = CorpHub.make({ hubUrl: url, key })
      const health = yield* Effect.promise(() => hub.health())
      const me = yield* Effect.promise(() => hub.me())
      if (!me.ok) return { ...base, hub_reachable: health.ok, hub_error: me.code }
      return {
        ...base,
        hub_reachable: health.ok,
        // S-A13: email может быть неизвестен — тогда поле не проставляется вовсе (без `null` наружу).
        user: publicUser(me.data),
        ...(me.data.key_kind === undefined ? {} : { key_kind: me.data.key_kind }),
      }
    })

    // --- Витрина (S-V1…S-V6) ---

    /**
     * Локальные статусы MCP и записи `mcp.<alias>` конфига (S-V5).
     *
     * Источник — `liveConfig()`, а не снимок инстанса: `configured`, `mcpUrls` и `permission`
     * питают карточку, которую тот же процесс отдаёт **сразу после своей записи** («Подключить»,
     * «Отключить», «Убрать из списка», «Права» — все зовут `cardFor`). На снимке карточка после
     * «Убрать из списка» продолжала бы называть alias настроенным, а после подключения токеном —
     * не видеть собственного `mcp.<alias>.url`, то есть вторую половину признака S-V29 п.4. Сегодня
     * первое спасал `mcpSvc.status()`, второе — избыточность признака; опираться на это нельзя.
     */
    const localState = Effect.fnUntraced(function* () {
      const statuses = yield* mcpSvc.status()
      const config = yield* liveConfig()
      // S-V23: раздел `permission` — по нему считается permission_state; тот же источник, что у
      // ответа `applyPermissionGroups`, поэтому витрина и ответ действия не расходятся.
      return {
        statuses,
        configured: new Set(Object.keys(config.mcp ?? {})),
        // S-V29 п.4: адрес записи `mcp.<alias>` — половина признака «подключено прямым способом»;
        // вторая половина — применимая запись хранилища (S-V26 п.3).
        mcpUrls: Object.fromEntries(
          Object.entries(config.mcp ?? {}).map(([alias, entry]) => [
            alias,
            entry && typeof entry === "object" && "url" in entry && typeof entry.url === "string"
              ? entry.url
              : undefined,
          ]),
        ) as Record<string, string | undefined>,
        permission: config.permission,
      }
    })

    /**
     * Учётные данные прямого режима (S-V26).
     *
     * Читаются один раз на построение витрины; нечитаемый или повреждённый файл трактуется как
     * «учётных данных нет» — витрина открывается, карточки показываются, а затронутые переходят в
     * «нужно ввести токен заново» (S-V26 п.5, второй случай). Файл при этом **не** удаляется:
     * его перезаписывает следующее успешное сохранение. Ни значение токена, ни его производные в
     * предупреждение не попадают — только имя файла (S-V26 п.6).
     */
    const readCredentials = Effect.fnUntraced(function* () {
      const result = yield* Effect.promise(() => CorpCredentials.read())
      if (result.corrupted)
        yield* Effect.logWarning("corp credentials: файл учётных данных нечитаем, считается отсутствующим", {
          file: CorpCredentials.file(),
        })
      return result
    })

    /**
     * Признак «подключение состоялось» (S-V15).
     *
     * Читается один раз на построение витрины; повреждённый файл трактуется как отсутствующий и
     * пишет предупреждение в лог, не мешая открыть витрину (S-V15 п.4, AC-179).
     */
    const readConnections = Effect.fnUntraced(function* (url: string) {
      const result = yield* Effect.promise(() => CorpConnections.read(url))
      if (result.corrupted)
        yield* Effect.logWarning("corp connections: файл признака подключений нечитаем, считается отсутствующим", {
          file: CorpConnections.fileFor(url),
        })
      return result.entry
    })

    /**
     * Записывает наблюдения признака (S-V15 п.2): локальный `connected` и запись подключения Hub.
     * `connected_at` первого наблюдения не меняется, повторные подключения файл не трогают.
     */
    const rememberConnections = Effect.fnUntraced(function* (
      entry: CorpConnections.Entry,
      observations: Iterable<string>,
    ) {
      const next = CorpConnections.remember(entry, observations)
      if (!next) return entry
      yield* Effect.promise(() => CorpConnections.write(next))
      return next
    })

    /**
     * Карточки витрины по карточкам каталога (S-V5, S-V6).
     *
     * `addr.hub` здесь решает три вопроса ревизии 1.11 (S-C10 п.7–8): есть ли у карточки ссылка
     * «Открыть в Hub», доступно ли подключение `facade` и не заблокирован ли экран прав
     * Hub-зависимого вида. `addr.identity` именует файл признака подключений (S-V15 п.2).
     */
    const toCards = Effect.fnUntraced(function* (addr: Addresses, servers: CorpSchema.CatalogServer[], stale: boolean) {
      const { statuses, configured, mcpUrls, permission } = yield* localState()
      const known = new Set(servers.map((server) => server.alias))
      // S-V20: группы, выброшенные разбором словаря, — та же новость, что отброшенные карточки,
      // и доезжает до пользователя тем же полем `dropped` (`corp.connectors.partial`).
      const dropped: CorpSchema.Dropped[] = []

      // S-V15: сначала фиксируем наблюдения этого построения витрины, потом считаем по ним карточки —
      // иначе признак у только что подключённого сервера появился бы лишь со следующего открытия.
      const observations: string[] = []
      for (const server of servers)
        if (
          CorpConnections.observed({
            ...(statuses[server.alias] === undefined ? {} : { local: statuses[server.alias]!.status }),
            ...(server.connection === undefined ? {} : { connection: server.connection.status }),
          })
        )
          observations.push(server.alias)
      for (const alias of configured)
        if (!known.has(alias) && statuses[alias]?.status === "connected") observations.push(alias)
      const connections = yield* rememberConnections(yield* readConnections(addr.identity), observations)
      // S-V26 п.5, второй случай: битое или нечитаемое хранилище трактуется как «учётных данных
      // нет» — витрина открывается, карточки показываются, затронутые переходят в «нужно ввести
      // токен заново». Файл при этом **не** удаляется; предупреждение уходит в лог.
      const credentials = yield* readCredentials()

      const cards: CorpSchema.CatalogCard[] = servers.map((server) => {
        const local = statuses[server.alias]
        const permissions = CorpSchema.parsePermissionModel(server.permission_model)
        const groups = CorpSchema.parsePermissionGroups(server.permission_groups)
        if (groups && groups.dropped > 0)
          for (let index = 0; index < groups.dropped; index++)
            dropped.push({ alias: server.alias, reason: "permission_groups.group" })
        const stored = credentials.store[server.alias]
        const upstreamOf = CorpSchema.parseUpstream(server.upstream)
        const directConnected =
          CorpCredentials.applicable(stored, upstreamOf?.url) && mcpUrls[server.alias] === upstreamOf?.url
        const card = CorpStatus.compute({
          alias: server.alias,
          server,
          ...(directConnected ? { directConnected: true } : {}),
          configured: configured.has(server.alias),
          ...(local === undefined ? {} : { local: local.status }),
          ...(local && "error" in local ? { localError: local.error } : {}),
          everConnectedLocally: CorpConnections.has(connections, server.alias),
          stale,
          hubConfigured: addr.hub !== undefined,
        })
        // S-V9, S-C10 п.7: три вида модели прав подтверждаются в Hub — без его адреса экран прав
        // заблокирован с названной причиной. Вид `permission_groups` целиком локален, а непонятый
        // вид блокируется прежней причиной («модель прав не поддерживается»), и подменять её нельзя.
        const permissionsNeedHub = addr.hub === undefined && groups === undefined && permissions !== undefined
        // S-V7, S-V24 п.7, S-V28 п.2–3: способ подключения, причину его отсутствия и доступность
        // каждого способа считает один общий модуль. Ни Desktop, ни TUI второй копии проверки не
        // заводят — расхождение оболочек по вопросу «можно ли этим подключиться» исключено по
        // построению, а не соглашением.
        const connect = { server, hubConfigured: addr.hub !== undefined }
        const connectMode = CorpStatus.connectMode(connect)
        const connectModeCode = CorpStatus.connectModeUnavailableCode(connect)
        return {
          alias: server.alias,
          title: server.title,
          // Короткая суть под именем коннектора (макет заказчика от 30.08, экран 2) — данные
          // каталога, оболочка их не переводит и не выкраивает из описания.
          ...(server.summary === undefined ? {} : { summary: server.summary }),
          ...(server.description === undefined ? {} : { description: server.description }),
          ...(server.owner === undefined ? {} : { owner: server.owner }),
          ...(server.contact === undefined ? {} : { contact: server.contact }),
          ...(server.docs_url === undefined ? {} : { docs_url: server.docs_url }),
          ...(server.status === undefined ? {} : { server_status: server.status }),
          // S-V22: значение колонки «Тип» — данные каталога; деградацию `type` → `owner` → пусто
          // делает оболочка, у которой есть оба поля.
          ...(server.type === undefined ? {} : { type: server.type }),
          // S-V22: значок карточки — данные каталога; без него оболочка рисует монограмму.
          ...(server.icon === undefined ? {} : { icon: server.icon }),
          // Цвет подложки значка (макет от 30.08, экран 1) — тоже данные каталога: таблицы
          // «alias → цвет» в оболочке нет, без поля подложка остаётся нейтральной.
          ...(server.icon_color === undefined ? {} : { icon_color: server.icon_color }),
          mode: server.mode,
          mcp_url: server.mcp_url,
          // Наружу уходит разобранная модель прав; непонятый вид — как отсутствующий, экран прав
          // блокируется с причиной (S-V9, S-V14 п.3). Дословное значение остаётся в кэше.
          ...(permissions === undefined ? {} : { permission_model: permissions }),
          // S-V20: разобранный словарь групп; неразобранный — как отсутствующий, экран деградирует
          // на прежний вид по `permission_model`. S-V23: действующий режим групп считает сервер.
          ...(groups === undefined
            ? {}
            : {
                permission_groups: groups.groups,
                permission_state: CorpConnectors.permissionState(server.alias, groups.groups, permission),
                // Ревизия 1.14: экран разрешений рисует строку на инструмент, и режим каждой строки
                // считает тот же сервер тем же правилом — клиент его не выводит из режима группы.
                permission_tool_state: CorpConnectors.permissionToolState(server.alias, groups.groups, permission),
              }),
          ...(server.connection === undefined ? {} : { connection_status: server.connection.status }),
          ...(server.connection?.preset === undefined ? {} : { preset: server.connection.preset }),
          ...(card.connectNeedsHub === true ? { connect_needs_hub: true } : {}),
          ...(permissionsNeedHub ? { permissions_need_hub: true } : {}),
          connect_mode: connectMode,
          // Поле непусто **только** при `connect_mode: "none"` (S-V28 п.2): по нему оболочка
          // разводит неактивное действие (`oauth_disabled`) и прежнее поведение ревизии 1.11
          // (`facade_needs_hub`), а не по одному лишь `connect_mode`.
          ...(connectModeCode === null ? {} : { connect_mode_unavailable_code: connectModeCode }),
          auth_methods: CorpStatus.authMethodViews(connect),
          // S-V26 п.6: наружу о хранилище видно ровно это — булев признак, имя учётной записи,
          // если целевая система его назвала, и момент последней успешной проверки токена. Ни
          // значения токена, ни его длины, ни производных.
          //
          // Учётная запись и время проверки уходят наружу **только** у применимой записи (тот же
          // признак, что `has_credentials`): запись, переставшая относиться к действующему адресу
          // карточки (S-V26 п.3), рассказывала бы про подключение, которого уже нет.
          has_credentials: CorpCredentials.applicable(stored, upstreamOf?.url),
          ...(CorpCredentials.applicable(stored, upstreamOf?.url) && stored?.account !== undefined
            ? { account: stored.account }
            : {}),
          ...(CorpCredentials.applicable(stored, upstreamOf?.url) && stored?.verified_at !== undefined
            ? { verified_at: stored.verified_at }
            : {}),
          status: card.status,
          actions: card.actions,
          state: card.state,
          ever_connected: card.everConnected,
          deprecated: card.deprecated,
          blocked: card.blocked,
          configured: configured.has(server.alias),
          ...(card.error === undefined ? {} : { error: card.error }),
          ...(card.errorClass === undefined ? {} : { error_class: card.errorClass }),
          hub_url: CorpConnectors.hubServerUrl(addr.hub, server.alias),
        }
      })
      // Правило 1 S-V6: alias есть в конфиге, но пропал из каталога — карточку всё равно показываем.
      for (const alias of configured) {
        if (known.has(alias)) continue
        const local = statuses[alias]
        const card = CorpStatus.compute({
          alias,
          configured: true,
          stale,
          ...(local ? { local: local.status } : {}),
          everConnectedLocally: CorpConnections.has(connections, alias),
          hubConfigured: addr.hub !== undefined,
        })
        cards.push({
          alias,
          title: alias,
          status: card.status,
          actions: card.actions,
          state: card.state,
          ever_connected: card.everConnected,
          deprecated: false,
          blocked: card.blocked,
          configured: true,
          ...(card.error === undefined ? {} : { error: card.error }),
          ...(card.errorClass === undefined ? {} : { error_class: card.errorClass }),
          hub_url: CorpConnectors.hubServerUrl(addr.hub, alias),
        })
      }
      return { cards, dropped }
    })

    /**
     * Выбор источника каталога (S-C10 п.3, S-V3, D-42).
     *
     * Источники пробуются в фиксированном порядке — статический адрес, Hub, дисковый кэш, — а
     * источник с незаданным адресом пропускается целиком и запросом не является. Отказ источника
     * (сеть, не-2xx, неразобранный конверт) **переводит выбор на следующий** и в кэш не пишется ни
     * дословно, ни частично: одна опечатка в статическом файле не стирает последний рабочий каталог.
     */
    const loadCatalog = Effect.fnUntraced(function* (addr: Addresses, now: number) {
      let error: CorpErrors.Code | undefined

      for (const source of sourcesOf(addr)) {
        if (source.kind === "static") {
          const result = yield* Effect.promise(() => CorpCatalog.fetchStatic(source.url))
          if (!result.ok) {
            // S-V14 п.7: отказ конверта статического источника не показывается пользователю как
            // `hub_invalid_response` — он переводит выбор дальше. Но молчаливая деградация
            // запрещена так же, как молчаливо пустой экран, поэтому запись в лог обязательна.
            yield* Effect.logWarning("corp catalog: источник каталога отклонён", {
              source: source.url,
              reason: CorpCatalog.failureReason(result),
            })
            error = "hub_unavailable"
            continue
          }
          yield* Effect.promise(() =>
            CorpCatalogCache.write({
              hubUrl: source.url,
              fetchedAt: now,
              version: result.version,
              servers: result.servers,
            }),
          )
          const loaded: LoadedCatalog = {
            source: "static",
            version: result.version,
            servers: result.servers,
            dropped: result.dropped,
            cachedAt: now,
            stale: false,
          }
          return loaded
        }

        // S-V4 относится к источнику Hub и только к нему (S-C10 п.6): без ключа Hub не спрашивают.
        const key = yield* corpKey()
        if (!key) {
          error = "unauthorized"
          continue
        }
        const hub = CorpHub.make({ hubUrl: source.url, key })
        const fresh = yield* Effect.promise(() => hub.catalog())
        if (!fresh.ok) {
          error = fresh.code
          continue
        }
        yield* Effect.promise(() =>
          CorpCatalogCache.write({
            hubUrl: source.url,
            fetchedAt: now,
            version: fresh.data.version,
            servers: fresh.data.servers,
          }),
        )
        const loaded: LoadedCatalog = {
          source: "hub",
          version: fresh.data.version,
          servers: fresh.data.servers,
          dropped: fresh.dropped ?? [],
          cachedAt: now,
          stale: false,
        }
        return loaded
      }

      // Источник 3 — дисковый кэш (S-V3, D-12). Отдача из кэша даёт `source:"cache"` независимо от
      // того, каким источником кэш был наполнен.
      const cached = yield* readCache(addr)
      const fromCache: LoadedCatalog =
        cached === undefined
          ? {
              source: "cache",
              version: "",
              servers: [],
              dropped: [],
              stale: true,
              ...(error === undefined ? {} : { error }),
            }
          : {
              source: "cache",
              version: cached.version,
              servers: cached.servers,
              dropped: [],
              cachedAt: cached.fetchedAt,
              stale: CorpCatalogCache.isStale(cached, now),
              ...(error === undefined ? {} : { error }),
            }
      return fromCache
    })

    const catalog = Effect.fn("CorpHttpApi.catalog")(function* (ctx: { query: { refresh?: string } }) {
      const addr = yield* requireCatalog()
      const refresh = ctx.query.refresh === "true"
      const now = Date.now()
      // Поколение снимается ДО первого обращения к источнику: всё, что случится с конфигом, ключом
      // и локальными статусами после этой строки, обязано отменить запись результата в memo.
      const epoch = memoEpoch
      const key = yield* memoKey(addr)
      const cachedView = memo.get(key)
      if (!refresh && cachedView && now - cachedView.at < CATALOG_MEMO_MS) return cachedView.view

      // S-V4: в сборке, где единственный источник каталога — Hub, отсутствие ключа даёт состояние
      // «Требуется вход» до всякого запроса. При заданном адресе статического каталога правило не
      // срабатывает: тот источник ключа не требует вовсе (S-C10 п.6).
      if (addr.catalog === undefined) {
        const corpApiKey = yield* corpKey()
        if (!corpApiKey)
          return {
            version: "",
            source: "cache" as const,
            hub_configured: true,
            stale: true,
            servers: [],
            hub_error: "unauthorized" as const,
          }
      }

      const loaded = yield* loadCatalog(addr, now)
      const built = yield* toCards(addr, loaded.servers, loaded.stale)
      // S-V14 п.5 и S-V20: отброшенные карточки и выброшенные группы словаря — один список.
      const dropped = [...loaded.dropped, ...built.dropped]
      if (dropped.length > 0) {
        // S-V14 п.5: отброшенные карточки не исчезают молча. В лог уходят только alias и путь к
        // полю — ни тела ответа источника, ни ключа провайдера, ни `poll_secret`. Правило одно на
        // оба источника: одинаковое тело даёт одинаковые записи в логе (S-V14 п.7).
        yield* Effect.logWarning("corp catalog: cards dropped", {
          count: dropped.length,
          cards: dropped.map((entry) => ({
            ...(entry.alias === undefined ? {} : { alias: entry.alias }),
            field: entry.reason,
          })),
        })
      }

      const view: CorpSchema.CatalogView = {
        version: loaded.version,
        source: loaded.source,
        hub_configured: addr.hub !== undefined,
        ...(loaded.cachedAt === undefined ? {} : { cached_at: loaded.cachedAt }),
        stale: loaded.stale,
        servers: built.cards,
        ...(dropped.length === 0 ? {} : { dropped }),
        ...(loaded.error === undefined ? {} : { hub_error: loaded.error }),
      }
      // Memo хранит только ответ живого источника: деградация на кэш должна перепроверяться каждым
      // открытием витрины, иначе источник, вернувшийся в строй, ждал бы окна свежести.
      // …и только если за время сборки не случилось действия, меняющего показанное (см. `memoEpoch`):
      // иначе в снимок легло бы состояние ДО действия, и сброс, сделанный этим действием, пропал бы.
      if (loaded.source !== "cache" && memoEpoch === epoch) {
        // Записи других инстансов старше окна свежести больше не нужны — memo не растёт бесконечно.
        for (const [entry, value] of memo) if (now - value.at >= CATALOG_MEMO_MS) memo.delete(entry)
        memo.set(key, { at: now, view })
      }
      return view
    })

    /**
     * Карточка каталога по alias — из действующего источника (S-C10 п.3), иначе из кэша.
     * Вместе с карточкой возвращается признак протухшего источника (S-V3), нужный правилу 2 S-V6.
     */
    const serverFor = Effect.fnUntraced(function* (addr: Addresses, alias: string) {
      const loaded = yield* loadCatalog(addr, Date.now())
      return { server: loaded.servers.find((server) => server.alias === alias), stale: loaded.stale }
    })

    /**
     * Карточка каталога **только из кэша** (S-V3).
     *
     * Нужна действиям, которым обращаться к Hub запрещено: у вида `permission_groups` запроса к Hub
     * не выполняется вовсе (S-V1, D-35), а словарь групп взять всё равно откуда-то надо.
     */
    const cachedServerFor = Effect.fnUntraced(function* (addr: Addresses, alias: string) {
      const cached = yield* readCache(addr)
      if (!cached) return { server: undefined, stale: true }
      return {
        server: cached.servers.find((server) => server.alias === alias),
        stale: CorpCatalogCache.isStale(cached, Date.now()),
      }
    })

    /**
     * Статус карточки после действия витрины (S-V1, S-V6).
     *
     * Считается тем же правилом и по тем же источникам, что и `toCards`: карточка каталога берётся
     * заново (действие меняет состояние подключения в Hub), локальные данные — из `GET /mcp` и конфига.
     * Без карточки каталога сработало бы правило 1 таблицы S-V6 и статус всегда был бы `unavailable`.
     *
     * `source` — уже прочитанная карточка: им пользуются действия, которым запрещено ходить в Hub.
     */
    const cardFor = Effect.fnUntraced(function* (
      addr: Addresses,
      alias: string,
      source?: { server: CorpSchema.CatalogServer | undefined; stale: boolean },
    ) {
      const { server, stale } = source ?? (yield* serverFor(addr, alias))
      const { statuses, configured, mcpUrls } = yield* localState()
      const local = statuses[alias]
      // S-V29 п.4: то же правило, что на витрине, — состояние карточки после действия обязано
      // совпадать с тем, что покажет следующее открытие витрины.
      const upstreamOf = server === undefined ? undefined : CorpSchema.parseUpstream(server.upstream)
      const stored = (yield* readCredentials()).store[alias]
      const directConnected = CorpCredentials.applicable(stored, upstreamOf?.url) && mcpUrls[alias] === upstreamOf?.url
      // S-V15: наблюдение фиксируется и после отдельного действия — состояние карточки в ответе
      // действия обязано совпадать с тем, что покажет следующее открытие витрины.
      const observed = CorpConnections.observed({
        ...(local === undefined ? {} : { local: local.status }),
        ...(server?.connection === undefined ? {} : { connection: server.connection.status }),
      })
      const connections = yield* rememberConnections(yield* readConnections(addr.identity), observed ? [alias] : [])
      return CorpStatus.compute({
        alias,
        ...(server === undefined ? {} : { server }),
        ...(directConnected ? { directConnected: true } : {}),
        configured: configured.has(alias),
        ...(local === undefined ? {} : { local: local.status }),
        ...(local && "error" in local ? { localError: local.error } : {}),
        everConnectedLocally: CorpConnections.has(connections, alias),
        stale,
        hubConfigured: addr.hub !== undefined,
      }).status
    })

    // --- Действия витрины (S-V7…S-V9) ---

    // --- Прямое подключение токеном (S-V25, ревизия 1.13) ---

    /**
     * Прямое подключение: предпроверки без сети → проверка → обмен → сохранение → соединение
     * (S-V25). Ни Hub, ни браузера в пути нет: за всё действие приложение обращается ровно по двум
     * адресам — `verify.url` (и, если объявлен, `exchange.url`) и `upstream.url`.
     *
     * Порядок предпроверок обязателен и именно такой: способ опознаётся, проверяется его
     * доступность и применимость прямого режима, и **только потом** — само значение токена. Иначе
     * закрытый способ отвечал бы «токен слишком короткий», то есть подсказывал бы форму токена,
     * которым всё равно нельзя подключиться, и запрет читался бы как ошибка ввода.
     */
    const connectToken = Effect.fn("CorpHttpApi.connectToken")(function* (ctx: {
      params: { alias: string }
      payload: unknown
    }) {
      const addr = yield* requireCatalog()
      const alias = ctx.params.alias
      const invalid = (message: string) => new CorpInvalidRequestError({ error: "invalid_request", message })

      // Предпроверка 1: alias отсутствует в действующем каталоге.
      const { server } = yield* serverFor(addr, alias)
      if (!server) return yield* new CorpNotFoundError({ error: "not_found" })

      // Предпроверка 2: опознание способа. Тело не объект, `token` не строка, способ не назван при
      // нескольких применимых или назван неизвестный — всё это «непонятно, что делать», и
      // различать эти случаи пользователю не требуется.
      const body =
        typeof ctx.payload === "object" && ctx.payload !== null && !Array.isArray(ctx.payload)
          ? (ctx.payload as Record<string, unknown>)
          : undefined
      if (!body) return yield* invalid("request body must be an object")
      const token = body["token"]
      if (typeof token !== "string") return yield* invalid("token must be a string")
      const methodId = body["method"]
      if (methodId !== undefined && typeof methodId !== "string") return yield* invalid("method must be a string")

      const methods = CorpStatus.authMethods({ server, hubConfigured: addr.hub !== undefined })
      let chosen: (typeof methods)[number] | undefined
      if (methodId === undefined) {
        const applicable = methods.filter((entry) => entry.method.type === "user_token")
        if (applicable.length !== 1)
          return yield* invalid(
            applicable.length === 0 ? "connector has no token method" : "method is required: several token methods",
          )
        chosen = applicable[0]
      } else {
        chosen = methods.find((entry) => entry.method.id === methodId)
        if (!chosen) return yield* invalid(`unknown auth method: ${methodId}`)
      }

      // Предпроверка 3: способ недоступен (S-V28 п.5). Отказ выдаётся **до** проверки типа способа
      // и до единого исходящего запроса: закрытый `oauth2` обязан отвечать `409` с названной
      // причиной, а не `400` о форме тела (AC-311).
      if (!chosen.availability.available)
        return yield* new CorpAuthMethodUnavailableError({
          error: "auth_method_unavailable",
          unavailable_code: chosen.availability.unavailableCode ?? "catalog_unavailable",
          message: `auth method "${chosen.method.id}" is not available`,
        })
      if (chosen.method.type !== "user_token") return yield* invalid(`auth method "${chosen.method.id}" takes no token`)

      // Предпроверка 4: у карточки не разобран `upstream` — прямым режимом она не подключается.
      const upstream = CorpSchema.parseUpstream(server.upstream)
      if (!upstream)
        return yield* new CorpDirectUnavailableError({
          error: "direct_unavailable",
          message: `connector "${alias}" has no upstream block`,
        })

      // Предпроверка 5: значение токена. Прочих проверок значения нет: годность токена решает
      // целевая система, а не догадка о его виде.
      const field = chosen.method.field
      if (token === "") return yield* invalid("token must not be empty")
      if (field?.min_length !== undefined && token.length < field.min_length)
        return yield* invalid(`token must be at least ${field.min_length} characters`)
      if (field?.max_length !== undefined && token.length > field.max_length)
        return yield* invalid(`token must be at most ${field.max_length} characters`)

      // Проверка — ровно один запрос (S-V25 п.2). Значение токена в лог не пишется никогда.
      const verified = yield* Effect.promise(() => CorpDirect.verify(chosen!.method, token))
      if (verified.result !== "verified") {
        // S-V26 п.6: в лог идут alias, адрес без строки запроса и код ответа; тела ответа целевой
        // системы в логе нет.
        yield* Effect.logWarning("corp connect-token: проверка токена не удалась", {
          alias,
          url: urlWithoutQuery(chosen.method.verify?.url),
          result: verified.result,
          ...(verified.status === undefined ? {} : { status: verified.status }),
        })
        // При любом исходе, кроме `verified`, роут **ничего не пишет**: ни `mcp.<alias>` в конфиг,
        // ни записи в хранилище, ни признака «подключение состоялось».
        return {
          alias,
          status: yield* cardFor(addr, alias),
          auth_method: chosen.method.id,
          verify_result: verified.result,
          ...(verified.status === undefined ? {} : { verify_status: verified.status }),
          exchange_result: null,
          credentials_saved: false,
        }
      }

      // Момент успешной проверки — засекается ЗДЕСЬ, сразу после ответа целевой системы, а не в
      // момент записи файла: между ними лежит обмен токена, у которого свой сетевой запрос
      // (макет заказчика от 30.08, экран 3 — «проверен сегодня в 21:40»).
      const verifiedAt = new Date().toISOString()

      // Обмен — не более одного запроса, и он не отменяет подключение (S-V25 п.5). Способ без
      // блока `exchange` даёт `null`: отсутствие обмена — не исход и не предупреждение.
      const exchanged =
        chosen.method.exchange === undefined
          ? undefined
          : yield* Effect.promise(() => CorpDirect.exchange(chosen!.method, token))
      const issued = exchanged?.result === "exchanged"

      // (а) Учётные данные — в хранилище. Отказ записи прекращает действие (S-V26 п.5).
      const record: CorpCredentials.Record_ = {
        upstream_url: upstream.url,
        method_id: chosen.method.id,
        token: issued ? exchanged!.token! : token,
        ...(issued && exchanged!.token_id !== undefined ? { token_id: exchanged!.token_id } : {}),
        issued,
        ...(verified.account === undefined ? {} : { account: verified.account }),
        verified_at: verifiedAt,
        saved_at: new Date().toISOString(),
        credential_headers: upstream.credential_headers,
        ...(upstream.static_headers === undefined ? {} : { static_headers: upstream.static_headers }),
      }
      const saved = yield* Effect.promise(() => CorpCredentials.save(alias, record))
      if (!saved.ok)
        return yield* new CorpStorageUnavailableError({
          error: "storage_unavailable",
          message: `could not save credentials: ${saved.error}`,
        })
      // Отказ `chmod` — не отказ хранения (S-V26 п.5, третий случай): запись состоялась, а
      // предупреждение с именем файла уходит в лог.
      if (saved.chmodFailed)
        yield* Effect.logWarning("corp credentials: права файла хранилища не выставлены", {
          file: CorpCredentials.file(),
        })
      // S-V26 п.6: в лог идёт **имя** учётного заголовка и не идёт его значение.
      yield* Effect.logInfo("corp connect-token: учётные заголовки сохранены", {
        alias,
        headers: Object.keys(upstream.credential_headers),
        issued,
      })

      // (б) Патч конфига — с `oauth: false` (MAJ-C: у записи без этого ключа MCP-OAuth остаётся
      // вооружённым, и цепочка `native` достижима по upstream-роуту `POST /mcp/:alias/auth/
      // authenticate`; блока `oauth` со `scope` в прямом режиме по-прежнему нет, D-57) и **без**
      // ключа `headers` (D-60, S-V26 п.2).
      // Адрес берётся из `upstream.url`, а не из `mcp_url`: у `facade`-карточки `mcp_url` указывает
      // на прокси Hub, и подставить его сюда значило бы вернуть Hub в путь, из которого его убрали.
      const patch = CorpConnectors.directConnectPatch(alias, upstream.url)
      const entry = patch.mcp[alias]!
      yield* configSvc.updateGlobal(patch)
      // (в) Соединение MCP. Учётные заголовки подставляются при создании транспорта (S-V26 п.4).
      yield* mcpSvc.add(alias, entry).pipe(Effect.catch(() => Effect.void))
      yield* dropMemo()

      return {
        alias,
        status: yield* cardFor(addr, alias),
        auth_method: chosen.method.id,
        verify_result: verified.result,
        ...(verified.status === undefined ? {} : { verify_status: verified.status }),
        ...(verified.account === undefined ? {} : { account: verified.account }),
        exchange_result: exchanged?.result ?? null,
        credentials_saved: true,
      }
    })

    /**
     * Отказ браузерного шага — в канал ошибок, а не в дефект (S-V19, S-Q9; BUG фасадного подключения).
     *
     * `MCP.startAuth` завершает попытку `Effect.die(error)` на всём, что не является ожидаемым
     * `UnauthorizedError` (`mcp/index.ts`): отказ DCR, недоступный сервер, ответ не той формы. Дефект
     * идёт мимо канала ошибок, поэтому `Effect.catch` вокруг вызова его не ловил, и роут отвечал
     * `500 UnknownError` — «Unexpected server error», то есть текстом про поломку приложения там, где
     * на самом деле не ответила целевая система. Наблюдение на стенде: `POST …/connect` фасадной
     * карточки → `500 {"name":"UnknownError"}`, в логе — `ServerError` из `registerClient`.
     *
     * Чинится **на стороне корп-кода**, а не в `mcp/index.ts`, и причина названа: типизированный
     * отказ `startAuth` расширил бы канал ошибок upstream-роута `POST /mcp/:A/auth/authenticate`, а
     * его файл править запрещено (S-V28 п.5, AC-345). Дефект здесь не проглатывается: его текст
     * доезжает до поля `error` ответа и до класса отказа `error_class` (S-V19) ровно тем же путём,
     * каким доезжал бы обычный отказ, — пользователь получает человеческий текст класса, а
     * техническая строка остаётся в подсказке.
     */
    const authFailure = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
      effect.pipe(Effect.catchDefect((defect: unknown) => Effect.fail(defect)))

    const connect = Effect.fn("CorpHttpApi.connect")(function* (ctx: {
      params: { alias: string }
      /**
       * Тела может не быть вовсе (S-V7 шаг 1): у «Подключить» без выбранного пресета клиент
       * пустой слот выбрасывает и шлёт `POST` без `body`. Отсутствие тела и `{}` значат одно и то
       * же — пресет не выбран, берётся умолчание.
       */
      payload: { preset?: string } | null
    }) {
      const addr = yield* requireCatalog()
      const alias = ctx.params.alias
      const { server } = yield* serverFor(addr, alias)
      if (!server)
        return {
          alias,
          status: "unavailable" as const,
          hub_error: "not_found" as const,
          // S-V19: карточки нет — значит нет ни `mcp_url`, ни режима, подключать этим способом нечем.
          error_class: CorpErrors.connectErrorClass({ code: "not_found" }),
        }

      // S-V28 п.5 (микроревизия 1.13.1): у закрытой `native`-карточки действие отвергается **до**
      // записи `mcp.<alias>` и до единого исходящего запроса — ни discovery, ни DCR, ни
      // `authorize`, ни `token`, ни открытия браузера. Запрос, посланный мимо интерфейса, получает
      // тот же отказ, что и кнопка: запрет программный, а не косметический.
      //
      // Спрашивается **признак** `nativeConnectDisabled` (S-V28 п.2, п.7), а не производный от него
      // код причины карточки: `connect_mode_unavailable_code` равен `null` у любой карточки, чей
      // `connect_mode` вычислился не в `"none"`, — в том числе у `native`-карточки с разобранным
      // `upstream` и доступным способом `user_token` (строка 1 таблицы S-V7 даёт `"direct"`).
      // Охранник на коде причины такую карточку пропускал бы к шагу 2 S-V7, то есть к штатному
      // MCP OAuth с браузером. У предиката пути стать `null` нет.
      const connectInput = { server, hubConfigured: addr.hub !== undefined }
      if (CorpStatus.nativeConnectDisabled(connectInput))
        return yield* new CorpAuthMethodUnavailableError({
          error: "auth_method_unavailable",
          unavailable_code: "oauth_disabled",
          message: `connector "${alias}" cannot be connected: OAuth is disabled in this build`,
        })

      // S-V29 п.1: один alias — одно подключение. Пока у alias есть действующие прямые учётные
      // данные, подключить его фасадным способом нельзя: смена способа означает смену того, кто
      // хранит учётные данные, и молча приложение её не делает.
      const upstreamUrl = CorpSchema.parseUpstream(server.upstream)?.url
      const stored = (yield* readCredentials()).store[alias]
      if (CorpCredentials.applicable(stored, upstreamUrl))
        return yield* new CorpBadRequestError({ error: "direct_connected" })

      // S-V7, S-C10 п.8: `native` подключается штатным MCP OAuth клиента и Hub в этом не участвует
      // никогда. `facade` подключается способом `user_token` через Hub-фасад — без адреса Hub этот
      // способ недоступен: шаг 1 не выполняется и запись `mcp.<alias>` не создаётся.
      if (addr.hub === undefined && server.mode === "facade")
        return yield* new CorpBadRequestError({ error: "facade_needs_hub" })

      const preset = ctx.payload?.preset ?? CorpStatus.DEFAULT_PRESET
      const patch = CorpConnectors.connectPatch(server, preset)
      // Шаг 1 (D-7): персист через updateGlobal, а не через runtime-only POST /mcp/:name/connect (F17).
      yield* configSvc.updateGlobal(patch)
      yield* mcpSvc.add(alias, patch.mcp[alias])
      yield* dropMemo()

      // Шаг 2: штатный MCP-OAuth сервера — браузер и ожидание callback 19876 (F15/F16).
      const status = yield* authFailure(mcpSvc.authenticate(alias)).pipe(
        Effect.catch((error) => Effect.succeed({ status: "failed" as const, error: String(error) })),
      )
      if (status.status === "failed" || status.status === "needs_client_registration") {
        // Шаг 4: запись mcp.<alias> остаётся, чтобы повтор был в один клик. Признак «подключение
        // состоялось» (S-V15) при этом не выставляется — попытка не удалась.
        // S-V19: ошибка не остаётся необъяснённой — класс определяется всегда, в том числе `unknown`.
        return {
          alias,
          status: yield* cardFor(addr, alias),
          error: status.error,
          error_class: CorpErrors.connectErrorClass({
            local: status.status,
            ...(status.error === undefined ? {} : { message: String(status.error) }),
            // S-V19 (ревизия 1.14), S-Q9, BUG-I14-001: класс считается по тем же признакам, что и у
            // карточки каталога (`corp/status.ts::compute`), — правило одно на оба места. Признаки
            // идут парой: у `mode:"facade"` за `mcp_url` стоит сам Hub, но назвать его можно только
            // когда адрес Hub в сборке задан (D-43). Без них тот же отказ того же alias получал
            // здесь `network_unreachable`/`upstream_unavailable`, а на карточке — `hub_unreachable`:
            // тост Desktop советовал «включите VPN», а витрина секундой позже — «Hub не отвечает».
            mode: server.mode,
            hubConfigured: connectInput.hubConfigured,
          }),
        }
      }
      return { alias, status: yield* cardFor(addr, alias) }
    })

    /**
     * Отзыв выпущенного токена и удаление записи хранилища (S-V27 п.2, п.3).
     *
     * Отзыв выполняется **перед** локальными шагами и только если он возможен: у способа объявлен
     * блок `revoke` **и** токен выпущен приложением (`issued: true`). Чужой токен приложение не
     * отзывает — он принадлежит учётной записи пользователя и мог быть выпущен для других задач;
     * приложение его только **забывает**.
     *
     * Запись хранилища удаляется **всегда** — независимо от исхода отзыва, включая `not_revoked` и
     * `unreachable` (тот же принцип, что D-49: удаление у себя — обязательство, отзыв — best
     * effort). Удаляется ровно запись этого alias.
     *
     * Карточка берётся **из кэша** каталога: обращаться к Hub этому действию запрещено (S-V27 п.1),
     * а блок отзыва взять всё равно откуда-то надо.
     */
    const revokeCredentials = Effect.fnUntraced(function* (addr: Addresses, alias: string) {
      const record = (yield* readCredentials()).store[alias]
      if (!record) return { revoke: "skipped" as CorpSchema.RevokeResult, direct: false }
      const cached = yield* cachedServerFor(addr, alias)
      const method = CorpSchema.parseAuthMethods(cached.server?.auth_methods).find(
        (entry) => entry.id === record.method_id,
      )
      const outcome = yield* Effect.promise(() => CorpDirect.revoke(method, record))
      if (outcome.result === "not_revoked" || outcome.result === "unreachable")
        // Неуспех отзыва — предупреждение, а не ошибка: локальная часть выполнена в любом случае.
        yield* Effect.logWarning("corp disconnect: отозвать выпущенный токен не удалось", {
          alias,
          result: outcome.result,
          ...(outcome.status === undefined ? {} : { status: outcome.status }),
        })
      yield* Effect.promise(() => CorpCredentials.remove(alias))
      return { revoke: outcome.result, direct: true }
    })

    const disconnect = Effect.fn("CorpHttpApi.disconnect")(function* (ctx: { params: { alias: string } }) {
      const addr = yield* requireCatalog()
      const alias = ctx.params.alias
      // S-V27 п.1: у прямо подключённой карточки перед локальными шагами выполняется отзыв.
      const revoked = yield* revokeCredentials(addr, alias)
      yield* mcpSvc.removeAuth(alias)
      yield* mcpSvc.disconnect(alias).pipe(Effect.catch(() => Effect.void))
      yield* configSvc.updateGlobal(CorpConnectors.disconnectPatch(alias))
      yield* dropMemo()

      const key = yield* corpKey()
      let hubError: CorpErrors.Code | undefined
      // S-C10 п.7: при незаданном адресе Hub шаг **пропускается**, а не считается отказом Hub —
      // ни предупреждения, ни поля `hub_error`. «Нечего звать» и «позвали, не ответил» — разное.
      // S-V27 п.1: у прямо подключённой карточки этого шага **нет вовсе** при любом адресе Hub —
      // подключение живёт целиком у пользователя, и Hub о нём ничего не знает.
      if (key && addr.hub !== undefined && !revoked.direct) {
        const hub = CorpHub.make({ hubUrl: addr.hub, key })
        const removed = yield* Effect.promise(() => hub.removeConnection(alias))
        // S-V8: отказ Hub не откатывает локальные шаги, но показывается предупреждением.
        if (!removed.ok) hubError = removed.code
      }
      return {
        alias,
        status: "not_connected" as const,
        // Поле `revoke` — свойство **прямого** подключения (S-V27 п.1): у карточки, у которой
        // учётных данных не было вовсе, отзывать нечего и говорить не о чем, поэтому поля нет.
        // Прежние ответы «Отключить» ревизией 1.13 не переформулированы (AC-62, AC-175).
        ...(revoked.direct ? { revoke: revoked.revoke } : {}),
        ...(hubError === undefined ? {} : { hub_error: hubError }),
      }
    })

    /**
     * S-V17 «Убрать из списка».
     *
     * Смысл действия — «я больше не хочу видеть этот сервер подключённым у себя»: оно доводит до
     * конца отключение и **удаляет** запись `mcp.<alias>` из конфига, чего «Отключить» не делает.
     * Отказ Hub на последнем, необязательном шаге локальные шаги не откатывает: локальное состояние
     * пользователя приведено в порядок в любом случае (AC-176).
     */
    const forget = Effect.fn("CorpHttpApi.forget")(function* (ctx: { params: { alias: string } }) {
      const addr = yield* requireCatalog()
      const alias = ctx.params.alias
      // S-V27 п.4: «Убрать из списка» делает то же, что «Отключить», и дополнительно удаляет ключ
      // `mcp.<alias>` и запись признака подключений. Отзыв идёт теми же четырьмя исходами.
      const revoked = yield* revokeCredentials(addr, alias)
      // Шаг 1: те же локальные шаги, что у S-V8.
      yield* mcpSvc.removeAuth(alias)
      yield* mcpSvc.disconnect(alias).pipe(Effect.catch(() => Effect.void))
      // Шаг 2: ключ `mcp.<alias>` удаляется целиком; прочий конфиг пользователя не трогается (S-C7).
      yield* configSvc.updateGlobal(CorpConnectors.forgetPatch(alias))
      // Шаг 3: признак «подключение состоялось» снимается — единственный способ его снять (S-V15 п.3).
      const connections = yield* readConnections(addr.identity)
      const without = CorpConnections.forget(connections, alias)
      if (without) yield* Effect.promise(() => CorpConnections.write(without))
      yield* dropMemo()

      // Шаг 4 необязателен: без ключа и при недоступном Hub он пропускается, а не откатывает шаги 1–3.
      // При незаданном адресе Hub шага 4 **не существует** (S-C10 п.7): предупреждение о
      // недоступности Hub в сборке, где Hub не настроен, — ложная тревога.
      const key = yield* corpKey()
      let hubError: CorpErrors.Code | undefined
      // S-V27 п.1: у прямо подключённой карточки шага обращения к Hub нет вовсе (п.4 отсылает к
      // тем же правилам): подключение живёт целиком у пользователя.
      if (key && addr.hub !== undefined && !revoked.direct) {
        const hub = CorpHub.make({ hubUrl: addr.hub, key })
        const removed = yield* Effect.promise(() => hub.removeConnection(alias))
        if (!removed.ok) hubError = removed.code
      }
      return {
        alias,
        status: "not_connected" as const,
        removed: true,
        ...(revoked.direct ? { revoke: revoked.revoke } : {}),
        ...(hubError === undefined ? {} : { hub_error: hubError }),
      }
    })

    /**
     * S-V21: применение режимов групп записью в раздел `permission` глобального конфига.
     *
     * Hub в этом не участвует вовсе (D-35): ни запроса, ни `oauth.scope`, ни повторной авторизации.
     * Запись — детерминированная перезапись всего блока alias двумя вызовами `updateGlobal` в
     * строго этом порядке; правило порядка ключей внутри блока держит `permissionGroupsPatch`.
     */
    const applyPermissionGroups = Effect.fnUntraced(function* (
      addr: Addresses,
      alias: string,
      modes: Record<string, CorpSchema.PermissionMode>,
      tools: Record<string, CorpSchema.PermissionMode> | undefined,
    ) {
      // Словарь берётся из кэша каталога, а не из Hub: «запрос к Hub не выполняется вовсе» (S-V1)
      // относится и к чтению — экран разрешений открывается с витрины, которая кэш только что
      // перезаписала (S-V3).
      const source = yield* cachedServerFor(addr, alias)
      const parsed =
        source.server === undefined ? undefined : CorpSchema.parsePermissionGroups(source.server.permission_groups)
      // Словаря нет — применять режимы не к чему: состав ключей выводится только из него.
      if (!parsed) return yield* new CorpBadRequestError({ error: "permission_groups_unavailable" })

      // Ключи берутся из **глобального** конфига: правится именно он, а гасить `undefined` имеет
      // смысл только то, что в этом файле действительно лежит.
      const globalConfig = yield* liveConfig()
      const patch = CorpConnectors.permissionGroupsPatch(alias, {
        groups: parsed.groups,
        modes,
        ...(tools === undefined ? {} : { tools }),
        existing: Object.keys(globalConfig.permission ?? {}),
      })
      yield* configSvc.updateGlobal(patch.clear)
      yield* configSvc.updateGlobal(patch.write)
      yield* dropMemo()

      // Состояние считается по конфигу **после** записи — и тем же правилом, что на витрине (S-V23).
      // MAJ-E: требование «после записи» держится только тем, что источник — `liveConfig()`, то есть
      // тот самый слой, который две строки выше перезаписали и чей кэш `updateGlobal` инвалидировал.
      // Снимок инстанса (`configSvc.get()`) здесь давал «вчерашнее» ВСЕГДА, а не при неудачном
      // порядке: ветка `{modes}` требует кэша каталога и без предшествующего чтения витрины отвечает
      // `400`, то есть снимок гарантированно материализуется раньше записи.
      const config = yield* liveConfig()
      return {
        alias,
        status: yield* cardFor(addr, alias, source),
        reauth_required: false,
        permission_state: CorpConnectors.permissionState(alias, parsed.groups, config.permission),
        permission_tool_state: CorpConnectors.permissionToolState(alias, parsed.groups, config.permission),
      }
    })

    const permissions = Effect.fn("CorpHttpApi.permissions")(function* (ctx: {
      params: { alias: string }
      payload: {
        preset?: string
        groups?: string[]
        modes?: Record<string, CorpSchema.PermissionMode>
        tools?: Record<string, CorpSchema.PermissionMode>
      }
    }) {
      const addr = yield* requireCatalog()
      const alias = ctx.params.alias
      // S-V1: два вида тела взаимоисключающи. Оба сразу — ошибка запроса, и ничего не записывается:
      // молча предпочесть один вид значило бы применить не то, о чём просил клиент.
      // `tools` — не третий вид тела, а спутник `modes`, поэтому с `preset` он несовместим тем же
      // правилом: «режимы инструментов плюс пресет Hub» — тело, о смысле которого нельзя догадаться.
      if (ctx.payload.preset !== undefined && (ctx.payload.modes !== undefined || ctx.payload.tools !== undefined))
        return yield* new CorpBadRequestError({ error: "conflicting_body" })
      // Ни того, ни другого: прежде такое тело отвергала схема (`preset` был обязателен), и оно
      // обязано отвергаться и теперь — молчаливый `readonly` по умолчанию снял бы права, о которых
      // никто не просил. Одни лишь `tools` — тоже «нет тела»: без `modes` неизвестен режим
      // wildcard, а запись блока детерминирована и обязана записать его явно (S-V21).
      if (ctx.payload.preset === undefined && ctx.payload.modes === undefined)
        return yield* new CorpBadRequestError({ error: "missing_body" })

      // Ветка `modes` уходит до чтения каталога из Hub: в ней Hub не участвует ни на шаг (D-35).
      // Она же — единственная, работающая в сборке без Hub (S-C10 п.7): вид `permission_groups`
      // целиком локален и от источника каталога не зависит.
      const tools = ctx.payload.tools
      if (ctx.payload.modes !== undefined) return yield* applyPermissionGroups(addr, alias, ctx.payload.modes, tools)

      // Тело `{preset}` подтверждается в Hub (S-V9): без его адреса роут отвечает отказом с
      // названной причиной и **ничего не записывает** ни в конфиг, ни в Hub (S-C10 п.7).
      if (addr.hub === undefined) return yield* new CorpBadRequestError({ error: "permissions_need_hub" })
      const hubAddress = addr.hub

      const { server } = yield* serverFor(addr, alias)
      const preset = ctx.payload.preset ?? CorpStatus.DEFAULT_PRESET
      const key = yield* corpKey()
      if (!key)
        return {
          alias,
          status: yield* cardFor(addr, alias),
          preset,
          reauth_required: false,
          hub_error: "unauthorized" as const,
        }

      const hub = CorpHub.make({ hubUrl: hubAddress, key })
      const updated = yield* Effect.promise(() => hub.setPermissions(alias, preset, ctx.payload.groups))
      if (!updated.ok)
        return {
          alias,
          status: yield* cardFor(addr, alias),
          preset,
          reauth_required: false,
          hub_error: updated.code,
        }

      const previous = server?.connection?.preset
      const reauth = CorpConnectors.needsReauth(previous, preset, updated.data.status)

      // BLK-3 (ревью `review-i4-rev113-3`), признак **способа** подключения. Спрашивается наличие
      // учётных данных, а не режим карточки: у `facade`-карточки с разобранным `upstream` и
      // способом `user_token` строка 1 таблицы S-V7 даёт `connect_mode == "direct"`, поэтому
      // предикат уровня карточки (`nativeConnectDisabled`) прямое подключение не видит по
      // построению — он отвечает про режим, а действие относится к способу.
      //
      // Условие **слабее**, чем `CorpCredentials.applicable(stored, upstreamUrl)` соседнего роута
      // `connect`, и это намеренно: там признак решает «занят ли alias», здесь — «можно ли трогать
      // ключ `oauth` и открывать браузер», и по S-V28 п.10б неизвестное деградирует в сторону
      // запрета. Каталог сменил адрес сервера — запись перестала быть применимой, но
      // `mcp.<alias>.url` по-прежнему указывает на целевую систему, и перевооружать её нельзя тем
      // более.
      const stored = (yield* readCredentials()).store[alias]
      const directConnected = stored !== undefined
      // Действующая запись alias. Нужна и патчу, и охраннику браузерного шага ниже: разоружение
      // D-63 живёт в записи и переживает свой признак — «Отключить» удаляет учётные данные, оставляя
      // `{enabled:false, url:<адрес целевой системы>, oauth:false}`, а нечитаемый файл хранилища по
      // S-V26 п.5 считается «данных нет».
      //
      // BLK-4: источник записи — `liveConfig()`, то есть тот слой, который «Отключить» и патч прав
      // и правят. Прежнее чтение снимка инстанса делало этот охранник **неспособным** увидеть
      // разоружение: снимок замерзает на первом обращении, а витрина, открытая до подключения,
      // материализует его раньше любой записи — и после «Отключить» охранник видел запись, которой
      // уже нет, перевооружал `mcp.<alias>.oauth` и запускал браузерный шаг. Ссылка на то, что
      // «эффективный конфиг читает `mcp/index.ts`», снята намеренно: `mcp/index.ts` читает тот же
      // замороженный снимок, а по S-V28 п.5 запрет обязан жить в корп-роуте и на чужой охранник не
      // опираться.
      const entry = (yield* liveConfig()).mcp?.[alias]

      // MAJ-H (errata 1.13.6, §13 п.11): `entry !== undefined` — не украшение, а запрет создавать
      // **обрывок**. Патч правит существующую запись; у alias, которого в глобальном слое нет
      // (никогда не подключался, либо запись живёт только в личном слое, которого корп-код не
      // пишет), он заводил `mcp.<alias> = {oauth:{scope}}` — без `type` и без `url`. Такая запись
      // MCP-сервером не является, и `ConfigParse.schema` на ней БРОСАЕТ `ConfigInvalidError`
      // синхронно внутри `Effect.fnUntraced`, то есть **дефектом**, мимо `orElseSucceed` в
      // `Config.loadGlobal`: роут отвечал `500` с пустым телом, а следующий `GET /corp/catalog` —
      // тоже `500`, потому что глобальный конфиг оставался нечитаемым до правки файла руками
      // (воспроизведено зондом на настоящих роутах, оба случая — и с личным слоем, и без записи
      // вовсе). Условие то же самое, по которому ниже закрыт браузерный шаг, и берётся из того же
      // прочитанного `entry`: одно значение одного слоя — два решения.
      if (server && entry !== undefined) {
        // Патч правит **существующую** запись, поэтому ему передаётся и способ подключения, и сама
        // запись.
        const patch = CorpConnectors.permissionsPatch(server, preset, { directConnected, current: entry })
        if (patch) yield* configSvc.updateGlobal(patch)
      }
      yield* dropMemo()

      // S-V28 п.5, третья строка (микроревизия 1.13.1): у карточки, закрытой запретом, шаг 2
      // правила S-V7 **не запускается** — браузер не открывается и ни одного исходящего запроса по
      // OAuth-адресам MCP-сервера нет. Ответ при этом прежний и несёт `reauth_required: true`:
      // причину экран берёт из `connect_mode_unavailable_code` карточки, которая у него уже есть.
      // Запись прав в Hub выполнена выше — закрыт **браузерный шаг**, а не выбор пресета.
      //
      // Признак тот же и спрашивается так же, как в `connect`: `nativeConnectDisabled`, а не
      // производный код причины карточки, у которого есть путь стать `null` при `connect_mode`,
      // вычисленном не в `"none"` (см. охранник `connect`).
      //
      // **Карточки нет — шаг 2 не запускается.** Этот роут — единственный из трёх, который при
      // отсутствующем alias не прекращает действие: `connect-token` отвечает `404`, `connect` —
      // `unavailable/not_found`, а здесь ветка `{preset}` осмысленна и без карточки (права пишет
      // Hub, а карточка нужна лишь для патча конфига и ответа). Поэтому сторона деградации
      // называется **здесь**: режим карточки, которой нет, **неизвестен**, а неизвестный признак
      // по S-V28 п.10б деградирует в сторону запрета. Иначе достижим обход: у alias локально
      // осталась запись `mcp.<alias>`, а карточка из каталога исчезла (убрал администратор либо
      // отбросил разбор S-V14 — для рукописного статического каталога S-C10 п.3 это рядовое
      // событие), Hub отвечает `needs_reauth` — и запрещённый браузерный шаг S-V7 запускается на
      // карточке, о режиме которой не известно ничего. Цена названа S-V28 п.9: повторная
      // авторизация из экрана прав для такого alias не работает — как и для закрытой карточки.
      //
      // **Прямое подключение — третья сторона того же охранника** (BLK-3). У прямого способа
      // браузерного шага нет по определению (S-V25 п.8): учётные данные пользователь ввёл сам,
      // OAuth в этом способе не участвует, а `mcp.<alias>.url` указывает на целевую систему — то
      // есть запуск шага 2 здесь и есть та самая цепочка `native`, которую запрет закрывает.
      // Признак спрашивается у **способа** подключения (учётные данные), а не у режима карточки:
      // режим у такой карточки `facade`, и предикат про режим честно отвечает «не запрещено».
      //
      // Четвёртая сторона — **разоружённая запись** (`CorpConnectors.oauthDisarmed`). Она нужна
      // отдельно от учётных данных: после «Отключить» запись остаётся с `oauth:false` и адресом
      // целевой системы, а учётных данных уже нет, — и признак способа такой alias не ловит. Звать
      // на нём `authenticate` бессмысленно и опасно: сегодня попытку останавливает охранник
      // `MCP.startAuth` (`mcp/index.ts`, D-63), но корп-роут не вправе опираться на чужой охранник
      // как на единственный (S-V28 п.5: запрет живёт в корп-роутах). Условие записано один раз — в
      // `oauthDisarmed`, его же спрашивает патч прав (S-V28 п.3).
      // Пятая сторона — **записи нет в источнике решения** (MAJ-H, §13 п.11, S-V28 п.10б).
      // Глобальный слой — единственный источник решений корп-роутов, и запись, которой в нём нет,
      // оставляет состояние alias **неизвестным**: она может не существовать вовсе, а может жить в
      // личном слое, которого корп-код не пишет и не вправе трактовать. Неизвестное — запрет, и
      // сторона деградации названа здесь, а не подразумевается: до этой правки такой alias проходил
      // ВСЕ четыре условия и браузерный шаг запускался. Останавливал его только охранник
      // `MCP.startAuth`, читающий слитый конфиг, — чужой охранник, на который корп-роуту опираться
      // запрещено (S-V28 п.5). Цена та же, что у соседних сторон и названа S-V28 п.9: повторная
      // авторизация из экрана прав для такого alias не работает — сначала «Подключить», которое и
      // заводит запись в том слое, где корп-код принимает решения.
      const oauthClosed =
        directConnected ||
        entry === undefined ||
        CorpConnectors.oauthDisarmed(entry) ||
        server === undefined ||
        CorpStatus.nativeConnectDisabled({ server, hubConfigured: true })
      if (reauth && !oauthClosed) {
        yield* authFailure(mcpSvc.authenticate(alias)).pipe(Effect.catch(() => Effect.void))
      }
      return {
        alias,
        status: yield* cardFor(addr, alias),
        preset,
        reauth_required: reauth,
      }
    })

    return handlers
      .handle("loginStart", loginStart)
      .handle("loginPoll", loginPoll)
      .handle("loginTeam", loginTeam)
      .handle("loginCancel", loginCancel)
      .handle("logout", logout)
      .handle("status", status)
      .handle("providerEnable", providerEnable)
      .handle("catalog", catalog)
      .handle("connect", connect)
      .handle("connectToken", connectToken)
      .handle("disconnect", disconnect)
      .handle("forget", forget)
      .handle("permissions", permissions)
  }),
)
