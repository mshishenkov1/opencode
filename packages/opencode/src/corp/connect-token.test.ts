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

describe("connect-token — сохранение и соединение (S-V25 п.6, S-V29; AC-320)", () => {
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
      expect(config.mcp[alias]).toEqual({ type: "remote", url: `${target.url}/mcp`, enabled: true })
      expect(config.mcp[alias].url).not.toBe(`${target.url}/mcp-proxy/${alias}`)
      expect("oauth" in config.mcp[alias]).toBe(false)
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
        expect(configAfterBlock.mcp[alias]).toEqual({ type: "remote", url: `${target.url}/mcp`, enabled: true })

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
        expect(config.mcp[alias]).toEqual({ type: "remote", url: `${target.url}/mcp`, enabled: true })
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
describe("connect-token — BLK-1: запрет native не обходится карточкой mode:native с разобранным upstream и доступным user_token (S-V7, S-V28 п.2, п.5)", () => {
  function forbiddenNativeCard(alias: string, overrides: Record<string, unknown> = {}) {
    const target = Harness.state.target.url
    return nativeCard(alias, {
      auth_methods: [tokenMethod(target)],
      upstream: upstreamBlock(target),
      ...overrides,
    })
  }

  Harness.it.live(
    'POST /connect на карточке native+direct — 409 oauth_disabled, а не штатный MCP OAuth, хотя connect_mode == "direct" и connect_mode_unavailable_code == null',
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
    "PUT /permissions на карточке native+direct с ответом Hub needs_reauth — права записаны в Hub, но повторная авторизация НЕ запущена",
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
