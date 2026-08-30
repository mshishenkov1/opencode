import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { CorpApi, CorpPaths } from "@/server/routes/instance/httpapi/groups/corp"
import { corpHandlers } from "@/server/routes/instance/httpapi/handlers/corp"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer, SchemaErrorMiddleware } from "@/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Effect, Fiber, Layer, Logger } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { AccountTest } from "../../test/fake/account"
import { NpmTest } from "../../test/fake/npm"
import { testInstanceStoreLayer } from "../../test/fixture/fixture"
import { testEffect } from "../../test/lib/effect"

/**
 * Сторожи на BLK-5 (сброс memo каталога входом/выходом/во всех рабочих каталогах, коммиты
 * `d4db696564`/`775b2c423c`) и на клиентскую половину той же починки не относятся сюда —
 * см. `packages/app/src/corp/catalog-invalidate.test.ts`.
 *
 * До этого файла три починки не имели ни одного файла тестов — держались только на чтении кода.
 * Здесь память процесса (`memo`, `memoEpoch` в `handlers/corp.ts`) проверяется через настоящий
 * локальный HTTP-сервер корп-роутов с моком Hub (`Bun.serve`), приёмом `orchestration.test.ts`:
 * MCP замокан на границе сервиса, рабочий каталог запроса читается ИЗ `state.directory` НА КАЖДЫЙ
 * запрос (а не фиксируется на старте теста) — это и позволяет одному тесту переключаться между
 * двумя рабочими каталогами так же, как это делает реальный `?directory=`.
 *
 * Отличие от `authLayer`/`mcpLayer` в `orchestration.test.ts`: там `Auth.Service.set/remove` —
 * заглушки, только пишущие в журнал вызовов. Здесь `set`/`remove` ДЕЙСТВИТЕЛЬНО меняют
 * `state.key` — без этого «вход»/«выход» не были бы наблюдаемы следующим запросом, а именно это
 * здесь и проверяется (BLK-5 — про то, что видно СЛЕДУЮЩИМ запросом после действия).
 *
 * Запуск: `bun test src/corp/catalog-memo.test.ts` из `packages/opencode`.
 */

// --- Мок Hub ---

interface HubRequest {
  method: string
  path: string
  authorization: string | null
  body?: unknown
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function startHub() {
  const mock = {
    url: "",
    requests: [] as HubRequest[],
    /** Ответ `GET /cli/poll/:id`; `undefined` — «pending» (вход не завершён). */
    pollAnswer: undefined as undefined | ((loginId: string) => unknown),
    /** Каталог по ключу Bearer — так повторный вход другим ключом видит другой каталог. */
    catalogByKey: new Map<string, unknown>(),
    /** Сколько раз Hub получил `GET /api/catalog` — контроль «кэш жив» (ровно один запрос). */
    catalogCallCount: 0,
    /**
     * Задерживает ответ на ПЕРВЫЙ `GET /api/catalog` — то же наблюдение зондом, что в
     * `775b2c423c`: «Hub задержан на первом GET /api/catalog, действие выполнено внутри задержки».
     * Тело ответа снимается ДО ожидания (`snapshot`) — Hub «уже посчитал» ответ к моменту, когда
     * действие его изменило, только сама отправка задержана.
     */
    catalogGate: undefined as Promise<void> | undefined,
    permissionsResult: (alias: string, body: { preset?: string }) =>
      json({ alias, status: "connected", preset: body?.preset }),
    stop: () => {},
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get("authorization")
      const bodyJson = ["GET", "DELETE", "HEAD"].includes(request.method)
        ? undefined
        : await request.json().catch(() => undefined)
      mock.requests.push({
        method: request.method,
        path: url.pathname,
        authorization,
        ...(bodyJson === undefined ? {} : { body: bodyJson }),
      })

      if (url.pathname === "/health") return json({ status: "ok" })
      if (url.pathname === "/cli/start" && request.method === "POST")
        return json({
          login_id: `login-${mock.requests.length}`,
          poll_secret: "secret-do-not-leak",
          browser_url: `${mock.url}/ui/login`,
          user_code: "MGNT-0001",
          expires_in: 600,
        })
      const pollMatch = url.pathname.match(/^\/cli\/poll\/([^/]+)$/)
      if (pollMatch) return json(mock.pollAnswer ? mock.pollAnswer(pollMatch[1]!) : { status: "pending" })
      if (url.pathname === "/api/me/key" && request.method === "DELETE") return json({ revoked: true })

      const key = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined
      if (url.pathname === "/api/me") return json({ user_id: `user-of-${key}`, key_kind: "persistent" })

      if (url.pathname === "/api/catalog") {
        mock.catalogCallCount += 1
        const isFirst = mock.catalogCallCount === 1
        const snapshot = key !== undefined ? mock.catalogByKey.get(key) : undefined
        if (isFirst && mock.catalogGate) await mock.catalogGate
        return snapshot === undefined ? json({ error: "litellm_unavailable" }, 502) : json(snapshot)
      }

      const permissions = url.pathname.match(/^\/api\/me\/connections\/([^/]+)\/permissions$/)
      if (permissions && request.method === "PUT")
        return mock.permissionsResult(decodeURIComponent(permissions[1]!), bodyJson as { preset?: string })

      const connection = url.pathname.match(/^\/api\/me\/connections\/([^/]+)$/)
      if (connection && request.method === "DELETE")
        return json({ alias: decodeURIComponent(connection[1]!), status: "not_connected" })

      return json({ error: "not_found" }, 404)
    },
  })
  mock.url = `http://127.0.0.1:${server.port}`
  mock.stop = () => server.stop(true)
  return mock
}

function card(alias: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    title: alias,
    mode: "facade" as const,
    mcp_url: `https://hub.example/mcp/${alias}`,
    permission_model: {
      kind: "header_groups" as const,
      groups: [
        { id: "read", title: "Чтение", preset: "readonly" },
        { id: "write", title: "Запись", preset: "readwrite" },
      ],
      always: [],
    },
    ...overrides,
  }
}

function catalogOf(servers: unknown[], version = "1") {
  return { version, servers }
}

// --- Состояние теста ---

type Status = MCP.Status

interface TestState {
  hub: ReturnType<typeof startHub>
  key: string | undefined
  directory: string
  statuses: Record<string, Status>
  addStatus: Status
  authenticate: (alias: string) => Status
  calls: string[]
}

let state: TestState

// --- Слои (приём `orchestration.test.ts`) ---

const TestHttpApi = HttpApi.make("opencode-instance").addHttpApi(CorpApi).middleware(SchemaErrorMiddleware)

/**
 * В отличие от моков соседних файлов, `set`/`remove` здесь ДЕЙСТВИТЕЛЬНО меняют `state.key` —
 * без этого вход/выход не были бы наблюдаемы следующим запросом (ровно то, что проверяет BLK-5).
 */
const authLayer = Layer.mock(Auth.Service)({
  get: (providerID: string) =>
    Effect.succeed(
      providerID === "magnit_prod" && state.key !== undefined ? new Auth.Api({ type: "api", key: state.key }) : undefined,
    ),
  all: () => Effect.succeed({}),
  set: (_id: string, info: { type: string; key?: string }) =>
    Effect.sync(() => {
      state.calls.push(`auth.set:${info.key}`)
      if (info.type === "api" && typeof info.key === "string") state.key = info.key
    }),
  remove: (_id: string) =>
    Effect.sync(() => {
      state.calls.push("auth.remove")
      state.key = undefined
    }),
})

const mcpLayer = Layer.mock(MCP.Service)({
  status: () => Effect.sync(() => ({ ...state.statuses })),
  add: (name: string, _mcp: any) =>
    Effect.sync(() => {
      state.calls.push(`add:${name}`)
      state.statuses[name] = state.addStatus
      return { status: { ...state.statuses } }
    }),
  authenticate: (name: string) =>
    Effect.sync(() => {
      state.calls.push(`authenticate:${name}`)
      const status = state.authenticate(name)
      if (status.status === "connected") state.statuses[name] = status
      return status
    }),
  removeAuth: (name: string) => Effect.sync(() => void state.calls.push(`removeAuth:${name}`)),
  disconnect: (name: string) =>
    Effect.suspend(() => {
      state.calls.push(`disconnect:${name}`)
      if (!(name in state.statuses)) return Effect.fail(new MCP.NotFoundError({ name }))
      state.statuses[name] = { status: "disabled" }
      return Effect.void
    }),
})

const infra = CrossSpawnSpawner.defaultLayer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

const offlineClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }))),
)

const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(authLayer),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, offlineClient)),
  Layer.provideMerge(FSUtil.defaultLayer),
  Layer.provideMerge(infra),
)

const passthroughAuthorization = Layer.succeed(Authorization, Authorization.of((effect) => effect))

/** Рабочий каталог запроса берётся из `state.directory` НА КАЖДЫЙ запрос (не фиксируется при старте теста). */
const workspaceRoutingLayer = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    Effect.suspend(() =>
      effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: state.directory }))),
    ),
  ),
)

const logs: { level: string; text: string }[] = []
const captureLogger = Logger.make<unknown, void>((options) => {
  let text: string
  try {
    text = JSON.stringify(options.message) ?? String(options.message)
  } catch {
    text = String(options.message)
  }
  logs.push({ level: String(options.logLevel), text })
})

const served = HttpRouter.serve(
  HttpApiBuilder.layer(TestHttpApi).pipe(
    Layer.provide(corpHandlers),
    Layer.provide([passthroughAuthorization, workspaceRoutingLayer, schemaErrorLayer]),
    Layer.provide(Layer.mock(Session.Service)({})),
    Layer.provide(instanceContextLayer),
    Layer.provide(testInstanceStoreLayer),
    Layer.provide(mcpLayer),
    Layer.provide(authLayer),
    Layer.provide(configLayer),
    Layer.provide(Logger.layer([captureLogger])),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(infra))

const it = testEffect(served)

// --- Обвязка ---

const tmpDirs: string[] = []
let previousGlobalConfig: string
let previousGlobalData: string

async function tmp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

beforeEach(async () => {
  const hub = startHub()
  const globalDir = await tmp("corp-memo-global-")
  await fs.writeFile(path.join(globalDir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
  previousGlobalConfig = Global.Path.config
  ;(Global.Path as { config: string }).config = globalDir
  previousGlobalData = Global.Path.data
  ;(Global.Path as { data: string }).data = await tmp("corp-memo-data-")
  process.env["OPENCODE_CORP_HUB_URL"] = hub.url
  delete process.env["OPENCODE_CORP_CATALOG_URL"]

  logs.length = 0
  state = {
    hub,
    key: undefined,
    directory: await tmp("corp-memo-work-"),
    statuses: {},
    addStatus: { status: "disabled" },
    authenticate: () => ({ status: "connected" }),
    calls: [],
  }
})

afterEach(() => {
  state.hub.stop()
  ;(Global.Path as { config: string }).config = previousGlobalConfig
  ;(Global.Path as { data: string }).data = previousGlobalData
  delete process.env["OPENCODE_CORP_HUB_URL"]
  delete process.env["OPENCODE_CORP_CATALOG_URL"]
})

afterAll(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

const post = (route: string, payload?: unknown) =>
  payload === undefined
    ? HttpClientRequest.post(route).pipe(HttpClient.execute)
    : HttpClientRequest.post(route).pipe(HttpClientRequest.bodyJson(payload), Effect.orDie, Effect.flatMap(HttpClient.execute))

const put = (route: string, body: unknown) =>
  HttpClientRequest.put(route).pipe(HttpClientRequest.bodyJson(body), Effect.orDie, Effect.flatMap(HttpClient.execute))

const get = (route: string) => HttpClientRequest.get(route).pipe(HttpClient.execute)

const connectRoute = (alias: string) => CorpPaths.connect.replace(":alias", alias)
const permissionsRoute = (alias: string) => CorpPaths.permissions.replace(":alias", alias)
const loginPollRoute = (id: string) => CorpPaths.loginPoll.replace(":loginID", id)

const body = <A>(response: { json: Effect.Effect<unknown, any, any> }) => response.json as Effect.Effect<A, any, any>

/** Полный вход: `POST /corp/login/start` + `GET /corp/login/poll/:id`, Hub отвечает `ready` сразу. */
const login = (key: string) =>
  Effect.gen(function* () {
    state.hub.pollAnswer = () => ({ status: "ready", key, key_kind: "persistent", user: { user_id: `user-${key}` } })
    const started = yield* body<{ login_id: string }>(yield* post(CorpPaths.loginStart))
    const polled = yield* body<{ status: string }>(yield* get(loginPollRoute(started.login_id)))
    expect(polled.status).toBe("ready")
  })

/** Ждёт запрос `GET /api/catalog` СВЕРХ уже накопленных (`baselineCount`) — не «был хоть раз». */
const waitForNextHubCatalogRequest = (baselineCount: number) =>
  Effect.gen(function* () {
    while (state.hub.requests.filter((request) => request.path === "/api/catalog").length <= baselineCount)
      yield* Effect.sleep("20 millis")
  }).pipe(
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die(new Error("Hub не получил новый GET /api/catalog")) }),
  )

// --- Guard 1: выход снимает снимок (BLK-5, d4db696564) ---

describe("BLK-5 — выход снимает снимок каталога (d4db696564)", () => {
  it.live(
    "GET /corp/catalog сразу после POST /corp/logout (key_removed=true) отдаёт «Требуется вход», а не полный каталог с прежним cached_at",
    () =>
      Effect.gen(function* () {
        yield* login("sk-logout-key")
        state.hub.catalogByKey.set("sk-logout-key", catalogOf([card("srv-a")]))

        const before = yield* body<{ cached_at?: number; servers: unknown[]; hub_error?: string }>(
          yield* get(CorpPaths.catalog),
        )
        expect(before.hub_error).toBeUndefined()
        expect(before.servers.length).toBe(1)
        expect(before.cached_at).toBeDefined()

        const logoutResult = yield* body<{ key_removed: boolean }>(yield* post(CorpPaths.logout))
        expect(logoutResult.key_removed).toBe(true)

        const after = yield* body<{ hub_error?: string; cached_at?: number; servers: unknown[] }>(
          yield* get(CorpPaths.catalog),
        )
        expect(after.hub_error).toBe("unauthorized")
        expect(after.servers).toEqual([])
        expect(after.cached_at).not.toBe(before.cached_at)
      }),
  )
})

// --- Guard 2: повторный вход снимает снимок (BLK-5, d4db696564) ---

describe("BLK-5 — повторный вход снимает снимок каталога (d4db696564)", () => {
  it.live("витрина, открытая с прежним ключом, после входа с ДРУГИМ ключом показывает каталог нового ключа", () =>
    Effect.gen(function* () {
      yield* login("sk-team-a")
      state.hub.catalogByKey.set("sk-team-a", catalogOf([card("team-a-server")], "A"))
      state.hub.catalogByKey.set("sk-team-b", catalogOf([card("team-b-server")], "B"))

      const first = yield* body<{ version: string; servers: { alias: string }[] }>(yield* get(CorpPaths.catalog))
      expect(first.version).toBe("A")
      expect(first.servers.map((server) => server.alias)).toEqual(["team-a-server"])

      // Повторный вход другим ключом — та же команда действий, что «выбор другой команды»
      // (`POST /corp/login/poll/:id/team` тоже приходит в общую ветку `ready`, S-A3).
      yield* login("sk-team-b")

      const second = yield* body<{ version: string; servers: { alias: string }[] }>(yield* get(CorpPaths.catalog))
      expect(second.version).toBe("B")
      expect(second.servers.map((server) => server.alias)).toEqual(["team-b-server"])
    }),
  )
})

// --- Guard 3: все рабочие каталоги (BLK-5, d4db696564) ---

describe("BLK-5 — dropMemo снимает записи ВСЕХ рабочих каталогов (d4db696564)", () => {
  it.live("«Подключить», выполненное в каталоге Б, видно витрине, открытой в каталоге А", () =>
    Effect.gen(function* () {
      yield* login("sk-shared")
      const alias = "shared-server"
      state.hub.catalogByKey.set("sk-shared", catalogOf([card(alias)]))

      const dirA = state.directory
      const beforeA = yield* body<{ servers: { alias: string; configured: boolean }[] }>(yield* get(CorpPaths.catalog))
      expect(beforeA.servers.find((server) => server.alias === alias)?.configured).toBe(false)

      // Переключение на второй рабочий каталог — тот же приём, что `orchestration.test.ts`
      // (`state.directory` читается middleware НА КАЖДЫЙ запрос, не фиксируется на старте теста).
      const dirB = yield* Effect.promise(() => tmp("corp-memo-dirb-"))
      state.directory = dirB

      const connectResponse = yield* post(connectRoute(alias), {})
      expect(connectResponse.status).toBe(200)

      // Вернуться в каталог А — БЕЗ ?refresh: если dropMemo снял только запись каталога Б (старая
      // редакция `memo.delete(memoKey(addr))`), каталог А ещё минуту отдавал бы `configured:false`.
      state.directory = dirA
      const afterA = yield* body<{ servers: { alias: string; configured: boolean }[] }>(yield* get(CorpPaths.catalog))
      expect(afterA.servers.find((server) => server.alias === alias)?.configured).toBe(true)
    }),
  )
})

// --- Guard 4: гонка поколений memoEpoch (BLK-5, вторая половина, 775b2c423c) ---

describe("BLK-5 (вторая половина) — снимок не переписывается ответом, прочитанным ДО действия (775b2c423c)", () => {
  it.live(
    "витрина, начатая до PUT .../permissions {preset}, отдаёт клиенту СВОЙ (старый) ответ, но не кладёт его в memo",
    () =>
      Effect.gen(function* () {
        yield* login("sk-race")
        const alias = "race-server"
        state.hub.catalogByKey.set(
          "sk-race",
          catalogOf([card(alias, { connection: { status: "connected", preset: "readonly" } })]),
        )
        const connected = yield* post(connectRoute(alias), { preset: "readonly" })
        expect(connected.status).toBe(200)

        // Задержка ПЕРВОГО обращения к Hub-каталогу — «витрина, начатая до действия»: запрос уже
        // ушёл в Hub, но ответ ещё не пришёл, когда действие меняет состояние.
        let releaseGate: () => void = () => {}
        state.hub.catalogGate = new Promise<void>((resolve) => {
          releaseGate = resolve
        })
        state.hub.catalogCallCount = 0
        const baselineCatalogRequests = state.hub.requests.filter((request) => request.path === "/api/catalog").length

        const witness = yield* get(CorpPaths.catalog).pipe(Effect.forkDetach)
        yield* waitForNextHubCatalogRequest(baselineCatalogRequests)

        // Действие ВНУТРИ задержки: Hub теперь отвечает readwrite, PUT меняет пресет и зовёт dropMemo().
        state.hub.catalogByKey.set(
          "sk-race",
          catalogOf([card(alias, { connection: { status: "connected", preset: "readwrite" } })]),
        )
        const putResponse = yield* put(permissionsRoute(alias), { preset: "readwrite" })
        expect(putResponse.status).toBe(200)

        // Отпустить задержанный ответ Hub — тело было снято ДО действия (readonly).
        releaseGate()

        const witnessResponse = yield* Fiber.join(witness)
        const witnessView = yield* body<{ servers: { alias: string; preset?: string }[] }>(witnessResponse)
        expect(witnessView.servers.find((server) => server.alias === alias)?.preset).toBe("readonly")

        // Но это НЕ попало в memo: следующее открытие обязано отдать readwrite, а не «застрявший» readonly.
        const next = yield* body<{ servers: { alias: string; preset?: string }[] }>(yield* get(CorpPaths.catalog))
        expect(next.servers.find((server) => server.alias === alias)?.preset).toBe("readwrite")
      }),
  )
})

// --- Guard 5: контроль «кэш жив» (обязателен — без него сторожи 1-4 бессмысленны) ---

describe("контроль «кэш жив» — без него сторожи выше ничего не доказывают", () => {
  it.live("два подряд открытия витрины дают РОВНО ОДИН запрос GET /api/catalog к Hub", () =>
    Effect.gen(function* () {
      yield* login("sk-alive")
      state.hub.catalogByKey.set("sk-alive", catalogOf([card("alive-server")]))

      yield* get(CorpPaths.catalog)
      yield* get(CorpPaths.catalog)

      expect(state.hub.requests.filter((request) => request.path === "/api/catalog")).toHaveLength(1)
    }),
  )

  it.live("«Включить провайдера» снимок каталога НЕ сбрасывает — ответ до и с ?refresh=true после совпадают (кроме времени свежей выборки)", () =>
    Effect.gen(function* () {
      yield* login("sk-alive-2")
      state.hub.catalogByKey.set("sk-alive-2", catalogOf([card("alive-server-2")]))

      // Провайдер обязан быть ДЕЙСТВИТЕЛЬНО выключен: иначе `providerEnable` возвращается по ветке
      // `reason:"not_disabled"` ДО патча/инвалидации — код, который снимок якобы не трогает,
      // попросту не исполнился бы, и сторож ничего не проверил бы (проверено: без этого шага
      // инъекция ниже по коду не красит тест — сам этот файл поймал бы такой сторож на ревью).
      const globalConfigFile = path.join(Global.Path.config, "opencode.json")
      yield* Effect.promise(() =>
        fs.writeFile(
          globalConfigFile,
          JSON.stringify({ $schema: "https://opencode.ai/config.json", disabled_providers: ["magnit_prod"] }),
        ),
      )

      const before = yield* body<{ cached_at?: number }>(yield* get(CorpPaths.catalog))
      const hubCallsBefore = state.hub.requests.filter((request) => request.path === "/api/catalog").length

      const enabled = yield* body<{ changed: boolean }>(yield* post(CorpPaths.providerEnable))
      // Провайдер был выключен — «Включить» обязано пройти патч/инвалидацию (ветку `changed:true`),
      // иначе строка, которую проверяет этот сторож, не исполняется вовсе.
      expect(enabled.changed).toBe(true)

      const afterNoRefresh = yield* body<{ cached_at?: number }>(yield* get(CorpPaths.catalog))
      const hubCallsAfterNoRefresh = state.hub.requests.filter((request) => request.path === "/api/catalog").length
      // Снимок жив: второе открытие без ?refresh не сходило в Hub повторно, поэтому даже
      // `cached_at` (снятый в момент похода в Hub) остаётся тем же самым значением — не только
      // содержимое карточек, а сам объект снимка.
      expect(hubCallsAfterNoRefresh).toBe(hubCallsBefore)
      expect(afterNoRefresh).toEqual(before)

      // `?refresh=true` — настоящий новый поход в Hub, поэтому `cached_at` меняется по определению
      // (реальное время новой выборки). Сравнивается остальное содержимое (S-V3: `disabled_providers`
      // не входит ни в одно поле витрины) — прежде всего карточки и их поля.
      const afterRefresh = yield* body<{ cached_at?: number; servers: unknown[] }>(
        yield* get(`${CorpPaths.catalog}?refresh=true`),
      )
      const { cached_at: _beforeCachedAt, ...beforeRest } = before as { cached_at?: number; servers: unknown[] }
      const { cached_at: _afterCachedAt, ...afterRest } = afterRefresh
      expect(afterRest).toEqual(beforeRest)
    }),
  )
})
