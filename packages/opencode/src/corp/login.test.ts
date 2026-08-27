import { afterAll, describe, expect, test } from "bun:test"
import { Auth } from "@/auth"
import fs from "fs"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import * as CorpHub from "./hub"
import * as CorpLogin from "./login"
import * as CorpLogout from "./logout"

/**
 * Сессии входа по SSO (S-A2, S-A3, S-A4, S-A9, S-Q3; AC-15, AC-17, AC-19, AC-20, AC-30, AC-115).
 *
 * `poll_secret` живёт только в памяти процесса: наружу отдаётся публичное представление сессии.
 */

const START = {
  login_id: "login-1",
  poll_secret: "secret-do-not-leak",
  browser_url: "https://hub.test/ui/login/login-1",
  user_code: "MGNT-4271",
  expires_in: 600,
}

function clockOf(start = 1_700_000_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe("corp/login — хранилище сессий (AC-17, AC-30)", () => {
  test("AC-15: публичное представление сессии не содержит poll_secret", () => {
    const clock = clockOf()
    const store = CorpLogin.makeStore(clock.now)
    const session = store.create({
      loginId: START.login_id,
      pollSecret: START.poll_secret,
      hubUrl: "https://hub.test",
      expiresIn: START.expires_in,
    })

    const view = CorpLogin.publicView(session, START.user_code, START.browser_url, clock.now())
    expect(view).toEqual({
      login_id: "login-1",
      user_code: "MGNT-4271",
      browser_url: "https://hub.test/ui/login/login-1",
      expires_in: 600,
    })
    expect(JSON.stringify(view)).not.toContain("secret-do-not-leak")
    expect(Object.keys(view)).not.toContain("poll_secret")
  })

  test("AC-16: секрет сессии доступен только внутри процесса", () => {
    const store = CorpLogin.makeStore()
    store.create({ loginId: "l1", pollSecret: "s1", hubUrl: "https://hub.test" })
    expect(store.get("l1")?.pollSecret).toBe("s1")
    expect(store.get("unknown")).toBeUndefined()
  })

  test("AC-17: после успеха сессия удаляется, повторный опрос её не находит", () => {
    const store = CorpLogin.makeStore()
    store.create({ loginId: "l1", pollSecret: "s1", hubUrl: "https://hub.test" })
    expect(store.size()).toBe(1)
    store.drop("l1")
    expect(store.get("l1")).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  test("AC-30: отмена входа освобождает сессию в памяти", () => {
    const store = CorpLogin.makeStore()
    store.create({ loginId: "l1", pollSecret: "s1", hubUrl: "https://hub.test" })
    store.drop("l1")
    expect(store.size()).toBe(0)
  })

  test("AC-21: истёкшая сессия вычищается по часам", () => {
    const clock = clockOf()
    const store = CorpLogin.makeStore(clock.now)
    store.create({ loginId: "l1", pollSecret: "s1", hubUrl: "https://hub.test", expiresIn: 60 })
    clock.advance(59_000)
    expect(store.get("l1")).toBeDefined()
    clock.advance(2_000)
    expect(store.get("l1")).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  test("AC-21: без expires_in сессия живёт 600 с", () => {
    const clock = clockOf()
    const store = CorpLogin.makeStore(clock.now)
    store.create({ loginId: "l1", pollSecret: "s1", hubUrl: "https://hub.test" })
    expect(CorpLogin.DEFAULT_EXPIRES_IN_S).toBe(600)
    clock.advance(599_000)
    expect(store.get("l1")).toBeDefined()
    clock.advance(2_000)
    expect(store.get("l1")).toBeUndefined()
  })

  test("AC-19, AC-20: период опроса — 2 с, бюджет подряд идущих ошибок Hub — 5", () => {
    expect(CorpLogin.POLL_INTERVAL_MS).toBe(2000)
    expect(CorpLogin.MAX_CONSECUTIVE_HUB_ERRORS).toBe(5)
  })
})

describe("corp/login — метаданные auth-store (AC-17)", () => {
  test("AC-17: метаданные содержат hub, key_kind, user_id и team_id", () => {
    expect(
      CorpLogin.authMetadata({ hubUrl: "https://hub.test", keyKind: "persistent", userId: "u1", teamId: "t2" }),
    ).toEqual({ hub: "https://hub.test", key_kind: "persistent", user_id: "u1", team_id: "t2" })
  })

  test("AC-17: без команды ключ team_id не появляется", () => {
    const metadata = CorpLogin.authMetadata({ hubUrl: "https://hub.test", keyKind: "jwt", userId: "u1" })
    expect(metadata).toEqual({ hub: "https://hub.test", key_kind: "jwt", user_id: "u1" })
    expect("team_id" in metadata).toBe(false)
  })
})

describe("corp/login — полный сценарий входа против мока Hub (AC-115)", () => {
  test("AC-115: start → pending → team_selection_required → team → pending → ready", async () => {
    const calls: { path: string; secret?: string }[] = []
    const responses: (() => Response)[] = [
      () => json({ status: "pending" }),
      () =>
        json({
          status: "team_selection_required",
          teams: [
            { team_id: "t1", team_alias: "A" },
            { team_id: "t2", team_alias: "B" },
          ],
        }),
      () => json({ status: "pending" }),
      () => json({ status: "ready", key: "sk-test", key_kind: "persistent", user: { user_id: "u1", email: "u@m.ru" } }),
    ]
    let polls = 0

    const fetchImpl = (async (input: any, init: any) => {
      const url = new URL(String(input))
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        path: url.pathname,
        ...(headers["x-hub-poll-secret"] ? { secret: headers["x-hub-poll-secret"] } : {}),
      })
      if (url.pathname === "/cli/start") return json(START)
      if (url.pathname.endsWith("/team")) return json({ status: "pending" })
      const next = responses[Math.min(polls, responses.length - 1)]!
      polls += 1
      return next()
    }) as unknown as typeof fetch

    const hub = CorpHub.make({ hubUrl: "https://hub.test", fetch: fetchImpl })
    const store = CorpLogin.makeStore()

    const started = await hub.cliStart(CorpHub.clientDescriptor("1.17.9-magnit.1"))
    expect(started.ok).toBe(true)
    if (!started.ok) throw new Error("ожидался успех /cli/start")
    const session = store.create({
      loginId: started.data.login_id,
      pollSecret: started.data.poll_secret,
      hubUrl: "https://hub.test",
      expiresIn: started.data.expires_in,
    })
    const view = CorpLogin.publicView(session, started.data.user_code, started.data.browser_url)

    const first = await hub.cliPoll(session.loginId, session.pollSecret)
    expect(first.ok && first.data.status).toBe("pending")

    const second = await hub.cliPoll(session.loginId, session.pollSecret)
    if (!second.ok || second.data.status !== "team_selection_required") throw new Error("ожидался выбор команды")
    expect(second.data.teams.map((team) => team.team_alias)).toEqual(["A", "B"])

    const sent = await hub.cliTeam(session.loginId, session.pollSecret, "t2")
    expect(sent.ok && sent.data.status).toBe("pending")

    const third = await hub.cliPoll(session.loginId, session.pollSecret)
    expect(third.ok && third.data.status).toBe("pending")

    const ready = await hub.cliPoll(session.loginId, session.pollSecret)
    if (!ready.ok || ready.data.status !== "ready") throw new Error("ожидался ready")
    expect(ready.data.user.email).toBe("u@m.ru")

    // Все опросы несут секрет заголовком, публичное представление его не содержит.
    const pollCalls = calls.filter((call) => call.path.startsWith("/cli/poll"))
    expect(pollCalls).toHaveLength(5)
    for (const call of pollCalls) expect(call.secret).toBe(START.poll_secret)
    expect(JSON.stringify(view)).not.toContain(START.poll_secret)
    expect(JSON.stringify(view)).not.toContain("sk-test")

    store.drop(session.loginId)
    expect(store.get(session.loginId)).toBeUndefined()
  })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/**
 * Выход (S-A14, S-Q3; AC-279…AC-283, AC-291, AC-300).
 *
 * `CorpLogout.perform` — единственный модуль, в котором описаны обе части выхода и их порядок
 * (S-A14 п.3), поэтому проверяется здесь же, на моках `Auth`/HTTP и без сети, тем же приёмом, что
 * `AC-115` выше: подменённый `fetch` у `CorpHub.make` и объект, реализующий `Auth.Interface`
 * напрямую (модуль принимает его параметром, а не через контекст Effect — см. `Input.auth`).
 */

/** Ключ magnit_prod, которым выполняется вызов выхода; `user_id` нужен для проверки AC-291. */
const CURRENT_KEY: Auth.Info = {
  type: "api",
  key: "sk-current-do-not-leak",
  metadata: { hub: "https://hub.test", user_id: "u1-old" },
}

/**
 * Auth-store в памяти, реализующий `Auth.Interface` без файловой системы (S-Q3).
 *
 * Вызовы `get`/`set`/`remove` дописываются в переданный `calls` — тем же массивом, что и вызовы
 * `fetch` (см. `fetchRecording`), чтобы порядок «отзыв до удаления» (S-A14 п.3) проверялся по
 * фактической последовательности перехваченных вызовов, а не по их составу.
 */
function mockAuth(initial: Record<string, Auth.Info> = {}, calls: string[] = []) {
  const store: Record<string, Auth.Info> = { ...initial }
  const auth: Auth.Interface = {
    get: (id: string) =>
      Effect.sync(() => {
        calls.push(`auth.get:${id}`)
        return store[id]
      }),
    all: () => Effect.sync(() => ({ ...store })),
    set: (id: string, info: Auth.Info) =>
      Effect.sync(() => {
        calls.push(`auth.set:${id}`)
        store[id] = info
      }),
    remove: (id: string) =>
      Effect.suspend(() => {
        calls.push(`auth.remove:${id}`)
        delete store[id]
        return Effect.void
      }),
  }
  return { auth, store, calls }
}

/** `fetch`, который пишет каждый вызов в общий с auth-store массив `calls` и отвечает по правилу. */
function fetchRecording(
  calls: string[],
  respond: (init: RequestInit | undefined, url: URL) => Response | Promise<Response>,
) {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(`fetch:${init?.method ?? "GET"} ${url.pathname}`)
    return respond(init, url)
  }) as unknown as typeof fetch
}

describe("corp/logout — выход (S-A14, S-Q3; AC-279, AC-283)", () => {
  test("AC-279: успешный отзыв — DELETE до Auth.remove, Bearer текущим ключом, без тела, ответ без секретов", async () => {
    const calls: string[] = []
    const { auth, store } = mockAuth({ magnit_prod: CURRENT_KEY }, calls)
    let seenAuth: string | undefined
    let seenBody: unknown
    const fetchImpl = fetchRecording(calls, (init, url) => {
      expect(url.pathname).toBe("/api/me/key")
      expect(init?.method).toBe("DELETE")
      seenAuth = (init?.headers as Record<string, string> | undefined)?.["authorization"]
      seenBody = init?.body
      return json({ revoked: true })
    })

    const outcome = await Effect.runPromise(CorpLogout.perform({ auth, hubUrl: "https://hub.test", fetch: fetchImpl }))

    // R-L11: DELETE {hub}/api/me/key (не POST /cli/logout, микроревизия 1.12.1). Порядок — по
    // последовательности перехваченных вызовов: после удаления вызывать эндпоинт нечем (S-A14 п.3).
    expect(calls).toEqual(["auth.get:magnit_prod", "fetch:DELETE /api/me/key", "auth.remove:magnit_prod"])
    expect(seenAuth).toBe(`Bearer ${CURRENT_KEY.key}`)
    expect(seenBody).toBeUndefined()
    expect(outcome).toEqual({ keyRemoved: true, hub: "revoked" })
    expect(store["magnit_prod"]).toBeUndefined()

    const result = CorpLogout.toResult(outcome)
    expect(result).toEqual({ key_removed: true, hub: "revoked" })
    expect("revoke_error" in result).toBe(false)
    expect("hub_error" in result).toBe(false)
    // Ни ключ, ни заголовок авторизации не попадают в ответ (п.8).
    expect(JSON.stringify(result)).not.toContain(CURRENT_KEY.key)
    expect(JSON.stringify(result)).not.toContain("Bearer")
  })

  test("AC-279: 401/403 от Hub — тоже успех (ключ уже недействителен), выполняется тот же порядок", async () => {
    for (const status of [401, 403]) {
      const calls: string[] = []
      const { auth, store } = mockAuth({ magnit_prod: CURRENT_KEY }, calls)
      const fetchImpl = fetchRecording(calls, () => new Response("", { status }))
      const outcome = await Effect.runPromise(CorpLogout.perform({ auth, hubUrl: "https://hub.test", fetch: fetchImpl }))
      expect(outcome, String(status)).toEqual({ keyRemoved: true, hub: "revoked" })
      expect(calls, String(status)).toEqual(["auth.get:magnit_prod", `fetch:DELETE /api/me/key`, "auth.remove:magnit_prod"])
      expect(store["magnit_prod"], String(status)).toBeUndefined()
    }
  })

  test("AC-283: выход трогает только запись magnit_prod — прочие записи auth-store целы", async () => {
    const other: Auth.Info = { type: "api", key: "sk-other-mcp-server", metadata: {} }
    const calls: string[] = []
    const { auth, store } = mockAuth({ magnit_prod: CURRENT_KEY, "other-server": other }, calls)
    const fetchImpl = fetchRecording(calls, () => json({ revoked: true }))

    await Effect.runPromise(CorpLogout.perform({ auth, hubUrl: "https://hub.test", fetch: fetchImpl }))

    expect(store["magnit_prod"]).toBeUndefined()
    expect(store["other-server"]).toEqual(other)
    expect(calls.filter((call) => call.startsWith("auth.remove"))).toEqual(["auth.remove:magnit_prod"])

    // Границы структурны, а не только поведенческие: модуль выхода не импортирует ничего, что
    // касалось бы коннекторов, конфига или кэша каталога, — тронуть их извне `perform()` нечем
    // (S-A14 п.7).
    const source = fs.readFileSync(path.join(import.meta.dirname, "logout.ts"), "utf8")
    for (const forbidden of ["CorpConnections", "CorpConnectors", "CorpCatalogCache", "mcp-auth", "permission"])
      expect(source, forbidden).not.toContain(forbidden)
  })
})

describe("corp/logout — четыре исхода отзыва (S-A14 п.1, S-Q3; AC-280)", () => {
  test("AC-280: таймаут, 502, 500 и нечитаемое тело 200 дают hub:\"unavailable\", ключ всё равно удалён", async () => {
    const cases: { name: string; fetchImpl: typeof fetch; hubError: string }[] = [
      {
        name: "таймаут/сетевая ошибка",
        fetchImpl: (async () => {
          throw new Error("сеть недоступна")
        }) as unknown as typeof fetch,
        hubError: "hub_unavailable",
      },
      { name: "502", fetchImpl: (async () => new Response("", { status: 502 })) as unknown as typeof fetch, hubError: "hub_unavailable" },
      // R-L11.6: 500 — Hub не убрал ключ у себя, это тоже "unavailable", а не отдельный исход.
      { name: "500", fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch, hubError: "hub_unavailable" },
      {
        name: "нечитаемое тело 200",
        fetchImpl: (async () =>
          new Response("не json{{{", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
        hubError: "hub_invalid_response",
      },
    ]

    for (const { name, fetchImpl, hubError } of cases) {
      const { auth, store } = mockAuth({ magnit_prod: CURRENT_KEY })
      const outcome = await Effect.runPromise(CorpLogout.perform({ auth, hubUrl: "https://hub.test", fetch: fetchImpl }))
      expect(outcome.hub, name).toBe("unavailable")
      expect(outcome.hubError, name).toBe(hubError as never)
      // Отказ Hub локальную часть не откладывает и не отменяет (D-49) — ключ удалён несмотря на отказ.
      expect(outcome.keyRemoved, name).toBe(true)
      expect(store["magnit_prod"], name).toBeUndefined()
      expect(CorpLogout.toResult(outcome), name).toEqual({ key_removed: true, hub: "unavailable", hub_error: hubError })
    }
  })

  test("AC-280: 401 засчитан успехом (hub:\"revoked\"), а не «unavailable»", async () => {
    const { auth } = mockAuth({ magnit_prod: CURRENT_KEY })
    const fetchImpl = (async () => new Response("", { status: 401 })) as unknown as typeof fetch
    const outcome = await Effect.runPromise(CorpLogout.perform({ auth, hubUrl: "https://hub.test", fetch: fetchImpl }))
    expect(outcome.hub).toBe("revoked")
    expect(outcome.hubError).toBeUndefined()
  })
})

describe("corp/logout — идемпотентность и сборка без Hub (S-A14 пп.5-6, S-Q3; AC-281, AC-282)", () => {
  test("AC-281: ключа нет — запрос к Hub не выполняется вовсе; повтор не ошибка и ничего не меняет", async () => {
    const { auth } = mockAuth({})
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls += 1
      throw new Error("Hub не должен вызываться, ключа нет")
    }) as unknown as typeof fetch

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await Effect.runPromise(CorpLogout.perform({ auth, hubUrl: "https://hub.test", fetch: fetchImpl }))
      expect(outcome, `попытка ${attempt}`).toEqual({ keyRemoved: false, hub: "skipped" })
      expect(CorpLogout.toResult(outcome), `попытка ${attempt}`).toEqual({ key_removed: false, hub: "skipped" })
    }
    expect(fetchCalls).toBe(0)
  })

  test("AC-282: адрес Hub не задан — запросов ноль, hub:\"skipped\" без hub_error, ключ всё равно удалён", async () => {
    const calls: string[] = []
    const { auth, store } = mockAuth({ magnit_prod: CURRENT_KEY }, calls)
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls += 1
      throw new Error("Hub не должен вызываться, сборка без Hub")
    }) as unknown as typeof fetch

    // hubUrl не передан вовсе — как в сборке без Hub (S-C10).
    const outcome = await Effect.runPromise(CorpLogout.perform({ auth, fetch: fetchImpl }))
    expect(fetchCalls).toBe(0)
    expect(outcome).toEqual({ keyRemoved: true, hub: "skipped" })
    expect(store["magnit_prod"]).toBeUndefined()
    expect(calls).toEqual(["auth.get:magnit_prod", "auth.remove:magnit_prod"])

    const result = CorpLogout.toResult(outcome)
    expect(result).toEqual({ key_removed: true, hub: "skipped" })
    expect("hub_error" in result).toBe(false)
    // D-43: ни в ответе, ни в его сериализации слова «Hub» нет.
    expect(/hub/i.test(JSON.stringify(result).replace(/"hub":"skipped"/, ""))).toBe(false)
  })
})

describe("corp/logout — исход not_revoked, микроревизия 1.12.1 (S-A14 п.1, S-V3; AC-300)", () => {
  test("AC-300: revoke_error переносится дословно — три известных кода и один неизвестный", async () => {
    for (const revokeError of ["not_permitted", "upstream_unavailable", "invalid_response", "unheard_of_code"]) {
      const { auth, store } = mockAuth({ magnit_prod: CURRENT_KEY })
      const fetchImpl = (async () => json({ revoked: false, revoke_error: revokeError })) as unknown as typeof fetch

      const outcome = await Effect.runPromise(CorpLogout.perform({ auth, hubUrl: "https://hub.test", fetch: fetchImpl }))
      expect(outcome.hub, revokeError).toBe("not_revoked")
      expect(outcome.revokeError, revokeError).toBe(revokeError)
      expect(outcome.hubError, revokeError).toBeUndefined()
      expect(outcome.keyRemoved, revokeError).toBe(true)
      expect(store["magnit_prod"], revokeError).toBeUndefined()

      const result = CorpLogout.toResult(outcome)
      expect(result, revokeError).toEqual({ key_removed: true, hub: "not_revoked", revoke_error: revokeError })
      expect("hub_error" in result, revokeError).toBe(false)
    }
  })

  test("AC-300: \"not_revoked\" и \"unavailable\" — разные исходы, сливать запрещено", async () => {
    const notRevoked = await Effect.runPromise(
      CorpLogout.perform({
        auth: mockAuth({ magnit_prod: CURRENT_KEY }).auth,
        hubUrl: "https://hub.test",
        fetch: (async () => json({ revoked: false, revoke_error: "not_permitted" })) as unknown as typeof fetch,
      }),
    )
    const unavailable = await Effect.runPromise(
      CorpLogout.perform({
        auth: mockAuth({ magnit_prod: CURRENT_KEY }).auth,
        hubUrl: "https://hub.test",
        fetch: (async () => {
          throw new Error("сеть недоступна")
        }) as unknown as typeof fetch,
      }),
    )
    expect(notRevoked.hub).toBe("not_revoked")
    expect(unavailable.hub).toBe("unavailable")
    expect(notRevoked.hub).not.toBe(unavailable.hub)
    expect(CorpLogout.toResult(notRevoked)).not.toEqual(CorpLogout.toResult(unavailable))
    expect(CorpLogout.toResult(notRevoked)).not.toHaveProperty("hub_error")
    expect(CorpLogout.toResult(unavailable)).not.toHaveProperty("revoke_error")
  })

  test("AC-300, S-A5: message от Hub не пересылается — разбор берёт только revoked/revoke_error", async () => {
    const LEAK = "СЕКРЕТНАЯ ФРАЗА ОТ HUB — НЕ ПОКАЗЫВАТЬ ПОЛЬЗОВАТЕЛЮ"
    const { auth } = mockAuth({ magnit_prod: CURRENT_KEY })
    // Hub кладёт в ответ лишнее поле `message` — схема `KeyRevoke` объявляет только два поля
    // (`revoked`, `revoke_error`); проверяется наблюдаемое следствие: результат его не содержит.
    const fetchImpl = (async () => json({ revoked: false, revoke_error: "not_permitted", message: LEAK })) as unknown as typeof fetch

    const outcome = await Effect.runPromise(CorpLogout.perform({ auth, hubUrl: "https://hub.test", fetch: fetchImpl }))
    const result = CorpLogout.toResult(outcome)

    expect("message" in result).toBe(false)
    expect(JSON.stringify(result)).not.toContain(LEAK)
  })
})

/**
 * Инфраструктура для AC-291 ниже: обработчик `CorpLoginCommand` держит охрану («выход не звался,
 * ключ не пишется до успеха») внутри своей Effect-функции в `cli/cmd/corp.ts` — не в модуле
 * `CorpLogin`, чей контракт (сессии, метаданные) уже проигран напрямую в AC-115 выше. Проверить
 * охрану, не переисполняя её логику в тесте, можно только настоящим запуском команды — тем же
 * приёмом, что `cli.test.ts` (мини-Hub на `Bun.serve`, реальный процесс `bun run`, файловый
 * auth-store). Сокращённая копия здесь: `cli.test.ts` проверяет вывод и коды ошибок, этот файл —
 * саму охрану записи ключа (S-A17).
 */
const LOGIN_ROOT = path.resolve(import.meta.dirname, "../../../..")
const LOGIN_ENTRY = path.join(LOGIN_ROOT, "packages/opencode/src/index.ts")
const EXISTING_KEY = {
  type: "api",
  key: "sk-existing-do-not-touch",
  metadata: { hub: "https://old-hub.test", key_kind: "persistent", user_id: "u-old" },
}
const loginTmpDirs: string[] = []
const loginServers: { stop: () => void }[] = []

afterAll(async () => {
  while (loginServers.length) loginServers.pop()!.stop()
  while (loginTmpDirs.length) await fsp.rm(loginTmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function loginMakeHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "corp-login-ac291-"))
  loginTmpDirs.push(dir)
  for (const sub of ["data", "config", "cache", "state"]) await fsp.mkdir(path.join(dir, sub), { recursive: true })
  return dir
}

/** Пустая заглушка браузера — та же, что в `cli.test.ts`: пакет `open` ищет команду в PATH. */
async function loginBrowserStub() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "corp-login-ac291-bin-"))
  loginTmpDirs.push(dir)
  for (const name of ["open", "xdg-open"]) {
    const file = path.join(dir, name)
    await fsp.writeFile(file, "#!/bin/sh\nexit 0\n")
    await fsp.chmod(file, 0o755)
  }
  return dir
}
const loginStubPath = await loginBrowserStub()

async function loginWriteKey(home: string) {
  const file = path.join(home, "data", "opencode", "auth.json")
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify({ magnit_prod: EXISTING_KEY }), { mode: 0o600 })
}

async function loginReadAuth(home: string) {
  return JSON.parse(await fsp.readFile(path.join(home, "data", "opencode", "auth.json"), "utf8"))
}

function loginJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Мини-Hub только для сценариев ниже: `/cli/start`, `/cli/poll/:id`, `/cli/poll/:id/team`. */
function loginHub(script: { polls: (() => Response)[]; teams?: { team_id: string; team_alias: string }[] }) {
  let index = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/cli/start")
        return loginJson({
          login_id: "login-1",
          poll_secret: "poll-secret-ac291",
          browser_url: `${url.origin}/ui/login/login-1`,
          user_code: "MGNT-4271",
          expires_in: 120,
        })
      if (/^\/cli\/poll\/[^/]+$/.test(url.pathname)) {
        const next = script.polls[Math.min(index, script.polls.length - 1)]!
        index += 1
        return next()
      }
      if (/^\/cli\/poll\/[^/]+\/team$/.test(url.pathname) && request.method === "POST")
        return request.json().then(() => loginJson({ status: "pending" })) as unknown as Response
      return loginJson({ error: "not_found" }, 404)
    },
  })
  const handle = { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
  loginServers.push(handle)
  return handle
}

async function loginRun(home: string, args: string[]) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "--conditions=browser", LOGIN_ENTRY, ...args],
    cwd: LOGIN_ROOT,
    env: {
      ...process.env,
      PATH: `${loginStubPath}:${process.env["PATH"] ?? ""}`,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CORP_HUB_URL: "",
      NO_COLOR: "1",
      CI: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, out: stdout + stderr }
}

describe("corp/login — повторный вход при живом ключе (S-A17, S-Q3; AC-291)", () => {
  const cliSource = fs.readFileSync(path.join(import.meta.dirname, "../cli/cmd/corp.ts"), "utf8")
  const loginCommandSource = cliSource.slice(
    cliSource.indexOf("export const CorpLoginCommand"),
    cliSource.indexOf("const selectTeam = Effect.fnUntraced"),
  )

  test("AC-291: клиент не вызывает выход перед входом — команда входа не ссылается на выход вовсе", () => {
    expect(loginCommandSource.length).toBeGreaterThan(0)
    // D-50: выход первым шагом оставил бы пользователя без ключа при любой неудаче входа — гарантия
    // структурна: обработчик входа не импортирует и не вызывает модуль выхода.
    expect(loginCommandSource).not.toContain("CorpLogout")
    expect(loginCommandSource).not.toContain("authSvc.remove")
    expect(loginCommandSource).not.toContain(".remove(")
  })

  test("AC-291: вход отменён на выборе команды — auth-store не тронут, прежняя запись цела", async () => {
    // Неинтерактивный процесс (`stdin: "ignore"`) без `--team`: `selectTeam` не может спросить
    // выбор и возвращает `undefined` — `CorpLoginCommand` завершается `fail` ДО единственного места,
    // где он вызывает `authSvc.set` (см. предыдущий тест). Играется настоящий процесс: если бы
    // охрана исчезла и обработчик писал ключ раньше, эта запись бы изменилась.
    const teams = [
      { team_id: "t1", team_alias: "A" },
      { team_id: "t2", team_alias: "B" },
    ]
    const server = loginHub({ polls: [() => loginJson({ status: "team_selection_required", teams })], teams })
    const home = await loginMakeHome()
    await loginWriteKey(home)
    const before = await loginReadAuth(home)

    const result = await loginRun(home, ["corp", "login", "--hub", server.url])

    expect(result.code).toBe(1)
    expect(await loginReadAuth(home)).toEqual(before)
  }, 60_000)

  test("AC-291: вход завершился ошибкой Hub (сессия истекла) — auth-store не тронут, прежняя запись цела", async () => {
    const server = loginHub({ polls: [() => loginJson({ error: "login_expired" }, 404)] })
    const home = await loginMakeHome()
    await loginWriteKey(home)
    const before = await loginReadAuth(home)

    const result = await loginRun(home, ["corp", "login", "--hub", server.url])

    expect(result.code).toBe(1)
    expect(await loginReadAuth(home)).toEqual(before)
  }, 60_000)

  test("AC-291: успешный перелогин продуктовым путём CorpLoginCommand — метаданные перезаписаны целиком", async () => {
    // В отличие от прежней версии теста, ключ здесь не пишется вызовом из теста: он появляется
    // только если настоящий обработчик дошёл до `ready` и сам вызвал `authSvc.set`.
    const server = loginHub({
      polls: [() => loginJson({ status: "ready", key: "sk-new-real", key_kind: "persistent", user: { user_id: "u2-new", email: "new@m.ru" } })],
    })
    const home = await loginMakeHome()
    await loginWriteKey(home)

    const result = await loginRun(home, ["corp", "login", "--hub", server.url])

    expect(result.code).toBe(0)
    const after = await loginReadAuth(home)
    expect(Object.keys(after)).toEqual(["magnit_prod"])
    expect(after["magnit_prod"].type).toBe("api")
    expect(after["magnit_prod"].key).toBe("sk-new-real")
    expect(after["magnit_prod"].metadata.user_id).toBe("u2-new")
    expect(after["magnit_prod"].metadata.hub).toBe(server.url)
    // Отзыв прежнего ключа — обязанность Hub (S-A17 п.2): клиент не звал remove сам, а новая
    // запись не несёт следов прежней (чужой user_id рядом с новым ключом не остался).
    expect(JSON.stringify(after["magnit_prod"])).not.toContain("u-old")
    expect(JSON.stringify(after["magnit_prod"])).not.toContain(EXISTING_KEY.key)
  }, 60_000)
})
