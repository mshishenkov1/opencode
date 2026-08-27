import { describe, expect, test } from "bun:test"
import path from "path"
import * as CorpConnectors from "./connectors"
import * as CorpSchema from "./schema"
import * as CorpStatus from "./status"
import { liveCatalogBody, liveTagCard } from "../../test/fixture/corp-hub-live"

/**
 * Действия витрины над конфигом и её экраны (S-V7…S-V10, S-V12, S-V14, S-Q4; AC-57, AC-58, AC-61,
 * AC-62, AC-64, AC-65, AC-68, AC-155, AC-156, AC-157, AC-158, AC-161, AC-164, AC-165, AC-167).
 *
 * Проверяются патчи, которые уходят в `Config.updateGlobal`, признак повторной авторизации, экран
 * прав по таблице S-V9 и пустые состояния витрины.
 */

const facade: CorpSchema.CatalogServer = {
  alias: "gitlab",
  title: "GitLab",
  status: "ga",
  mode: "facade",
  mcp_url: "https://hub.test/mcp/gitlab",
  permission_model: { kind: "header_groups", groups: [{ id: "read", title: "Чтение", preset: "readonly" }] },
}

const native: CorpSchema.CatalogServer = {
  alias: "tag",
  title: "ТЭГ",
  status: "beta",
  mode: "native",
  mcp_url: "https://hub.test/mcp/tag",
  permission_model: { kind: "consent", presets: { default: "Экран согласия" } },
}

describe("corp/connectors — «Подключить» (AC-57, AC-58, AC-61)", () => {
  test("AC-57: facade-сервер получает запись mcp.<alias> с oauth.scope", () => {
    expect(CorpConnectors.connectPatch(facade, "readonly")).toEqual({
      mcp: {
        gitlab: {
          type: "remote",
          url: "https://hub.test/mcp/gitlab",
          enabled: true,
          oauth: { scope: "gitlab:readonly" },
        },
      },
    })
  })

  test("AC-58: native-сервер не получает ключ oauth", () => {
    const patch = CorpConnectors.connectPatch(native, "readonly")
    expect(patch).toEqual({
      mcp: { tag: { type: "remote", url: "https://hub.test/mcp/tag", enabled: true } },
    })
    expect("oauth" in patch.mcp["tag"]!).toBe(false)
  })

  test("AC-61: без явного пресета используется readonly", () => {
    const patch = CorpConnectors.connectPatch(facade)
    expect(patch.mcp["gitlab"]!.oauth).toEqual({ scope: "gitlab:readonly" })
  })

  test("AC-57: расширенный пресет попадает в scope", () => {
    const patch = CorpConnectors.connectPatch(facade, "readwrite")
    expect(patch.mcp["gitlab"]!.oauth).toEqual({ scope: "gitlab:readwrite" })
  })
})

describe("corp/connectors — «Отключить» (AC-62)", () => {
  test("AC-62: патч гасит запись, но не удаляет её", () => {
    const patch = CorpConnectors.disconnectPatch("gitlab") as { mcp: Record<string, unknown> }
    expect(patch).toEqual({ mcp: { gitlab: { enabled: false } } })
    expect(patch.mcp["gitlab"]).not.toBeUndefined()
  })
})

/**
 * «Убрать из списка» (S-V17; AC-175).
 *
 * Смысл действия — «я больше не хочу видеть этот сервер подключённым у себя»: в отличие от
 * «Отключить», оно **удаляет** запись `mcp.<alias>` из конфига, а не переводит её в `enabled:false`.
 */
describe("corp/connectors — «Убрать из списка» (AC-175)", () => {
  test("AC-175: патч удаляет ключ mcp.<alias> целиком, а не гасит его", () => {
    const patch = CorpConnectors.forgetPatch("gitlab") as { mcp: Record<string, unknown> }
    expect("gitlab" in patch.mcp).toBe(true)
    expect(patch.mcp["gitlab"]).toBeUndefined()
    // Отличие от «Отключить» наблюдаемо: там значение остаётся объектом с enabled:false.
    expect(patch).not.toEqual(CorpConnectors.disconnectPatch("gitlab") as object)
    expect(JSON.stringify(patch)).not.toContain("enabled")
  })

  test("AC-175: правятся только ключи mcp.<alias>, прочий конфиг пользователя не затрагивается", () => {
    const patch = CorpConnectors.forgetPatch("gitlab") as Record<string, unknown>
    expect(Object.keys(patch)).toEqual(["mcp"])
    expect(Object.keys((patch["mcp"] as Record<string, unknown>) ?? {})).toEqual(["gitlab"])
  })
})

describe("corp/connectors — «Права» (AC-64, AC-65)", () => {
  test("AC-64: facade — патч обновляет только oauth.scope", () => {
    expect(CorpConnectors.permissionsPatch(facade, "readwrite") as unknown).toEqual({
      mcp: { gitlab: { oauth: { scope: "gitlab:readwrite" } } },
    } as unknown)
  })

  test("AC-65: native — локального патча нет", () => {
    expect(CorpConnectors.permissionsPatch(native, "readwrite")).toBeUndefined()
  })

  test("AC-64: смена пресета требует повторной авторизации", () => {
    expect(CorpConnectors.needsReauth("readonly", "readwrite", "connected")).toBe(true)
  })

  test("AC-64: статус needs_reauth от Hub требует повторной авторизации даже при том же пресете", () => {
    expect(CorpConnectors.needsReauth("readwrite", "readwrite", "needs_reauth")).toBe(true)
  })

  test("AC-64: тот же пресет и connected — повторная авторизация не нужна", () => {
    expect(CorpConnectors.needsReauth("readonly", "readonly", "connected")).toBe(false)
  })

  test("AC-64: неизвестный прежний пресет не считается сменой", () => {
    expect(CorpConnectors.needsReauth(undefined, "readwrite", "connected")).toBe(false)
  })
})

describe("corp/connectors — «Открыть в Hub» (AC-68)", () => {
  test("AC-68: ссылка ведёт на карточку сервера в Hub", () => {
    expect(CorpConnectors.hubServerUrl("https://hub.test", "gitlab")).toBe("https://hub.test/ui/servers/gitlab")
    expect(CorpConnectors.hubServerUrl("https://hub.test/", "gitlab-platform")).toBe(
      "https://hub.test/ui/servers/gitlab-platform",
    )
  })

  test("AC-68: без адреса Hub действие недоступно", () => {
    expect(CorpConnectors.hubServerUrl(undefined, "gitlab")).toBeUndefined()
    expect(CorpConnectors.hubServerUrl("", "gitlab")).toBeUndefined()
  })
})

/**
 * Экран прав и пустые состояния витрины (S-V9, S-V12, S-V14, S-Q4;
 * AC-155, AC-156, AC-157, AC-158, AC-161, AC-164, AC-165).
 *
 * Правила экрана живут в Desktop/web, поэтому тело `presetsFor`, `toolsFor`, `partial` и `empty`
 * берётся из исходника и исполняется как есть — копии правила в тесте нет (тот же приём, что в
 * `packages/tui/src/corp/dialog-actions.test.ts`). Карточки — из разбора живого тела Hub
 * (`test/fixture/corp-hub-live.ts`).
 *
 * **Ревизия 1.10.** Экран прав и его пресеты уехали с витрины на страницу коннектора (S-D11), а
 * пустое состояние стало возвращать пару «текст + действие» вместо одной строки (S-V12, шесть
 * состояний). Тесты идут за реализацией: `presetsFor`/`toolsFor` берутся из `dialog-connector.tsx`,
 * `empty` — из витрины и получает те же аргументы, что и в ней. Ни одно утверждение при этом не
 * ослаблено: сравниваются те же ключи словаря и та же различимость состояний.
 */

const DIALOG = path.resolve(import.meta.dirname, "../../../app/src/components/corp/dialog-connectors.tsx")
const dialogSource = await Bun.file(DIALOG).text()
const PAGE = path.resolve(import.meta.dirname, "../../../app/src/components/corp/dialog-connector.tsx")
const pageSource = await Bun.file(PAGE).text()

/**
 * Тело функции или мемо по её объявлению — исполняется без рендера компонента.
 *
 * `as const` из тела снимается: `new Function` разбирает JavaScript, а не TypeScript. Утверждение
 * типа на поведение не влияет — снимается ровно оно, никакой другой правки тела нет.
 */
function blockOf(source: string, marker: string) {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker}`).toBeGreaterThan(-1)
  const lineEnd = source.indexOf("\n", at)
  const open = source.lastIndexOf("{", lineEnd)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth += 1
    else if (source[index] === "}") {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index).replace(/\bas const\b/g, "")
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

const dialogBlock = (marker: string) => blockOf(dialogSource, marker)
const pageBlock = (marker: string) => blockOf(pageSource, marker)

type Model = CorpSchema.PermissionModel | undefined
/** S-V9: какие пресеты предлагает прежний экран прав для этого вида модели. */
const presetsFor = new Function("model", pageBlock("export function presetsFor(")) as (
  model: Model,
) => { value: string; labelKey?: string }[]
/** S-V9: состав среза инструментов выбранного пресета. */
const toolsFor = new Function("model", "preset", pageBlock("export function toolsFor(")) as (
  model: Model,
  preset: string | undefined,
) => string[]

/** Пустое состояние витрины (S-V12): текст и предлагаемое действие либо `undefined`. */
export interface EmptyState {
  text: string
  action: "refresh" | "login" | "resetFilter"
}
const emptyState = new Function(
  "catalog",
  "cards",
  "visible",
  "tab",
  "language",
  "dropped",
  "corpErrorKey",
  "unavailableSource",
  "hubConfigured",
  dialogBlock("const empty = createMemo("),
) as (
  catalog: { data?: unknown; isLoading?: boolean },
  cards: () => unknown[],
  visible: () => unknown[],
  tab: () => string,
  language: { t: (key: string, args?: unknown) => string },
  dropped: () => number,
  corpErrorKey: (code: string) => string,
  /** Текст недоступного источника каталога (S-V12 п.3, ревизия 1.11). */
  unavailableSource: () => string,
  hubConfigured: () => boolean,
) => EmptyState | undefined
/** S-V12: предупреждение о неполном каталоге поверх принятых карточек. */
const partial = new Function("dropped", "cards", "language", dialogBlock("const partial = createMemo(")) as (
  dropped: () => number,
  cards: () => unknown[],
  language: { t: (key: string, args?: unknown) => string },
) => string | undefined

/** Словарь-заглушка: тексты проверяет `dictionary.test.ts`, здесь важен выбранный ключ. */
const language = {
  t: (key: string, args?: unknown) => (args === undefined ? key : `${key}:${JSON.stringify(args)}`),
}
const corpErrorKey = (code: string) => `corp.error.${code}`

const parsed = (body: unknown) => {
  const result = CorpSchema.parseCatalog(body)
  if (!result) throw new Error("конверт должен быть разобран")
  return result
}

const liveTag = parsed(liveCatalogBody()).servers[0]!
const liveModel = CorpSchema.parsePermissionModel(liveTag.permission_model)
const liveTools = (liveTagCard()["permission_model"] as { presets: Record<string, { tools: string[] }> }).presets

describe("corp/connectors — экран прав по таблице S-V9 (AC-155, AC-156, AC-157)", () => {
  test("AC-155, строка 1: header_groups предлагает readonly/readwrite и раскрывает состав групп", () => {
    const model = CorpSchema.parsePermissionModel(facade.permission_model)
    if (model?.kind !== "header_groups") throw new Error("ожидалась модель header_groups")

    expect(presetsFor(model)).toEqual([
      { value: "readonly", labelKey: "corp.preset.readonly" },
      { value: "readwrite", labelKey: "corp.preset.readwrite" },
    ])
    // Состав прав показывается группами, а не списком инструментов.
    expect(model.groups.map((group) => group.title)).toEqual(["Чтение"])
    expect(toolsFor(model, "readonly")).toEqual([])
  })

  test("AC-155, строка 2: tool_filter предлагает имена пресетов Hub и показывает их tools как есть", () => {
    if (liveModel?.kind !== "tool_filter") throw new Error("ожидалась модель tool_filter")

    // Имена — ключи `presets` в порядке ответа Hub, локализованных подписей у них нет.
    expect(presetsFor(liveModel)).toEqual([{ value: "readonly" }, { value: "readwrite" }])
    expect(toolsFor(liveModel, "readonly")).toEqual(liveTools["readonly"]!.tools)
    expect(toolsFor(liveModel, "readwrite")).toEqual(["*"])
    // Ни групп, ни списка always у этого вида нет — отметить отдельный инструмент нельзя.
    expect(liveModel).not.toHaveProperty("groups")
    expect(liveModel).not.toHaveProperty("always")
  })

  test("AC-155, строка 3: consent показывает только имена пресетов, без состава прав", () => {
    const model = CorpSchema.parsePermissionModel(native.permission_model)
    if (model?.kind !== "consent") throw new Error("ожидалась модель consent")

    expect(presetsFor(model)).toEqual([{ value: "default" }])
    expect(toolsFor(model, "default")).toEqual([])
  })

  test("AC-156, строка 4: неизвестный вид модели прав — пресеты не предлагаются, выбор недоступен", () => {
    const card = liveTagCard()
    card["permission_model"] = { kind: "quota_tiers", tiers: [{ id: "basic", calls: 100 }] }
    const catalog = parsed({ version: 1, servers: [card] })

    // Карточка в витрине есть и её учитывает счётчик коннекторов.
    expect(catalog.dropped).toEqual([])
    expect(catalog.servers.map((server) => server.alias)).toEqual(["tag"])

    const model = CorpSchema.parsePermissionModel(catalog.servers[0]!.permission_model)
    expect(model).toBeUndefined()
    // Пресета для тела PUT /api/me/connections/<alias>/permissions взять неоткуда — запрос не уйдёт.
    expect(presetsFor(model)).toEqual([])
    expect(toolsFor(model, "readonly")).toEqual([])
  })

  test("AC-156, AC-157: карточка с непонятой моделью прав сохраняет остальные действия", () => {
    const card = liveTagCard()
    card["permission_model"] = { kind: "quota_tiers", tiers: [] }
    const server = parsed({ version: 1, servers: [card] }).servers[0]!

    // Проверяется то, ради чего тест написан: непонятая модель прав не отбрасывает карточку и не
    // отнимает у неё ни подключение, ни «Открыть в Hub». Набор действий здесь определяется не
    // моделью прав, а состоянием: живая карточка `tag` несёт `connection.status = "connected"`,
    // то есть по S-V15 п.1б подключение к ней состоялось (состояние 3 таблицы S-V16).
    const notConnected = CorpStatus.compute({ alias: server.alias, server, configured: false, stale: false })
    expect(notConnected.actions).not.toContain("permissions")
    expect(notConnected.actions).toContain("open_hub")
    expect(notConnected.actions.some((action) => action === "connect" || action === "reconnect")).toBe(true)
    expect(notConnected.actions).toEqual(["reconnect", "forget", "open_hub"])
    const connected = CorpStatus.compute({
      alias: server.alias,
      server,
      configured: true,
      local: "connected",
      stale: false,
    })
    expect(connected.actions).toEqual(["permissions", "disconnect", "open_hub"])
    expect(CorpConnectors.hubServerUrl("https://hub.test", server.alias)).toBe("https://hub.test/ui/servers/tag")
  })

  test("AC-157: без permission_model экран прав заблокирован, а подключение идёт с пресетом readonly", () => {
    const card = liveTagCard()
    delete card["permission_model"]
    const server = parsed({ version: 1, servers: [card] }).servers[0]!

    expect(server.permission_model).toBeUndefined()
    expect(presetsFor(CorpSchema.parsePermissionModel(server.permission_model))).toEqual([])
    expect(CorpConnectors.connectPatch(server).mcp["tag"]!.oauth).toEqual({ scope: "tag:readonly" })
  })

  test("AC-156, AC-207: без пресетов экран прав не даёт отправить PUT и называет причину", () => {
    // Ревизия 1.10: экран пресетов живёт на странице коннектора (S-D11), правило не изменилось.
    const screen = pageSource.slice(
      pageSource.indexOf("const ConnectorPresets"),
      pageSource.indexOf("export const DialogConnectorPermissions"),
    )
    // Причина названа всегда. Микроревизия 1.11.1 развела её на два текста по признаку «адрес Hub
    // задан» (S-C10 п.7): ключ выбирает `permissionsUnavailableKey`, и оба текста — про одну и ту
    // же причину, поэтому проверка не ослаблена, а идёт на шаг глубже.
    expect(screen).toContain("language.t(permissionsUnavailableKey(props.hubConfigured))")
    const key = pageSource.slice(pageSource.indexOf("export function permissionsUnavailableKey("))
    const chooser = key.slice(0, key.indexOf("\n}"))
    expect(chooser).toContain('"corp.connectors.permissionsUnavailable"')
    expect(chooser).toContain('"corp.connectors.permissionsUnavailableNoHub"')
    // Единственный источник запроса прав — перебор предложенных пресетов: пустой список => нет запроса.
    const options = screen.indexOf("<For each={options()}>")
    expect(options, "перебор пресетов не найден").toBeGreaterThan(-1)
    expect(screen.indexOf('kind: "permissions"')).toBeGreaterThan(options)
    expect(screen.split('kind: "permissions"').length - 1).toBe(1)
    // Причина показывается ровно тогда, когда пресетов нет.
    expect(screen).toContain("const unavailable = createMemo(() => options().length === 0)")
    // AC-207: прочие действия карточки экран прав не отнимает — их набор он вообще не трогает.
    expect(screen).not.toContain('kind: "connect"')
    expect(screen).not.toContain('kind: "disconnect"')
  })

  test("AC-155: заголовок групп клиент не формирует ни при одном виде модели", () => {
    for (const server of [facade, native, liveTag]) {
      const entry = CorpConnectors.connectPatch(server, "readwrite").mcp[server.alias]!
      expect(Object.keys(entry).sort()).toEqual(
        server.mode === "facade" ? ["enabled", "oauth", "type", "url"] : ["enabled", "type", "url"],
      )
      expect(entry).not.toHaveProperty("headers")
    }
  })
})

describe("corp/connectors — scope facade-карточки с моделью tool_filter (AC-164)", () => {
  test("AC-164: живая карточка tag получает scope tag:readonly — его задаёт режим, а не модель прав", () => {
    expect(liveTag.mode).toBe("facade")
    expect(liveModel?.kind).toBe("tool_filter")

    expect(CorpConnectors.connectPatch(liveTag)).toEqual({
      mcp: {
        tag: {
          type: "remote",
          url: liveTag.mcp_url,
          enabled: true,
          oauth: { scope: "tag:readonly" },
        },
      },
    })
    expect(CorpConnectors.connectPatch(liveTag, "readwrite").mcp["tag"]!.oauth).toEqual({ scope: "tag:readwrite" })
    expect(CorpConnectors.permissionsPatch(liveTag, "readwrite") as unknown).toEqual({
      mcp: { tag: { oauth: { scope: "tag:readwrite" } } },
    } as unknown)
  })

  test("AC-164: та же модель прав у native-карточки scope не даёт — решает режим (D-28)", () => {
    const card = liveTagCard()
    card["mode"] = "native"
    const server = parsed({ version: 1, servers: [card] }).servers[0]!

    expect(CorpSchema.parsePermissionModel(server.permission_model)?.kind).toBe("tool_filter")
    expect(CorpConnectors.connectPatch(server).mcp["tag"]!.oauth).toBeUndefined()
    expect(CorpConnectors.permissionsPatch(server, "readwrite")).toBeUndefined()
  })
})

/**
 * Шесть пустых состояний витрины (S-V12, ревизия 1.10; AC-161, AC-158, AC-220, AC-221, AC-222).
 *
 * Первые четыре — про каталог целиком и предлагают «Обновить»/«Войти»; пятое и шестое — про вкладку
 * и предлагают «Показать все». Все шесть обязаны быть попарно различимы текстом.
 */
describe("corp/connectors — пустые состояния витрины (AC-161, AC-158, AC-220, AC-221, AC-222)", () => {
  interface Input {
    data?: unknown
    loading?: boolean
    cards?: unknown[]
    visible?: unknown[]
    tab?: string
    dropped?: number
    /** Задан ли адрес Hub в сборке (S-V12 п.3): от него зависит, как назван недоступный источник. */
    hub?: boolean
  }
  const state = (input: Input) => {
    // Ревизия 1.11 (S-V12 п.3): состояние 3 называет недоступный **источник** каталога. При заданном
    // адресе Hub это прежнее «Hub недоступен» дословно — на нём и идут проверки ревизии 1.10.
    const hub = input.hub ?? true
    return emptyState(
      { data: input.data, isLoading: input.loading ?? false },
      () => input.cards ?? (input.data as { servers?: unknown[] } | undefined)?.servers ?? [],
      () => input.visible ?? [],
      () => input.tab ?? "all",
      language,
      () => input.dropped ?? 0,
      corpErrorKey,
      () => (hub ? "corp.connectors.hubDown" : "corp.connectors.catalogUnavailable"),
      () => hub,
    )
  }
  const view = (data: unknown) => state({ data })?.text
  const withDropped = (data: unknown, dropped: number) => state({ data, dropped })?.text

  test("AC-161: все карточки отброшены — «Каталог не разобран» с числом отброшенных", () => {
    const catalog = parsed({
      version: 1,
      servers: [
        { title: "Без alias", mode: "facade", mcp_url: "https://hub.test/mcp/a" },
        { alias: "proxy", title: "Прокси", mode: "proxy", mcp_url: "https://hub.test/mcp/c" },
      ],
    })
    expect(catalog.servers).toEqual([])
    expect(catalog.dropped).toHaveLength(2)

    const unparsed = state({ data: { servers: [], dropped: catalog.dropped }, dropped: catalog.dropped.length })
    expect(unparsed?.text).toBe(`corp.empty.unparsed:${JSON.stringify({ dropped: 2 })}`)
    expect(unparsed?.action).toBe("refresh")
  })

  test("AC-161: «Каталог не разобран» отличается от «Каталог пуст» и от «Hub недоступен»", () => {
    const unparsed = withDropped({ servers: [], dropped: [{ reason: "alias" }] }, 1)
    const empty = view({ servers: [], dropped: [] })
    const down = view({ servers: [], hub_error: "hub_unavailable" })
    const needsLogin = view({ servers: [], hub_error: "unauthorized" })

    expect(empty).toBe("corp.connectors.empty")
    expect(down).toContain("corp.connectors.hubDown")
    expect(needsLogin).toBe("corp.connectors.needsLogin")
    expect(new Set([unparsed, empty, down, needsLogin]).size).toBe(4)
  })

  test("AC-222: прежние четыре состояния сохранили свои действия «Обновить» и «Войти»", () => {
    expect(state({ data: { servers: [], dropped: [] } })?.action).toBe("refresh")
    expect(state({ data: { servers: [], dropped: [{ reason: "alias" }] }, dropped: 1 })?.action).toBe("refresh")
    expect(state({ data: { servers: [], hub_error: "hub_unavailable" } })?.action).toBe("refresh")
    expect(state({ data: { servers: [], hub_error: "unauthorized" } })?.action).toBe("login")
    // Каталог ещё не пришёл — состояние «Hub недоступен» с тем же действием.
    expect(state({ data: undefined })).toEqual({ text: "corp.connectors.hubDown", action: "refresh" })
    // Пока каталог грузится, пустого состояния нет вовсе — иначе оно мигало бы на каждом открытии.
    expect(state({ data: undefined, loading: true })).toBeUndefined()
  })

  test("AC-220: во вкладке «Подключённые» пусто — «Пока ничего не подключено» и сброс фильтра", () => {
    const result = state({ data: { servers: [{ alias: "tag" }] }, tab: "connected", visible: [] })
    expect(result).toEqual({ text: "corp.empty.tabConnected", action: "resetFilter" })
    // Действие не перезапрашивает каталог: каталог-то на месте.
    expect(result?.action).not.toBe("refresh")
  })

  test("AC-221: во вкладке «Неподключённые» пусто — «Подключено всё» и тот же сброс фильтра", () => {
    const result = state({ data: { servers: [{ alias: "tag" }] }, tab: "not_connected", visible: [] })
    expect(result).toEqual({ text: "corp.empty.tabNotConnected", action: "resetFilter" })
  })

  test("AC-220, AC-221: пока во вкладке есть хоть одна строка, пустого состояния нет", () => {
    for (const tab of ["all", "connected", "not_connected"])
      expect(state({ data: { servers: [{ alias: "tag" }] }, tab, visible: [{ alias: "tag" }] }), tab).toBeUndefined()
    // На вкладке «Все» пустой результат — причина в поиске, и об этом говорит сам список.
    expect(state({ data: { servers: [{ alias: "tag" }] }, tab: "all", visible: [] })).toBeUndefined()
  })

  test("AC-222: все шесть состояний попарно различимы текстом", () => {
    const texts = [
      state({ data: { servers: [], dropped: [] } })?.text,
      state({ data: { servers: [], dropped: [{ reason: "alias" }] }, dropped: 1 })?.text,
      state({ data: { servers: [], hub_error: "hub_unavailable" } })?.text,
      state({ data: { servers: [], hub_error: "unauthorized" } })?.text,
      state({ data: { servers: [{ alias: "tag" }] }, tab: "connected", visible: [] })?.text,
      state({ data: { servers: [{ alias: "tag" }] }, tab: "not_connected", visible: [] })?.text,
    ]
    expect(texts.filter(Boolean)).toHaveLength(6)
    expect(new Set(texts).size).toBe(6)
  })

  test("AC-158: разобрана хотя бы одна карточка — витрина показывает её и число отброшенных", () => {
    const catalog = parsed({
      version: 1,
      servers: [liveTagCard(), { title: "Без alias", mode: "facade", mcp_url: "https://hub.test/mcp/a" }],
    })
    expect(catalog.servers.map((server) => server.alias)).toEqual(["tag"])

    expect(
      partial(
        () => catalog.dropped.length,
        () => catalog.servers,
        language,
      ),
    ).toBe(`corp.connectors.partial:${JSON.stringify({ dropped: 1 })}`)
    // Ничего не отброшено — предупреждения нет.
    expect(
      partial(
        () => 0,
        () => catalog.servers,
        language,
      ),
    ).toBeUndefined()
    // Отброшены все — вместо предупреждения работает пустое состояние.
    expect(
      partial(
        () => 2,
        () => [],
        language,
      ),
    ).toBeUndefined()
  })
})

describe("corp/connectors — диагностика отброшенных карточек (AC-165)", () => {
  test("AC-165: dropped называет alias и путь к полю и не выносит наружу тело ответа Hub", () => {
    const secret = "sk-magnit-do-not-leak"
    const catalog = parsed({
      version: 1,
      servers: [
        liveTagCard(),
        { title: "Без alias", mode: "facade", mcp_url: `https://hub.test/mcp/x?token=${secret}` },
        { alias: "gitlab", title: "GitLab", mode: "proxy", mcp_url: "https://hub.test/mcp/gitlab", note: secret },
      ],
    })

    expect(catalog.servers.map((server) => server.alias)).toEqual(["tag"])
    expect(catalog.dropped).toEqual([{ reason: "alias" }, { alias: "gitlab", reason: "mode" }])
    // Диагностика — это alias и имя поля, а не тело Hub: в лог и наружу секретам попасть неоткуда.
    expect(JSON.stringify(catalog.dropped)).not.toContain(secret)
    for (const entry of catalog.dropped)
      expect(Object.keys(entry).sort()).toEqual(entry.alias === undefined ? ["reason"] : ["alias", "reason"])
  })
})
