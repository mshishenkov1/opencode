import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from "bun:test"
import { randomUUID } from "crypto"
import { Effect } from "effect"
import * as Harness from "../../test/fixture/corp-direct-harness"

/**
 * S-Q14: секрет не покидает хранилище (S-V26 п.6, ревизия 1.13; AC-326).
 *
 * Отдельный тест, как того требует правило: S-V26 п.6 — сквозное и по одному экрану не проверяется.
 * Подключение выполняется **маркерным** токеном, уникальным в пределах теста (S-Q14 прямо это
 * предписывает: проверка «нет слова token» краснела бы на верной реализации, законно пишущей
 * `token_rejected` и `connect-token`). За сеанс перехватываются: весь вывод логгера
 * (`Harness.logs`, тот же перехватчик, что видит сервер), тела ответов корп-роутов и файлы
 * конфигурации на диске.
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

function directCard(alias: string, target: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    title: alias,
    status: "beta",
    mode: "facade",
    mcp_url: `${target}/mcp-proxy/${alias}`,
    permission_model: { kind: "consent", presets: { default: "Экран согласия" } },
    auth_methods: [
      { id: "corp_oauth", title: "OAuth", type: "oauth2", available: true },
      {
        id: "personal_token",
        title: "Личный токен",
        type: "user_token",
        field: { label: "Токен" },
        verify: { url: `${target}/verify`, account_field: "account" },
      },
    ],
    upstream: { url: `${target}/mcp`, credential_headers: { Authorization: "Bearer {{access_token}}" } },
    ...overrides,
  }
}

function serveCatalog(servers: unknown[]) {
  const target = Harness.state.target
  target.routes.set("/catalog", () => Harness.json({ version: "1", servers }))
  process.env["OPENCODE_CORP_CATALOG_URL"] = `${target.url}/catalog`
}

describe("S-Q14 — секрет не покидает хранилище (AC-326)", () => {
  Harness.it.live("маркерного токена нет ни в логе, ни в ответах роутов, ни в файлах конфигурации", () =>
    Effect.gen(function* () {
      const alias = "leak-check"
      const marker = `MARKER-${randomUUID()}`
      const target = Harness.state.target
      target.routes.set("/verify", () => Harness.json({ account: "ivanov" }))
      serveCatalog([directCard(alias, target.url)])

      const responses: unknown[] = []
      const connectResponse = yield* Harness.post(Harness.connectTokenRoute(alias), {
        method: "personal_token",
        token: marker,
      })
      responses.push(yield* Harness.body<unknown>(connectResponse))

      const catalogResponse = yield* Harness.get(Harness.CorpPaths.catalog)
      responses.push(yield* Harness.body<unknown>(catalogResponse))

      const statusResponse = yield* Harness.get(Harness.CorpPaths.status)
      responses.push(yield* Harness.body<unknown>(statusResponse))

      // Перехваченный лог сервера (тот же перехватчик, что видит корп-роут) не содержит маркера.
      const logText = JSON.stringify(Harness.logs)
      expect(logText).not.toContain(marker)
      // Ни один ответ роутов за сеанс не содержит маркера.
      const responseText = JSON.stringify(responses)
      expect(responseText).not.toContain(marker)
      // Ни один файл конфигурации на диске не содержит маркера (mcp.<alias> не получает headers).
      const configText = yield* Effect.promise(() => Harness.globalConfigText())
      expect(configText).not.toContain(marker)

      // Наружу о хранилище видно ровно has_credentials:true и account — не длину, не хеш, не префикс.
      const catalogView = responses[1] as { servers: { alias: string; has_credentials: boolean }[] }
      const card = catalogView.servers.find((entry) => entry.alias === alias)!
      expect(card.has_credentials).toBe(true)
      expect(JSON.stringify(card)).not.toContain(marker.slice(0, 8))

      // В лог попало ИМЯ учётного заголовка (Authorization), а не его значение.
      expect(logText).toContain("Authorization")
      expect(logText).not.toContain(`Bearer ${marker}`)

      // Маркер действительно был использован (иначе проверка «нет маркера» была бы бессмысленной) —
      // он лежит в файле хранилища, единственном законном месте.
      const store = yield* Effect.promise(() => Harness.credentialsFileText())
      expect(store).toContain(marker)
    }),
  )

  Harness.it.live("при отказе целевой системы в лог идут alias и код ответа, а НЕ тело ответа", () =>
    Effect.gen(function* () {
      const alias = "leak-check-rejected"
      const secretInBody = `REJECT-BODY-SECRET-${randomUUID()}`
      const target = Harness.state.target
      target.routes.set("/verify-reject", () => new Response(JSON.stringify({ detail: secretInBody }), { status: 401 }))
      serveCatalog([
        directCard(alias, target.url, {
          auth_methods: [
            { id: "corp_oauth", title: "OAuth", type: "oauth2", available: true },
            {
              id: "personal_token",
              title: "Личный токен",
              type: "user_token",
              field: { label: "Токен" },
              verify: { url: `${target.url}/verify-reject` },
            },
          ],
        }),
      ])

      const response = yield* Harness.post(Harness.connectTokenRoute(alias), {
        method: "personal_token",
        token: "rejected-token-value",
      })
      const result = yield* Harness.body<{ verify_result: string }>(response)
      expect(result.verify_result).toBe("token_rejected")

      const logText = JSON.stringify(Harness.logs)
      expect(logText).toContain(alias)
      // Код ответа (401) присутствует, тело ответа целевой системы — нет.
      expect(logText).toContain("401")
      expect(logText).not.toContain(secretInBody)
    }),
  )
})
