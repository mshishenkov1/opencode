import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { connectorType } from "@opencode-ai/core/corp/constants"
import * as CatalogCache from "./catalog-cache"
import * as CorpConnectors from "./connectors"
import * as CorpSchema from "./schema"

/**
 * Словарь разрешений карточки и колонка «Тип» (S-V20, S-V22, S-I6, S-V3, S-V14;
 * AC-200…AC-203, AC-215, AC-216).
 *
 * Разбор (`parsePermissionGroups`) отделён от хранения: в `CatalogServer` и в кэш `permission_groups`
 * и `type` кладутся **дословно**, как пришли от Hub, а разобранная форма считается отдельно — по
 * образцу `permission_model` (S-V3). Версия клиента, которая формата не понимает, обязана сохранить
 * его для следующей.
 */

const dirs: string[] = []

async function dataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corp-permission-groups-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

/** Русские `title`/`description` — данные каталога (S-I6): клиент их не переводит и не подменяет. */
const READ_POSTS = {
  id: "read_posts",
  title: "Читать сообщения и треды",
  description: "Чтение переписки в каналах и тредах, которые вам доступны.",
  default: "allow",
  tools: ["get_post", "get_thread"],
}

const REST = {
  title: "Остальные возможности",
  description: "Инструменты коннектора, не попавшие ни в одну группу.",
  default: "ask",
}

const card = (extra: Record<string, unknown>) => ({
  alias: "tag",
  title: "ТЭГ",
  mode: "native",
  mcp_url: "https://hub.test/mcp/tag",
  ...extra,
})

describe("corp/permission-groups — разбор словаря (S-V20; AC-200)", () => {
  test("AC-200: словарь принят, группа несёт id, title, description, default и порядок каталога", () => {
    const parsed = CorpSchema.parsePermissionGroups({ version: 1, groups: [READ_POSTS], rest: REST })
    if (!parsed) throw new Error("словарь должен разобраться")

    expect(parsed.dropped).toBe(0)
    expect(parsed.groups.version).toBe(1)
    expect(parsed.groups.groups).toEqual([
      {
        id: "read_posts",
        title: "Читать сообщения и треды",
        description: "Чтение переписки в каналах и тредах, которые вам доступны.",
        default: "allow",
        tools: ["get_post", "get_thread"],
      },
    ])
    // Порядок инструментов внутри группы — порядок каталога: от него зависит порядок ключей записи.
    expect(parsed.groups.groups[0]!.tools).toEqual(["get_post", "get_thread"])
    expect(parsed.groups.rest).toEqual({
      title: "Остальные возможности",
      description: "Инструменты коннектора, не попавшие ни в одну группу.",
      default: "ask",
    })
  })

  test("AC-200: порядок групп на выходе — порядок массива groups", () => {
    const parsed = CorpSchema.parsePermissionGroups({
      version: 1,
      groups: [
        { ...READ_POSTS, id: "c", tools: ["c1"] },
        { ...READ_POSTS, id: "a", tools: ["a1"] },
        { ...READ_POSTS, id: "b", tools: ["b1"] },
      ],
    })
    expect(parsed?.groups.groups.map((group) => group.id)).toEqual(["c", "a", "b"])
  })

  test("AC-200: блок rest необязателен — без него действует ask, а тексты остаются за оболочкой", () => {
    const parsed = CorpSchema.parsePermissionGroups({ version: 1, groups: [READ_POSTS] })
    expect(parsed?.groups.rest).toEqual({ default: "ask" })
    expect(CorpSchema.REST_DEFAULT_MODE).toBe("ask")
    // Заглушки текстов разбор не подставляет: подставить их — дело оболочки (S-V20).
    expect(parsed?.groups.rest?.title).toBeUndefined()
    expect(parsed?.groups.rest?.description).toBeUndefined()
  })
})

describe("corp/permission-groups — хранение дословное (S-V20, S-V3; AC-201)", () => {
  const unknownVersion = {
    version: 99,
    groups: [{ id: "future", title: "Из будущего", default: "maybe", tools: ["x"], extra: { deep: [1, 2] } }],
    rest: { default: "sometimes" },
  }

  test("AC-201: карточка с неизвестной версией словаря и полем type принята и не обеднена", () => {
    const result = CorpSchema.parseCatalogServer(card({ permission_groups: unknownVersion, type: "Мессенджер" }))
    if (!result.ok) throw new Error(`карточка должна быть принята: ${result.reason}`)

    expect(result.server.permission_groups).toEqual(unknownVersion)
    expect(result.server.type).toBe("Мессенджер")
    // Разбор при этом честно говорит «не понял» — экран прав деградирует (S-V20).
    expect(CorpSchema.parsePermissionGroups(result.server.permission_groups)).toBeUndefined()
  })

  test("AC-201: кэш возвращает permission_groups и type байт в байт", async () => {
    const dir = await dataDir()
    const result = CorpSchema.parseCatalogServer(card({ permission_groups: unknownVersion, type: "Мессенджер" }))
    if (!result.ok) throw new Error("карточка должна быть принята")

    await CatalogCache.write(
      { hubUrl: "https://hub.test", fetchedAt: 1_700_000_000_000, version: "2026-08-26.1", servers: [result.server] },
      dir,
    )
    const back = await CatalogCache.read("https://hub.test", dir)
    const stored = back?.servers[0]

    expect(stored?.permission_groups).toEqual(unknownVersion)
    expect(stored?.type).toBe("Мессенджер")
    // Проверка «байт в байт»: сериализация прочитанного совпадает с сериализацией пришедшего.
    expect(JSON.stringify(stored?.permission_groups)).toBe(JSON.stringify(unknownVersion))
    // Обеднённого представления в кэше нет — на диске лежит исходное тело поля.
    const text = await fs.readFile(CatalogCache.fileFor("https://hub.test", dir), "utf8")
    expect(text).toContain('"maybe"')
    expect(text).toContain('"Из будущего"')
  })
})

describe("corp/permission-groups — деградация вместо пустого экрана (S-V20, S-V9; AC-202)", () => {
  const toolFilter = { kind: "tool_filter", presets: { readonly: { tools: ["whoami"] } } }

  test("AC-202: groups не массив — карточка не отброшена, экран строится по permission_model", () => {
    const result = CorpSchema.parseCatalogServer(
      card({ permission_groups: { version: 1, groups: { read: [] } }, permission_model: toolFilter }),
    )
    if (!result.ok) throw new Error("карточка не должна отбрасываться")

    expect(CorpSchema.parsePermissionGroups(result.server.permission_groups)).toBeUndefined()
    // Прежний экран пресетов вида `tool_filter` доступен — «пустого экрана» не возникает.
    const model = CorpSchema.parsePermissionModel(result.server.permission_model)
    expect(model?.kind).toBe("tool_filter")
    // И дословное значение уцелело для следующей версии клиента (S-V3).
    expect(result.server.permission_groups).toEqual({ version: 1, groups: { read: [] } })
  })

  test("AC-202: нарушенный конверт словаря в любой форме даёт деградацию, а не отказ карточки", () => {
    for (const broken of [
      { groups: [READ_POSTS] },
      { version: "1", groups: [READ_POSTS] },
      { version: 1 },
      { version: 1, groups: "read" },
      // Ревизия 1.14 сделала версию 2 известной (раздел `tools`), поэтому «версия новее известной»
      // теперь начинается с тройки: прежняя двойка разбирается, и требовать от неё деградации
      // значило бы требовать отказа от заказанного формата.
      { version: CorpSchema.PERMISSION_GROUPS_VERSION + 1, groups: [READ_POSTS] },
      { version: 1, groups: [] },
      "not an object",
      [],
      null,
    ]) {
      const result = CorpSchema.parseCatalogServer(card({ permission_groups: broken, permission_model: toolFilter }))
      expect(result.ok, JSON.stringify(broken)).toBe(true)
      expect(CorpSchema.parsePermissionGroups(broken), JSON.stringify(broken)).toBeUndefined()
    }
  })

  test("AC-202: version больше известной клиенту — деградация, а не попытка разобрать", () => {
    // Известная версия — 2 (ревизия 1.14, раздел `tools`). Число здесь названо дословно намеренно:
    // «версия, которую понимает сборка» — часть контракта с каталогом, и молчаливое её повышение
    // (сборка начала бы разбирать формат, которого не знает) обязано валить тест, а не проходить.
    expect(CorpSchema.PERMISSION_GROUPS_VERSION).toBe(2)
    expect(
      CorpSchema.parsePermissionGroups({ version: CorpSchema.PERMISSION_GROUPS_VERSION + 1, groups: [READ_POSTS] }),
    ).toBeUndefined()
  })
})

/**
 * Словарь версии 2 (S-V20, ревизия 1.14; AC-200, AC-202).
 *
 * Заказчик от 30.08 заказал экран разрешений по классам риска, и раздел `tools` — его источник.
 * Три утверждения держат ровно то, что от версий требуется: **2 разбирается** (иначе экрана нет),
 * **1 разбирается как прежде** (словарь без раздела `tools` не обязан внезапно его получить), **3
 * деградирует** (формат новее известного разбирать нечем).
 */
describe("corp/permission-groups — три версии словаря (S-V20; AC-200, AC-202)", () => {
  const TOOLS = {
    get_post: { title: "Прочитать сообщение", class: "read_only" },
    create_post: { title: "Отправить сообщение", class: "write_delete" },
  }

  test("AC-200: версия 2 разбирается и раздел tools доезжает до разобранной формы", () => {
    const parsed = CorpSchema.parsePermissionGroups({ version: 2, groups: [READ_POSTS], rest: REST, tools: TOOLS })
    if (!parsed) throw new Error("словарь версии 2 должен разбираться")
    expect(parsed.groups.version).toBe(2)
    expect(parsed.groups.tools).toEqual({
      get_post: { class: "read_only", title: "Прочитать сообщение" },
      create_post: { class: "write_delete", title: "Отправить сообщение" },
    })
    // Группы версии 2 разбираются тем же правилом, что и версии 1: раздел `tools` их не заменяет.
    expect(parsed.groups.groups.map((group) => group.id)).toEqual(["read_posts"])
  })

  test("AC-202: версия 1 разбирается ровно как прежде — раздела tools у неё не появляется", () => {
    // Тот же словарь, что и выше, но объявленный версией 1: раздел `tools` в этом формате не
    // существует, и вычитать его оттуда значило бы читать поле, которого контракт не обещал.
    const parsed = CorpSchema.parsePermissionGroups({ version: 1, groups: [READ_POSTS], rest: REST, tools: TOOLS })
    if (!parsed) throw new Error("словарь версии 1 должен разбираться")
    expect(parsed.groups.version).toBe(1)
    expect(parsed.groups.tools).toBeUndefined()
    expect(parsed.groups.groups).toEqual([
      {
        id: "read_posts",
        title: "Читать сообщения и треды",
        description: "Чтение переписки в каналах и тредах, которые вам доступны.",
        default: "allow",
        tools: ["get_post", "get_thread"],
      },
    ])
    expect(parsed.groups.rest).toEqual({
      title: "Остальные возможности",
      description: "Инструменты коннектора, не попавшие ни в одну группу.",
      default: "ask",
    })
  })

  test("AC-202: версия 3 деградирует целиком, а карточку не отбрасывает и значение не теряет", () => {
    const dictionary = { version: 3, groups: [READ_POSTS], tools: TOOLS }
    expect(CorpSchema.parsePermissionGroups(dictionary)).toBeUndefined()
    const result = CorpSchema.parseCatalogServer(card({ permission_groups: dictionary }))
    if (!result.ok) throw new Error(`карточка должна быть принята: ${result.reason}`)
    // Дословное значение уцелело для следующей версии клиента (S-V3).
    expect(result.server.permission_groups).toEqual(dictionary)
  })

  test("AC-200: инструмент без имени класса и без title попадает в interactive, а не в «только чтение»", () => {
    // Про неизвестное нельзя говорить «ничего не меняет»: непонятый инструмент в самой
    // разрешительной секции экрана — это разрешение, выданное по недоразумению.
    const parsed = CorpSchema.parsePermissionGroups({
      version: 2,
      groups: [READ_POSTS],
      tools: {
        bare: {},
        weird: { class: "whatever" },
        titled: { title: "Только имя" },
        read: { class: "read_only" },
      },
    })
    if (!parsed) throw new Error("словарь версии 2 должен разбираться")
    expect(CorpSchema.PERMISSION_TOOL_CLASS_DEFAULT).toBe("interactive")
    expect(parsed.groups.tools?.["bare"]).toEqual({ class: "interactive" })
    expect(parsed.groups.tools?.["weird"]).toEqual({ class: "interactive" })
    // Человеческого имени может не быть — техническое честнее выдуманного, и запись не выбрасывается.
    expect(parsed.groups.tools?.["titled"]).toEqual({ class: "interactive", title: "Только имя" })
    // Объявленный класс при этом никуда не уходит: умолчание применяется только к непонятому.
    expect(parsed.groups.tools?.["read"]).toEqual({ class: "read_only" })
  })
})

describe("corp/permission-groups — частичная порча мягче (S-V20, S-I6; AC-203)", () => {
  const groups = [
    { ...READ_POSTS, id: "read_posts" },
    { ...READ_POSTS, id: "broken", title: "Битая группа", default: "sometimes", tools: ["danger"] },
    { ...READ_POSTS, id: "write_posts", title: "Писать сообщения", default: "ask", tools: ["create_post"] },
  ]

  test("AC-203: неразобранной оказывается только группа с default вне перечисления", () => {
    const parsed = CorpSchema.parsePermissionGroups({ version: 1, groups, rest: REST })
    if (!parsed) throw new Error("словарь должен разобраться частично")

    expect(parsed.groups.groups.map((group) => group.id)).toEqual(["read_posts", "write_posts"])
    // Число выброшенных групп сообщается наружу — тем же средством, что число отброшенных карточек.
    expect(parsed.dropped).toBe(1)
  })

  test("AC-203: инструменты выброшенной группы отдельного ключа не получают и уходят в rest", () => {
    const parsed = CorpSchema.parsePermissionGroups({ version: 1, groups, rest: REST })
    const tools = parsed!.groups.groups.flatMap((group) => group.tools)
    expect(tools).not.toContain("danger")
    // Значит, режим им даст wildcard блока alias, то есть `rest` (S-V21).
    expect(parsed!.groups.rest?.default).toBe("ask")
  })

  test("AC-203: русские title и description разобранных групп доходят без изменений", () => {
    const parsed = CorpSchema.parsePermissionGroups({ version: 1, groups, rest: REST })
    expect(parsed!.groups.groups[0]!.title).toBe("Читать сообщения и треды")
    expect(parsed!.groups.groups[0]!.description).toBe("Чтение переписки в каналах и тредах, которые вам доступны.")
    expect(parsed!.groups.groups[1]!.title).toBe("Писать сообщения")
    expect(parsed!.groups.rest!.title).toBe("Остальные возможности")
  })

  test("AC-203: группа без названия, с пустым tools и с повтором id тоже выбрасывается поодиночке", () => {
    const parsed = CorpSchema.parsePermissionGroups({
      version: 1,
      groups: [
        READ_POSTS,
        { ...READ_POSTS, id: "no_title", title: "" },
        { ...READ_POSTS, id: "no_tools", tools: [] },
        { ...READ_POSTS, id: "bad_tools", tools: ["ok", 42] },
        { ...READ_POSTS, id: "read_posts" },
        { ...READ_POSTS, id: "kept", title: "Уцелевшая", tools: ["ok"] },
      ],
    })
    expect(parsed!.groups.groups.map((group) => group.id)).toEqual(["read_posts", "kept"])
    expect(parsed!.dropped).toBe(4)
  })

  test("AC-203: когда не разобралась ни одна группа, словарь целиком считается непонятым", () => {
    expect(
      CorpSchema.parsePermissionGroups({ version: 1, groups: [{ ...READ_POSTS, default: "sometimes" }] }),
    ).toBeUndefined()
  })
})

describe("corp/permission-groups — колонка «Тип» (S-V22, S-I6; AC-215, AC-216)", () => {
  test("AC-215: значение колонки — type каталога как есть, без перевода", () => {
    expect(connectorType({ type: "Мессенджер", owner: "AI Lab" })).toBe("Мессенджер")
    // Словаря типов клиент не ведёт: значение возвращается тем же, каким пришло.
    expect(connectorType({ type: "Трекер задач" })).toBe("Трекер задач")
  })

  test("AC-216: без пригодного type колонка показывает MCP — владелец в неё не попадает", () => {
    // Решение заказчика от 30.08: деградация «type → owner → пустая ячейка» отменена. Владелец —
    // ответ на другой вопрос («чей коннектор»), и в колонке «что это» он был неверен; пустой
    // ячейки не бывает вовсе.
    expect(connectorType({ type: "Мессенджер", owner: "AI Lab" })).toBe("Мессенджер")
    expect(connectorType({ owner: "AI Lab" })).toBe("MCP")
    expect(connectorType({})).toBe("MCP")
    // Пустая и пробельная строка равносильны отсутствию поля — и дают то же умолчание.
    expect(connectorType({ type: "", owner: "AI Lab" })).toBe("MCP")
    expect(connectorType({ type: "   ", owner: "AI Lab" })).toBe("MCP")
    expect(connectorType({ type: "", owner: "" })).toBe("MCP")
    // Ни при каком составе карточки значение owner в колонку «Тип» не попадает.
    for (const owner of ["AI Lab", "Платформа", ""])
      expect(connectorType({ owner }), owner).not.toBe(owner === "" ? " " : owner)
  })

  test("AC-216: значение колонки непусто всегда — пустой ячейки в витрине не бывает", () => {
    for (const card of [{}, { owner: "AI Lab" }, { type: "" }, { type: "  " }, { type: "Трекер задач" }])
      expect(connectorType(card as { type?: string }).trim().length, JSON.stringify(card)).toBeGreaterThan(0)
  })

  test("AC-216: карточка без type и без owner принимается целиком", () => {
    const result = CorpSchema.parseCatalogServer(card({}))
    if (!result.ok) throw new Error("карточка должна быть принята")
    expect(result.server.type).toBeUndefined()
    expect(result.server.owner).toBeUndefined()
    expect(result.server.alias).toBe("tag")
    expect(result.server.title).toBe("ТЭГ")
  })

  test("AC-216: type неизвестного вида равносилен отсутствию поля и карточку не отбрасывает", () => {
    for (const value of [42, true, { name: "Мессенджер" }, ["Мессенджер"], null]) {
      const result = CorpSchema.parseCatalogServer(card({ type: value, owner: "AI Lab" }))
      expect(result.ok, JSON.stringify(value)).toBe(true)
      if (!result.ok) continue
      expect(result.server.type, JSON.stringify(value)).toBeUndefined()
      // Деградация доходит до колонки: показывается умолчание `MCP`, а не владелец.
      expect(connectorType(result.server), JSON.stringify(value)).toBe("MCP")
    }
  })

  test("AC-215, AC-216: правило колонки живёт в одном модуле на обе оболочки (S-Q9)", () => {
    // Сервер берёт его оттуда же, что Desktop и TUI: разойтись оболочки не могут по построению.
    expect(CorpConnectors.connectorType).toBe(connectorType)
  })
})
