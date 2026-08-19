import { describe, expect, test } from "bun:test"
import * as CorpHub from "./hub"

/**
 * Клиент Hub (S-V2, S-Q2; AC-16, AC-21, AC-22, AC-23, AC-39, AC-40, AC-41, AC-114).
 *
 * Сеть не используется: `fetch` инъектируется. Проверяется наблюдаемое поведение контрактов §3.1–3.2 —
 * заголовки исходящего запроса, разбор ответа схемой и стабильные коды ошибок наружу.
 */

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal | null
}

function recorder(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: any, init: any) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      ...(init?.body === undefined || init?.body === null ? {} : { body: String(init.body) }),
      signal: init?.signal ?? null,
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { calls, fetch: fetchImpl }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

const CATALOG_BODY = {
  version: "2026-08-19.1",
  servers: [
    {
      alias: "gitlab",
      title: "GitLab",
      description: "Merge requests",
      owner: "Platform",
      status: "ga",
      mode: "facade",
      mcp_url: "https://hub.test/mcp/gitlab",
      permission_model: {
        kind: "header_groups",
        groups: [{ id: "read", title: "Read", preset: "readonly" }],
        always: ["gitlab_search"],
      },
      connection: { status: "not_connected" },
    },
  ],
}

const client = (handler: (call: Call) => Response | Promise<Response>, options: Partial<CorpHub.Options> = {}) => {
  const mock = recorder(handler)
  const hub = CorpHub.make({
    hubUrl: "https://hub.test/",
    key: "sk-corp-key",
    fetch: mock.fetch,
    requestId: () => "req-0001",
    ...options,
  })
  return { hub, calls: mock.calls }
}

describe("corp/hub — успешные вызовы (AC-39, AC-114)", () => {
  test("AC-39: GET /api/catalog отправляет Authorization и X-Request-ID и разбирает карточки", async () => {
    const { hub, calls } = client(() => json(CATALOG_BODY))
    const result = await hub.catalog()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("ожидался успех")
    expect(result.data.version).toBe("2026-08-19.1")
    expect(result.data.servers.map((server) => server.alias)).toEqual(["gitlab"])
    expect(result.data.servers[0]!.permission_model).toEqual({
      kind: "header_groups",
      groups: [{ id: "read", title: "Read", preset: "readonly" }],
      always: ["gitlab_search"],
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://hub.test/api/catalog")
    expect(calls[0]!.headers["authorization"]).toBe("Bearer sk-corp-key")
    expect(calls[0]!.headers["x-request-id"]).toBe("req-0001")
    expect(calls[0]!.headers["accept"]).toBe("application/json")
  })

  test("AC-39: таймаут запроса — 5 с, запрос уходит с AbortSignal", async () => {
    expect(CorpHub.REQUEST_TIMEOUT_MS).toBe(5000)
    const { hub, calls } = client(() => json(CATALOG_BODY))
    await hub.catalog()
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  test("AC-114: POST /cli/start передаёт описание клиента и не требует Authorization", async () => {
    const { hub, calls } = client(() =>
      json({
        login_id: "login-1",
        poll_secret: "secret-do-not-leak",
        browser_url: "https://hub.test/ui/login/login-1",
        user_code: "MGNT-4271",
        expires_in: 600,
      }),
    )
    const result = await hub.cliStart("opencode/1.17.9-magnit.1 darwin-arm64")

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("ожидался успех")
    expect(result.data.login_id).toBe("login-1")
    expect(result.data.user_code).toBe("MGNT-4271")
    expect(calls[0]!.url).toBe("https://hub.test/cli/start")
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.headers["authorization"]).toBeUndefined()
    expect(JSON.parse(calls[0]!.body!)).toEqual({ client: "opencode/1.17.9-magnit.1 darwin-arm64" })
  })

  test("AC-16: GET /cli/poll передаёт poll_secret только заголовком X-Hub-Poll-Secret", async () => {
    const { hub, calls } = client(() => json({ status: "pending" }))
    const result = await hub.cliPoll("login-1", "secret-do-not-leak")

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("ожидался успех")
    expect(result.data.status).toBe("pending")
    expect(calls[0]!.url).toBe("https://hub.test/cli/poll/login-1")
    expect(calls[0]!.headers["x-hub-poll-secret"]).toBe("secret-do-not-leak")
    expect(calls[0]!.headers["authorization"]).toBeUndefined()
    expect(calls[0]!.body).toBeUndefined()
  })

  test("AC-114: ветка team_selection_required разбирается со списком команд", async () => {
    const { hub } = client(() =>
      json({
        status: "team_selection_required",
        teams: [
          { team_id: "t1", team_alias: "A" },
          { team_id: "t2", team_alias: "B" },
        ],
      }),
    )
    const result = await hub.cliPoll("login-1", "secret")

    expect(result.ok).toBe(true)
    if (!result.ok || result.data.status !== "team_selection_required") throw new Error("ожидался выбор команды")
    expect(result.data.teams).toEqual([
      { team_id: "t1", team_alias: "A" },
      { team_id: "t2", team_alias: "B" },
    ])
  })

  test("AC-114: ветка ready отдаёт ключ, тип ключа и пользователя", async () => {
    const { hub } = client(() =>
      json({
        status: "ready",
        key: "sk-test",
        key_kind: "persistent",
        user: { user_id: "u1", email: "u@m.ru" },
        team_id: "t2",
      }),
    )
    const result = await hub.cliPoll("login-1", "secret")

    expect(result.ok).toBe(true)
    if (!result.ok || result.data.status !== "ready") throw new Error("ожидался ready")
    expect(result.data.key).toBe("sk-test")
    expect(result.data.key_kind).toBe("persistent")
    expect(result.data.user).toEqual({ user_id: "u1", email: "u@m.ru" })
    expect(result.data.team_id).toBe("t2")
  })

  test("AC-114: POST /cli/poll/:id/team отправляет team_id и заголовок секрета", async () => {
    const { hub, calls } = client(() => json({ status: "pending" }))
    const result = await hub.cliTeam("login-1", "secret-do-not-leak", "t2")

    expect(result.ok).toBe(true)
    expect(calls[0]!.url).toBe("https://hub.test/cli/poll/login-1/team")
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.headers["x-hub-poll-secret"]).toBe("secret-do-not-leak")
    expect(JSON.parse(calls[0]!.body!)).toEqual({ team_id: "t2" })
  })

  test("AC-114: GET /api/me, GET /api/me/connections, PUT permissions, DELETE connection", async () => {
    const bodies: Record<string, unknown> = {
      "https://hub.test/api/me": { user_id: "u1", email: "u@m.ru", key_kind: "persistent" },
      "https://hub.test/api/me/connections": [{ alias: "gitlab", status: "connected", preset: "readonly" }],
      "https://hub.test/api/me/connections/gitlab/permissions": {
        alias: "gitlab",
        status: "needs_reauth",
        preset: "readwrite",
      },
      "https://hub.test/api/me/connections/gitlab": { alias: "gitlab", status: "not_connected" },
    }
    const { hub, calls } = client((call) => json(bodies[call.url]))

    const me = await hub.me()
    expect(me.ok && me.data.email).toBe("u@m.ru")

    const connections = await hub.connections()
    expect(connections.ok && connections.data[0]!.alias).toBe("gitlab")

    const updated = await hub.setPermissions("gitlab", "readwrite")
    expect(updated.ok && updated.data.status).toBe("needs_reauth")
    expect(calls[2]!.method).toBe("PUT")
    expect(JSON.parse(calls[2]!.body!)).toEqual({ preset: "readwrite" })

    const removed = await hub.removeConnection("gitlab")
    expect(removed.ok && removed.data.status).toBe("not_connected")
    expect(calls[3]!.method).toBe("DELETE")
  })

  test("AC-114: PUT permissions с группами передаёт groups", async () => {
    const { hub, calls } = client(() => json({ alias: "gitlab", status: "connected", preset: "custom" }))
    await hub.setPermissions("gitlab", "custom", ["read", "write"])
    expect(JSON.parse(calls[0]!.body!)).toEqual({ preset: "custom", groups: ["read", "write"] })
  })

  test("AC-114: GET /health доступен без ключа", async () => {
    const { hub, calls } = client(() => json({ status: "ok" }), { key: undefined })
    const result = await hub.health()
    expect(result.ok).toBe(true)
    expect(calls[0]!.url).toBe("https://hub.test/health")
    expect(calls[0]!.headers["authorization"]).toBeUndefined()
  })

  test("AC-39: alias в пути экранируется", async () => {
    const { hub, calls } = client(() => json({ alias: "a/b", status: "not_connected" }))
    await hub.removeConnection("a/b")
    expect(calls[0]!.url).toBe("https://hub.test/api/me/connections/a%2Fb")
  })
})

describe("corp/hub — ошибки (AC-21, AC-22, AC-23, AC-40, AC-41, AC-114)", () => {
  test("AC-40: тело без обязательного поля alias отбрасывается целиком", async () => {
    const { hub } = client(() =>
      json({
        version: "1",
        servers: [{ title: "GitLab", status: "ga", mode: "facade", mcp_url: "https://hub.test/mcp/gitlab" }],
      }),
    )
    const result = await hub.catalog()
    expect(result).toEqual({ ok: false, code: "hub_invalid_response" })
  })

  test("AC-40: не-JSON тело при 200 — hub_invalid_response", async () => {
    const { hub } = client(() => new Response("<html>oops</html>", { status: 200 }))
    const result = await hub.catalog()
    expect(result).toEqual({ ok: false, code: "hub_invalid_response" })
  })

  test("AC-41: таймаут запроса — hub_unavailable", async () => {
    const { hub } = client(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
      { timeoutMs: 20 },
    )
    const result = await hub.catalog()
    expect(result).toEqual({ ok: false, code: "hub_unavailable" })
  })

  test("AC-41: сетевая ошибка — hub_unavailable", async () => {
    const { hub } = client(() => {
      throw new TypeError("fetch failed")
    })
    const result = await hub.catalog()
    expect(result).toEqual({ ok: false, code: "hub_unavailable" })
  })

  test("AC-22: 429 c Retry-After отдаёт rate_limited и не пересылает тело Hub", async () => {
    const { hub } = client(() =>
      json({ error: "rate_limited", message: "внутренняя деталь sk-leak" }, 429, { "retry-after": "30" }),
    )
    const result = await hub.cliStart("opencode/test")

    expect(result).toEqual({ ok: false, code: "rate_limited", retryAfter: 30 })
    expect(JSON.stringify(result)).not.toContain("sk-leak")
  })

  test("AC-23: 502 litellm_invalid_response отдаётся своим кодом", async () => {
    const { hub } = client(() => json({ error: "litellm_invalid_response" }, 502))
    const result = await hub.cliPoll("login-1", "secret")
    expect(result).toEqual({ ok: false, code: "litellm_invalid_response" })
  })

  test("AC-114: 502 litellm_unavailable отдаётся своим кодом", async () => {
    const { hub } = client(() => json({ error: "litellm_unavailable" }, 502))
    const result = await hub.cliPoll("login-1", "secret")
    expect(result).toEqual({ ok: false, code: "litellm_unavailable" })
  })

  test("AC-114: 502 без известного кода в теле — hub_unavailable", async () => {
    const { hub } = client(() => json({ error: "bad gateway" }, 502))
    const result = await hub.cliPoll("login-1", "secret")
    expect(result).toEqual({ ok: false, code: "hub_unavailable" })
  })

  test("AC-21: 404 login_expired на опросе", async () => {
    const { hub } = client(() => json({ error: "login_expired" }, 404))
    const result = await hub.cliPoll("login-1", "secret")
    expect(result).toEqual({ ok: false, code: "login_expired" })
  })

  test("AC-21: 404 без тела на опросе тоже login_expired", async () => {
    const { hub } = client(() => new Response("", { status: 404 }))
    const result = await hub.cliPoll("login-1", "secret")
    expect(result).toEqual({ ok: false, code: "login_expired" })
  })

  test("AC-114: 403 на опросе — forbidden", async () => {
    const { hub } = client(() => json({ error: "forbidden" }, 403))
    const result = await hub.cliPoll("login-1", "secret")
    expect(result).toEqual({ ok: false, code: "forbidden" })
  })

  test("AC-114: 400 invalid_team и 409 team_selection_not_required при выборе команды", async () => {
    const invalid = client(() => json({ error: "invalid_team" }, 400))
    expect(await invalid.hub.cliTeam("login-1", "secret", "t9")).toEqual({ ok: false, code: "invalid_team" })

    const conflict = client(() => new Response("", { status: 409 }))
    expect(await conflict.hub.cliTeam("login-1", "secret", "t1")).toEqual({
      ok: false,
      code: "team_selection_not_required",
    })

    const bare400 = client(() => new Response("", { status: 400 }))
    expect(await bare400.hub.cliTeam("login-1", "secret", "t1")).toEqual({ ok: false, code: "invalid_team" })
  })

  test("AC-114: 401 на /api/* — unauthorized", async () => {
    const { hub } = client(() => json({ error: "unauthorized" }, 401))
    expect(await hub.me()).toEqual({ ok: false, code: "unauthorized" })
  })

  test("AC-114: 404 на подключении — not_found", async () => {
    const { hub } = client(() => new Response("", { status: 404 }))
    expect(await hub.setPermissions("gitlab", "readwrite")).toEqual({ ok: false, code: "not_found" })
    expect(await hub.removeConnection("gitlab")).toEqual({ ok: false, code: "not_found" })
  })

  test("AC-114: 400 на /api/* — invalid_request", async () => {
    const { hub } = client(() => json({}, 400))
    expect(await hub.setPermissions("gitlab", "")).toEqual({ ok: false, code: "invalid_request" })
  })

  test("AC-48: без ключа запрос к /api/* не отправляется, наружу unauthorized", async () => {
    const { hub, calls } = client(() => json(CATALOG_BODY), { key: undefined })
    expect(await hub.catalog()).toEqual({ ok: false, code: "unauthorized" })
    expect(await hub.me()).toEqual({ ok: false, code: "unauthorized" })
    expect(calls).toHaveLength(0)
  })
})

describe("corp/hub — служебное", () => {
  test("AC-114: базовый URL нормализуется, хвостовые слэши отбрасываются", async () => {
    const { hub } = client(() => json({ status: "ok" }))
    expect(hub.hubUrl).toBe("https://hub.test")
  })

  test("AC-114: clientDescriptor содержит версию и платформу", () => {
    expect(CorpHub.clientDescriptor("1.17.9-magnit.1")).toBe(
      `opencode/1.17.9-magnit.1 ${process.platform}-${process.arch}`,
    )
  })
})
