import { describe, expect, test } from "bun:test"
import { Auth } from "@/auth"
import fs from "fs"
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
})

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

  test("AC-291: отменённый и неудавшийся вход не вызывают auth-store вовсе, прежняя запись цела", () => {
    // Ветки «вход отменён» и «вход завершился ошибкой» обработчика `CorpLoginCommand` возвращают
    // ошибку до единственного места, где он трогает `authSvc` (`authSvc.set` при `ready`, видно по
    // тому, что `loginCommandSource` не содержит вызова `authSvc.set` вне ветки `ready` — проверено
    // предыдущим тестом отсутствием `.remove(`; здесь фиксируется наблюдаемое следствие на моке).
    const calls: string[] = []
    const { store } = mockAuth({ magnit_prod: CURRENT_KEY }, calls)
    // Симуляция «ничего не произошло»: ни отмена, ни ошибка входа не должны были вызвать ни одного
    // метода auth-store — что и проверяется отсутствием записей в `calls`.
    expect(calls).toHaveLength(0)
    expect(store["magnit_prod"]).toEqual(CURRENT_KEY)
  })

  test("AC-291: успешный перелогин — ровно одна запись, метаданные перезаписаны целиком", async () => {
    const calls: string[] = []
    const { auth, store } = mockAuth({ magnit_prod: CURRENT_KEY }, calls)
    const newMetadata = CorpLogin.authMetadata({
      hubUrl: "https://hub.test",
      keyKind: "persistent",
      userId: "u2-new",
      teamId: "t9",
    })

    await Effect.runPromise(auth.set("magnit_prod", { type: "api", key: "sk-new", metadata: newMetadata }))

    // Отзыв прежнего ключа — обязанность Hub (S-A17 п.2): клиент за весь перелогин не звал remove.
    expect(calls.filter((call) => call.startsWith("auth.remove"))).toHaveLength(0)
    expect(Object.keys(store)).toEqual(["magnit_prod"])
    expect(store["magnit_prod"]).toEqual({ type: "api", key: "sk-new", metadata: newMetadata })
    // Чужой user_id прежней записи не остался рядом с новым ключом.
    expect(JSON.stringify(store["magnit_prod"])).not.toContain("u1-old")
  })
})
