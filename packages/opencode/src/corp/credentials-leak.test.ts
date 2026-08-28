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

      // MAJ-3 (review-i4-rev113-1): тело GET /config названо в AC-326 поимённо и раньше не
      // перехватывалось — проверка файла конфига на диске (ниже) близка, но не то же самое, что
      // ответ роута, который читает оболочка. Харнесс поднимает ConfigApi рядом с корп-роутами
      // именно ради этой проверки (corp-direct-harness.ts).
      const configResponse = yield* Harness.get(Harness.configRoute)
      responses.push(yield* Harness.body<unknown>(configResponse))

      // Перехваченный лог сервера (тот же перехватчик, что видит корп-роут) не содержит маркера.
      const logText = JSON.stringify(Harness.logs)
      expect(logText).not.toContain(marker)
      // Ни один ответ роутов за сеанс не содержит маркера (включая GET /config, добавленный выше).
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

  /**
   * MAJ-3 (review-i4-rev113-1): единственный маркерный тест до этой правки проходил ровно один
   * путь — способ без `exchange`, введённый токен, `account` назван. ВЫПУЩЕННЫЙ (постоянный)
   * токен обменом (S-V25 п.5) маркером не проверялся вовсе: инъекция ИНЖ-15 (issued_token
   * пишется в лог открытым текстом при issued===true) оставляла 556/0 зелёными. Второй маркер —
   * для выпущенного токена — идёт ОТДЕЛЬНО от маркера введённого токена, чтобы утечка именно
   * выпущенного значения была отличима от утечки введённого.
   */
  Harness.it.live(
    "выпущенный обменом токен (issued:true) не утекает в лог, в ответы роутов и в конфиг — только введённый маркер уходит в /verify",
    () =>
      Effect.gen(function* () {
        const alias = "leak-check-issued"
        const enteredMarker = `MARKER-ENTERED-${randomUUID()}`
        const issuedMarker = `MARKER-ISSUED-${randomUUID()}`
        const target = Harness.state.target
        target.routes.set("/verify", () => Harness.json({ account: "ivanov" }))
        target.routes.set("/exchange", () => Harness.json({ access_token: issuedMarker, id: "tok-issued" }))
        serveCatalog([
          directCard(alias, target.url, {
            auth_methods: [
              { id: "corp_oauth", title: "OAuth", type: "oauth2", available: true },
              {
                id: "personal_token",
                title: "Личный токен",
                type: "user_token",
                field: { label: "Токен" },
                verify: {
                  url: `${target.url}/verify`,
                  account_field: "account",
                  headers: { Authorization: "Bearer {{access_token}}" },
                },
                exchange: { url: `${target.url}/exchange`, token_field: "access_token", token_id_field: "id" },
              },
            ],
          }),
        ])

        const responses: unknown[] = []
        const connectResponse = yield* Harness.post(Harness.connectTokenRoute(alias), {
          method: "personal_token",
          token: enteredMarker,
        })
        responses.push(yield* Harness.body<{ exchange_result: string; credentials_saved: boolean }>(connectResponse))
        const catalogResponse = yield* Harness.get(Harness.CorpPaths.catalog)
        responses.push(yield* Harness.body<unknown>(catalogResponse))
        const configResponse = yield* Harness.get(Harness.configRoute)
        responses.push(yield* Harness.body<unknown>(configResponse))

        const connectResult = responses[0] as { exchange_result: string; credentials_saved: boolean }
        expect(connectResult.exchange_result).toBe("exchanged")
        expect(connectResult.credentials_saved).toBe(true)

        // ВЫПУЩЕННЫЙ токен не утекает никуда: ни в лог, ни в один из перехваченных ответов роутов,
        // ни в файлы конфигурации.
        const logText = JSON.stringify(Harness.logs)
        expect(logText).not.toContain(issuedMarker)
        const responseText = JSON.stringify(responses)
        expect(responseText).not.toContain(issuedMarker)
        const configText = yield* Effect.promise(() => Harness.globalConfigText())
        expect(configText).not.toContain(issuedMarker)

        // Введённый токен, отправленный на verify, тоже не утекает — обмен не отменяет это правило.
        expect(logText).not.toContain(enteredMarker)
        expect(responseText).not.toContain(enteredMarker)

        // Оба маркера действительно были в деле — иначе проверки выше были бы бессмысленными:
        // в хранилище лежит ВЫПУЩЕННЫЙ токен (S-V25 п.5: exchanged побеждает введённый), введённый
        // же маркер ушёл ровно в один реальный запрос — на verify — и нигде больше.
        const store = yield* Effect.promise(() => Harness.credentialsFileText())
        expect(store).toContain(issuedMarker)
        expect(store).not.toContain(enteredMarker)
        const verifyRequests = target.requests.filter((request) => request.path === "/verify")
        expect(verifyRequests).toHaveLength(1)
        expect(JSON.stringify(verifyRequests[0]!.headers)).toContain(enteredMarker)
      }),
  )

  /**
   * MAJ-3 (review-i4-rev113-1): ветка «целевая система account не назвала» — `verify.account_field`
   * отсутствует в способе каталога (S-V24 п.2: это УМОЛЧАНИЕ контракта, а не экзотика) — ни разу не
   * проходилась. Инъекция ИНЖ-14a (введённый токен утекает в поле `account` ответа роута ТОЛЬКО
   * когда `account` целевая система не назвала) оставляла 556/0 зелёными именно потому, что
   * единственный маркерный тест всегда называл `account_field` и попадал в ветку, где утечки нет.
   */
  Harness.it.live(
    "способ без account_field: токен не утекает в поле account ответа роута, когда система не назвала пользователя",
    () =>
      Effect.gen(function* () {
        const alias = "leak-check-no-account-field"
        const marker = `MARKER-NOFIELD-${randomUUID()}`
        const target = Harness.state.target
        // Ответ 200 без узнаваемого поля пользователя — ровно то, что даёт целевая система, когда
        // `account_field` не задан методом (S-V24 п.2): читать в теле ответа при этом нечего.
        target.routes.set("/verify-no-account", () => Harness.json({ ok: true }))
        serveCatalog([
          directCard(alias, target.url, {
            auth_methods: [
              { id: "corp_oauth", title: "OAuth", type: "oauth2", available: true },
              {
                id: "personal_token",
                title: "Личный токен",
                type: "user_token",
                field: { label: "Токен" },
                // `account_field` намеренно НЕ задан — умолчание контракта (S-V24 п.2).
                verify: { url: `${target.url}/verify-no-account` },
              },
            ],
          }),
        ])

        const response = yield* Harness.post(Harness.connectTokenRoute(alias), {
          method: "personal_token",
          token: marker,
        })
        expect(response.status).toBe(200)
        const result = yield* Harness.body<{ verify_result: string; account?: string }>(response)
        expect(result.verify_result).toBe("verified")
        // Система не назвала пользователя — поля `account` в ответе нет вовсе, и уж точно в нём нет
        // введённого токена (ИНЖ-14a: токен утекает в `account` именно в этой ветке).
        expect(result.account).toBeUndefined()
        expect(JSON.stringify(result)).not.toContain(marker)

        const logText = JSON.stringify(Harness.logs)
        expect(logText).not.toContain(marker)

        // Маркер действительно был использован — он лежит в хранилище, единственном законном месте.
        const store = yield* Effect.promise(() => Harness.credentialsFileText())
        expect(store).toContain(marker)
      }),
  )
})
