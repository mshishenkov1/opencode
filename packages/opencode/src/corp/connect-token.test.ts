import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import * as CorpCredentials from "./credentials"
import * as Harness from "../../test/fixture/corp-direct-harness"

/**
 * Прямое подключение токеном через настоящий корп-роут (S-V25…S-V29, ревизия 1.13;
 * AC-251, AC-311, AC-315…AC-320, AC-327…AC-331, AC-339, AC-340, AC-343).
 *
 * Внешних систем, кроме одного сервера «целевой системы» (`Harness.state.target`), нет: он же
 * отдаёт статический каталог, он же отвечает на `verify`/`exchange`/`revoke` и на `upstream.url`.
 * Hub не поднимается вовсе — прямой режим о нём не знает и знать не должен (S-V25 п.8), а гейт
 * запрета OAuth (S-V28 п.8) проверяется отсутствием любого исходящего запроса, кроме этих.
 */

beforeAll(async () => {
  await Harness.setupHarness()
})
beforeEach(async () => {
  await Harness.beforeEachHarness()
})
afterEach(() => {
  Harness.afterEachHarness()
})
afterAll(async () => {
  await Harness.cleanupTmpDirs()
})

// --- Фикстуры карточек ---

function oauthMethod(overrides: Record<string, unknown> = {}) {
  return { id: "corp_oauth", title: "Корпоративная авторизация", type: "oauth2", available: true, ...overrides }
}

function tokenMethod(target: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "personal_token",
    title: "Личный токен",
    type: "user_token",
    field: { label: "Токен", min_length: 4, max_length: 40 },
    verify: { url: `${target}/verify`, account_field: "account" },
    ...overrides,
  }
}

function upstreamBlock(target: string, overrides: Record<string, unknown> = {}) {
  return {
    url: `${target}/mcp`,
    credential_headers: { Authorization: "Bearer {{access_token}}" },
    ...overrides,
  }
}

function directCard(alias: string, target: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    title: alias,
    status: "beta",
    mode: "facade",
    mcp_url: `${target}/mcp-proxy/${alias}`,
    permission_model: { kind: "consent", presets: { default: "Экран согласия" } },
    auth_methods: [oauthMethod(), tokenMethod(target)],
    upstream: upstreamBlock(target),
    ...overrides,
  }
}

/** Публикует статический каталог на сервере `target` и указывает на него сборку. */
function serveCatalog(servers: unknown[]) {
  const target = Harness.state.target
  target.routes.set("/catalog", () => Harness.json({ version: "1", servers }))
  process.env["OPENCODE_CORP_CATALOG_URL"] = `${target.url}/catalog`
}

async function snapshotFiles() {
  const config = await Harness.globalConfigText()
  const credentials = await Harness.credentialsFileText()
  return { config, credentials }
}

describe("connect-token — предпроверки без сети (S-V25 п.1, AC-311, AC-319)", () => {
  Harness.it.live("AC-311: способ corp_oauth (oauth2) закрыт запретом — 409 даже на пустом токене", () =>
    Effect.gen(function* () {
      const alias = "direct-oauth"
      serveCatalog([directCard(alias, Harness.state.target.url)])
      const before = yield* Effect.promise(() => snapshotFiles())

      const response = yield* Harness.post(Harness.connectTokenRoute(alias), {
        method: "corp_oauth",
        token: "some-token-value",
      })
      expect(response.status).toBe(409)
      const result = yield* Harness.body<{ error: string; unavailable_code: string }>(response)
      expect(result.error).toBe("auth_method_unavailable")
      expect(result.unavailable_code).toBe("oauth_disabled")

      // Тот же 409 повторяется на ПУСТОМ токене — доступность способа проверяется раньше значения
      // токена (S-V25 п.1, AC-311).
      const empty = yield* Harness.post(Harness.connectTokenRoute(alias), { method: "corp_oauth", token: "" })
      expect(empty.status).toBe(409)
      const emptyResult = yield* Harness.body<{ error: string; unavailable_code: string }>(empty)
      expect(emptyResult.unavailable_code).toBe("oauth_disabled")

      // Ни одного запроса, кроме получения самого каталога: ни verify, ни upstream.url — запрет
      // выдаётся до единого исходящего запроса (S-V25 п.1, S-V28 п.8).
      expect(Harness.state.target.requests.filter((request) => request.path !== "/catalog")).toEqual([])
      const after = yield* Effect.promise(() => snapshotFiles())
      expect(after).toEqual(before)
    }),
  )

  Harness.it.live(
    "AC-319: шесть неверных тел дают 400 до сети; неизвестный alias — 404; без upstream — 409 direct_unavailable",
    () =>
      Effect.gen(function* () {
        const alias = "direct-precheck"
        const noUpstreamAlias = "direct-no-upstream"
        const twoTokenAlias = "direct-two-token"
        const target = Harness.state.target.url
        serveCatalog([
          directCard(alias, target),
          directCard(noUpstreamAlias, target, { upstream: undefined }),
          directCard(twoTokenAlias, target, {
            auth_methods: [tokenMethod(target, { id: "a" }), tokenMethod(target, { id: "b" })],
          }),
        ])
        const before = yield* Effect.promise(() => snapshotFiles())

        const bodies: unknown[] = [
          ["array", "not", "object"],
          { method: "personal_token" }, // без token
          { method: "personal_token", token: "" }, // token пустой
          { method: "personal_token", token: "ab" }, // короче min_length (4)
          { token: "abcdef" }, // method не указан при двух способах user_token — отправляется отдельно ниже
          { method: "unknown_method", token: "abcdef" },
        ]
        for (const payload of bodies.slice(0, 4)) {
          const response = yield* Harness.post(Harness.connectTokenRoute(alias), payload)
          expect(response.status, JSON.stringify(payload)).toBe(400)
          const result = yield* Harness.body<{ error: string }>(response)
          expect(result.error).toBe("invalid_request")
        }
        const twoTokenResponse = yield* Harness.post(Harness.connectTokenRoute(twoTokenAlias), {
          token: "abcdef",
        })
        expect(twoTokenResponse.status).toBe(400)
        expect((yield* Harness.body<{ error: string }>(twoTokenResponse)).error).toBe("invalid_request")
        const unknownMethodResponse = yield* Harness.post(Harness.connectTokenRoute(alias), {
          method: "unknown_method",
          token: "abcdef",
        })
        expect(unknownMethodResponse.status).toBe(400)

        const notFound = yield* Harness.post(Harness.connectTokenRoute("does-not-exist"), {
          method: "personal_token",
          token: "abcdef",
        })
        expect(notFound.status).toBe(404)
        expect((yield* Harness.body<{ error: string }>(notFound)).error).toBe("not_found")

        const noUpstream = yield* Harness.post(Harness.connectTokenRoute(noUpstreamAlias), {
          method: "personal_token",
          token: "abcdef",
        })
        expect(noUpstream.status).toBe(409)
        expect((yield* Harness.body<{ error: string }>(noUpstream)).error).toBe("direct_unavailable")

        expect(Harness.state.target.requests.filter((request) => request.path !== "/catalog")).toEqual([])
        const after = yield* Effect.promise(() => snapshotFiles())
        expect(after).toEqual(before)
      }),
  )

  Harness.it.live(
    "щель S-V28 п.1: карточка только с oauth2 и без user_token — метод не назван, ответ определён (400)",
    () =>
      Effect.gen(function* () {
        const alias = "direct-oauth-only"
        serveCatalog([directCard(alias, Harness.state.target.url, { auth_methods: [oauthMethod()] })])

        const response = yield* Harness.post(Harness.connectTokenRoute(alias), { token: "abcdef" })
        expect(response.status).toBe(400)
        expect((yield* Harness.body<{ error: string }>(response)).error).toBe("invalid_request")
        expect(Harness.state.target.requests.filter((request) => request.path !== "/catalog")).toEqual([])
      }),
  )
})

describe("connect-token — проверка токена: ровно один запрос, пять исходов (S-V25 п.2, п.3; AC-315…AC-317)", () => {
  Harness.it.live("AC-315: ровно один запрос verify, подстановка {{access_token}}, без лишних заголовков", () =>
    Effect.gen(function* () {
      const alias = "direct-verify-shape"
      const target = Harness.state.target
      target.routes.set("/verify", () => Harness.json({ account: "ivanov" }))
      serveCatalog([
        directCard(alias, target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, { verify: { url: `${target.url}/verify`, account_field: "account", headers: { Authorization: "Bearer {{access_token}}" } } }),
          ],
        }),
      ])

      const response = yield* Harness.post(Harness.connectTokenRoute(alias), {
        method: "personal_token",
        token: "secret-token-value",
      })
      expect(response.status).toBe(200)
      const result = yield* Harness.body<{ verify_result: string; account?: string }>(response)
      expect(result.verify_result).toBe("verified")
      expect(result.account).toBe("ivanov")
      // Значение токена не отдаётся ни в каком поле ответа.
      expect(JSON.stringify(result)).not.toContain("secret-token-value")

      const verifyRequests = target.requests.filter((request) => request.path === "/verify")
      expect(verifyRequests).toHaveLength(1)
      const sent = verifyRequests[0]!
      expect(sent.method).toBe("GET")
      expect(sent.body).toBeUndefined()
      expect(sent.headers["authorization"]).toBe("Bearer secret-token-value")
      expect(sent.headers["accept"]).toBe("application/json")
      expect(sent.headers["user-agent"]).toContain("opencode/")
      // Ключ magnit_prod (SSO) в проверку не подставляется никогда — заголовок пришёл ровно из
      // подстановки verify.headers, а не из какого-то отдельного источника авторизации.
      expect(sent.headers["magnit_prod"]).toBeUndefined()
    }),
  )

  Harness.it.live("AC-316: пять РАЗНЫХ исходов verify_result, ни одна пара не совпадает", () =>
    Effect.gen(function* () {
      const target = Harness.state.target
      const cases: { path: string; status?: number; body?: unknown; timeout?: boolean; expected: string }[] = [
        { path: "/v-ok", status: 200, body: { account: "ivanov" }, expected: "verified" },
        { path: "/v-missing", status: 200, body: {}, expected: "account_missing" },
        { path: "/v-401", status: 401, body: {}, expected: "token_rejected" },
        { path: "/v-500", status: 500, body: {}, expected: "verify_failed" },
        { path: "/v-timeout", timeout: true, expected: "upstream_unreachable" },
      ]
      const servers = cases.map((entry, index) => {
        target.routes.set(entry.path, () =>
          entry.timeout ? new Promise<Response>(() => {}) : Harness.json(entry.body, entry.status),
        )
        return directCard(`direct-verify-${index}`, target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, {
              verify: { url: `${target.url}${entry.path}`, account_field: "account", require_account: true },
            }),
          ],
        })
      })
      serveCatalog(servers)

      const outcomes: string[] = []
      for (const [index, entry] of cases.entries()) {
        if (entry.timeout) continue // таймаут 10с — покрыт отдельно ниже без ожидания реального интервала.
        const response = yield* Harness.post(Harness.connectTokenRoute(`direct-verify-${index}`), {
          method: "personal_token",
          token: "abcdef",
        })
        const result = yield* Harness.body<{ verify_result: string }>(response)
        outcomes.push(result.verify_result)
        expect(result.verify_result, entry.path).toBe(entry.expected)
        if (entry.expected !== "verified") {
          const config = yield* Effect.promise(() => Harness.globalConfig())
          expect(config.mcp?.[`direct-verify-${index}`]).toBeUndefined()
          const credentials = yield* Effect.promise(() => Harness.credentialsFileText())
          expect(credentials === undefined || !credentials.includes(`direct-verify-${index}`)).toBe(true)
        }
      }
      // Четыре различных исхода без сети получены и без единого совпадения (пятый, upstream_unreachable,
      // подтверждается отдельным сфокусированным тестом — реальный таймаут здесь замедлил бы сьют).
      expect(new Set(outcomes).size).toBe(outcomes.length)
    }),
  )

  Harness.it.live("AC-316: пятый исход — upstream_unreachable — сеть недостижима (DNS-отказ, без таймаута)", () =>
    Effect.gen(function* () {
      const alias = "direct-verify-unreachable"
      const target = Harness.state.target
      serveCatalog([
        directCard(alias, target.url, {
          auth_methods: [
            oauthMethod(),
            // Порт, на котором заведомо никто не слушает в тестовой песочнице (127.0.0.1:1).
            tokenMethod(target.url, { verify: { url: "http://127.0.0.1:1/verify" } }),
          ],
        }),
      ])

      const response = yield* Harness.post(Harness.connectTokenRoute(alias), { method: "personal_token", token: "abcdef" })
      const result = yield* Harness.body<{ verify_result: string }>(response)
      expect(result.verify_result).toBe("upstream_unreachable")
      const config = yield* Effect.promise(() => Harness.globalConfig())
      expect(config.mcp?.[alias]).toBeUndefined()
    }),
  )

  Harness.it.live("AC-317: require_account:true и тело без account_field — account_missing, а не verified", () =>
    Effect.gen(function* () {
      const target = Harness.state.target
      target.routes.set("/v-json", () => Harness.json({}))
      target.routes.set("/v-not-json", () => new Response("not json at all", { status: 200 }))
      const jsonAlias = "direct-account-missing-json"
      const notJsonAlias = "direct-account-missing-nonjson"
      serveCatalog([
        directCard(jsonAlias, target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, { verify: { url: `${target.url}/v-json`, account_field: "account", require_account: true } }),
          ],
        }),
        directCard(notJsonAlias, target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, { verify: { url: `${target.url}/v-not-json`, account_field: "account", require_account: true } }),
          ],
        }),
      ])

      const jsonResponse = yield* Harness.post(Harness.connectTokenRoute(jsonAlias), {
        method: "personal_token",
        token: "abcdef",
      })
      expect((yield* Harness.body<{ verify_result: string }>(jsonResponse)).verify_result).toBe("account_missing")

      // Тело, не разобранное как JSON, при успешном коде даёт ТОТ ЖЕ исход — не verify_failed.
      const notJsonResponse = yield* Harness.post(Harness.connectTokenRoute(notJsonAlias), {
        method: "personal_token",
        token: "abcdef",
      })
      expect((yield* Harness.body<{ verify_result: string }>(notJsonResponse)).verify_result).toBe("account_missing")

      const config = yield* Effect.promise(() => Harness.globalConfig())
      expect(config.mcp?.[jsonAlias]).toBeUndefined()
      expect(config.mcp?.[notJsonAlias]).toBeUndefined()
    }),
  )
})

describe("connect-token — обмен: не более одного запроса, четыре исхода (S-V25 п.5; AC-318)", () => {
  Harness.it.live("AC-318: четыре РАЗНЫХ exchange_result; подключение состоялось во всех четырёх случаях", () =>
    Effect.gen(function* () {
      const target = Harness.state.target
      target.routes.set("/verify", () => Harness.json({}))
      const cases: { path: string; status: number; body: unknown; expected: string }[] = [
        { path: "/x-ok", status: 200, body: { access_token: "issued-token-value", id: "tok-1" }, expected: "exchanged" },
        { path: "/x-403", status: 403, body: {}, expected: "exchange_denied" },
        { path: "/x-empty", status: 200, body: {}, expected: "exchange_failed" },
      ]
      const servers = cases.map((entry, index) => {
        target.routes.set(entry.path, () => Harness.json(entry.body, entry.status))
        return directCard(`direct-exchange-${index}`, target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, {
              verify: { url: `${target.url}/verify` },
              exchange: { url: `${target.url}${entry.path}`, token_field: "access_token", token_id_field: "id" },
            }),
          ],
        })
      })
      // Четвёртый случай — сеть недостижима — отдельным alias на нерабочем порту, без реального обмена.
      servers.push(
        directCard("direct-exchange-unreachable", target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, {
              verify: { url: `${target.url}/verify` },
              exchange: { url: "http://127.0.0.1:1/exchange", token_field: "access_token" },
            }),
          ],
        }),
      )
      serveCatalog(servers)

      const outcomes: string[] = []
      for (const [index, entry] of cases.entries()) {
        const response = yield* Harness.post(Harness.connectTokenRoute(`direct-exchange-${index}`), {
          method: "personal_token",
          token: "user-entered-token",
        })
        const result = yield* Harness.body<{ verify_result: string; exchange_result: string }>(response)
        expect(result.verify_result).toBe("verified")
        expect(result.exchange_result, entry.path).toBe(entry.expected)
        outcomes.push(result.exchange_result)
        // Ни один из трёх неуспешных исходов не отменяет подключение (S-V25 п.5).
        const config = yield* Effect.promise(() => Harness.globalConfig())
        expect(config.mcp?.[`direct-exchange-${index}`]).toEqual({
          type: "remote",
          url: `${target.url}/mcp`,
          enabled: true,
          oauth: false,
        })
      }
      const unreachableResponse = yield* Harness.post(Harness.connectTokenRoute("direct-exchange-unreachable"), {
        method: "personal_token",
        token: "user-entered-token",
      })
      const unreachableResult = yield* Harness.body<{ exchange_result: string }>(unreachableResponse)
      expect(unreachableResult.exchange_result).toBe("exchange_unreachable")
      outcomes.push(unreachableResult.exchange_result)
      expect(new Set(outcomes).size).toBe(4)

      // exchanged — в хранилище лежит ВЫПУЩЕННЫЙ токен, а не введённый; остальные три хранят введённый.
      const store = JSON.parse((yield* Effect.promise(() => Harness.credentialsFileText()))!)
      expect(store["direct-exchange-0"]).toMatchObject({ token: "issued-token-value", token_id: "tok-1", issued: true })
      expect(store["direct-exchange-1"]).toMatchObject({ token: "user-entered-token", issued: false })
      expect(store["direct-exchange-2"]).toMatchObject({ token: "user-entered-token", issued: false })
      expect(store["direct-exchange-unreachable"]).toMatchObject({ token: "user-entered-token", issued: false })
    }),
  )

  Harness.it.live("AC-318: способ без блока exchange даёт exchange_result:null", () =>
    Effect.gen(function* () {
      const alias = "direct-no-exchange"
      const target = Harness.state.target
      target.routes.set("/verify", () => Harness.json({}))
      serveCatalog([
        directCard(alias, target.url, {
          auth_methods: [oauthMethod(), tokenMethod(target.url, { verify: { url: `${target.url}/verify` } })],
        }),
      ])

      const response = yield* Harness.post(Harness.connectTokenRoute(alias), { method: "personal_token", token: "abcdef" })
      const result = yield* Harness.body<{ exchange_result: string | null }>(response)
      expect(result.exchange_result).toBeNull()
    }),
  )
})

describe("connect-token — сохранение и соединение (S-V25 п.6, S-V29; AC-320, AC-350 прогон 1)", () => {
  Harness.it.live("AC-320: mcp.<alias>.url == upstream.url, а не facade mcp_url; без oauth и без headers", () =>
    Effect.gen(function* () {
      const alias = "direct-connect-shape"
      const target = Harness.state.target
      target.routes.set("/verify", () => Harness.json({}))
      serveCatalog([
        directCard(alias, target.url, {
          mode: "facade",
          mcp_url: `${target.url}/mcp-proxy/${alias}`,
          auth_methods: [oauthMethod(), tokenMethod(target.url, { verify: { url: `${target.url}/verify` } })],
          upstream: upstreamBlock(target.url),
        }),
      ])

      const response = yield* Harness.post(Harness.connectTokenRoute(alias), { method: "personal_token", token: "abcdef" })
      expect(response.status).toBe(200)
      const config = yield* Effect.promise(() => Harness.globalConfig())
      expect(config.mcp[alias]).toEqual({ type: "remote", url: `${target.url}/mcp`, enabled: true, oauth: false })
      expect(config.mcp[alias].url).not.toBe(`${target.url}/mcp-proxy/${alias}`)
      // errata 1.13.4 (D-63): ключ oauth ОБЯЗАН присутствовать и быть РОВНО false — не отсутствовать
      // и не быть объектом. Отсутствие ключа оставляет MCP-OAuth вооружённым.
      // Эта же проверка — AC-350, прогон (1) («прочитан глобальный конфиг»): mcp.<alias>.oauth
      // равен РОВНО false у alias, подключённого прямым способом. Прогоны (2) и (3) того же
      // критерия — реальный upstream-роут `MCP.startAuth` и классификация 401 — этот харнесс не
      // может проверить (MCP замокан на границе сервиса, см. шапку файла): они в
      // `test/mcp/direct-oauth-disarm.test.ts`, на настоящем `MCP.Service`.
      expect(config.mcp[alias].oauth).toBe(false)
      expect("headers" in config.mcp[alias]).toBe(false)
      expect(Harness.state.calls).toContain(`add:${alias}`)
    }),
  )
})

/**
 * MAJ-2 ревью review-i4-rev113-1: AC-324 и AC-325 объявлены `type: integration` («when: выполнен
 * POST …/connect-token» / «when: открыта витрина и страница коннектора»), а были реализованы
 * unit-тестом чистой функции `CorpCredentials.save()`/`read()` в `credentials.test.ts` — роут не
 * поднимался вовсе. Инъекция ИНЖ-8 (снят охранник `if (!saved.ok)` в `connectToken`) оставляла
 * 556/0 зелёными именно из-за этого: юнит видел отказ `save()`, но не видел, что роут с ним делает.
 * Здесь оба критерия проходятся через настоящий HTTP-роут харнесса (`Harness.post`/`Harness.get`),
 * а не через прямой вызов модуля `credentials.ts`.
 */
describe("connect-token — хранилище недоступно на настоящем роуте, а не только в модуле (S-V26 п.5; AC-324, AC-325)", () => {
  Harness.it.live(
    "AC-324: POST …/connect-token с недоступным для записи каталогом данных — 500 storage_unavailable, mcp.<alias> НЕ записан, соединение НЕ поднято, карточка НЕ подключена",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return // fs.chmod на Windows переключает только read-only
        const alias = "direct-storage-unavailable"
        const target = Harness.state.target
        target.routes.set("/verify", () => Harness.json({ account: "ivanov" }))
        serveCatalog([directCard(alias, target.url)])
        const before = yield* Effect.promise(() => snapshotFiles())

        // Тот же приём, что в юнит-тесте AC-324 (`credentials.test.ts`), применённый к
        // `Global.Path.data`, которым реально пользуется роут: `CorpCredentials.save()` внутри
        // `connectToken` вызывается БЕЗ явного `dataDir` и падает на настоящем каталоге данных.
        yield* Effect.promise(() => fs.chmod(Global.Path.data, 0o500))

        const response = yield* Harness.post(Harness.connectTokenRoute(alias), {
          method: "personal_token",
          token: "abcdef",
        })
        expect(response.status).toBe(500)
        const result = yield* Harness.body<{ error: string; message: string }>(response)
        expect(result.error).toBe("storage_unavailable")
        expect(result.message).toBeTruthy()
        // Значение токена не отдаётся ни в каком поле ответа.
        expect(JSON.stringify(result)).not.toContain("abcdef")

        // Проверка verify состоялась (ровно один запрос) — отказ хранилища наступает ПОСЛЕ неё,
        // а не подменяет её; но ни конфиг, ни соединение MCP этим не затронуты (S-V26 п.5).
        const verifyRequests = target.requests.filter((request) => request.path === "/verify")
        expect(verifyRequests).toHaveLength(1)

        // Восстанавливаем права ДО чтения снимка: сравнение файлов не должно упасть на правах,
        // а не на содержимом — сути отказа хранилища это не отменяет, отказ уже зафиксирован ответом.
        yield* Effect.promise(() => fs.chmod(Global.Path.data, 0o700))
        const after = yield* Effect.promise(() => snapshotFiles())
        // Конфиг НЕ изменился: ключ mcp.<alias> не появился (S-V26 п.5, AC-324).
        expect(after.config).toBe(before.config)

        // Соединение НЕ поднято: ни mcp.add, ни mcp.authenticate не вызваны.
        expect(Harness.state.calls).not.toContain(`add:${alias}`)
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)

        // Карточка НЕ показана подключённой на настоящем роуте каталога.
        const catalogResponse = yield* Harness.get(Harness.CorpPaths.catalog)
        const view = yield* Harness.body<{
          servers: { alias: string; status: string; state: string; has_credentials: boolean }[]
        }>(catalogResponse)
        const card = view.servers.find((entry) => entry.alias === alias)!
        expect(card.status).not.toBe("connected")
        expect(card.state).not.toBe("connected")
        expect(card.has_credentials).toBe(false)
      }),
  )

  Harness.it.live(
    "AC-325: файл хранилища с битым JSON — витрина открывается через настоящий роут, карточка теряет has_credentials, предупреждение уходит в лог, файл НЕ удалён",
    () =>
      Effect.gen(function* () {
        const alias = "direct-corrupted-store"
        const target = Harness.state.target
        target.routes.set("/verify", () => Harness.json({ account: "ivanov" }))
        serveCatalog([directCard(alias, target.url)])

        // Сперва подключаем по-настоящему — запись хранилища существует и применима.
        const MARKER = "MARKER-ac325-token"
        const connectResponse = yield* Harness.post(Harness.connectTokenRoute(alias), {
          method: "personal_token",
          token: MARKER,
        })
        expect(connectResponse.status).toBe(200)
        const connectedCatalog = yield* Harness.get(Harness.CorpPaths.catalog)
        const connectedView = yield* Harness.body<{ servers: { alias: string; has_credentials: boolean }[] }>(
          connectedCatalog,
        )
        expect(connectedView.servers.find((entry) => entry.alias === alias)!.has_credentials).toBe(true)

        // Файл хранилища портится напрямую на диске — не через модуль `credentials.ts` (это уже
        // проверено юнит-тестом), а как внешнее событие между запусками сборки.
        Harness.logs.length = 0
        const file = CorpCredentials.file()
        yield* Effect.promise(() => fs.writeFile(file, "{not valid json", { mode: 0o600 }))

        // Витрина открывается через настоящий роут — не падает, карточки показаны. `refresh=true`
        // обходит memo каталога (S-V3, 60 секунд): без него второй `GET /corp/catalog` в пределах
        // окна вернул бы кэшированный до порчи файла снимок и проверка была бы бессмысленной —
        // страница коннектора (тот же ответ, отфильтрованный на один alias) читает те же карточки.
        const catalogResponse = yield* Harness.get(`${Harness.CorpPaths.catalog}?refresh=true`)
        expect(catalogResponse.status).toBe(200)
        const view = yield* Harness.body<{
          servers: { alias: string; has_credentials: boolean; connect_mode: string }[]
        }>(catalogResponse)
        const card = view.servers.find((entry) => entry.alias === alias)!
        // Затронутая карточка «нужно ввести токен заново»: учётных данных больше не видно, хотя
        // способ прямого подключения по-прежнему доступен — форма ввода токена на экране остаётся.
        expect(card.has_credentials).toBe(false)
        expect(card.connect_mode).toBe("direct")

        // Предупреждение ушло в лог — по имени файла, без значения маркера.
        const logText = JSON.stringify(Harness.logs)
        expect(logText).toContain("corp credentials")
        expect(logText).not.toContain(MARKER)

        // Файл НЕ удалён автоматически и НЕ переписан открытием витрины — битое содержимое на месте;
        // перезаписывается только следующим успешным сохранением (проверено в credentials.test.ts).
        const stillCorrupted = yield* Effect.promise(() => fs.readFile(file, "utf8"))
        expect(stillCorrupted).toBe("{not valid json")
      }),
  )
})

describe("connect-token — границы с прежними способами (S-V29; AC-330, AC-331)", () => {
  Harness.it.live(
    "AC-330: пока действуют прямые учётные данные, «Подключить» (facade) отвечает 400 direct_connected; " +
      "смена upstream.url снимает блокировку",
    () =>
      Effect.gen(function* () {
        const alias = "direct-vs-facade"
        const target = Harness.state.target
        target.routes.set("/verify", () => Harness.json({}))
        serveCatalog([
          directCard(alias, target.url, {
            auth_methods: [oauthMethod(), tokenMethod(target.url, { verify: { url: `${target.url}/verify` } })],
          }),
        ])
        const connected = yield* Harness.post(Harness.connectTokenRoute(alias), { method: "personal_token", token: "abcdef" })
        expect(connected.status).toBe(200)

        const blocked = yield* Harness.post(Harness.connectRoute(alias), {})
        expect(blocked.status).toBe(400)
        const blockedBody = yield* Harness.body<{ error: string }>(blocked)
        expect(blockedBody.error).toBe("direct_connected")
        // Попытка отвергнута без правки конфига: запись подключения осталась прямой.
        const configAfterBlock = yield* Effect.promise(() => Harness.globalConfig())
        expect(configAfterBlock.mcp[alias]).toEqual({ type: "remote", url: `${target.url}/mcp`, enabled: true, oauth: false })

        // Каталог сменил upstream.url — сохранённая запись хранилища больше не применима к этому
        // alias, и попытка facade-подключения перестаёт видеть direct_connected (S-V26 п.3, S-V29).
        serveCatalog([
          directCard(alias, target.url, {
            auth_methods: [oauthMethod(), tokenMethod(target.url, { verify: { url: `${target.url}/verify` } })],
            upstream: upstreamBlock(target.url, { url: `${target.url}/mcp-v2` }),
          }),
        ])
        const afterMove = yield* Harness.post(Harness.connectRoute(alias), {})
        const afterMoveBody = yield* Harness.body<{ error?: string }>(afterMove)
        expect(afterMoveBody.error).not.toBe("direct_connected")
      }),
  )

  Harness.it.live(
    "AC-331: поле connection карточки не влияет на прямо подключённую — приоритет у локальной записи",
    () =>
      Effect.gen(function* () {
        const alias = "direct-vs-connection-field"
        const target = Harness.state.target
        target.routes.set("/verify", () => Harness.json({}))
        // Реалистичный локальный статус после успешного поднятия транспорта — MCP.add сообщает
        // «connected», как это делает настоящая серверная часть после удачного подключения.
        Harness.state.addStatus = { status: "connected" }
        serveCatalog([
          directCard(alias, target.url, {
            auth_methods: [oauthMethod(), tokenMethod(target.url, { verify: { url: `${target.url}/verify` } })],
          }),
        ])
        const connected = yield* Harness.post(Harness.connectTokenRoute(alias), { method: "personal_token", token: "abcdef" })
        expect(connected.status).toBe(200)

        // Тот же alias теперь описан ещё и с полем connection.status:"not_connected" (как если бы
        // источником была запись Hub о другом подключении того же пользователя) — карточка обязана
        // остаться подключённой прямым способом, а не сброситься к «не подключён».
        serveCatalog([
          directCard(alias, target.url, {
            auth_methods: [oauthMethod(), tokenMethod(target.url, { verify: { url: `${target.url}/verify` } })],
            connection: { status: "not_connected", updated_at: "2026-08-28T00:00:00Z" },
          }),
        ])
        const status = yield* Harness.get(Harness.CorpPaths.catalog)
        const view = yield* Harness.body<{ servers: { alias: string; status: string; actions: string[] }[] }>(status)
        const card = view.servers.find((entry) => entry.alias === alias)!
        expect(card.status).toBe("connected")
        expect(card.actions).toContain("disconnect")

        const config = yield* Effect.promise(() => Harness.globalConfig())
        expect(config.mcp[alias]).toEqual({ type: "remote", url: `${target.url}/mcp`, enabled: true, oauth: false })
      }),
  )
})

function nativeCard(alias: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    title: alias,
    status: "beta",
    mode: "native",
    mcp_url: `${Harness.state.target.url}/mcp-native/${alias}`,
    permission_model: { kind: "consent", presets: { default: "Экран согласия" } },
    ...overrides,
  }
}

describe("connect-token — запрет native (S-V28, микроревизия 1.13.1; AC-339, AC-340, AC-343)", () => {
  Harness.it.live("AC-339: POST /connect на native_srv отвечает 409, ни одного исходящего запроса, браузер не открыт", () =>
    Effect.gen(function* () {
      const alias = "native_srv"
      serveCatalog([nativeCard(alias)])
      const before = yield* Effect.promise(() => snapshotFiles())

      const response = yield* Harness.post(Harness.connectRoute(alias), { preset: "readonly" })
      expect(response.status).toBe(409)
      const result = yield* Harness.body<{ error: string; unavailable_code: string }>(response)
      expect(result.error).toBe("auth_method_unavailable")
      expect(result.unavailable_code).toBe("oauth_disabled")

      expect(Harness.state.target.requests.filter((request) => request.path !== "/catalog")).toEqual([])
      const after = yield* Effect.promise(() => snapshotFiles())
      expect(after).toEqual(before)
      expect(yield* Effect.promise(() => Harness.browserOpenCount())).toBe(0)
      expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)
      expect(Harness.state.calls).not.toContain(`add:${alias}`)
    }),
  )

  Harness.it.live(
    "AC-340: PUT permissions на подключённой native_srv записывает права в Hub, но НЕ запускает повторную авторизацию",
    () =>
      Effect.gen(function* () {
        const alias = "native_srv"
        const target = Harness.state.target
        target.routes.set(`/api/me/connections/${alias}/permissions`, () =>
          Harness.json({ alias, status: "needs_reauth", preset: "readwrite" }),
        )
        Harness.state.key = "sk-magnit-test"
        process.env["OPENCODE_CORP_HUB_URL"] = target.url
        serveCatalog([nativeCard(alias)])

        const response = yield* Harness.put(Harness.permissionsRoute(alias), { preset: "readwrite" })
        expect(response.status).toBe(200)
        const result = yield* Harness.body<{ preset: string; reauth_required: boolean }>(response)
        expect(result.preset).toBe("readwrite")
        // Прежние поля ответа — новых полей маршрут не заводит; причину экран берёт из карточки.
        expect(result.reauth_required).toBe(true)

        // Запись прав в Hub ВЫПОЛНЕНА — запрет закрывает браузерный шаг, а не выбор пресета.
        const sent = target.requests.find((request) => request.path === `/api/me/connections/${alias}/permissions`)
        expect(sent?.method).toBe("PUT")

        // Шаг 2 правила S-V7 НЕ запущен: ни одного запроса по OAuth-адресам MCP-сервера, браузер не открыт.
        const oauthRequests = target.requests.filter(
          (request) => request.path !== "/catalog" && request.path !== `/api/me/connections/${alias}/permissions`,
        )
        expect(oauthRequests).toEqual([])
        expect(yield* Effect.promise(() => Harness.browserOpenCount())).toBe(0)
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)

        const config = yield* Effect.promise(() => Harness.globalConfig())
        expect(config.mcp?.[alias]?.oauth).toBeUndefined()
      }),
  )

  Harness.it.live(
    "AC-343: сборка без Hub (только CORP_CATALOG_URL) — native и facade закрыты и видны, прямое подключение работает",
    () =>
      Effect.gen(function* () {
        const target = Harness.state.target
        target.routes.set("/verify", () => Harness.json({}))
        const nativeAlias = "native_srv"
        const facadeAlias = "facade_srv"
        const directAlias = "direct_srv"
        serveCatalog([
          nativeCard(nativeAlias),
          { alias: facadeAlias, title: facadeAlias, status: "beta", mode: "facade", mcp_url: `${target.url}/mcp-facade` },
          directCard(directAlias, target.url, {
            auth_methods: [oauthMethod(), tokenMethod(target.url, { verify: { url: `${target.url}/verify` } })],
          }),
        ])

        // Витрина и все три страницы коннектора открываются.
        const catalogResponse = yield* Harness.get(Harness.CorpPaths.catalog)
        const view = yield* Harness.body<{
          servers: { alias: string; connect_mode: string; connect_mode_unavailable_code?: string }[]
        }>(catalogResponse)
        const byAlias = Object.fromEntries(view.servers.map((entry) => [entry.alias, entry]))
        expect(byAlias[nativeAlias]!.connect_mode).toBe("none")
        expect(byAlias[nativeAlias]!.connect_mode_unavailable_code).toBe("oauth_disabled")
        expect(byAlias[facadeAlias]!.connect_mode).toBe("none")
        expect(byAlias[facadeAlias]!.connect_mode_unavailable_code).toBe("facade_needs_hub")
        expect(byAlias[directAlias]!.connect_mode).toBe("direct")

        // Попытка подключить native — тот же 409, что в AC-339.
        const nativeAttempt = yield* Harness.post(Harness.connectRoute(nativeAlias), {})
        expect(nativeAttempt.status).toBe(409)

        // Прямое подключение — единственный работающий способ в этой сборке.
        const direct = yield* Harness.post(Harness.connectTokenRoute(directAlias), {
          method: "personal_token",
          token: "abcdef",
        })
        expect(direct.status).toBe(200)
        expect((yield* Harness.body<{ verify_result: string }>(direct)).verify_result).toBe("verified")

        // Ни одного запроса по OAuth-адресам, ни одного по адресу Hub (не настроен вовсе).
        const suspectPaths = target.requests.filter(
          (request) => !["/catalog", "/verify"].includes(request.path),
        )
        expect(suspectPaths).toEqual([])
        expect(yield* Effect.promise(() => Harness.browserOpenCount())).toBe(0)

        // Обе закрытые карточки остались в витрине с названными причинами.
        const finalCatalog = yield* Harness.get(Harness.CorpPaths.catalog)
        const finalView = yield* Harness.body<{ servers: { alias: string }[] }>(finalCatalog)
        expect(finalView.servers.map((entry) => entry.alias).sort()).toEqual(
          [nativeAlias, facadeAlias, directAlias].sort(),
        )
      }),
  )

  Harness.it.live(
    "AC-251: сборка без Hub, native — 409 oauth_disabled, конфиг побайтово тот же, браузер не открыт, карточка видна неактивной",
    () =>
      Effect.gen(function* () {
        // Микроревизия 1.13.1 отменила прежнее требование AC-251 (записать mcp.<alias> и запустить
        // штатный MCP OAuth) и заменила его тем же запретом S-V28, что и в сборке с Hub (AC-339):
        // отсутствие Hub на исход не влияет — причина отказа та же (S-C10).
        const alias = "native_no_hub"
        serveCatalog([nativeCard(alias)])
        const before = yield* Effect.promise(() => snapshotFiles())

        const response = yield* Harness.post(Harness.connectRoute(alias), {})
        expect(response.status).toBe(409)
        const result = yield* Harness.body<{ error: string; unavailable_code: string }>(response)
        expect(result.error).toBe("auth_method_unavailable")
        expect(result.unavailable_code).toBe("oauth_disabled")

        // Ни DCR, ни PKCE, ни callback — ни одного исходящего запроса, кроме получения каталога.
        expect(Harness.state.target.requests.filter((request) => request.path !== "/catalog")).toEqual([])
        expect(yield* Effect.promise(() => Harness.browserOpenCount())).toBe(0)
        // Конфиг побайтово тот же, что в снимке — mcp.<alias> не создан.
        const after = yield* Effect.promise(() => snapshotFiles())
        expect(after).toEqual(before)

        // Карточка остаётся в витрине с действием «Подключить», отрисованным неактивным по этой же
        // причине — оболочка берёт connect_mode/connect_mode_unavailable_code из ответа роута
        // (проверка разметки — AC-341), здесь проверяется сам ответ роута каталога.
        const catalogResponse = yield* Harness.get(Harness.CorpPaths.catalog)
        const view = yield* Harness.body<{
          servers: { alias: string; connect_mode: string; connect_mode_unavailable_code?: string }[]
        }>(catalogResponse)
        const card = view.servers.find((entry) => entry.alias === alias)!
        expect(card.connect_mode).toBe("none")
        expect(card.connect_mode_unavailable_code).toBe("oauth_disabled")
      }),
  )
})

/**
 * BLK-1 (review-i4-rev113-1): сторож на этот дефект отсутствовал ни в одном из 1289 тестов сборки —
 * ни один не бил по карточке `mode:"native"` с разобранным `upstream` **и** доступным способом
 * `user_token`. Такую форму данных Hub не выпускает (R-U8.1 п.4: `user_token` при `mode:native`
 * запрещён его схемой), но статический каталог (S-C10 п.3) пишется руками, а S-V24 п.6 запрещает
 * клиенту опираться на добросовестность источника.
 *
 * На такой карточке строка 1 таблицы S-V7 сильнее строки 2: `connect_mode` вычисляется в
 * `"direct"`, и производный `connect_mode_unavailable_code` поэтому равен `null` (строка «а»
 * таблицы S-V28 п.2). Охранник роута, спрашивающий этот ПРОИЗВОДНЫЙ код причины, такую карточку
 * пропускал бы к штатному MCP OAuth с браузером — ровно это ревью и воспроизвело временным тестом
 * через настоящий роут (POST /connect → 200, mcp.<alias> записан, mcp.add и mcp.authenticate
 * вызваны). Оба роута теперь спрашивают признак `nativeConnectDisabled` напрямую — по
 * `server.mode === "native"` — у которого пути стать неверным на этой карточке нет; тесты ниже
 * проверяют это на **настоящем** HTTP-роуте, а не на чистой функции `status.ts`.
 */
describe("connect-token — BLK-1: запрет native не обходится карточкой mode:native с разобранным upstream и доступным user_token (S-V7, S-V28 п.2, п.5; AC-348)", () => {
  function forbiddenNativeCard(alias: string, overrides: Record<string, unknown> = {}) {
    const target = Harness.state.target.url
    return nativeCard(alias, {
      auth_methods: [tokenMethod(target)],
      upstream: upstreamBlock(target),
      ...overrides,
    })
  }

  Harness.it.live(
    'AC-348 (1): POST /connect на карточке native+direct — 409 oauth_disabled, а не штатный MCP OAuth, хотя connect_mode == "direct" и connect_mode_unavailable_code == null',
    () =>
      Effect.gen(function* () {
        const alias = "native_direct_shape"
        serveCatalog([forbiddenNativeCard(alias)])

        // Подтверждаем предпосылку теста: производный код причины действительно `null` на этой
        // карточке (иначе тест проверял бы не то, что сломалось в BLK-1: S-V7 строка 1 сильнее строки 2).
        const precheckCatalog = yield* Harness.get(Harness.CorpPaths.catalog)
        const precheckView = yield* Harness.body<{
          servers: { alias: string; connect_mode: string; connect_mode_unavailable_code?: string }[]
        }>(precheckCatalog)
        const precheckCard = precheckView.servers.find((entry) => entry.alias === alias)!
        expect(precheckCard.connect_mode).toBe("direct")
        expect(precheckCard.connect_mode_unavailable_code).toBeUndefined()

        const before = yield* Effect.promise(() => snapshotFiles())
        const response = yield* Harness.post(Harness.connectRoute(alias), {})
        expect(response.status).toBe(409)
        const result = yield* Harness.body<{ error: string; unavailable_code: string }>(response)
        expect(result.error).toBe("auth_method_unavailable")
        expect(result.unavailable_code).toBe("oauth_disabled")

        // Ни единого исходящего запроса, кроме получения каталога — ни discovery, ни DCR, ни
        // authorize, ни token; браузер не открыт.
        expect(Harness.state.target.requests.filter((request) => request.path !== "/catalog")).toEqual([])
        expect(yield* Effect.promise(() => Harness.browserOpenCount())).toBe(0)
        expect(Harness.state.calls).not.toContain(`add:${alias}`)
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)

        // Конфиг побайтово тот же: mcp.<alias> не создан ни штатным MCP OAuth, ни прямым режимом
        // (прямой режим на этой карточке подключается только через POST …/connect-token, не /connect).
        const after = yield* Effect.promise(() => snapshotFiles())
        expect(after).toEqual(before)
      }),
  )

  Harness.it.live(
    "AC-348 (2): PUT /permissions на карточке native+direct с ответом Hub needs_reauth — права записаны в Hub, но повторная авторизация НЕ запущена",
    () =>
      Effect.gen(function* () {
        const alias = "native_direct_shape_reauth"
        const target = Harness.state.target
        target.routes.set(`/api/me/connections/${alias}/permissions`, () =>
          Harness.json({ alias, status: "needs_reauth", preset: "readwrite" }),
        )
        Harness.state.key = "sk-magnit-test"
        process.env["OPENCODE_CORP_HUB_URL"] = target.url
        serveCatalog([forbiddenNativeCard(alias)])

        const response = yield* Harness.put(Harness.permissionsRoute(alias), { preset: "readwrite" })
        expect(response.status).toBe(200)
        const result = yield* Harness.body<{ preset: string; reauth_required: boolean }>(response)
        expect(result.preset).toBe("readwrite")
        // Запись прав в Hub ВЫПОЛНЕНА — запрет закрывает браузерный шаг, а не выбор пресета.
        expect(result.reauth_required).toBe(true)
        const sent = target.requests.find((request) => request.path === `/api/me/connections/${alias}/permissions`)
        expect(sent?.method).toBe("PUT")

        // Шаг 2 правила S-V7 НЕ запущен: ни одного запроса по OAuth-адресам, браузер не открыт,
        // mcp.authenticate не вызван — несмотря на то, что connect_mode этой карточки "direct" и
        // connect_mode_unavailable_code равен null.
        const oauthRequests = target.requests.filter(
          (request) => request.path !== "/catalog" && request.path !== `/api/me/connections/${alias}/permissions`,
        )
        expect(oauthRequests).toEqual([])
        expect(yield* Effect.promise(() => Harness.browserOpenCount())).toBe(0)
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)
      }),
  )

  // AC-348, прогон (3) — ОБЯЗАТЕЛЬНЫЙ третий прогон критерия: запрет S-V28 закрывает только
  // OAuth-путь (шаг 2 S-V7), а не карточку целиком. Без этого теста сторож удовлетворяла бы и
  // реализация «на этой форме карточки отказывать всегда» — ровно то расширение дефекта, о
  // котором предупреждает тело AC-348 (D-63 упомянут только в AC-320/AC-350; здесь — S-V28 п.10а).
  Harness.it.live(
    "AC-348 (3): POST /connect-token на той же карточке native+direct — прямое подключение РАБОТАЕТ, форма патча как у S-V25 п.6б",
    () =>
      Effect.gen(function* () {
        const alias = "native_direct_shape_token"
        const target = Harness.state.target
        target.routes.set("/verify", () => Harness.json({}))
        serveCatalog([forbiddenNativeCard(alias)])

        const response = yield* Harness.post(Harness.connectTokenRoute(alias), {
          method: "personal_token",
          token: "abcdef",
        })
        expect(response.status).toBe(200)
        const result = yield* Harness.body<{ verify_result: string }>(response)
        expect(result.verify_result).toBe("verified")

        const config = yield* Effect.promise(() => Harness.globalConfig())
        expect(config.mcp[alias]).toEqual({ type: "remote", url: `${target.url}/mcp`, enabled: true, oauth: false })
        expect(Harness.state.calls).toContain(`add:${alias}`)
      }),
  )
})

/**
 * BLK-2 (errata 1.13.4, S-V28 п.10б): предикат «режим карточки неизвестен» обязан деградировать в
 * сторону ЗАПРЕТА, а не в сторону разрешения. До починки инъекция ИНЖ-В2 (уборка `server ===
 * undefined ||` из охранника роута permissions) оставляла `state.calls` равным
 * `["authenticate:<alias>"]` на alias, локально помеченном подключённым, но пропавшем из
 * действующего каталога — ровно обход, который здесь проверяется на настоящем HTTP-роуте.
 *
 * Оба прогона ниже различаются ТОЛЬКО причиной, по которой режим карточки неизвестен — каталог
 * без alias вовсе, и каталог, где alias есть, но не прошёл разбор ядра (S-V14 п.2) и осел в
 * `dropped[]`. Оба обязаны вести себя одинаково: запись прав в Hub выполняется (деградация не
 * молчит и не теряет действие пользователя), а браузерный шаг S-V7 — нет.
 *
 * Третий сценарий в этом же describe — КОНТРОЛЬНЫЙ, не входит в тело AC-349: та же карточка, но
 * НЕ закрытая (`facade` с `needs_reauth`), обязана запускать `authenticate`. Без него сторож
 * удовлетворяла бы и реализация «никогда не авторизовывать» — она проходит оба «неизвестных»
 * прогона нулём вызовов `authenticate`, ничего не проверяя по существу.
 */
describe("connect-token — BLK-2: PUT permissions на alias с неизвестным режимом карточки деградирует к запрету (S-V28 п.10б; AC-349)", () => {
  /** Локальная запись подключения — без неё «повторная авторизация не запущена» ничего не значит. */
  async function seedLocalConnection(alias: string, upstreamUrl: string) {
    await fs.writeFile(
      path.join(Global.Path.config, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: { [alias]: { type: "remote", url: upstreamUrl, enabled: true, oauth: false } },
      }),
    )
    Harness.state.statuses[alias] = { status: "connected" }
  }

  const unknownModeCases: { label: string; alias: string; catalog: (alias: string) => unknown[] }[] = [
    {
      label: "каталог отдаёт servers: [] — карточки в нём нет вовсе (администратор убрал)",
      alias: "blk2-empty-catalog",
      catalog: () => [],
    },
    {
      label: "карточка в каталоге есть, но её ядро не разобрано (нет mode/mcp_url) — попала в dropped[]",
      alias: "blk2-dropped-card",
      catalog: (alias) => [{ alias, title: alias }],
    },
  ]

  for (const testCase of unknownModeCases) {
    Harness.it.live(`AC-349: ${testCase.label} — reauth ЗАПРОШЕН, но не выполнен; права в Hub записаны`, () =>
      Effect.gen(function* () {
        const alias = testCase.alias
        const target = Harness.state.target
        const upstreamUrl = `${target.url}/mcp`
        yield* Effect.promise(() => seedLocalConnection(alias, upstreamUrl))
        target.routes.set(`/api/me/connections/${alias}/permissions`, () =>
          Harness.json({ alias, status: "needs_reauth", preset: "readwrite" }),
        )
        Harness.state.key = "sk-magnit-test"
        process.env["OPENCODE_CORP_HUB_URL"] = target.url
        serveCatalog(testCase.catalog(alias))

        // Предпосылка зафиксирована явно, как в стороже BLK-1: среди РАЗОБРАННЫХ карточек каталога
        // alias нет — режим карточки поэтому НЕИЗВЕСТЕН (не "direct", не "native", не "none").
        // Карточка МОЖЕТ появиться в ответе `servers` (S-V15: alias когда-то был подключён, витрина
        // показывает его "unavailable" по локальному признаку), но полей `connect_mode` у такой
        // синтетической записи нет — их даёт только `serverFor`, ровно то же место, что читает
        // охранник роута. Для второго прогона предпосылка также требует, что alias осел в dropped[].
        const precheckCatalog = yield* Harness.get(Harness.CorpPaths.catalog)
        const precheckView = yield* Harness.body<{
          servers: { alias: string; connect_mode?: string }[]
          dropped?: { alias?: string; reason: string }[]
        }>(precheckCatalog)
        expect(precheckView.servers.find((entry) => entry.alias === alias)?.connect_mode).toBeUndefined()
        if (testCase.label.includes("dropped"))
          expect(precheckView.dropped?.some((entry) => entry.alias === alias)).toBe(true)

        const response = yield* Harness.put(Harness.permissionsRoute(alias), { preset: "readwrite" })
        expect(response.status).toBe(200)
        const result = yield* Harness.body<{ reauth_required: boolean }>(response)
        expect(result.reauth_required).toBe(true)

        // Запись прав в Hub ВЫПОЛНЕНА — деградация закрывает браузерный шаг, а не запись пресета.
        const sent = target.requests.find((request) => request.path === `/api/me/connections/${alias}/permissions`)
        expect(sent?.method).toBe("PUT")

        // Шаг 2 правила S-V7 НЕ запущен: ни одной записи authenticate:* в журнале MCP (до починки
        // было ["authenticate:<alias>"]), ни одного исходящего запроса к MCP-серверу.
        expect(Harness.state.calls.filter((call) => call.startsWith("authenticate:"))).toEqual([])
        const oauthRequests = target.requests.filter(
          (request) => request.path !== "/catalog" && request.path !== `/api/me/connections/${alias}/permissions`,
        )
        expect(oauthRequests).toEqual([])
        expect(yield* Effect.promise(() => Harness.browserOpenCount())).toBe(0)

        const config = yield* Effect.promise(() => Harness.globalConfig())
        expect(config.mcp[alias]).toEqual({ type: "remote", url: upstreamUrl, enabled: true, oauth: false })
      }),
    )
  }

  Harness.it.live(
    "контроль: тот же запрос на карточке, которая ЕСТЬ и НЕ закрыта (facade с needs_reauth), ЗАПУСКАЕТ authenticate",
    () =>
      Effect.gen(function* () {
        const alias = "blk2-open-card"
        const target = Harness.state.target
        target.routes.set(`/api/me/connections/${alias}/permissions`, () =>
          Harness.json({ alias, status: "needs_reauth", preset: "readwrite" }),
        )
        Harness.state.key = "sk-magnit-test"
        process.env["OPENCODE_CORP_HUB_URL"] = target.url
        // Чистая facade-карточка (без upstream и способа user_token) — connect_mode вычисляется в
        // "facade", а не в "direct"; nativeConnectDisabled ложна на любой не-native карточке, так
        // что этот запрос обязан остаться ОТКРЫТЫМ — предикат бьёт только по mode:"native".
        serveCatalog([nativeCard(alias, { mode: "facade", auth_methods: [oauthMethod()], upstream: undefined })])

        // «Подключить» сперва — как в обычном пользовательском пути (AC-64 orchestration.test.ts):
        // без базовой записи mcp.<alias> патч прав (oauth.scope) писать было бы не на что.
        const connected = yield* Harness.post(Harness.connectRoute(alias), {})
        expect(connected.status).toBe(200)
        Harness.state.calls = []

        const response = yield* Harness.put(Harness.permissionsRoute(alias), { preset: "readwrite" })
        expect(response.status).toBe(200)
        const result = yield* Harness.body<{ reauth_required: boolean }>(response)
        expect(result.reauth_required).toBe(true)
        expect(Harness.state.calls).toContain(`authenticate:${alias}`)
      }),
  )
})

describe("connect-token — отзыв при «Отключить» (S-V27; AC-327, AC-328)", () => {
  Harness.it.live("AC-327: три РАЗНЫХ исхода revoke; запись хранилища удалена во всех трёх, без Hub", () =>
    Effect.gen(function* () {
      const target = Harness.state.target
      target.routes.set("/verify", () => Harness.json({}))
      target.routes.set("/exchange", () => Harness.json({ access_token: "issued-value", id: "tok-1" }))
      const cases: { path: string; status: number; expected: string }[] = [
        { path: "/r-ok", status: 200, expected: "revoked" },
        { path: "/r-500", status: 500, expected: "not_revoked" },
      ]
      const servers = cases.map((entry, index) => {
        target.routes.set(entry.path, () => new Response("", { status: entry.status }))
        return directCard(`direct-revoke-${index}`, target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, {
              verify: { url: `${target.url}/verify` },
              exchange: {
                url: `${target.url}/exchange`,
                token_field: "access_token",
                token_id_field: "id",
                revoke: { url: `${target.url}${entry.path}` },
              },
            }),
          ],
        })
      })
      servers.push(
        directCard("direct-revoke-unreachable", target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, {
              verify: { url: `${target.url}/verify` },
              exchange: {
                url: `${target.url}/exchange`,
                token_field: "access_token",
                token_id_field: "id",
                revoke: { url: "http://127.0.0.1:1/revoke" },
              },
            }),
          ],
        }),
      )
      serveCatalog(servers)

      const aliases = ["direct-revoke-0", "direct-revoke-1", "direct-revoke-unreachable"]
      for (const alias of aliases) {
        const connect = yield* Harness.post(Harness.connectTokenRoute(alias), { method: "personal_token", token: "abcdef" })
        expect((yield* Harness.body<{ exchange_result: string }>(connect)).exchange_result).toBe("exchanged")
      }

      const outcomes: string[] = []
      for (const alias of aliases) {
        const response = yield* Harness.post(Harness.disconnectRoute(alias))
        const result = yield* Harness.body<{ revoke?: string }>(response)
        outcomes.push(result.revoke!)
        const store = yield* Effect.promise(() => Harness.credentialsFileText())
        expect(store === undefined || !store.includes(`"${alias}"`)).toBe(true)
      }
      expect(outcomes[0]).toBe("revoked")
      expect(outcomes[1]).toBe("not_revoked")
      expect(outcomes[2]).toBe("unreachable")
      expect(new Set(outcomes).size).toBe(3)
      // Ни при заданном, ни при незаданном адресе Hub шага обращения к Hub у прямого подключения нет
      // вовсе (S-V27 п.1) — в этой сборке Hub не настроен, и его отсутствие тому не мешает.
    }),
  )

  Harness.it.live("AC-328: чужой токен (issued:false) и способ без revoke — оба дают skipped, без запроса", () =>
    Effect.gen(function* () {
      const target = Harness.state.target
      target.routes.set("/verify", () => Harness.json({}))
      target.routes.set("/revoke-should-not-be-called", () => new Response("", { status: 200 }))
      serveCatalog([
        // Токен введён пользователем — обмена нет, issued:false.
        directCard("direct-skip-no-exchange", target.url, {
          auth_methods: [oauthMethod(), tokenMethod(target.url, { verify: { url: `${target.url}/verify` } })],
        }),
        // Обмен есть и выпустил токен, но у способа нет блока revoke.
        directCard("direct-skip-no-revoke", target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, {
              verify: { url: `${target.url}/verify` },
              exchange: { url: `${target.url}/exchange-2`, token_field: "access_token" },
            }),
          ],
        }),
      ])
      target.routes.set("/exchange-2", () => Harness.json({ access_token: "issued-value" }))

      for (const alias of ["direct-skip-no-exchange", "direct-skip-no-revoke"])
        yield* Harness.post(Harness.connectTokenRoute(alias), { method: "personal_token", token: "abcdef" })

      const before = target.requests.length
      for (const alias of ["direct-skip-no-exchange", "direct-skip-no-revoke"]) {
        const response = yield* Harness.post(Harness.disconnectRoute(alias))
        const result = yield* Harness.body<{ revoke?: string }>(response)
        expect(result.revoke).toBe("skipped")
      }
      // Отзывать было некого — ни одного нового запроса за оба отключения.
      expect(target.requests.length).toBe(before)
    }),
  )
})

describe("connect-token — «Убрать из списка» у прямого подключения (S-V27 п.4; AC-329)", () => {
  Harness.it.live("AC-329: отзыв + удаление хранилища + удаление mcp.<alias> из конфига, без Hub", () =>
    Effect.gen(function* () {
      const alias = "direct-forget"
      const target = Harness.state.target
      target.routes.set("/verify", () => Harness.json({}))
      target.routes.set("/exchange", () => Harness.json({ access_token: "issued-value", id: "tok-1" }))
      target.routes.set("/revoke", () => new Response("", { status: 200 }))
      serveCatalog([
        directCard(alias, target.url, {
          auth_methods: [
            oauthMethod(),
            tokenMethod(target.url, {
              verify: { url: `${target.url}/verify` },
              exchange: { url: `${target.url}/exchange`, token_field: "access_token", token_id_field: "id", revoke: { url: `${target.url}/revoke` } },
            }),
          ],
        }),
      ])
      yield* Harness.post(Harness.connectTokenRoute(alias), { method: "personal_token", token: "abcdef" })

      const response = yield* Harness.del(Harness.forgetRoute(alias))
      const result = yield* Harness.body<{ removed: boolean; revoke?: string }>(response)
      expect(result.removed).toBe(true)
      expect(result.revoke).toBe("revoked")

      const config = yield* Effect.promise(() => Harness.globalConfig())
      expect(config.mcp?.[alias]).toBeUndefined()
      const store = yield* Effect.promise(() => Harness.credentialsFileText())
      expect(store === undefined || !store.includes(`"${alias}"`)).toBe(true)
      // Обращений по адресу Hub нет при любом его значении — в этой сборке Hub не настроен.
      const revokeRequests = target.requests.filter((request) => request.path === "/revoke")
      expect(revokeRequests).toHaveLength(1)

      // Карточка осталась в витрине, в состоянии 1 таблицы S-V16 («Не подключён»): «Подключить»
      // снова доступно, «Отключить» и «Убрать из списка» — нет.
      const catalogResponse = yield* Harness.get(Harness.CorpPaths.catalog)
      const view = yield* Harness.body<{
        servers: { alias: string; actions: string[]; connect_mode: string; has_credentials: boolean }[]
      }>(catalogResponse)
      const card = view.servers.find((entry) => entry.alias === alias)!
      // Форму подключения (S-D13) страница рисует по `connect_mode`, а не по составу `actions`
      // (тому же полю, которым эта карточка была подключена, — S-V25 п.4). Она осталась «direct»,
      // и токен можно ввести заново.
      expect(card.connect_mode).toBe("direct")
      expect(card.has_credentials).toBe(false)
      expect(card.actions).not.toContain("disconnect")
      expect(card.actions).not.toContain("forget")
    }),
  )
})

/**
 * BLK-3 (errata 1.13.5, ревью `review-i4-rev113-3`): четвёртый обход того же класса, что BLK-1/BLK-2
 * (S-V28 п.10). `permissionsPatch` не создавал запись `mcp.<alias>`, а **изменял** её: на прямо
 * подключённом alias `PUT …/permissions` переписывал `mcp.<alias>.oauth` с `false` на `{scope}`,
 * снимая разоружение D-63, и роут запускал на такой записи `mcp.authenticate` — цепочку `native` в
 * два шага мимо запрета S-V28 (S-V25 п.6б создаёт запись, upstream-роут `POST
 * /mcp/:alias/auth/authenticate` её авторизует). Пятый путь того же класса, найденный при починке
 * первого: после «Отключить» учётные данные удалены, но запись остаётся `{enabled:false,
 * url:<целевая система>, oauth:false}` — признак способа подключения (`directConnected`) её уже не
 * ловит, а `PUT permissions` при `needs_reauth` звал `authenticate` на записи с адресом целевой
 * системы, опираясь на чужой охранник `MCP.startAuth` (`mcp/index.ts`, D-63) как на единственный.
 *
 * Оба следствия закрыты одним условием `CorpConnectors.oauthDisarmed` (записано один раз, S-V28
 * п.3), которое спрашивают independently ДВЕ точки: `permissionsPatch` (два независимых отказа —
 * `directConnected` и `oauthDisarmed(current)`, ни один не покрывает другой) и охранник браузерного
 * шага `oauthClosed` в роуте (`directConnected || oauthDisarmed(entry) || server === undefined ||
 * nativeConnectDisabled(...)`).
 *
 * AC-351 — перебор действий витрины над ОДНИМ прямо подключённым alias, плюс обязательный
 * контрольный случай (обычная facade-карточка, где перевооружение и повторная авторизация ДОЛЖНЫ
 * происходить — без него сторож удовлетворяла бы реализация «никогда не менять права»).
 */
describe("connect-token — BLK-3: «Права»/«Отключить»/«Убрать из списка» не перевооружают прямое подключение (S-V9, S-V25, S-V28, S-V29; AC-351)", () => {
  Harness.it.live(
    "AC-351: пять действий подряд над прямо подключённым alias — oauth остаётся РОВНО false до конца, authenticate не вызван ни разу",
    () =>
      Effect.gen(function* () {
        const alias = "blk3-direct-showcase"
        const target = Harness.state.target
        target.routes.set("/verify", () => Harness.json({ account: "ivanov" }))
        Harness.state.key = "sk-magnit-test"
        process.env["OPENCODE_CORP_HUB_URL"] = target.url
        serveCatalog([directCard(alias, target.url)])

        // Предпосылка (S-V25 п.6б): alias подключён ПРЯМЫМ способом через connect-token.
        const connected = yield* Harness.post(Harness.connectTokenRoute(alias), {
          method: "personal_token",
          token: "abcdef",
        })
        expect(connected.status).toBe(200)
        const upstreamUrl = `${target.url}/mcp`
        const afterConnect = yield* Effect.promise(() => Harness.globalConfig())
        expect(afterConnect.mcp[alias]).toEqual({ type: "remote", url: upstreamUrl, enabled: true, oauth: false })

        const permissionsPath = `/api/me/connections/${alias}/permissions`
        const connectionsPath = `/api/me/connections/${alias}`
        const setHubPermissionsResponse = (status: "needs_reauth" | "connected", preset: string) =>
          target.routes.set(permissionsPath, () => Harness.json({ alias, status, preset }))

        function expectOauthStillFalse(config: any) {
          expect("oauth" in config.mcp[alias]).toBe(true)
          expect(config.mcp[alias].oauth).toBe(false)
        }

        // --- (1) PUT permissions {preset:"readwrite"}, Hub needs_reauth ---
        setHubPermissionsResponse("needs_reauth", "readwrite")
        const run1 = yield* Harness.put(Harness.permissionsRoute(alias), { preset: "readwrite" })
        expect(run1.status).toBe(200)
        const result1 = yield* Harness.body<{ preset: string; reauth_required: boolean }>(run1)
        expect(result1.preset).toBe("readwrite")
        expect(result1.reauth_required).toBe(true)
        expect(target.requests.filter((request) => request.path === permissionsPath)).toHaveLength(1)
        expectOauthStillFalse(yield* Effect.promise(() => Harness.globalConfig()))
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)

        // --- (2) PUT permissions {preset:"readonly"}, Hub {status:"connected"} — ОТДЕЛЬНО от (1):
        // перевооружение шло и без повторной авторизации; реализация, закрывшая только браузерный
        // шаг, обязана краснеть здесь.
        setHubPermissionsResponse("connected", "readonly")
        const run2 = yield* Harness.put(Harness.permissionsRoute(alias), { preset: "readonly" })
        expect(run2.status).toBe(200)
        const result2 = yield* Harness.body<{ preset: string; reauth_required: boolean }>(run2)
        expect(result2.preset).toBe("readonly")
        expect(result2.reauth_required).toBe(false)
        expect(target.requests.filter((request) => request.path === permissionsPath)).toHaveLength(2)
        expectOauthStillFalse(yield* Effect.promise(() => Harness.globalConfig()))
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)

        // --- (3) POST disconnect — действие ОБЯЗАНО работать (200, поля как в AC-62/AC-327). Hub-шага
        // у прямого подключения нет вовсе (S-V27 п.1): учётные данные ещё есть в этом самом вызове.
        const run3 = yield* Harness.post(Harness.disconnectRoute(alias))
        expect(run3.status).toBe(200)
        const result3 = yield* Harness.body<{ status: string; revoke?: string }>(run3)
        expect(result3.status).toBe("not_connected")
        const afterDisconnect = yield* Effect.promise(() => Harness.globalConfig())
        expectOauthStillFalse(afterDisconnect)
        expect(afterDisconnect.mcp[alias].enabled).toBe(false)
        expect(afterDisconnect.mcp[alias].url).toBe(upstreamUrl)
        const store = yield* Effect.promise(() => Harness.credentialsFileText())
        expect(store === undefined || !store.includes(`"${alias}"`)).toBe(true)
        expect(target.requests.filter((request) => request.path === connectionsPath)).toEqual([])
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)

        // --- (4) PUT permissions ПОСЛЕ отключения, снова needs_reauth — ОТДЕЛЬНО от (1): признак
        // способа подключения здесь отвечает «не прямое» (учётные данные удалены шагом (3)), запись
        // держится только собственным oauth===false (S-V9, D-64) — и это условие закрывает не
        // только патч, но и браузерный шаг.
        setHubPermissionsResponse("needs_reauth", "readwrite")
        const run4 = yield* Harness.put(Harness.permissionsRoute(alias), { preset: "readwrite" })
        expect(run4.status).toBe(200)
        const result4 = yield* Harness.body<{ preset: string; reauth_required: boolean }>(run4)
        expect(result4.reauth_required).toBe(true)
        expect(target.requests.filter((request) => request.path === permissionsPath)).toHaveLength(3)
        expectOauthStillFalse(yield* Effect.promise(() => Harness.globalConfig()))
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)

        // --- (5) DELETE /corp/connectors/:alias — «Убрать из списка» ОБЯЗАНО работать. Учётных
        // данных уже нет с шага (3): признак способа отвечает «не прямое», и на этом шаге Hub
        // получает штатный (необязательный) запрос удаления связи — тот же путь, что и у ЛЮБОГО
        // alias без прямых учётных данных (AC-176); ответ ему не нужен для локальных шагов.
        target.routes.set(connectionsPath, () => Harness.json({ alias, status: "not_connected" }))
        const run5 = yield* Harness.del(Harness.forgetRoute(alias))
        expect(run5.status).toBe(200)
        const result5 = yield* Harness.body<{ removed: boolean; hub_error?: string }>(run5)
        expect(result5.removed).toBe(true)
        expect(result5.hub_error).toBeUndefined()
        const afterForget = yield* Effect.promise(() => Harness.globalConfig())
        expect(afterForget.mcp?.[alias]).toBeUndefined()
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)

        // --- Итог по всему прогону: браузер не открыт ни разу, ни одного запроса по OAuth-адресам
        // MCP-сервера (discovery, DCR, authorize, token) — только каталог, verify и обращения к Hub,
        // которые сам прогон и сделал.
        expect(yield* Effect.promise(() => Harness.browserOpenCount())).toBe(0)
        const oauthRequests = target.requests.filter(
          (request) => !["/catalog", "/verify", permissionsPath, connectionsPath].includes(request.path),
        )
        expect(oauthRequests).toEqual([])
      }),
  )

  /**
   * Обязательный контрольный случай (AC-351, then): без него сторож удовлетворяла бы реализация
   * «никогда не менять права и не звать authenticate» — она проходит весь прогон выше нулём записей
   * и нулём вызовов, ничего не проверяя по существу. Карточка здесь — штатная `facade` БЕЗ
   * `upstream` и БЕЗ `user_token`: `directConnected` ложен, запись создаётся `connectPatch`
   * (`oauth.scope`, не `oauth:false`), и `oauthDisarmed` тоже ложен. Перевооружение и повторная
   * авторизация здесь ОБЯЗАНЫ произойти.
   */
  Harness.it.live(
    "контроль AC-351: обычная facade-карточка без upstream/user_token, Hub needs_reauth — oauth.scope перевооружается, authenticate вызван",
    () =>
      Effect.gen(function* () {
        const alias = "blk3-control-facade"
        const target = Harness.state.target
        Harness.state.key = "sk-magnit-test"
        process.env["OPENCODE_CORP_HUB_URL"] = target.url
        serveCatalog([
          {
            alias,
            title: alias,
            status: "beta",
            mode: "facade",
            mcp_url: `${target.url}/mcp-proxy/${alias}`,
            permission_model: { kind: "consent", presets: { default: "Экран согласия" } },
          },
        ])

        const connected = yield* Harness.post(Harness.connectRoute(alias), {})
        expect(connected.status).toBe(200)
        Harness.state.calls = []

        target.routes.set(`/api/me/connections/${alias}/permissions`, () =>
          Harness.json({ alias, status: "needs_reauth", preset: "readwrite" }),
        )
        const response = yield* Harness.put(Harness.permissionsRoute(alias), { preset: "readwrite" })
        expect(response.status).toBe(200)
        const result = yield* Harness.body<{ reauth_required: boolean }>(response)
        expect(result.reauth_required).toBe(true)
        expect(Harness.state.calls).toContain(`authenticate:${alias}`)

        const config = yield* Effect.promise(() => Harness.globalConfig())
        expect(config.mcp[alias].oauth).toEqual({ scope: `${alias}:readwrite` })
      }),
  )

  /**
   * Признак `directConnected` независим от `oauthDisarmed` (S-V28 п.5): штатный поток connect-token
   * пишет учётные данные и `oauth:false` ДВУМЯ отдельными шагами — (а) `CorpCredentials.save`,
   * ЗАТЕМ (б) `configSvc.updateGlobal(directConnectPatch(...))`. Если шаг (б) не выполнится (диск
   * недоступен для записи ровно в этот момент — тот же приём, что у AC-324/AC-325 выше, только на
   * `Global.Path.config`, а не на `Global.Path.data`), учётные данные остаются сохранёнными, а
   * `mcp.<alias>` не появляется вовсе: `entry` для этого alias — `undefined`, и `oauthDisarmed
   * (undefined)` ложно (условие явно требует `entry !== undefined`). Единственное, что здесь
   * закрывает браузерный шаг, — признак СПОСОБА подключения (`directConnected`, по наличию
   * учётных данных, а не по записи конфига).
   */
  Harness.it.live(
    "AC-351 (доп.): признак directConnected нужен отдельно от oauthDisarmed — учётные данные есть, а mcp.<alias> нет вовсе",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return // fs.chmod на Windows переключает только read-only
        const alias = "blk3-config-write-failed"
        const target = Harness.state.target
        target.routes.set("/verify", () => Harness.json({ account: "ivanov" }))
        Harness.state.key = "sk-magnit-test"
        process.env["OPENCODE_CORP_HUB_URL"] = target.url
        serveCatalog([directCard(alias, target.url)])

        // Тот же приём, что у AC-324 (`fs.chmod` на файле, который `connectToken` пишет), но на
        // ФАЙЛЕ глобального конфига: шаг (а) (сохранение учётных данных) успевает пройти раньше,
        // шаг (б) (патч `mcp.<alias>`) падает на этом же файле. Права каталога здесь не годятся
        // (0o500 на директории не мешает ПЕРЕЗАПИСИ уже существующего файла) — нужен файл.
        const configFile = path.join(Global.Path.config, "opencode.json")
        yield* Effect.promise(() => fs.chmod(configFile, 0o400))
        const connectResponse = yield* Harness.post(Harness.connectTokenRoute(alias), {
          method: "personal_token",
          token: "abcdef",
        })
        // Восстанавливаем права СРАЗУ после действия, которое должно было упасть на записи, —
        // дальнейшие шаги теста (включая cleanup) пишут в этот же файл штатно.
        yield* Effect.promise(() => fs.chmod(configFile, 0o600))
        expect(connectResponse.status).not.toBe(200)

        // Предпосылка теста подтверждена явно: учётные данные ЕСТЬ, записи `mcp.<alias>` — НЕТ.
        const store = yield* Effect.promise(() => Harness.credentialsFileText())
        expect(store).toContain(`"${alias}"`)
        const config = yield* Effect.promise(() => Harness.globalConfig())
        expect(config.mcp?.[alias]).toBeUndefined()

        target.routes.set(`/api/me/connections/${alias}/permissions`, () =>
          Harness.json({ alias, status: "needs_reauth", preset: "readwrite" }),
        )
        const response = yield* Harness.put(Harness.permissionsRoute(alias), { preset: "readwrite" })
        expect(response.status).toBe(200)

        // Способ подключения (учётные данные) один решает исход: authenticate не вызван, несмотря
        // на то, что записи `mcp.<alias>` нет вовсе — `oauthDisarmed(undefined)` на этой форме
        // солгала бы «не закрыто», реши эту форму только он.
        expect(Harness.state.calls).not.toContain(`authenticate:${alias}`)
        expect(yield* Effect.promise(() => Harness.browserOpenCount())).toBe(0)

        // Запись прав в Hub всё равно выполнена — закрыт браузерный шаг, а не выбор пресета.
        const sent = target.requests.find((request) => request.path === `/api/me/connections/${alias}/permissions`)
        expect(sent?.method).toBe("PUT")
      }),
  )
})
