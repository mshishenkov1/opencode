import { describe, expect, test } from "bun:test"
import path from "path"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import type { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Permission } from "@/permission"
import * as CorpConnectors from "./connectors"
import * as CorpSchema from "./schema"

/**
 * Режим каждого инструмента и спутник `tools` тела роута прав (S-V21, S-V23, ревизия 1.14;
 * AC-367, AC-368).
 *
 * До этого файла у обоих критериев не было ни одного сторожа: `permission_tool_state` в тестах не
 * упоминался вовсе, а `permissionGroupsPatch` вызывался только без поля `tools`.
 *
 * Чем проверяется. Тем же способом, что соседний `permissions.test.ts` и по той же причине (S-Q13):
 * конфиг в тесте руками не собирается — он **получается сохранением** по S-V21, двумя патчами
 * `permissionGroupsPatch`, применёнными тем же механизмом (`jsonc-parser`), каким их применяет
 * `Config.updateGlobal` к файлу. Дальше смотрят не на состав ключей, а на **действие**
 * `Permission.evaluate`: у правильной записи и у записи с уехавшим wildcard состав ключей
 * одинаков, а поведение противоположно.
 *
 * Запуск: `bun --cwd packages/opencode test src/corp/permission-tools.test.ts`.
 */

/** Alias с дефисом: `sanitize` его сохраняет, и ключи обязаны это показывать (S-V21, D-8). */
const ALIAS = "tag-mcp"
const EMPTY = "{}"

type Mode = CorpSchema.PermissionMode

/**
 * Словарь версии 2 — разбирается настоящим `parsePermissionGroups` из сырого вида каталога, а не
 * собирается в тесте: раздел `tools` появился именно в версии 2, и это часть проверяемого.
 */
function dictionaryV2(raw: {
  groups: { id: string; tools: string[]; default: Mode }[]
  tools?: Record<string, { class?: string; title?: string }>
  rest?: Mode
}): CorpSchema.PermissionGroups {
  const parsed = CorpSchema.parsePermissionGroups({
    version: 2,
    groups: raw.groups.map((group) => ({ ...group, title: `группа ${group.id}` })),
    ...(raw.tools === undefined ? {} : { tools: raw.tools }),
    ...(raw.rest === undefined ? {} : { rest: { default: raw.rest } }),
  })
  expect(parsed, "словарь версии 2 не разобрался").toBeDefined()
  return parsed!.groups
}

/** Тот же точечный `modify`/`applyEdits`, каким `Config.updateGlobal` правит `.jsonc` (F21). */
function applyPatch(input: string, patch: unknown, at: string[] = []): string {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    return applyEdits(input, modify(input, at, patch, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  return Object.entries(patch as Record<string, unknown>).reduce(
    (result, [key, value]) => applyPatch(result, value, [...at, key]),
    input,
  )
}

interface Saved {
  text: string
  permission: ConfigPermissionV1.Info
  ruleset: ReturnType<typeof Permission.fromConfig>
  patch: CorpConnectors.PermissionGroupsPatch
}

/** Сохранение по S-V21: гашение блока alias, затем запись блока целиком. */
function save(
  groups: CorpSchema.PermissionGroups,
  modes: Record<string, Mode>,
  tools?: Record<string, Mode>,
  before = EMPTY,
): Saved {
  const existing = Object.keys((parseJsonc(before) as { permission?: Record<string, unknown> })?.permission ?? {})
  const patch = CorpConnectors.permissionGroupsPatch(ALIAS, {
    groups,
    modes,
    existing,
    ...(tools === undefined ? {} : { tools }),
  })
  let text = before
  for (const step of [patch.clear, patch.write]) text = applyPatch(text, step)
  const permission = ((parseJsonc(text) as { permission?: ConfigPermissionV1.Info }).permission ??
    {}) as ConfigPermissionV1.Info
  return { text, permission, ruleset: Permission.fromConfig(permission), patch }
}

/** Действующий режим инструмента — так же, как его спрашивает MCP-вызов (`Session.tools`). */
const modeOf = (saved: Saved, tool: string) =>
  Permission.evaluate(CorpConnectors.permissionKey(ALIAS, tool), "*", saved.ruleset).action

// ---------------------------------------------------------------- AC-367: permission_tool_state

/**
 * Словарь из критерия: у одного инструмента будет поимённый выбор, у его группы — свой режим,
 * а `outside_tool` не назван ни одной группой и живёт только разделом `tools` — то есть под
 * wildcard.
 */
const DICTIONARY = dictionaryV2({
  groups: [
    { id: "read", tools: ["get_post", "get_thread", "search"], default: "ask" },
    { id: "write", tools: ["create_post", "delete_post"], default: "ask" },
  ],
  tools: {
    get_post: { class: "read_only", title: "Читать сообщение" },
    outside_tool: { class: "interactive", title: "Инструмент вне групп" },
  },
  rest: "ask",
})

describe("режим каждого инструмента (S-V23, ревизия 1.14; AC-367)", () => {
  const saved = save(DICTIONARY, { read: "allow", write: "deny", rest: "ask" }, { get_post: "deny" })
  const state = CorpConnectors.permissionToolState(ALIAS, DICTIONARY, saved.permission)

  test("AC-367: поимённо заданный инструмент несёт свой режим, остальные его группы — режим группы", () => {
    expect(state["get_post"]).toBe("deny")
    expect(state["get_thread"]).toBe("allow")
    expect(state["search"]).toBe("allow")
    expect(state["create_post"]).toBe("deny")
    // И это наблюдается на действии, а не только в ответе: сервер отдаёт то же, что применится.
    for (const tool of Object.keys(state)) expect(state[tool], tool).toBe(modeOf(saved, tool))
  })

  test("AC-367: инструмент вне групп несёт режим wildcard", () => {
    const wildcard = save(DICTIONARY, { read: "allow", write: "allow", rest: "deny" })
    const modes = CorpConnectors.permissionToolState(ALIAS, DICTIONARY, wildcard.permission)
    expect(modes["outside_tool"]).toBe("deny")
    // А инструменты групп в этом же конфиге остались при своих — «остальное» их не накрыло.
    expect(modes["get_post"]).toBe("allow")
  })

  test("AC-367: режим СЧИТАЕТСЯ, а не читается ключом — ключа может не быть вовсе", () => {
    // Конфиг без единого ключа alias: правило-wildcard общего конфига обязано учитываться.
    const foreign = { "*": "deny" } as unknown as ConfigPermissionV1.Info
    const modes = CorpConnectors.permissionToolState(ALIAS, DICTIONARY, foreign)
    expect(Object.values(modes).every((mode) => mode === "deny")).toBe(true)
    // И пустой конфиг тоже даёт режим каждому — строк без режима на экране не бывает.
    const empty = CorpConnectors.permissionToolState(ALIAS, DICTIONARY, undefined)
    expect(Object.keys(empty).length).toBe(Object.keys(state).length)
    for (const mode of Object.values(empty)) expect(["allow", "ask", "deny"]).toContain(mode)
  })

  test("AC-367: «инструмент наследует режим группы, пока его не задали лично» — отдельной ветки нет", () => {
    const inherited = save(DICTIONARY, { read: "allow", write: "deny", rest: "ask" })
    const modes = CorpConnectors.permissionToolState(ALIAS, DICTIONARY, inherited.permission)
    // Того же поимённого ключа нет — и режим совпал с групповым сам собой.
    expect(modes["get_post"]).toBe("allow")
    expect(modes["get_thread"]).toBe("allow")
    expect(modes["delete_post"]).toBe("deny")
  })

  test("AC-367: значения mixed здесь не бывает ни при каком конфиге", () => {
    // Тот самый конфиг, на котором группа `read` расходится: у неё `mixed` — а у инструментов нет.
    const groups = CorpConnectors.permissionState(ALIAS, DICTIONARY, saved.permission)
    expect(groups["read"]).toBe("mixed")
    for (const [tool, mode] of Object.entries(state)) expect(["allow", "ask", "deny"], tool).toContain(mode)
    expect(Object.values(state)).not.toContain("mixed")
  })

  test("AC-367: состав ключей — объединение инструментов групп и раздела tools, без повторов", () => {
    const keys = Object.keys(state)
    expect(keys.sort()).toEqual(
      ["create_post", "delete_post", "get_post", "get_thread", "outside_tool", "search"].sort(),
    )
    expect(new Set(keys).size).toBe(keys.length)
    // Словарь версии 1 раздела `tools` не имеет — и лишних строк оттуда не появляется.
    const v1 = CorpSchema.parsePermissionGroups({
      version: 1,
      groups: [{ id: "read", title: "Чтение", default: "ask", tools: ["get_post"] }],
      tools: { outside_tool: { class: "read_only" } },
    })!.groups
    expect(Object.keys(CorpConnectors.permissionToolState(ALIAS, v1, saved.permission))).toEqual(["get_post"])
  })

  test("AC-367: считает СЕРВЕР — и карточка, и ответ роута берут одну функцию и один конфиг", async () => {
    const handler = await Bun.file(
      path.resolve(import.meta.dirname, "../server/routes/instance/httpapi/handlers/corp.ts"),
    ).text()
    const uses = handler.split("CorpConnectors.permissionToolState(").length - 1
    expect(uses, "permission_tool_state считается не в двух местах").toBe(2)
    // Тот же источник, что у режимов групп: рядом с каждым `permissionState` стоит свой
    // `permissionToolState`, и различие источников было бы видно расхождением их числа.
    expect(handler.split("CorpConnectors.permissionState(").length - 1).toBe(2)
    for (const call of handler.split("CorpConnectors.permissionToolState(").slice(1)) {
      const args = call.slice(0, call.indexOf(")")).replace(/\s+/g, " ")
      expect(args).toContain("permission")
    }
    // Клиент его не пересчитывает: страница коннектора берёт готовое поле.
    const page = await Bun.file(
      path.resolve(import.meta.dirname, "../../../app/src/components/corp/dialog-connector.tsx"),
    ).text()
    expect(page).toContain("props.card.permission_tool_state")
    expect(page).not.toContain("Permission.evaluate")
  })
})

// ---------------------------------------------------------------- AC-368: спутник tools в теле роута

/** Словарь для проверок записи: два инструмента в группе и один только в разделе `tools`. */
const WRITE_DICT = dictionaryV2({
  groups: [
    { id: "read", tools: ["get_post", "get_thread"], default: "ask" },
    { id: "write", tools: ["create_post"], default: "ask" },
  ],
  tools: { get_post: { class: "read_only" }, lonely_tool: { class: "interactive" } },
  rest: "ask",
})

describe("тело роута прав со спутником tools (S-V21, ревизия 1.14; AC-368)", () => {
  const modes = { read: "allow" as Mode, write: "deny" as Mode, rest: "ask" as Mode }

  test("AC-368: тело {modes} даёт тот же блок, что и до ревизии 1.14 — раздел tools его не трогает", () => {
    const plain = save(WRITE_DICT, modes)
    // Блок ревизии 1.13: wildcard первым, затем инструменты групп в порядке словаря. Инструмента,
    // названного ТОЛЬКО разделом `tools`, в блоке нет — до ревизии его там и не было.
    expect(Object.entries(plain.permission)).toEqual([
      ["tag-mcp_*", "ask"],
      ["tag-mcp_get_post", "allow"],
      ["tag-mcp_get_thread", "allow"],
      ["tag-mcp_create_post", "deny"],
    ])
    // И пустой спутник ничего не меняет — «поля нет» и «поле пусто» дают тот же байт в байт блок.
    expect(save(WRITE_DICT, modes, {}).text).toBe(plain.text)
    expect(save(WRITE_DICT, modes, undefined).text).toBe(plain.text)
  })

  test("AC-368: исключение меняет ЗНАЧЕНИЕ одного ключа и не меняет ПОРЯДКА ключей", () => {
    const plain = save(WRITE_DICT, modes)
    const withTool = save(WRITE_DICT, modes, { get_thread: "deny" })

    expect(Object.keys(withTool.permission)).toEqual(Object.keys(plain.permission))
    expect(withTool.permission["tag-mcp_get_thread"]).toBe("deny")
    expect(withTool.permission["tag-mcp_get_post"]).toBe("allow")
    // Наблюдается на действии, а не только на записи.
    expect(modeOf(withTool, "get_thread")).toBe("deny")
    expect(modeOf(withTool, "get_post")).toBe("allow")
  })

  test("AC-368: порядок выводится из словаря, а не из истории нажатий", () => {
    const plain = save(WRITE_DICT, modes)
    // Тот же набор исключений, названный в другом порядке, обязан дать тот же порядок ключей:
    // иначе от истории нажатий начал бы зависеть результат (`findLast`).
    const forward = save(WRITE_DICT, modes, { get_post: "deny", create_post: "allow" })
    const backward = save(WRITE_DICT, modes, { create_post: "allow", get_post: "deny" })
    expect(Object.keys(forward.permission)).toEqual(Object.keys(plain.permission))
    expect(Object.entries(backward.permission)).toEqual(Object.entries(forward.permission))
    expect(forward.patch.keys[0]).toBe(CorpConnectors.permissionWildcardKey(ALIAS))
  })

  test("AC-368: инструмент только из раздела tools получает ключ ТОЛЬКО при поимённом выборе", () => {
    const without = save(WRITE_DICT, modes)
    expect(Object.keys(without.permission)).not.toContain("tag-mcp_lonely_tool")
    // Без выбора он остаётся под wildcard — как прежде.
    expect(modeOf(without, "lonely_tool")).toBe("ask")

    const chosen = save(WRITE_DICT, modes, { lonely_tool: "deny" })
    expect(Object.keys(chosen.permission)).toContain("tag-mcp_lonely_tool")
    expect(modeOf(chosen, "lonely_tool")).toBe("deny")
    // И он встал ПОСЛЕ wildcard, иначе wildcard отменил бы его по `findLast`.
    expect(Object.keys(chosen.permission)[0]).toBe(CorpConnectors.permissionWildcardKey(ALIAS))
  })

  test("AC-368: ПРАВИЛО ПОРЯДКА держит и исключения — уехавший wildcard их молча отменяет", () => {
    const correct = save(WRITE_DICT, { read: "allow", write: "allow", rest: "allow" }, { get_thread: "deny" })
    expect(modeOf(correct, "get_thread")).toBe("deny")

    const wildcard = CorpConnectors.permissionWildcardKey(ALIAS)
    const broken = Object.fromEntries([
      ...Object.entries(correct.permission).filter(([key]) => key !== wildcard),
      [wildcard, correct.permission[wildcard]!],
    ]) as ConfigPermissionV1.Info
    // Состав ключей тот же, поведение противоположно — проверка «по составу» этого не увидела бы.
    expect(Object.entries(broken).sort()).toEqual(Object.entries(correct.permission).sort())
    expect(Permission.evaluate(CorpConnectors.permissionKey(ALIAS, "get_thread"), "*", Permission.fromConfig(broken)).action).toBe(
      "allow",
    )
  })
})

// ---------------------------------------------------------------- AC-368: тело {tools} без modes

/**
 * Условие отказа берётся из САМОГО обработчика и исполняется — копии правила в тесте нет.
 *
 * `tools` — не третий вид тела, а спутник `modes`: без `modes` неизвестен режим wildcard, а запись
 * блока детерминирована и обязана записать его явно.
 */
const HANDLER = await Bun.file(
  path.resolve(import.meta.dirname, "../server/routes/instance/httpapi/handlers/corp.ts"),
).text()

function condition(error: string) {
  const at = HANDLER.indexOf(`error: "${error}"`)
  expect(at, `не найдена ветка ${error}`).toBeGreaterThan(-1)
  const open = HANDLER.lastIndexOf("if (", at)
  expect(open, `не найдено условие ветки ${error}`).toBeGreaterThan(-1)
  let depth = 0
  for (let index = HANDLER.indexOf("(", open); index < HANDLER.length; index++) {
    if (HANDLER[index] === "(") depth += 1
    else if (HANDLER[index] === ")") {
      depth -= 1
      if (depth === 0) return HANDLER.slice(HANDLER.indexOf("(", open) + 1, index)
    }
  }
  throw new Error(`условие ветки ${error} не закрыто`)
}

const missingBody = new Function("ctx", `return (${condition("missing_body")})`) as (ctx: {
  payload: Record<string, unknown>
}) => boolean
const conflictingBody = new Function("ctx", `return (${condition("conflicting_body")})`) as (ctx: {
  payload: Record<string, unknown>
}) => boolean

describe("тело {tools} без modes не принимается (S-V21, ревизия 1.14; AC-368)", () => {
  const BODIES = {
    modes: { modes: { read: "allow", rest: "ask" } },
    both: { modes: { read: "allow", rest: "ask" }, tools: { get_post: "deny" } },
    toolsOnly: { tools: { get_post: "deny" } },
    preset: { preset: "readonly" },
  } as const

  test("AC-368: {modes} и {modes, tools} принимаются, одни лишь {tools} — нет", () => {
    expect(missingBody({ payload: BODIES.modes })).toBe(false)
    expect(missingBody({ payload: BODIES.both })).toBe(false)
    expect(missingBody({ payload: BODIES.preset })).toBe(false)
    // Одни лишь `tools` — это «нет тела»: режим wildcard взять неоткуда.
    expect(missingBody({ payload: BODIES.toolsOnly })).toBe(true)
    expect(missingBody({ payload: {} })).toBe(true)
  })

  test("AC-368: tools несовместим с preset тем же правилом, что и modes", () => {
    expect(conflictingBody({ payload: { preset: "readonly", tools: { get_post: "deny" } } })).toBe(true)
    expect(conflictingBody({ payload: { preset: "readonly", modes: { rest: "ask" } } })).toBe(true)
    expect(conflictingBody({ payload: BODIES.both })).toBe(false)
    expect(conflictingBody({ payload: BODIES.preset })).toBe(false)
  })

  test("AC-368: отказ стоит РАНЬШЕ любой записи в конфиг и любого обращения к Hub", () => {
    const at = HANDLER.indexOf('error: "missing_body"')
    const branch = HANDLER.indexOf("ctx.payload.modes !== undefined) return", at)
    expect(branch, "ветка modes не найдена после проверок тела").toBeGreaterThan(at)
    const head = HANDLER.slice(HANDLER.indexOf("const permissions = Effect.fn("), at)
    expect(head).not.toContain("updateGlobal")
    expect(head).not.toContain("CorpHub")
  })
})
