import { describe, expect, test } from "bun:test"
import path from "path"
import * as CorpConnectors from "./connectors"
import * as CorpCredentials from "./credentials"
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
    expect(
      CorpConnectors.permissionsPatch(facade, "readwrite", { directConnected: false, current: undefined }) as unknown,
    ).toEqual({
      mcp: { gitlab: { oauth: { scope: "gitlab:readwrite" } } },
    } as unknown)
  })

  test("AC-65: native — локального патча нет", () => {
    expect(
      CorpConnectors.permissionsPatch(native, "readwrite", { directConnected: false, current: undefined }),
    ).toBeUndefined()
  })

  /**
   * BLK-3 (errata 1.13.5): отказ патча — два НЕЗАВИСИМЫХ условия (S-V9), ни одно не покрывает
   * другое. Здесь — первое: способ подключения назван вызывающим напрямую (`directConnected:true`).
   * Карточка при этом обычная `facade`, а `current` не несёт признака разоружения — патч обязан
   * отказать РОВНО по признаку способа.
   */
  test("AC-351: directConnected:true — патч отказывает даже если запись не разоружена", () => {
    expect(
      CorpConnectors.permissionsPatch(facade, "readwrite", {
        directConnected: true,
        current: { type: "remote", url: facade.mcp_url, enabled: true },
      }),
    ).toBeUndefined()
  })

  /**
   * BLK-3 (errata 1.13.5): второе условие — `current.oauth === false` переживает удаление учётных
   * данных («Отключить»), поэтому патч обязан отказать и когда `directConnected:false` (способ уже
   * не опознаётся), опираясь только на форму самой записи (D-63, `oauthDisarmed`).
   */
  test("AC-351: current.oauth === false — патч отказывает и без directConnected", () => {
    expect(
      CorpConnectors.permissionsPatch(facade, "readwrite", {
        directConnected: false,
        current: { type: "remote", url: facade.mcp_url, enabled: false, oauth: false },
      }),
    ).toBeUndefined()
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
    expect(
      CorpConnectors.permissionsPatch(liveTag, "readwrite", { directConnected: false, current: undefined }) as unknown,
    ).toEqual({
      mcp: { tag: { oauth: { scope: "tag:readwrite" } } },
    } as unknown)
  })

  test("AC-164: та же модель прав у native-карточки scope не даёт — решает режим (D-28)", () => {
    const card = liveTagCard()
    card["mode"] = "native"
    const server = parsed({ version: 1, servers: [card] }).servers[0]!

    expect(CorpSchema.parsePermissionModel(server.permission_model)?.kind).toBe("tool_filter")
    expect(CorpConnectors.connectPatch(server).mcp["tag"]!.oauth).toBeUndefined()
    expect(
      CorpConnectors.permissionsPatch(server, "readwrite", { directConnected: false, current: undefined }),
    ).toBeUndefined()
  })
})

/**
 * Пять пустых состояний витрины (S-V12; AC-161, AC-158, AC-220, AC-221, AC-222).
 *
 * Первые четыре — про каталог целиком и предлагают «Обновить»/«Войти»; пятое — про вкладку
 * «Подключённые» и предлагает «Показать все». Все пять обязаны быть попарно различимы текстом.
 *
 * **Ревизия 1.12.** Было шесть: вместе со вкладкой «Неподключённые» (S-V11, D-53) исчезло её
 * пустое состояние «Подключено всё» — «состояния без вкладки не существует» (S-V12). Номера
 * остальных не сдвинуты: состояние 5 осталось состоянием 5.
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
  /**
   * Набор вкладок-фильтров, взятый из исходника, а не пересказанный литералом (AC-221): если
   * третья вкладка когда-нибудь вернётся в `TAB_KEY`, каждый цикл ниже подхватит её сам, а не
   * пройдёт мимо неё молча.
   */
  const tabKeys = Object.keys(
    new Function(`return {${dialogBlock("const TAB_KEY = {")}}`)() as Record<string, string>,
  )

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

  // AC-221 ревизией 1.12 РАЗВЁРНУТ В ПРОТИВОПОЛОЖНОСТЬ: вкладку «Неподключённые» убрал заказчик
  // (D-53, S-V11), а вместе с нею исчезло шестое пустое состояние «Подключено всё» — «состояния
  // без вкладки не существует» (S-V12). Критерий требует ОТСУТСТВИЯ снятого требования, потому
  // что «снятое требование обязано быть снято проверяемо, иначе вернётся само». Прежнюю проверку
  // («во вкладке „Неподключённые“ пусто — „Подключено всё“») выполнить больше нельзя ни при каком
  // составе каталога, и заменена она не ослабленной, а обратной. Третий пункт AC-221 — отсутствие
  // ключей corp.connectors.tabNotConnected и corp.empty.tabNotConnected в словарях — проверяет
  // packages/app/src/corp/dictionary.test.ts (ru, en), а таблицу пустых состояний TUI —
  // packages/tui/src/corp/connectors-view.test.ts; здесь проверяется витрина Desktop/web, чей
  // исходник этот файл исполняет.
  test("AC-221: вкладки «Неподключённые» нет, и шестого пустого состояния не существует", () => {
    // Набор доступных фильтров исчерпывается двумя: таблица подписей берётся из исходника и
    // исполняется, а не пересказывается в тесте.
    expect(tabKeys).toEqual(["all", "connected"])
    expect(dialogSource).toContain('export type ConnectorsTab = "all" | "connected"')
    // В разметке — те же две вкладки и ни одной третьей.
    expect(dialogSource).toContain('<TabsV2.Trigger value="all">')
    expect(dialogSource).toContain('<TabsV2.Trigger value="connected">')
    expect(dialogSource).not.toContain('value="not_connected"')
    // Ключей снятой вкладки витрина не упоминает вовсе — мёртвый ключ рано или поздно возвращается
    // на экран (S-I1).
    expect(dialogSource).not.toContain("tabNotConnected")

    // Шестого состояния нет ни при каком составе каталога: ни когда подключено всё (тот самый
    // случай, что прежде его давал), ни когда подключена часть, ни когда не подключено ничего.
    const compositions = {
      всёПодключено: [{ alias: "tag", state: "connected" }],
      частьПодключена: [
        { alias: "tag", state: "connected" },
        { alias: "jira", state: "not_connected" },
      ],
      ничегоНеПодключено: [{ alias: "jira", state: "not_connected" }],
    }
    for (const [name, servers] of Object.entries(compositions))
      // Снятое значение вкладки проверяется наравне с живыми (взятыми из исходника, tabKeys): даже
      // если его кто-то подставит, состояния «Подключено всё» больше нет.
      for (const tab of [...tabKeys, "not_connected"])
        for (const visible of [servers, []]) {
          const where = `${name}/${tab}/видимых:${visible.length}`
          const result = state({ data: { servers }, tab, visible })
          expect(result?.text, where).not.toBe("corp.empty.tabNotConnected")
          // Единственное оставшееся состояние вкладки — пятое, и только во вкладке «Подключённые».
          if (result?.action === "resetFilter")
            expect([tab, result.text], where).toEqual(["connected", "corp.empty.tabConnected"])
        }

    // При этом состояние 5 и его действие «Показать все» работают как прежде (последний пункт AC-221).
    expect(state({ data: { servers: [{ alias: "tag" }] }, tab: "connected", visible: [] })).toEqual({
      text: "corp.empty.tabConnected",
      action: "resetFilter",
    })
  })

  test("AC-220, AC-221: пока во вкладке есть хоть одна строка, пустого состояния нет", () => {
    // Перебор — по реальному набору вкладок (tabKeys), а не по литералу: появись третья вкладка
    // снова, этот цикл сам начнёт проверять её, а не пройдёт мимо.
    for (const tab of tabKeys)
      expect(state({ data: { servers: [{ alias: "tag" }] }, tab, visible: [{ alias: "tag" }] }), tab).toBeUndefined()
    // На вкладке «Все» пустой результат — причина в поиске, и об этом говорит сам список.
    expect(state({ data: { servers: [{ alias: "tag" }] }, tab: "all", visible: [] })).toBeUndefined()
  })

  // «Все ШЕСТЬ состояний» → «все ПЯТЬ» (ревизия 1.12 в теле AC-222): шестое исчезло вместе со
  // вкладкой «Неподключённые» (S-V12, D-53), прежние пять сохранены дословно и по-прежнему обязаны
  // быть попарно различимы. Второй пункт AC-222 — вкладки не показываются при «Hub недоступен» и
  // «Требуется вход» — проверяется по разметке в packages/app/src/corp/connectors-view.test.ts.
  test("AC-222: все пять состояний попарно различимы текстом", () => {
    const texts = [
      state({ data: { servers: [], dropped: [] } })?.text,
      state({ data: { servers: [], dropped: [{ reason: "alias" }] }, dropped: 1 })?.text,
      state({ data: { servers: [], hub_error: "hub_unavailable" } })?.text,
      state({ data: { servers: [], hub_error: "unauthorized" } })?.text,
      state({ data: { servers: [{ alias: "tag" }] }, tab: "connected", visible: [] })?.text,
    ]
    expect(texts.filter(Boolean)).toHaveLength(5)
    expect(new Set(texts).size).toBe(5)
    // Ровно пять, а не «не меньше пяти»: прежний вход шестого состояния не даёт состояния вовсе.
    expect(state({ data: { servers: [{ alias: "tag" }] }, tab: "not_connected", visible: [] })).toBeUndefined()
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

/**
 * Разбор `auth_methods`/`upstream` и запрет OAuth (S-V24, S-V28, ревизия 1.13; AC-303…AC-310,
 * AC-314, AC-338, AC-342).
 *
 * Роут `GET /corp/catalog` не поднимается — способ, доступность и `connect_mode` считают чистые
 * функции `CorpSchema.parseAuthMethods`/`parseUpstream` и `CorpStatus.authMethods`/`connectMode`/
 * `connectModeUnavailableCode`, общие для роута, Desktop и TUI (S-V28 п.3). То, что роут добавляет
 * сверху (has_credentials, конверт ответа), — предмет `connect-token.test.ts` (интеграционные AC).
 */

const oauthMethodRaw = { id: "corp_oauth", title: "Корпоративная авторизация", type: "oauth2" }
const tokenMethodRaw = {
  id: "personal_token",
  title: "Личный токен",
  type: "user_token",
  field: { label: "Токен" },
  verify: { url: "https://target.test/verify" },
}
const upstreamRaw = {
  url: "https://target.test/mcp",
  credential_headers: { Authorization: "Bearer {{access_token}}" },
}

function directServerFixture(overrides: Record<string, unknown> = {}) {
  const card = {
    alias: "svc",
    title: "Служба",
    status: "beta",
    mode: "facade",
    mcp_url: "https://hub.test/mcp/svc",
    permission_model: { kind: "consent", presets: { default: "x" } },
    auth_methods: [oauthMethodRaw, tokenMethodRaw],
    upstream: upstreamRaw,
    ...overrides,
  }
  return parsed({ version: 1, servers: [card] }).servers[0]!
}

describe("corp/schema + corp/status — разбор auth_methods/upstream (S-V24; AC-303…AC-309)", () => {
  test("AC-303: оба способа разобраны, connect_mode direct, verify/exchange/revoke/credential_headers наружу не уходят", () => {
    const server = directServerFixture()
    const connect = { server, hubConfigured: true }
    const views = CorpStatus.authMethodViews(connect)

    expect(views).toHaveLength(2)
    expect(views.map((view) => [view.id, view.title, view.type])).toEqual([
      ["corp_oauth", "Корпоративная авторизация", "oauth2"],
      ["personal_token", "Личный токен", "user_token"],
    ])
    const dump = JSON.stringify(views)
    expect(dump).not.toContain("verify")
    expect(dump).not.toContain("exchange")
    expect(dump).not.toContain("revoke")
    expect(dump).not.toContain("credential_headers")

    expect(CorpStatus.connectMode(connect)).toBe("direct")

    // has_credentials (S-V24 п.7) — без сохранённой записи хранилища признак ложный; это та же
    // функция, которой роут вычисляет поле has_credentials ответа.
    const upstream = CorpSchema.parseUpstream(server.upstream)!
    expect(CorpCredentials.applicable(undefined, upstream.url)).toBe(false)
  })

  test("AC-304: способ с неразобранным ядром отброшен ПООДИНОЧКЕ, карточка и прочие способы остаются", () => {
    const server = directServerFixture({
      auth_methods: [oauthMethodRaw, { id: "broken", title: "Без type" }, tokenMethodRaw],
    })
    const parsedMethods = CorpSchema.parseAuthMethods(server.auth_methods)
    expect(parsedMethods.map((method) => method.id)).toEqual(["corp_oauth", "personal_token"])
    // Перечень ядра карточки не расширен: карточка без auth_methods и upstream принимается как прежде.
    const bare = parsed({
      version: 1,
      servers: [{ alias: "bare", title: "Bare", mode: "facade", mcp_url: "https://hub.test/mcp/bare" }],
    }).servers
    expect(bare).toHaveLength(1)
  })

  test("AC-305: user_token без field.label или с неабсолютным verify.url отброшен, карточка осталась", () => {
    const noLabel = CorpSchema.parseAuthMethod({
      id: "a",
      title: "A",
      type: "user_token",
      field: {},
      verify: { url: "https://target.test/verify" },
    })
    expect(noLabel).toBeUndefined()
    const badVerify = CorpSchema.parseAuthMethod({
      id: "b",
      title: "B",
      type: "user_token",
      field: { label: "Token" },
      verify: { url: "not-a-url" },
    })
    expect(badVerify).toBeUndefined()

    // Без других способов user_token connect_mode считается дальше по таблице S-V7 — не "direct".
    const server = directServerFixture({
      auth_methods: [oauthMethodRaw, { id: "b", title: "B", type: "user_token", field: { label: "T" }, verify: { url: "not-a-url" } }],
    })
    expect(CorpStatus.connectMode({ server, hubConfigured: true })).not.toBe("direct")
  })

  test("AC-306: карточка без upstream или с пустым credential_headers НЕ отброшена, connect_mode != direct", () => {
    const noUpstream = directServerFixture({ upstream: undefined })
    expect(CorpSchema.parseUpstream(noUpstream.upstream)).toBeUndefined()
    expect(CorpStatus.connectMode({ server: noUpstream, hubConfigured: true })).not.toBe("direct")
    expect(CorpStatus.connectMode({ server: noUpstream, hubConfigured: true })).toBe("facade")
    expect(CorpStatus.connectMode({ server: noUpstream, hubConfigured: false })).toBe("none")

    const emptyCredentialHeaders = directServerFixture({ upstream: { ...upstreamRaw, credential_headers: {} } })
    expect(CorpSchema.parseUpstream(emptyCredentialHeaders.upstream)).toBeUndefined()
  })

  test("AC-308: available:\"yes\" (не булево) деградирует В СТОРОНУ ЗАПРЕТА — catalog_unavailable, не разрешения", () => {
    const method = CorpSchema.parseAuthMethod({ ...tokenMethodRaw, available: "yes" })!
    expect(method.availableInvalid).toBe(true)
    const availability = CorpStatus.methodAvailability(method)
    expect(availability.available).toBe(false)
    expect(availability.unavailableCode).toBe("catalog_unavailable")
  })

  test("AC-309: env: в verify.headers или в upstream.credential_headers — способ недоступен, без подстановки", () => {
    const envInVerify = CorpSchema.parseAuthMethod({
      ...tokenMethodRaw,
      verify: { url: "https://target.test/verify", headers: { "X-Tag": "env:TAG_TOKEN" } },
    })!
    expect(CorpStatus.methodAvailability(envInVerify).unavailableCode).toBe("env_header")

    const server = directServerFixture({ upstream: { ...upstreamRaw, credential_headers: { Authorization: "env:TAG_TOKEN" } } })
    const upstream = CorpSchema.parseUpstream(server.upstream)!
    expect(upstream.envHeader).toBe(true)
    // Значение не молча пропущено и не развёрнуто литералом — разбор хранит его как пришло, а
    // признак `envHeader` — единственное, что решает недоступность (S-V24 п.6).
    expect(upstream.credential_headers["Authorization"]).toBe("env:TAG_TOKEN")
    const methods = CorpStatus.authMethods({ server, hubConfigured: true })
    const tokenEntry = methods.find((entry) => entry.method.id === "personal_token")!
    expect(tokenEntry.availability.unavailableCode).toBe("env_header")
  })
})

describe("corp/status — запрет OAuth: разбор сохраняется, доступность закрыта (S-V28 п.1, п.6; AC-310)", () => {
  test("AC-310: способ oauth2 РАЗОБРАН (присутствует со своими id/title/type) и одновременно НЕДОСТУПЕН", () => {
    const server = directServerFixture()
    const views = CorpStatus.authMethodViews({ server, hubConfigured: true })
    const oauth = views.find((view) => view.type === "oauth2")!
    expect(oauth).toBeDefined()
    expect(oauth.id).toBe("corp_oauth")
    expect(oauth.title).toBe("Корпоративная авторизация")
    expect(oauth.available).toBe(false)
    expect(oauth.unavailable_code).toBe("oauth_disabled")
  })
})

describe("corp/status — снятие запрета одним предикатом, без правки экранов/роутов/словарей (S-V28 п.7; AC-314, AC-342)", () => {
  test("AC-314: oauthDisabled:false в вызове делает oauth2 доступным; способ, закрытый каталогом, остаётся закрытым", () => {
    const method = CorpSchema.parseAuthMethod(oauthMethodRaw)!
    const banned = CorpStatus.methodAvailability(method)
    expect(banned).toEqual({ available: false, unavailableCode: "oauth_disabled" })
    const lifted = CorpStatus.methodAvailability(method, { oauthDisabled: false })
    expect(lifted).toEqual({ available: true, unavailableCode: null })

    const closedByCatalog = CorpSchema.parseAuthMethod({ ...oauthMethodRaw, available: false })!
    expect(CorpStatus.methodAvailability(closedByCatalog, { oauthDisabled: false })).toEqual({
      available: false,
      unavailableCode: "catalog_unavailable",
    })
  })

  test("AC-338: карточка mode:\"native\" разобрана (не отброшена), connect_mode none/oauth_disabled, mode сохранён дословно", () => {
    const card = {
      alias: "native_srv",
      title: "Native",
      status: "beta" as const,
      mode: "native" as const,
      mcp_url: "https://hub.test/mcp/native_srv",
      permission_model: { kind: "consent", presets: { default: "x" } },
    }
    const catalog = parsed({ version: 1, servers: [card] })
    expect(catalog.dropped).toEqual([])
    const server = catalog.servers[0]!
    expect(server.alias).toBe("native_srv")
    expect(server.mode).toBe("native") // дословно, не подменено на "facade"
    expect(CorpStatus.connectMode({ server, hubConfigured: true })).toBe("none")
    expect(CorpStatus.connectModeUnavailableCode({ server, hubConfigured: true })).toBe("oauth_disabled")
  })

  test("AC-342: ОДНО снятие предиката одновременно открывает oauth2-способ И native-карточку; facade_needs_hub не отменяется", () => {
    const oauth2 = CorpSchema.parseAuthMethod(oauthMethodRaw)!
    const nativeServer: CorpSchema.CatalogServer = {
      alias: "native_srv",
      title: "Native",
      mode: "native",
      mcp_url: "https://hub.test/mcp/native_srv",
      permission_model: { kind: "consent", presets: { default: "x" } },
    }
    const facadeNoHub: CorpSchema.CatalogServer = {
      alias: "facade_srv",
      title: "Facade",
      mode: "facade",
      mcp_url: "https://hub.test/mcp/facade_srv",
    }
    const closedByCatalog = CorpSchema.parseAuthMethod({ ...oauthMethodRaw, available: false })!

    // Запрет действует (умолчание):
    expect(CorpStatus.methodAvailability(oauth2).unavailableCode).toBe("oauth_disabled")
    expect(CorpStatus.connectMode({ server: nativeServer, hubConfigured: true })).toBe("none")

    // Одно изменение — oauthDisabled:false — снимает ОБА запрета согласованно:
    const lifted = { oauthDisabled: false }
    expect(CorpStatus.methodAvailability(oauth2, lifted)).toEqual({ available: true, unavailableCode: null })
    expect(CorpStatus.connectMode({ server: nativeServer, hubConfigured: true, ...lifted })).toBe("native")
    expect(CorpStatus.connectModeUnavailableCode({ server: nativeServer, hubConfigured: true, ...lifted })).toBeNull()

    // Решения каталога и отсутствие Hub снятие запрета не отменяет:
    expect(CorpStatus.methodAvailability(closedByCatalog, lifted).unavailableCode).toBe("catalog_unavailable")
    expect(CorpStatus.connectModeUnavailableCode({ server: facadeNoHub, hubConfigured: false, ...lifted })).toBe(
      "facade_needs_hub",
    )
  })
})
