import { describe, expect, test } from "bun:test"
import path from "path"

/**
 * Клавиши витрины TUI подчиняются набору действий карточки (S-T6, S-V6; AC-78, AC-116).
 *
 * Набор действий считает сервер (`CorpStatus.compute`), клиент их не пересчитывает: «Подключить» на
 * `deprecated`-карточке без записи в конфиге, «Права» на неподключённой карточке и любое действие на
 * протухшем каталоге должны быть недоступны. Экран не рендерится: предикат `allows` берётся из
 * исходника диалога и выполняется на матрице карточек из таблицы S-V6.
 */

const DIALOG = path.resolve(import.meta.dirname, "../component/corp/dialog-connectors.tsx")
const source = await Bun.file(DIALOG).text()

/** Тело `allows(card, action)` из диалога — исполняется как есть, без копии правила в тесте. */
function extractAllows() {
  const start = source.indexOf("function allows(")
  expect(start, "функция allows(card, action) не найдена в диалоге витрины").toBeGreaterThan(-1)
  const open = source.indexOf("{", start)
  let depth = 0
  let end = open
  for (let at = open; at < source.length; at++) {
    if (source[at] === "{") depth += 1
    if (source[at] === "}") {
      depth -= 1
      if (depth === 0) {
        end = at
        break
      }
    }
  }
  const body = source.slice(open + 1, end)
  return new Function("card", "action", body) as (card: unknown, action: string) => boolean
}

const allows = extractAllows()

const card = (actions: string[]) => ({ actions })

describe("tui/corp — действия витрины по card.actions (S-T6, S-V6)", () => {
  test("S-V6 строка 7: неподключённая карточка разрешает «Подключить» и «Открыть в Hub»", () => {
    const value = card(["connect", "open_hub"])
    expect(allows(value, "connect")).toBe(true)
    expect(allows(value, "open_hub")).toBe(true)
    expect(allows(value, "disconnect")).toBe(false)
    expect(allows(value, "permissions")).toBe(false)
  })

  test("S-V6 строка 5: подключённая карточка разрешает «Права» и «Отключить», но не «Подключить»", () => {
    const value = card(["permissions", "disconnect", "open_hub"])
    expect(allows(value, "permissions")).toBe(true)
    expect(allows(value, "disconnect")).toBe(true)
    expect(allows(value, "connect")).toBe(false)
  })

  test("S-V6 строка 3: «Переподключить» доступно той же клавишей, что и «Подключить»", () => {
    const value = card(["reconnect", "disconnect"])
    expect(allows(value, "connect")).toBe(true)
    expect(allows(value, "permissions")).toBe(false)
  })

  test("S-V6: deprecated-карточка без записи в конфиге не даёт подключиться", () => {
    const value = card(["open_hub"])
    expect(allows(value, "connect")).toBe(false)
    expect(allows(value, "disconnect")).toBe(false)
    expect(allows(value, "permissions")).toBe(false)
    expect(allows(value, "open_hub")).toBe(true)
  })

  test("S-V6 строка 2: на протухшем каталоге остаются только «Отключить» и «Открыть в Hub»", () => {
    const value = card(["disconnect", "open_hub"])
    expect(allows(value, "connect")).toBe(false)
    expect(allows(value, "permissions")).toBe(false)
    expect(allows(value, "disconnect")).toBe(true)
  })

  test("S-V6 строка 1: пустой список действий запрещает всё, отсутствие карточки — тоже", () => {
    expect(allows(card([]), "connect")).toBe(false)
    expect(allows(undefined, "disconnect")).toBe(false)
  })
})

describe("tui/corp — предикат применён ко всем клавишам витрины (S-T6)", () => {
  const block = source.slice(source.indexOf("actions={["), source.indexOf("dialog.corp.refresh"))

  for (const command of ["dialog.corp.connect", "dialog.corp.disconnect", "dialog.corp.permissions"]) {
    test(`AC-78: клавиша ${command} отключена, если действия нет в card.actions`, () => {
      const entry = block.slice(block.indexOf(command))
      const guard = entry.slice(0, entry.indexOf("onTrigger"))
      expect(guard, `${command} без фильтра по card.actions`).toContain("disabled: (option) => !allows(option?.value")
    })
  }

  test("AC-78: «Открыть в Hub» дополнительно требует ссылку hub_url (S-V10)", () => {
    const entry = source.slice(source.indexOf("dialog.corp.open_hub"))
    const guard = entry.slice(0, entry.indexOf("onTrigger"))
    expect(guard).toContain('!allows(option?.value, "open_hub")')
    expect(guard).toContain("!option?.value.hub_url")
  })

  test("AC-78: обработчики действий тоже проверяют card.actions, а не только card.blocked", () => {
    const act = source.slice(source.indexOf("async function act("))
    expect(act.slice(0, act.indexOf("setBusy("))).toContain("if (!allows(card, action)) return")
    const permissions = source.slice(source.indexOf("async function openPermissions("))
    expect(permissions.slice(0, permissions.indexOf("presetOptions"))).toContain(
      'if (!allows(card, "permissions")) return',
    )
  })
})

/**
 * Экран прав TUI по таблице S-V9 (AC-155, AC-156, AC-157).
 *
 * `presetOptions` берётся из исходника диалога и исполняется как есть, подписи — через подставленный
 * `t`. Пустой список опций — единственное, на чём держится строка 4 таблицы: экран прав не
 * открывается, а `PUT /api/me/connections/<alias>/permissions` не отправляется.
 */
describe("tui/corp — экран прав по видам модели прав (S-V9, AC-155, AC-156, AC-157)", () => {
  function extractPresetOptions() {
    const start = source.indexOf("export function presetOptions(")
    expect(start, "функция presetOptions(model) не найдена в диалоге витрины").toBeGreaterThan(-1)
    const open = source.lastIndexOf("{", source.indexOf("\n", start))
    let depth = 0
    for (let at = open; at < source.length; at++) {
      if (source[at] === "{") depth += 1
      else if (source[at] === "}") {
        depth -= 1
        if (depth === 0)
          return new Function("t", "model", source.slice(open + 1, at)) as (
            t: (key: string) => string,
            model: unknown,
          ) => { value: string; title: string; description?: string }[]
      }
    }
    throw new Error("presetOptions не закрыт")
  }

  const presetOptions = extractPresetOptions()
  const t = (key: string) => `t(${key})`

  test("AC-155, строка 1: header_groups — readonly/readwrite с раскрытым составом групп", () => {
    const options = presetOptions(t, {
      kind: "header_groups",
      groups: [
        { id: "read", title: "Чтение", preset: "readonly" },
        { id: "write", title: "Запись", preset: "readwrite" },
      ],
      always: ["gitlab_search"],
    })
    expect(options.map((option) => option.value)).toEqual(["readonly", "readwrite"])
    expect(options[0]!.title).toBe("t(preset.readonly)")
    expect(options[0]!.description).toContain("Чтение (readonly)")
    expect(options[0]!.description).toContain("gitlab_search")
  })

  test("AC-155, строка 2: tool_filter — имена пресетов Hub и их tools как есть", () => {
    const options = presetOptions(t, {
      kind: "tool_filter",
      presets: { readonly: { tools: ["whoami", "get_*"] }, readwrite: { tools: ["*"] } },
    })
    expect(options.map((option) => option.value)).toEqual(["readonly", "readwrite"])
    expect(options.map((option) => option.title)).toEqual(["readonly", "readwrite"])
    expect(options[0]!.description).toBe("whoami, get_*")
    expect(options[1]!.description).toBe("*")
  })

  test("AC-155, строка 3: consent — только имена пресетов, без состава прав", () => {
    const options = presetOptions(t, { kind: "consent", presets: { default: { note: "экран согласия" } } })
    expect(options).toEqual([{ value: "default", title: "default" }])
  })

  test("AC-156, AC-157, строка 4: непонятая модель прав не даёт ни одного пресета", () => {
    // Карточка с неизвестным `kind` доходит до экрана без модели: корп-роут отдаёт наружу только
    // разобранную модель, непонятый вид становится отсутствующим (S-V14 п.3, проверено в
    // `packages/opencode/src/corp/hub.test.ts` и `connectors.test.ts`).
    expect(presetOptions(t, undefined)).toEqual([])
  })

  test("AC-156: при пустом списке пресетов экран не открывается и PUT не отправляется", () => {
    const handler = source.slice(source.indexOf("async function openPermissions("))
    const guard = handler.slice(handler.indexOf("presetOptions"), handler.indexOf("const preset = await"))
    expect(guard).toContain("options.length === 0")
    expect(guard).toContain('t("connectors.permissionsUnavailable")')
    expect(guard).toContain("return")
    // Запрос прав идёт строго после выбора пресета из непустого списка.
    expect(handler.indexOf("sdk.client.corp.permissions")).toBeGreaterThan(handler.indexOf("const preset = await"))
  })
})
