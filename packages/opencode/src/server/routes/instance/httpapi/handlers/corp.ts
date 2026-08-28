import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import * as CorpCatalog from "@/corp/catalog"
import * as CorpCatalogCache from "@/corp/catalog-cache"
import * as CorpConfig from "@/corp/config"
import * as CorpConnections from "@/corp/connections"
import * as CorpConnectors from "@/corp/connectors"
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
import { CorpBadRequestError, CorpDisabledError, CorpHubError } from "../groups/corp"

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

    /** Сбрасывает memo текущего инстанса после действий витрины (S-V7…S-V9). */
    const dropMemo = Effect.fnUntraced(function* (addr: Addresses) {
      memo.delete(yield* memoKey(addr))
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

      const globalConfig = yield* configSvc.getGlobal()
      const patch = CorpConfig.enableProviderPatch(globalConfig.disabled_providers)
      if (patch === undefined || !isGlobalConfigFile(disabled.file))
        return { changed: false, provider_disabled: disabled, reason: "foreign_layer" as const }

      yield* configSvc.updateGlobal(patch)
      // S-C11 п.4: провайдер доступен без перезапуска — та же инвалидация, что при входе (S-A3).
      // Список провайдеров строится по `disabled_providers` один раз на инстанс, поэтому кэша
      // конфига здесь так же недостаточно, как при входе.
      yield* configSvc.invalidate()
      yield* invalidateProviders()
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

    /** Локальные статусы MCP и записи `mcp.<alias>` действующего конфига (S-V5). */
    const localState = Effect.fnUntraced(function* () {
      const statuses = yield* mcpSvc.status()
      const config = yield* configSvc.get()
      // S-V23: раздел `permission` действующего (слитого) конфига — по нему считается permission_state.
      return {
        statuses,
        configured: new Set(Object.keys(config.mcp ?? {})),
        permission: config.permission,
      }
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
      const { statuses, configured, permission } = yield* localState()
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

      const cards: CorpSchema.CatalogCard[] = servers.map((server) => {
        const local = statuses[server.alias]
        const permissions = CorpSchema.parsePermissionModel(server.permission_model)
        const groups = CorpSchema.parsePermissionGroups(server.permission_groups)
        if (groups && groups.dropped > 0)
          for (let index = 0; index < groups.dropped; index++)
            dropped.push({ alias: server.alias, reason: "permission_groups.group" })
        const card = CorpStatus.compute({
          alias: server.alias,
          server,
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
        return {
          alias: server.alias,
          title: server.title,
          ...(server.description === undefined ? {} : { description: server.description }),
          ...(server.owner === undefined ? {} : { owner: server.owner }),
          ...(server.contact === undefined ? {} : { contact: server.contact }),
          ...(server.docs_url === undefined ? {} : { docs_url: server.docs_url }),
          ...(server.status === undefined ? {} : { server_status: server.status }),
          // S-V22: значение колонки «Тип» — данные каталога; деградацию `type` → `owner` → пусто
          // делает оболочка, у которой есть оба поля.
          ...(server.type === undefined ? {} : { type: server.type }),
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
              }),
          ...(server.connection === undefined ? {} : { connection_status: server.connection.status }),
          ...(server.connection?.preset === undefined ? {} : { preset: server.connection.preset }),
          ...(card.connectNeedsHub === true ? { connect_needs_hub: true } : {}),
          ...(permissionsNeedHub ? { permissions_need_hub: true } : {}),
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
      if (loaded.source !== "cache") {
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
      const { statuses, configured } = yield* localState()
      const local = statuses[alias]
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
        configured: configured.has(alias),
        ...(local === undefined ? {} : { local: local.status }),
        ...(local && "error" in local ? { localError: local.error } : {}),
        everConnectedLocally: CorpConnections.has(connections, alias),
        stale,
        hubConfigured: addr.hub !== undefined,
      }).status
    })

    // --- Действия витрины (S-V7…S-V9) ---

    const connect = Effect.fn("CorpHttpApi.connect")(function* (ctx: {
      params: { alias: string }
      payload: { preset?: string }
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

      // S-V7, S-C10 п.8: `native` подключается штатным MCP OAuth клиента и Hub в этом не участвует
      // никогда. `facade` подключается способом `user_token` через Hub-фасад — без адреса Hub этот
      // способ недоступен: шаг 1 не выполняется и запись `mcp.<alias>` не создаётся.
      if (addr.hub === undefined && server.mode === "facade")
        return yield* new CorpBadRequestError({ error: "facade_needs_hub" })

      const preset = ctx.payload.preset ?? CorpStatus.DEFAULT_PRESET
      const patch = CorpConnectors.connectPatch(server, preset)
      // Шаг 1 (D-7): персист через updateGlobal, а не через runtime-only POST /mcp/:name/connect (F17).
      yield* configSvc.updateGlobal(patch)
      yield* mcpSvc.add(alias, patch.mcp[alias])
      yield* dropMemo(addr)

      // Шаг 2: штатный MCP-OAuth сервера — браузер и ожидание callback 19876 (F15/F16).
      const status = yield* mcpSvc
        .authenticate(alias)
        .pipe(Effect.catch((error) => Effect.succeed({ status: "failed" as const, error: String(error) })))
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
          }),
        }
      }
      return { alias, status: yield* cardFor(addr, alias) }
    })

    const disconnect = Effect.fn("CorpHttpApi.disconnect")(function* (ctx: { params: { alias: string } }) {
      const addr = yield* requireCatalog()
      const alias = ctx.params.alias
      yield* mcpSvc.removeAuth(alias)
      yield* mcpSvc.disconnect(alias).pipe(Effect.catch(() => Effect.void))
      yield* configSvc.updateGlobal(CorpConnectors.disconnectPatch(alias))
      yield* dropMemo(addr)

      const key = yield* corpKey()
      let hubError: CorpErrors.Code | undefined
      // S-C10 п.7: при незаданном адресе Hub шаг **пропускается**, а не считается отказом Hub —
      // ни предупреждения, ни поля `hub_error`. «Нечего звать» и «позвали, не ответил» — разное.
      if (key && addr.hub !== undefined) {
        const hub = CorpHub.make({ hubUrl: addr.hub, key })
        const removed = yield* Effect.promise(() => hub.removeConnection(alias))
        // S-V8: отказ Hub не откатывает локальные шаги, но показывается предупреждением.
        if (!removed.ok) hubError = removed.code
      }
      return {
        alias,
        status: "not_connected" as const,
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
      // Шаг 1: те же локальные шаги, что у S-V8.
      yield* mcpSvc.removeAuth(alias)
      yield* mcpSvc.disconnect(alias).pipe(Effect.catch(() => Effect.void))
      // Шаг 2: ключ `mcp.<alias>` удаляется целиком; прочий конфиг пользователя не трогается (S-C7).
      yield* configSvc.updateGlobal(CorpConnectors.forgetPatch(alias))
      // Шаг 3: признак «подключение состоялось» снимается — единственный способ его снять (S-V15 п.3).
      const connections = yield* readConnections(addr.identity)
      const without = CorpConnections.forget(connections, alias)
      if (without) yield* Effect.promise(() => CorpConnections.write(without))
      yield* dropMemo(addr)

      // Шаг 4 необязателен: без ключа и при недоступном Hub он пропускается, а не откатывает шаги 1–3.
      // При незаданном адресе Hub шага 4 **не существует** (S-C10 п.7): предупреждение о
      // недоступности Hub в сборке, где Hub не настроен, — ложная тревога.
      const key = yield* corpKey()
      let hubError: CorpErrors.Code | undefined
      if (key && addr.hub !== undefined) {
        const hub = CorpHub.make({ hubUrl: addr.hub, key })
        const removed = yield* Effect.promise(() => hub.removeConnection(alias))
        if (!removed.ok) hubError = removed.code
      }
      return {
        alias,
        status: "not_connected" as const,
        removed: true,
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
      const globalConfig = yield* configSvc.getGlobal()
      const patch = CorpConnectors.permissionGroupsPatch(alias, {
        groups: parsed.groups,
        modes,
        existing: Object.keys(globalConfig.permission ?? {}),
      })
      yield* configSvc.updateGlobal(patch.clear)
      yield* configSvc.updateGlobal(patch.write)
      yield* dropMemo(addr)

      // Состояние считается по конфигу **после** записи — и тем же правилом, что на витрине (S-V23).
      const config = yield* configSvc.get()
      return {
        alias,
        status: yield* cardFor(addr, alias, source),
        reauth_required: false,
        permission_state: CorpConnectors.permissionState(alias, parsed.groups, config.permission),
      }
    })

    const permissions = Effect.fn("CorpHttpApi.permissions")(function* (ctx: {
      params: { alias: string }
      payload: { preset?: string; groups?: string[]; modes?: Record<string, CorpSchema.PermissionMode> }
    }) {
      const addr = yield* requireCatalog()
      const alias = ctx.params.alias
      // S-V1: два вида тела взаимоисключающи. Оба сразу — ошибка запроса, и ничего не записывается:
      // молча предпочесть один вид значило бы применить не то, о чём просил клиент.
      if (ctx.payload.preset !== undefined && ctx.payload.modes !== undefined)
        return yield* new CorpBadRequestError({ error: "conflicting_body" })
      // Ни того, ни другого: прежде такое тело отвергала схема (`preset` был обязателен), и оно
      // обязано отвергаться и теперь — молчаливый `readonly` по умолчанию снял бы права, о которых
      // никто не просил.
      if (ctx.payload.preset === undefined && ctx.payload.modes === undefined)
        return yield* new CorpBadRequestError({ error: "missing_body" })

      // Ветка `modes` уходит до чтения каталога из Hub: в ней Hub не участвует ни на шаг (D-35).
      // Она же — единственная, работающая в сборке без Hub (S-C10 п.7): вид `permission_groups`
      // целиком локален и от источника каталога не зависит.
      if (ctx.payload.modes !== undefined) return yield* applyPermissionGroups(addr, alias, ctx.payload.modes)

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

      if (server) {
        const patch = CorpConnectors.permissionsPatch(server, preset)
        if (patch) yield* configSvc.updateGlobal(patch)
      }
      yield* dropMemo(addr)

      if (reauth) {
        yield* mcpSvc.authenticate(alias).pipe(Effect.catch(() => Effect.void))
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
      .handle("disconnect", disconnect)
      .handle("forget", forget)
      .handle("permissions", permissions)
  }),
)
