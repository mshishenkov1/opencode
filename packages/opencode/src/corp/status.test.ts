import { describe, expect, test } from "bun:test"
import type * as CorpSchema from "./schema"
import * as CorpStatus from "./status"

/**
 * Правило вычисления статуса карточки витрины (S-V6, S-V11, S-Q9; AC-49…AC-56, AC-61, AC-69, AC-121).
 *
 * Чистый модуль: входы — карточка каталога, наличие записи в конфиге и локальный статус MCP.
 */

const catalogServer = (over: Partial<CorpSchema.CatalogServer> = {}): CorpSchema.CatalogServer => ({
  alias: "gitlab",
  title: "GitLab",
  description: "Merge requests, pipelines",
  owner: "Платформа",
  status: "ga",
  mode: "facade",
  mcp_url: "https://hub.test/mcp/gitlab",
  ...over,
})

describe("corp/status — таблица S-V6 (AC-50…AC-56, AC-121)", () => {
  test("AC-50: строка 1 — alias есть в конфиге, но отсутствует в каталоге", () => {
    const card = CorpStatus.compute({ alias: "gitlab", configured: true, stale: false })
    expect(card.status).toBe("unavailable")
    expect(card.actions).toEqual(["disconnect", "open_hub"])
    expect(card.actions).not.toContain("connect")
    expect(card.actions).not.toContain("permissions")
  })

  test("AC-51: строка 3 — локальный статус failed показывается как unavailable с текстом ошибки", () => {
    const card = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer(),
      configured: true,
      local: "failed",
      localError: "connection refused",
      stale: false,
    })
    expect(card.status).toBe("unavailable")
    expect(card.error).toBe("connection refused")
    expect(card.actions).toEqual(["reconnect", "disconnect"])
  })

  test("AC-52: строка 4 — needs_auth, needs_client_registration и connection.needs_reauth дают needs_auth", () => {
    const base = { alias: "gitlab", configured: true, stale: false }

    const needsAuth = CorpStatus.compute({ ...base, server: catalogServer(), local: "needs_auth" })
    expect(needsAuth.status).toBe("needs_auth")
    expect(needsAuth.actions).toEqual(["connect", "disconnect"])

    const needsRegistration = CorpStatus.compute({
      ...base,
      server: catalogServer(),
      local: "needs_client_registration",
      localError: "dcr rejected",
    })
    expect(needsRegistration.status).toBe("needs_auth")
    expect(needsRegistration.actions).toContain("connect")
    expect(needsRegistration.error).toBe("dcr rejected")

    const needsReauth = CorpStatus.compute({
      ...base,
      server: catalogServer({ connection: { status: "needs_reauth" } }),
      local: "connected",
    })
    expect(needsReauth.status).toBe("needs_auth")
    expect(needsReauth.actions).toContain("connect")
  })

  test("AC-53: строка 5 — локальный статус connected", () => {
    const card = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer({ connection: { status: "connected", preset: "readonly" } }),
      configured: true,
      local: "connected",
      stale: false,
    })
    expect(card.status).toBe("connected")
    expect(card.actions).toEqual(["permissions", "disconnect", "open_hub"])
  })

  test("AC-54: строка 6 — запись в конфиге есть, локальный статус disabled", () => {
    const card = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer(),
      configured: true,
      local: "disabled",
      stale: false,
    })
    expect(card.status).toBe("not_connected")
    expect(card.actions).toContain("connect")
  })

  test("AC-55: строка 7 — alias есть в каталоге, записи в конфиге нет", () => {
    const card = CorpStatus.compute({ alias: "gitlab", server: catalogServer(), configured: false, stale: false })
    expect(card.status).toBe("not_connected")
    expect(card.actions).toEqual(["connect", "open_hub"])
    expect(card.deprecated).toBe(false)
  })

  test("AC-56: deprecated без записи в конфиге — бейдж есть, «Подключить» недоступно", () => {
    const card = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer({ status: "deprecated" }),
      configured: false,
      stale: false,
    })
    expect(card.deprecated).toBe(true)
    expect(card.actions).not.toContain("connect")
    expect(card.actions).toContain("open_hub")
  })

  test("AC-56: deprecated с записью в конфиге сохраняет переподключение", () => {
    const card = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer({ status: "deprecated" }),
      configured: true,
      local: "disabled",
      stale: false,
    })
    expect(card.deprecated).toBe(true)
    expect(card.actions).toContain("connect")
  })

  test("AC-44: строка 2 — при протухшем каталоге «Подключить» и «Права» заблокированы", () => {
    const notConnected = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer(),
      configured: false,
      stale: true,
    })
    expect(notConnected.status).toBe("not_connected")
    expect(notConnected.blocked).toBe(true)
    expect(notConnected.actions).not.toContain("connect")
    expect(notConnected.actions).toContain("open_hub")

    const connected = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer(),
      configured: true,
      local: "connected",
      stale: true,
    })
    expect(connected.status).toBe("connected")
    expect(connected.actions).not.toContain("permissions")
    expect(connected.actions).toContain("disconnect")
  })

  test("AC-44: строка 2 — на протухшем каталоге блокируется и «Переподключить»", () => {
    // «Переподключить» идёт тем же путём S-V7 (запись конфига + authenticate) на данных протухшего
    // кэша, поэтому в строке 2 таблицы S-V6 остаются только «Отключить» и «Открыть в Hub».
    const fresh = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer(),
      configured: true,
      local: "failed",
      localError: "connection refused",
      stale: false,
    })
    expect(fresh.actions).toContain("reconnect")

    const stale = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer(),
      configured: true,
      local: "failed",
      localError: "connection refused",
      stale: true,
    })
    expect(stale.status).toBe("unavailable")
    expect(stale.blocked).toBe(true)
    expect(stale.actions).not.toContain("reconnect")
    expect(stale.actions).toEqual(["disconnect"])
  })

  test("AC-121: каждый статус витрины достижим", () => {
    const statuses = new Set([
      CorpStatus.compute({ alias: "a", configured: true, stale: false }).status,
      CorpStatus.compute({ alias: "a", server: catalogServer(), configured: true, local: "failed", stale: false })
        .status,
      CorpStatus.compute({ alias: "a", server: catalogServer(), configured: true, local: "needs_auth", stale: false })
        .status,
      CorpStatus.compute({ alias: "a", server: catalogServer(), configured: true, local: "connected", stale: false })
        .status,
      CorpStatus.compute({ alias: "a", server: catalogServer(), configured: false, stale: false }).status,
    ])
    expect([...statuses].sort()).toEqual(["connected", "needs_auth", "not_connected", "unavailable"])
  })
})

describe("corp/status — поиск и группировка (AC-69)", () => {
  const servers = [
    catalogServer({ alias: "gitlab", title: "GitLab", owner: "Платформа", description: "Merge requests" }),
    catalogServer({ alias: "jira", title: "Jira", owner: "Платформа", description: "Задачи и спринты" }),
    catalogServer({ alias: "tag", title: "ТЭГ", owner: "ТЭГ", description: "Корпоративный ассистент" }),
    catalogServer({ alias: "wiki", title: "Wiki", owner: "ТЭГ", description: "База знаний" }),
    catalogServer({ alias: "s3", title: "S3", owner: "Платформа", description: "Объектное хранилище" }),
  ]

  test("AC-69: поиск по подстроке description без учёта регистра", () => {
    const found = servers.filter((server) => CorpStatus.matches(server, "MERGE"))
    expect(found.map((server) => server.alias)).toEqual(["gitlab"])
  })

  test("AC-69: поиск идёт по title, alias, description и owner", () => {
    expect(servers.filter((s) => CorpStatus.matches(s, "тэг")).map((s) => s.alias)).toEqual(["tag", "wiki"])
    expect(servers.filter((s) => CorpStatus.matches(s, "jir")).map((s) => s.alias)).toEqual(["jira"])
    expect(servers.filter((s) => CorpStatus.matches(s, "  ")).map((s) => s.alias)).toEqual(servers.map((s) => s.alias))
    expect(servers.filter((s) => CorpStatus.matches(s, "нет-такого"))).toEqual([])
  })

  test("AC-69: группировка по owner сохраняет порядок каталога", () => {
    const groups = CorpStatus.groupByOwner(servers)
    expect(groups.map((group) => group.owner)).toEqual(["Платформа", "ТЭГ"])
    expect(groups[0]!.servers.map((s) => s.alias)).toEqual(["gitlab", "jira", "s3"])
    expect(groups[1]!.servers.map((s) => s.alias)).toEqual(["tag", "wiki"])
  })

  test("AC-69: карточки без владельца собираются в одну группу", () => {
    const groups = CorpStatus.groupByOwner([{ owner: undefined }, { owner: "A" }, { owner: undefined }])
    expect(groups.map((group) => group.owner)).toEqual(["", "A"])
    expect(groups[0]!.servers).toHaveLength(2)
  })
})

describe("corp/status — пресеты и scope (AC-57, AC-58, AC-61)", () => {
  test("AC-61: пресет по умолчанию — readonly", () => {
    expect(CorpStatus.DEFAULT_PRESET).toBe("readonly")
  })

  test("AC-57: для mode=facade scope — <alias>:<preset>", () => {
    expect(CorpStatus.oauthScope({ alias: "gitlab", mode: "facade" }, "readonly")).toBe("gitlab:readonly")
    expect(CorpStatus.oauthScope({ alias: "gitlab-platform", mode: "facade" }, "readwrite")).toBe(
      "gitlab-platform:readwrite",
    )
  })

  test("AC-58: для mode=native scope не задаётся", () => {
    expect(CorpStatus.oauthScope({ alias: "tag", mode: "native" }, "readonly")).toBeUndefined()
  })
})
