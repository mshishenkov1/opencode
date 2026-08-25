import { describe, expect, test } from "bun:test"
import * as CorpSchema from "./schema"
import * as CorpStatus from "./status"
import { liveTagCard } from "../../test/fixture/corp-hub-live"

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
    // Ревизия 1.9 (S-V15, S-V16): столбец «Статус витрины» строки 3 не изменён, изменён столбец
    // «Действия» — он разделён по признаку «подключение состоялось». Проверки статуса и подписи
    // сохранены дословно, набор действий проверяется парой случаев с ОДИНАКОВЫМ local="failed".
    const base = {
      alias: "gitlab",
      server: catalogServer(),
      configured: true,
      local: "failed" as const,
      localError: "connection refused",
      stale: false,
    }

    // (а) подключение к этому alias никогда не состоялось: записи подключения у Hub нет.
    const never = CorpStatus.compute(base)
    expect(never.status).toBe("unavailable")
    expect(never.error).toBe("connection refused")
    expect(never.actions).toEqual(["connect", "open_hub"])
    expect(never.actions).not.toContain("disconnect")
    expect(never.actions).not.toContain("forget")

    // (б) подключение состоялось раньше — признак S-V15 истинен.
    const ever = CorpStatus.compute({ ...base, everConnectedLocally: true })
    expect(ever.status).toBe("unavailable")
    expect(ever.error).toBe("connection refused")
    expect(ever.actions).toEqual(["reconnect", "forget", "open_hub"])
    expect(ever.actions).not.toContain("disconnect")
  })

  test("AC-52: строка 4 — needs_auth, needs_client_registration и connection.needs_reauth дают needs_auth", () => {
    const base = { alias: "gitlab", configured: true, stale: false }

    const needsAuth = CorpStatus.compute({ ...base, server: catalogServer(), local: "needs_auth" })
    expect(needsAuth.status).toBe("needs_auth")
    // Ревизия 1.9: именно этот случай показывал «Отключить» серверу, который пользователь никогда
    // не подключал (BUG-I4-010) — запись mcp.<alias> создаёт шаг 1 S-V7 ДО авторизации.
    expect(needsAuth.actions).toEqual(["connect", "open_hub"])
    expect(needsAuth.actions).not.toContain("disconnect")

    const needsAuthEver = CorpStatus.compute({
      ...base,
      server: catalogServer(),
      local: "needs_auth",
      everConnectedLocally: true,
    })
    expect(needsAuthEver.status).toBe("needs_auth")
    expect(needsAuthEver.actions).toEqual(["reconnect", "forget", "open_hub"])
    expect(needsAuthEver.actions).not.toContain("disconnect")

    const needsRegistration = CorpStatus.compute({
      ...base,
      server: catalogServer(),
      local: "needs_client_registration",
      localError: "dcr rejected",
    })
    expect(needsRegistration.status).toBe("needs_auth")
    expect(needsRegistration.actions).toContain("connect")
    expect(needsRegistration.actions).not.toContain("disconnect")
    expect(needsRegistration.error).toBe("dcr rejected")

    const needsReauth = CorpStatus.compute({
      alias: "gitlab",
      stale: false,
      configured: false,
      server: catalogServer({ connection: { status: "needs_reauth" } }),
    })
    expect(needsReauth.status).toBe("needs_auth")
    // Запись подключения Hub со статусом needs_reauth сама по себе доказывает состоявшееся
    // подключение (S-V15 п.1б), поэтому подпись действия повторной авторизации — «Повторить».
    expect(needsReauth.actions).toContain("reconnect")
    expect(needsReauth.actions).not.toContain("disconnect")
  })

  test("AC-52: needs_reauth поверх работающего локального соединения тоже даёт повторную авторизацию", () => {
    // Штатный путь S-V9/AC-64: пресет расширен readonly → readwrite, Hub пометил подключение
    // `needs_reauth`, локальный MCP при этом ещё работает на прежнем токене. Статус витрины —
    // needs_auth (строка 4 таблицы S-V6 идёт раньше строки 5), и AC-52 требует, чтобы у карточки
    // было действие повторной авторизации: без него расширенные права взять неоткуда.
    const card = CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer({ connection: { status: "needs_reauth", preset: "readwrite" } }),
      configured: true,
      local: "connected",
      stale: false,
    })
    expect(card.status).toBe("needs_auth")
    expect(card.actions.some((action) => action === "connect" || action === "reconnect")).toBe(true)
    // S-V18: бейдж «Подключено» ставится по состоянию 4, и на карточке «Требуется авторизация»
    // ему взяться неоткуда — иначе карточка одновременно подключена и требует авторизации.
    expect(card.state).not.toBe("connected")
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
    // кэша, поэтому блокируется вместе с «Подключить» и «Правами». Ревизия 1.9: «Убрать из списка»
    // блокировка stale не затрагивает — она нужна пользователю именно тогда, когда Hub недоступен,
    // и шаг обращения к Hub в ней необязателен (S-V16, S-V17 п.4).
    const base = {
      alias: "gitlab",
      server: catalogServer(),
      configured: true,
      local: "failed" as const,
      localError: "connection refused",
    }

    const fresh = CorpStatus.compute({ ...base, everConnectedLocally: true, stale: false })
    expect(fresh.actions).toContain("reconnect")

    const stale = CorpStatus.compute({ ...base, everConnectedLocally: true, stale: true })
    expect(stale.status).toBe("unavailable")
    expect(stale.blocked).toBe(true)
    expect(stale.actions).not.toContain("reconnect")
    expect(stale.actions).toEqual(["forget", "open_hub"])
    expect(stale.actions).not.toContain("disconnect")

    // Тот же протухший каталог у сервера, к которому подключения не было: блокируется «Подключить»,
    // а «Убрать из списка» не появляется — убирать нечего (D-31).
    const staleNever = CorpStatus.compute({ ...base, stale: true })
    expect(staleNever.status).toBe("unavailable")
    expect(staleNever.actions).toEqual(["open_hub"])
    expect(staleNever.actions).not.toContain("disconnect")
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

/**
 * Четыре состояния карточки и их наборы действий (S-V15, S-V16; AC-170…AC-174, AC-177, AC-178, AC-188).
 *
 * Различие между сервером, к которому пользователь никогда не подключался, и сервером, подключение
 * которого было и сломалось, — не косметическое: от него зависит, что пользователю предлагается
 * сделать. Прежние правила предлагали «Отключить» серверу, который пользователь никогда не
 * подключал (BUG-I4-010), и ревизия 1.9 объявила это дефектом.
 */
describe("corp/status — состояния карточки по признаку подключения (S-V16; AC-170…AC-174)", () => {
  const base = { alias: "gitlab", server: catalogServer(), stale: false }

  test("AC-170: «Не подключён» — только «Подключить» и «Открыть в Hub»", () => {
    for (const variant of [
      { configured: false },
      { configured: true, local: "disabled" as const },
      { configured: false, local: undefined },
    ]) {
      const card = CorpStatus.compute({ ...base, ...variant })
      expect(card.state, JSON.stringify(variant)).toBe("never")
      expect(card.everConnected, JSON.stringify(variant)).toBe(false)
      expect(card.actions, JSON.stringify(variant)).toEqual(["connect", "open_hub"])
      expect(card.actions, JSON.stringify(variant)).not.toContain("disconnect")
      expect(card.actions, JSON.stringify(variant)).not.toContain("reconnect")
      expect(card.actions, JSON.stringify(variant)).not.toContain("forget")
    }
  })

  test("AC-171: «Подключение не удалось» — «Отключить» и «Убрать из списка» отсутствуют", () => {
    // Запись `mcp.<alias>` создал шаг 1 S-V7 ДО авторизации, поэтому `configured: true` при
    // отсутствии признака S-V15 — это именно случай замечания заказчика.
    for (const local of ["needs_auth", "needs_client_registration"] as const) {
      const card = CorpStatus.compute({ ...base, configured: true, local, localError: "denied" })
      expect(card.status, local).toBe("needs_auth")
      expect(card.state, local).toBe("failed")
      expect(card.everConnected, local).toBe(false)
      expect(card.actions, local).toEqual(["connect", "open_hub"])
      expect(card.actions, local).not.toContain("disconnect")
      expect(card.actions, local).not.toContain("forget")
    }
  })

  test("AC-173: «Соединение потеряно» — «Повторить» и «Убрать из списка», подпись с текстом ошибки", () => {
    const card = CorpStatus.compute({
      ...base,
      configured: true,
      local: "failed",
      localError: "connection refused",
      everConnectedLocally: true,
    })
    expect(card.state).toBe("lost")
    expect(card.everConnected).toBe(true)
    expect(card.error).toBe("connection refused")
    expect(card.actions).toEqual(["reconnect", "forget", "open_hub"])
    expect(card.actions).not.toContain("disconnect")
  })

  test("AC-174: connection.needs_reauth без локальной истории даёт состояние 3 и статус needs_auth", () => {
    const card = CorpStatus.compute({
      ...base,
      server: catalogServer({ connection: { status: "needs_reauth" } }),
      configured: false,
    })
    // Признак истинен по данным Hub: запись подключения Hub создаётся только после успешной
    // авторизации (S-V15 п.1б), поэтому локальной истории для неё не требуется.
    expect(card.everConnected).toBe(true)
    expect(card.state).toBe("lost")
    expect(card.status).toBe("needs_auth")
    expect(card.actions).toEqual(["reconnect", "forget", "open_hub"])
    expect(card.actions).not.toContain("disconnect")
  })

  test("AC-174: connection.needs_reauth с записью в конфиге — «Соединение потеряно», а не «Отключено вами»", () => {
    // S-V16 прямо относит `needs_reauth` к подписи «Соединение потеряно»: связь сломалась сама.
    // Подпись «Отключено вами» закреплена за `disabled` после S-V8 — за собственным решением
    // пользователя, которого здесь не было. Путать одно с другим правило запрещает.
    const card = CorpStatus.compute({
      ...base,
      server: catalogServer({ connection: { status: "needs_reauth" } }),
      configured: true,
    })
    expect(card.status).toBe("needs_auth")
    expect(card.actions).toEqual(["reconnect", "forget", "open_hub"])
    expect(card.state).toBe("lost")
  })

  test("AC-177: «Подключено» — «Отключить», «Права», «Открыть в Hub»; «Подключить» нет", () => {
    const card = CorpStatus.compute({ ...base, configured: true, local: "connected" })
    expect(card.state).toBe("connected")
    expect(card.status).toBe("connected")
    expect(card.actions).toEqual(["permissions", "disconnect", "open_hub"])
    expect(card.actions).not.toContain("connect")
    expect(card.actions).not.toContain("reconnect")
    expect(card.actions).not.toContain("forget")
  })

  test("AC-178: после «Отключить» подпись — «Отключено вами», действия — «Повторить» и «Убрать из списка»", () => {
    // «Отключить» (S-V8) гасит запись конфига (`enabled:false` → локальный статус `disabled`) и
    // признак «подключение состоялось» НЕ снимает: пользователь отключил то, что у него работало.
    const card = CorpStatus.compute({
      ...base,
      configured: true,
      local: "disabled",
      everConnectedLocally: true,
    })
    expect(card.everConnected).toBe(true)
    expect(card.state).toBe("disconnected")
    expect(card.actions).toEqual(["reconnect", "forget", "open_hub"])
    expect(card.actions).not.toContain("disconnect")
  })

  test("AC-178: подписи состояния 3 различают поломку связи и собственное отключение", () => {
    const lost = CorpStatus.compute({
      ...base,
      configured: true,
      local: "failed",
      localError: "connection refused",
      everConnectedLocally: true,
    })
    const disconnected = CorpStatus.compute({ ...base, configured: true, local: "disabled", everConnectedLocally: true })
    expect(lost.state).toBe("lost")
    expect(disconnected.state).toBe("disconnected")
    // Набор действий у обеих подписей один: вопрос пользователя одинаков.
    expect(lost.actions).toEqual(disconnected.actions)
  })
})

/**
 * Покрытие таблицы S-V16 целиком (AC-188).
 *
 * Каждая строка таблицы, для состояний 2 и 3 — парой случаев с ОДИНАКОВЫМ локальным статусом и
 * разным признаком S-V15, и ни в одном случае состояний 1–3 в наборе нет `disconnect`.
 */
describe("corp/status — таблица S-V16 покрыта построчно (AC-188)", () => {
  const server = catalogServer()

  /** Каждая строка таблицы S-V16 с её условием. */
  const rows = [
    { row: 1, state: "never", input: { configured: false } },
    { row: 1, state: "never", input: { configured: true, local: "disabled" as const } },
    { row: 2, state: "failed", input: { configured: true, local: "failed" as const, localError: "boom" } },
    { row: 2, state: "failed", input: { configured: true, local: "needs_auth" as const } },
    { row: 2, state: "failed", input: { configured: true, local: "needs_client_registration" as const } },
    {
      row: 3,
      state: "lost",
      input: { configured: true, local: "failed" as const, localError: "boom", everConnectedLocally: true },
    },
    { row: 3, state: "lost", input: { configured: true, local: "needs_auth" as const, everConnectedLocally: true } },
    {
      row: 3,
      state: "lost",
      input: { configured: true, local: "needs_client_registration" as const, everConnectedLocally: true },
    },
    { row: 3, state: "disconnected", input: { configured: true, local: "disabled" as const, everConnectedLocally: true } },
    { row: 4, state: "connected", input: { configured: true, local: "connected" as const } },
  ] as const

  test("AC-188: каждая строка таблицы S-V16 достижима и даёт свой набор действий", () => {
    const seen = new Set<string>()
    for (const { row, state, input } of rows) {
      const card = CorpStatus.compute({ alias: "gitlab", server, stale: false, ...input })
      const label = `строка ${row}, ${JSON.stringify(input)}`
      expect(card.state, label).toBe(state)
      seen.add(card.state)
      // Тип ожидания — то же множество `CardAction`, что у карточки: опечатка в имени действия
      // становится ошибкой типов, а не молча непроходящей проверкой.
      const expected: CorpSchema.CardAction[] =
        state === "connected"
          ? ["permissions", "disconnect", "open_hub"]
          : state === "lost" || state === "disconnected"
            ? ["reconnect", "forget", "open_hub"]
            : ["connect", "open_hub"]
      expect(card.actions, label).toEqual(expected)
    }
    expect([...seen].sort()).toEqual(["connected", "disconnected", "failed", "lost", "never"])
  })

  test("AC-188: ни в одном случае состояний 1–3 набор действий не содержит disconnect", () => {
    for (const { row, input } of rows) {
      if (row === 4) continue
      const card = CorpStatus.compute({ alias: "gitlab", server, stale: false, ...input })
      expect(card.actions, JSON.stringify(input)).not.toContain("disconnect")
    }
  })

  test("AC-188: состояния 2 и 3 различаются только признаком S-V15 при одном локальном статусе", () => {
    for (const local of ["failed", "needs_auth", "needs_client_registration"] as const) {
      const input = { alias: "gitlab", server, configured: true, stale: false, local, localError: "boom" }
      const never = CorpStatus.compute(input)
      const ever = CorpStatus.compute({ ...input, everConnectedLocally: true })
      expect(never.status, local).toBe(ever.status)
      expect(never.state, local).toBe("failed")
      expect(ever.state, local).toBe("lost")
      expect(never.actions, local).toEqual(["connect", "open_hub"])
      expect(ever.actions, local).toEqual(["reconnect", "forget", "open_hub"])
    }
  })

  test("AC-188: признак выставляется и по локальному connected, и по connection.status Hub", () => {
    const byLocal = CorpStatus.compute({
      alias: "gitlab",
      server,
      configured: true,
      local: "disabled",
      everConnectedLocally: true,
      stale: false,
    })
    expect(byLocal.everConnected).toBe(true)

    for (const status of ["connected", "needs_reauth"] as const) {
      const byHub = CorpStatus.compute({
        alias: "gitlab",
        server: catalogServer({ connection: { status } }),
        configured: false,
        stale: false,
      })
      expect(byHub.everConnected, status).toBe(true)
    }

    const none = CorpStatus.compute({ alias: "gitlab", server, configured: true, local: "failed", stale: false })
    expect(none.everConnected).toBe(false)
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

/**
 * Неизвестное значение `status` карточки (S-V14 п.3; AC-163).
 *
 * Карточка приходит из разбора живого тела Hub, у которого значение `status` заменено на `sunset` —
 * значения нет в перечислении `beta|ga|deprecated`. Такое поле деградирует, а не отбрасывает карточку.
 */
describe("corp/status — неизвестное состояние карточки (AC-163)", () => {
  const sunset = () => {
    const card = liveTagCard()
    card["status"] = "sunset"
    const parsed = CorpSchema.parseCatalog({ version: 1, servers: [card] })
    if (!parsed || parsed.servers.length !== 1) throw new Error("карточка не должна отбрасываться")
    return parsed.servers[0]!
  }

  test("AC-163: карточка со status=sunset не отброшена и бейджа состояния не получает", () => {
    const server = sunset()
    expect(server.alias).toBe("tag")
    // Поле не разобрано — значит его как будто нет: ни бейджа «устаревший», ни другого состояния.
    expect(server.status).toBeUndefined()

    const card = CorpStatus.compute({ alias: server.alias, server, configured: false, stale: false })
    expect(card.deprecated).toBe(false)
    expect(card.status).toBe("not_connected")
    // Набор действий здесь не предмет проверки: живая карточка `tag` несёт
    // `connection.status = "connected"`, а это по S-V15 п.1б само по себе доказывает состоявшееся
    // подключение, поэтому карточка попадает в состояние 3 таблицы S-V16.
    expect(card.everConnected).toBe(true)
    expect(card.actions).toEqual(["reconnect", "forget", "open_hub"])
    expect(card.actions).not.toContain("disconnect")
  })

  test("AC-163: правила S-V6 применяются так, как если бы поля status не было", () => {
    const server = sunset()
    const withoutStatus: CorpSchema.CatalogServer = { ...server }
    delete (withoutStatus as { status?: unknown }).status

    for (const local of ["connected", "failed", undefined] as const) {
      const input = { alias: server.alias, configured: true, stale: false, ...(local ? { local } : {}) }
      expect(CorpStatus.compute({ ...input, server })).toEqual(CorpStatus.compute({ ...input, server: withoutStatus }))
    }
  })

  test("AC-163: карточка со status=deprecated бейдж по-прежнему получает", () => {
    const card = liveTagCard()
    card["status"] = "deprecated"
    const parsed = CorpSchema.parseCatalog({ version: 1, servers: [card] })
    const server = parsed!.servers[0]!
    expect(server.status).toBe("deprecated")
    expect(CorpStatus.compute({ alias: server.alias, server, configured: true, stale: false }).deprecated).toBe(true)
  })
})
