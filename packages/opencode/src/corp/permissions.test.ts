import { describe, expect, test } from "bun:test"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import type { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import * as CorpConnectors from "./connectors"
import * as CorpSchema from "./schema"

/**
 * Применение разрешений по группам — через `Permission.evaluate` (S-Q13, S-V21, S-V23;
 * AC-208…AC-211, AC-213, AC-237, AC-238).
 *
 * Проверять запись сравнением списка ключей **запрещено** (S-Q13): у правильной записи (wildcard
 * первым) и у катастрофически неправильной (wildcard последним) состав ключей одинаков, а поведение
 * противоположно — `Permission.evaluate` берёт **последнее** совпавшее правило (`findLast`, F47).
 * Поэтому каждый содержательный тест здесь:
 *   1. получает конфиг **сохранением** по S-V21 — двумя патчами `permissionGroupsPatch`, применёнными
 *      тем же механизмом, каким их применяет `Config.updateGlobal` к файлу `.jsonc` (`jsonc-parser`,
 *      F21). Конфиг в тесте руками не собирается: порядок ключей — это и есть предмет проверки;
 *   2. прогоняет инструменты через `Permission.evaluate` по этому конфигу и смотрит на **действие**.
 *
 * Отдельно живёт «инъекция» (`describe` в конце): тот же состав ключей, записанный в обратном
 * порядке, обязан ломать проверки этого файла — иначе они ничего не стерегут.
 */

/** Alias с дефисом: `sanitize` его сохраняет, и ключ обязан это показывать (S-V21, D-8; AC-208). */
const ALIAS = "tag-mcp"

const dictionary = (
  groups: { id: string; tools: string[]; default?: CorpSchema.PermissionMode }[],
  rest?: CorpSchema.PermissionMode,
): CorpSchema.PermissionGroups => ({
  version: 1,
  groups: groups.map((group) => ({
    id: group.id,
    title: `группа ${group.id}`,
    tools: group.tools,
    ...(group.default === undefined ? {} : { default: group.default }),
  })),
  ...(rest === undefined ? {} : { rest: { default: rest } }),
})

/**
 * Тот же способ записи, каким `Config.updateGlobal` правит `.jsonc` глобального конфига (F21):
 * точечный `modify`/`applyEdits` по пути ключа. Механизм записи здесь — инфраструктура, а не предмет
 * проверки: предмет — порядок ключей, который в этот механизм передаёт `permissionGroupsPatch`.
 */
function applyPatch(input: string, patch: unknown, at: string[] = []): string {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    return applyEdits(input, modify(input, at, patch, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  return Object.entries(patch as Record<string, unknown>).reduce(
    (result, [key, value]) => applyPatch(result, value, [...at, key]),
    input,
  )
}

interface Saved {
  /** Текст конфига после обоих вызовов — по нему видно, что чужие ключи и комментарии на месте. */
  text: string
  /** Разбор текста: порядок ключей раздела `permission` сохранён ровно таким, каким он записан. */
  permission: ConfigPermissionV1.Info
  /** Правила в том виде, в каком их читает `Permission.evaluate`. */
  ruleset: ReturnType<typeof Permission.fromConfig>
  patch: CorpConnectors.PermissionGroupsPatch
  /** Сколько раз вызван `Config.updateGlobal` — по S-V21 их ровно два. */
  calls: number
}

/**
 * Сохранение разрешений по S-V21: два вызова `Config.updateGlobal` в строго этом порядке — сначала
 * гашение всех ключей `^<alias>_`, затем запись блока целиком.
 */
function save(
  before: string,
  alias: string,
  groups: CorpSchema.PermissionGroups,
  modes: Record<string, CorpSchema.PermissionMode>,
): Saved {
  const existing = Object.keys((parseJsonc(before) as { permission?: Record<string, unknown> })?.permission ?? {})
  const patch = CorpConnectors.permissionGroupsPatch(alias, { groups, modes, existing })
  let text = before
  let calls = 0
  for (const step of [patch.clear, patch.write]) {
    text = applyPatch(text, step)
    calls += 1
  }
  const permission = ((parseJsonc(text) as { permission?: ConfigPermissionV1.Info }).permission ??
    {}) as ConfigPermissionV1.Info
  return { text, permission, ruleset: Permission.fromConfig(permission), patch, calls }
}

/** Действующий режим инструмента коннектора — так же, как его считает сервер (S-V23). */
const modeOf = (saved: Saved, alias: string, tool: string) =>
  Permission.evaluate(CorpConnectors.permissionKey(alias, tool), "*", saved.ruleset).action

const EMPTY = "{}"

describe("corp/permissions — соответствие «группа → ключи permission» (S-V21; AC-208)", () => {
  test("AC-208: дефис alias сохранён, недопустимый символ заменён тем же sanitize, что у MCP", () => {
    const saved = save(EMPTY, ALIAS, dictionary([{ id: "read", tools: ["get_post", "search posts"] }]), {
      read: "allow",
    })

    expect(saved.permission["tag-mcp_get_post"]).toBe("allow")
    expect(saved.permission["tag-mcp_search_posts"]).toBe("allow")
    // Ключ обязан совпасть с именем, под которым инструмент спрашивает разрешение (`mcp/index.ts`).
    expect(CorpConnectors.permissionKey(ALIAS, "search posts")).toBe(
      McpCatalog.sanitize(ALIAS) + "_" + McpCatalog.sanitize("search posts"),
    )
    // И это наблюдается на действии, а не только на составе ключей.
    expect(modeOf(saved, ALIAS, "search posts")).toBe("allow")
  })

  test("AC-208: alias и имя инструмента санируются одной функцией — своей копии правила нет", () => {
    expect(CorpConnectors.permissionKey("gitlab platform", "get:post")).toBe("gitlab_platform_get_post")
    expect(CorpConnectors.permissionWildcardKey(ALIAS)).toBe("tag-mcp_*")
    // `*` через `sanitize` не проходит: это шаблон, а не имя.
    expect(McpCatalog.sanitize("*")).toBe("_")
  })
})

describe("corp/permissions — ПРАВИЛО ПОРЯДКА: wildcard первым (S-V21, S-Q13; AC-209)", () => {
  const groups = dictionary([{ id: "read", tools: ["get_post", "get_thread"], default: "allow" }], "allow")

  test("AC-209: первым ключом блока идёт wildcard, явные ключи — после него", () => {
    const saved = save(EMPTY, ALIAS, groups, { read: "deny", rest: "allow" })
    const keys = Object.keys(saved.permission)

    expect(keys[0]).toBe("tag-mcp_*")
    expect(saved.permission["tag-mcp_*"]).toBe("allow")
    expect(keys.slice(1)).toEqual(["tag-mcp_get_post", "tag-mcp_get_thread"])
  })

  test("AC-209, AC-237: порядок подтверждается результатом Permission.evaluate, а не составом ключей", () => {
    const saved = save(EMPTY, ALIAS, groups, { read: "deny", rest: "allow" })

    // Явное правило группы побеждает wildcard `rest: allow` — иначе запись молча всё разрешила бы.
    expect(modeOf(saved, ALIAS, "get_post")).toBe("deny")
    expect(modeOf(saved, ALIAS, "get_thread")).toBe("deny")
    // Инструмент вне групп остаётся под wildcard.
    expect(modeOf(saved, ALIAS, "whoami")).toBe("allow")
  })
})

describe("corp/permissions — детерминированная перезапись блока alias (S-V21; AC-210)", () => {
  /** Конфиг «как у живого пользователя»: чужие коннекторы, `edit`, `bash`, `*` и комментарий. */
  const before = `{
  // комментарий пользователя переживает запись разрешений (S-C7)
  "permission": {
    "edit": "ask",
    "tag-mcp_old_one": "allow",
    "tag-mcp_old_two": "allow",
    "tag-mcp_old_three": "deny",
    "tag-mcp_old_four": "deny",
    "tag-mcp_*": "allow",
    "gitlab_get_issue": "allow",
    "bash": "ask",
    "*": "deny"
  }
}`

  const groups = dictionary([{ id: "read", tools: ["get_post", "get_thread"] }], "ask")
  const saved = save(before, ALIAS, groups, { read: "allow", rest: "ask" })

  test("AC-210: ровно два вызова updateGlobal — сначала гашение блока, затем запись целиком", () => {
    expect(saved.calls).toBe(2)
    const clear = (saved.patch.clear as unknown as { permission: Record<string, undefined> }).permission
    // Гасится каждый ключ блока alias и только он — `patchJsonc` удаляет по имени, а не по шаблону.
    expect(Object.keys(clear).sort()).toEqual(
      ["tag-mcp_*", "tag-mcp_old_four", "tag-mcp_old_one", "tag-mcp_old_three", "tag-mcp_old_two"].sort(),
    )
    for (const value of Object.values(clear)) expect(value).toBeUndefined()
    // Запись — блок целиком, wildcard первым.
    expect(saved.patch.keys[0]).toBe("tag-mcp_*")
    expect(saved.patch.keys).toEqual(["tag-mcp_*", "tag-mcp_get_post", "tag-mcp_get_thread"])
  })

  test("AC-210: от предыдущего набора не осталось ни одного ключа", () => {
    for (const key of Object.keys(saved.permission)) expect(key).not.toContain("_old_")
    // И это видно на действии: снятый инструмент больше не разрешён явным правилом.
    expect(modeOf(saved, ALIAS, "old_one")).toBe("ask")
  })

  test("AC-210: чужие ключи сохранены с прежним порядком относительно друг друга", () => {
    const keys = Object.keys(saved.permission)
    const foreign = keys.filter((key) => !key.startsWith("tag-mcp_"))
    expect(foreign).toEqual(["edit", "gitlab_get_issue", "bash", "*"])
    // Комментарий пользователя на месте (S-C7).
    expect(saved.text).toContain("комментарий пользователя")
    // И действие чужих правил прежнее — сравнивается с тем, что действовало ДО сохранения, а не с
    // выписанной в тест константой: у пользователя в конфиге стоит `"*": "deny"`, и оно тоже часть
    // «прежнего действия».
    const beforeRules = Permission.fromConfig(parseJsonc(before).permission)
    for (const key of ["gitlab_get_issue", "edit", "bash", "something_else"])
      expect(Permission.evaluate(key, "*", saved.ruleset).action, key).toBe(
        Permission.evaluate(key, "*", beforeRules).action,
      )
  })

  test("AC-210: блок alias лежит одним непрерывным участком", () => {
    const keys = Object.keys(saved.permission)
    const own = keys.map((key, at) => (key.startsWith("tag-mcp_") ? at : -1)).filter((at) => at >= 0)
    expect(own.length).toBe(3)
    expect(own[own.length - 1]! - own[0]!).toBe(own.length - 1)
  })
})

describe("corp/permissions — инструменты вне групп (S-V21; AC-211)", () => {
  test("AC-211: неизвестный инструмент отдельного ключа не получает и спрашивает через wildcard", () => {
    const groups = dictionary([{ id: "read", tools: ["get_post"] }], "ask")
    const saved = save(EMPTY, ALIAS, groups, { read: "allow", rest: "ask" })

    expect(Object.keys(saved.permission)).not.toContain("tag-mcp_brand_new_tool")
    expect(modeOf(saved, ALIAS, "brand_new_tool")).toBe("ask")
    // Появление нового инструмента у сервера само по себе не может дать ему `allow`.
    expect(modeOf(saved, ALIAS, "brand_new_tool")).not.toBe("allow")
    expect(modeOf(saved, ALIAS, "get_post")).toBe("allow")
  })
})

describe("corp/permissions — permission_state по действующему конфигу (S-V23; AC-213)", () => {
  /** Три инструмента в одной группе — свёртка считается по ним (S-V23). */
  const one = dictionary([{ id: "read", tools: ["a", "b", "c"] }], "ask")
  /** Тот же набор, разложенный по группам: так конфиг получается сохранением, а не сборкой руками. */
  const three = dictionary(
    [
      { id: "g1", tools: ["a"] },
      { id: "g2", tools: ["b"] },
      { id: "g3", tools: ["c"] },
    ],
    "ask",
  )

  const stateFor = (modes: Record<string, CorpSchema.PermissionMode>) =>
    CorpConnectors.permissionState(ALIAS, one, save(EMPTY, ALIAS, three, modes).permission)

  test("AC-213: три allow → allow, три deny → deny, три ask → ask, разнобой → mixed", () => {
    expect(stateFor({ g1: "allow", g2: "allow", g3: "allow", rest: "ask" })["read"]).toBe("allow")
    expect(stateFor({ g1: "deny", g2: "deny", g3: "deny", rest: "ask" })["read"]).toBe("deny")
    expect(stateFor({ g1: "ask", g2: "ask", g3: "ask", rest: "ask" })["read"]).toBe("ask")
    expect(stateFor({ g1: "allow", g2: "allow", g3: "deny", rest: "ask" })["read"]).toBe("mixed")
  })

  test("AC-213: режим взят из Permission.evaluate — правило-wildcard учтено, а не только ключ", () => {
    // Ни у одного инструмента группы своего ключа нет: их режим целиком приходит от wildcard.
    const saved = save(EMPTY, ALIAS, dictionary([{ id: "other", tools: ["z"] }], "deny"), {
      other: "allow",
      rest: "deny",
    })
    const state = CorpConnectors.permissionState(ALIAS, one, saved.permission)
    // «a», «b», «c» ключей не получили — их режим равен режиму wildcard.
    for (const tool of ["a", "b", "c"]) expect(Object.keys(saved.permission)).not.toContain(`tag-mcp_${tool}`)
    expect(state["read"]).toBe("deny")
    // Ключ `rest` в состоянии есть всегда и считается по wildcard.
    expect(state["rest"]).toBe("deny")
  })

  test("AC-213: вышележащий слой конфига учитывается — состояние считает не чтение ключа", () => {
    const saved = save(EMPTY, ALIAS, one, { read: "allow", rest: "allow" })
    // Правило, стоящее в конфиге ПОСЛЕ блока alias, побеждает по `findLast` — и состояние обязано
    // это показать, иначе экран покажет не то, что действует.
    const withLater = { ...saved.permission, "tag-mcp_b": "deny" } as ConfigPermissionV1.Info
    expect(CorpConnectors.permissionState(ALIAS, one, withLater)["read"]).toBe("mixed")
  })

  test("AC-213: пустого конфига хватает для состояния — умолчание Permission.evaluate равно ask", () => {
    const state = CorpConnectors.permissionState(ALIAS, one, {})
    expect(state["read"]).toBe("ask")
    expect(state["rest"]).toBe("ask")
  })
})

describe("corp/permissions — явное правило побеждает в обе стороны (S-Q13, S-V21; AC-237)", () => {
  const groups = dictionary([{ id: "read", tools: ["get_post"] }], "ask")

  /** Живой конфиг до сохранения: чужой коннектор и общие правила обязаны пережить запись. */
  const before = `{
  "permission": {
    "edit": "deny",
    "bash": "ask",
    "gitlab_get_issue": "allow",
    "*": "ask"
  }
}`

  test("AC-237: rest=allow + группа deny — инструмент группы запрещён, остальное разрешено", () => {
    const saved = save(before, ALIAS, groups, { read: "deny", rest: "allow" })
    expect(modeOf(saved, ALIAS, "get_post")).toBe("deny")
    expect(modeOf(saved, ALIAS, "anything_else")).toBe("allow")
  })

  test("AC-237: rest=deny + группа allow — инструмент группы разрешён, остальное запрещено", () => {
    const saved = save(before, ALIAS, groups, { read: "allow", rest: "deny" })
    expect(modeOf(saved, ALIAS, "get_post")).toBe("allow")
    expect(modeOf(saved, ALIAS, "anything_else")).toBe("deny")
  })

  test("AC-237: инструмент другого коннектора и ключи edit/bash/* сохраняют прежнее действие", () => {
    const rules = Permission.fromConfig(parseJsonc(before).permission)
    for (const modes of [
      { read: "deny" as const, rest: "allow" as const },
      { read: "allow" as const, rest: "deny" as const },
    ]) {
      const saved = save(before, ALIAS, groups, modes)
      for (const key of ["gitlab_get_issue", "edit", "bash", "totally_unrelated"]) {
        expect(Permission.evaluate(key, "*", saved.ruleset).action, `${key} @ ${JSON.stringify(modes)}`).toBe(
          Permission.evaluate(key, "*", rules).action,
        )
      }
    }
  })
})

describe("corp/permissions — режим deny убирает инструмент из списка модели (S-Q13, S-V21; AC-238)", () => {
  const groups = dictionary(
    [
      { id: "read", tools: ["get_post", "get_thread"] },
      { id: "write", tools: ["create_post"] },
      { id: "admin", tools: ["delete_post"] },
    ],
    "ask",
  )

  test("AC-238: инструментов группы deny в списке нет, инструменты allow и ask — есть", () => {
    const saved = save(EMPTY, ALIAS, groups, { read: "allow", write: "ask", admin: "deny", rest: "ask" })

    // Список, который видит модель, собирается тем же механизмом, что в `LLMRequestPrep.resolveTools`:
    // инструмент выпадает из набора, если для него действует запрет (`Permission.disabled`).
    const tools = ["get_post", "get_thread", "create_post", "delete_post"].map((tool) =>
      CorpConnectors.permissionKey(ALIAS, tool),
    )
    const disabled = Permission.disabled(tools, saved.ruleset)
    const visible = tools.filter((tool) => !disabled.has(tool))

    expect(visible).toEqual(["tag-mcp_get_post", "tag-mcp_get_thread", "tag-mcp_create_post"])
    expect(visible).not.toContain("tag-mcp_delete_post")
    // Проверка выполнена на составе списка, а не на факте отказа при вызове.
    expect(disabled.has("tag-mcp_delete_post")).toBe(true)
  })

  test("AC-238: rest=deny убирает из списка и инструменты, не названные ни одной группой", () => {
    const saved = save(EMPTY, ALIAS, groups, { read: "allow", write: "allow", admin: "allow", rest: "deny" })
    const tools = ["get_post", "brand_new_tool"].map((tool) => CorpConnectors.permissionKey(ALIAS, tool))
    const disabled = Permission.disabled(tools, saved.ruleset)

    expect(disabled.has("tag-mcp_get_post")).toBe(false)
    expect(disabled.has("tag-mcp_brand_new_tool")).toBe(true)
  })
})

/**
 * Инъекция «wildcard последним» (S-Q13, D-36).
 *
 * Смысл этого блока — доказать, что проверки выше не тавтологичны: у правильной и у
 * катастрофически неправильной записи **состав ключей одинаков**, поэтому тест на состав пропустил
 * бы дефект, а тест на `Permission.evaluate` — нет.
 */
describe("corp/permissions — инъекция «wildcard последним» обязана ловиться (S-Q13; AC-209, AC-237)", () => {
  const groups = dictionary([{ id: "read", tools: ["get_post", "get_thread"] }], "allow")
  const modes = { read: "deny" as const, rest: "allow" as const }

  const correct = save(EMPTY, ALIAS, groups, modes)
  /** Тот же блок, записанный в обратном порядке: wildcard уехал в конец. */
  const wildcard = CorpConnectors.permissionWildcardKey(ALIAS)
  const injected = (() => {
    const entries = Object.entries(correct.permission).filter(([key]) => key !== wildcard)
    const permission = Object.fromEntries([
      ...entries,
      [wildcard, correct.permission[wildcard]!],
    ]) as ConfigPermissionV1.Info
    return { permission, ruleset: Permission.fromConfig(permission) }
  })()

  test("AC-209: состав ключей у правильной и у испорченной записи одинаков", () => {
    expect(Object.keys(injected.permission).sort()).toEqual(Object.keys(correct.permission).sort())
    expect(Object.entries(injected.permission).sort()).toEqual(Object.entries(correct.permission).sort())
    // Отличается только порядок — то, чего проверка «по составу ключей» не видит.
    expect(Object.keys(injected.permission)).not.toEqual(Object.keys(correct.permission))
  })

  test("AC-209, AC-237: испорченный порядок молча отменяет явные правила — и тест это видит", () => {
    for (const tool of ["get_post", "get_thread"]) {
      const key = CorpConnectors.permissionKey(ALIAS, tool)
      expect(Permission.evaluate(key, "*", correct.ruleset).action).toBe("deny")
      // Wildcard, стоящий последним, побеждает по `findLast` и разрешает всё разом.
      expect(Permission.evaluate(key, "*", injected.ruleset).action).toBe("allow")
    }
    // И реализация записывает именно правильный порядок.
    expect(Object.keys(correct.permission)[0]).toBe(wildcard)
    expect(correct.patch.keys[0]).toBe(wildcard)
  })

  test("AC-238: с испорченным порядком запрещённая группа снова попадает в список модели", () => {
    const denied = save(EMPTY, ALIAS, groups, { read: "deny", rest: "ask" })
    const tools = ["get_post"].map((tool) => CorpConnectors.permissionKey(ALIAS, tool))
    expect(Permission.disabled(tools, denied.ruleset).has("tag-mcp_get_post")).toBe(true)

    const broken = Object.fromEntries([
      ...Object.entries(denied.permission).filter(([key]) => key !== wildcard),
      [wildcard, denied.permission[wildcard]!],
    ]) as ConfigPermissionV1.Info
    expect(Permission.disabled(tools, Permission.fromConfig(broken)).has("tag-mcp_get_post")).toBe(false)
  })
})
