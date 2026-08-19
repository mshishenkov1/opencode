import { describe, expect, test } from "bun:test"
import * as CorpHub from "./hub"
import * as CorpLogin from "./login"

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
