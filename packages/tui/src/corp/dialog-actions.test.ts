import { describe, expect, test } from "bun:test"
import path from "path"
import * as CorpStatus from "../../../opencode/src/corp/status"

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

/** Объявления клавиш витрины (`packages/tui/src/config/keybind.ts`). */
const keybindSource = await Bun.file(path.resolve(import.meta.dirname, "../config/keybind.ts")).text()

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

/**
 * Паритет TUI по состояниям витрины (S-T10, S-V15, S-V16, S-V18; AC-185, AC-186).
 *
 * Набор действий обе оболочки получают из одного модуля `packages/opencode/src/corp/status.ts` и
 * сами его не вычисляют — расхождение оболочек невозможно по построению, а не по договорённости.
 * Поэтому здесь на вход подаются те же карточки, что в AC-170, AC-171, AC-173 и AC-177, и
 * проверяется, что предикат клавиш витрины даёт на них ровно те действия, что и Desktop.
 */
describe("tui/corp — паритет состояний и клавиш с Desktop (S-T10; AC-185, AC-186)", () => {
  const catalogServer = {
    alias: "gitlab",
    title: "GitLab",
    status: "ga",
    mode: "facade",
    mcp_url: "https://hub.test/mcp/gitlab",
  } as Parameters<typeof CorpStatus.compute>[0]["server"]

  /** Те же входы, что у AC-170, AC-171, AC-173 и AC-177 — считает их общий модуль. */
  const cards = {
    never: CorpStatus.compute({ alias: "gitlab", server: catalogServer, configured: false, stale: false }),
    failed: CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer,
      configured: true,
      local: "needs_auth",
      stale: false,
    }),
    lost: CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer,
      configured: true,
      local: "failed",
      localError: "connection refused",
      everConnectedLocally: true,
      stale: false,
    }),
    connected: CorpStatus.compute({
      alias: "gitlab",
      server: catalogServer,
      configured: true,
      local: "connected",
      stale: false,
    }),
  }

  test("AC-185: четыре состояния приходят из общего модуля и различаются набором действий", () => {
    expect(cards.never.state).toBe("never")
    expect(cards.failed.state).toBe("failed")
    expect(cards.lost.state).toBe("lost")
    expect(cards.connected.state).toBe("connected")
    expect(cards.never.actions).toEqual(["connect", "open_hub"])
    expect(cards.failed.actions).toEqual(["connect", "open_hub"])
    expect(cards.lost.actions).toEqual(["reconnect", "forget", "open_hub"])
    expect(cards.connected.actions).toEqual(["permissions", "disconnect", "open_hub"])
  })

  test("AC-186: клавиша d действует только в состоянии «Подключено»", () => {
    expect(allows(cards.never, "disconnect")).toBe(false)
    expect(allows(cards.failed, "disconnect")).toBe(false)
    expect(allows(cards.lost, "disconnect")).toBe(false)
    expect(allows(cards.connected, "disconnect")).toBe(true)
  })

  test("AC-186: клавиша x действует только в состоянии «Соединение потеряно»", () => {
    expect(allows(cards.never, "forget")).toBe(false)
    expect(allows(cards.failed, "forget")).toBe(false)
    expect(allows(cards.lost, "forget")).toBe(true)
    expect(allows(cards.connected, "forget")).toBe(false)
  })

  test("AC-185: enter доступен в состояниях 1–3 и недоступен у подключённого", () => {
    expect(allows(cards.never, "connect")).toBe(true)
    expect(allows(cards.failed, "connect")).toBe(true)
    expect(allows(cards.lost, "connect")).toBe(true)
    expect(allows(cards.connected, "connect")).toBe(false)
    // «Права» — только у подключённого (S-V16, состояние 4).
    expect(allows(cards.connected, "permissions")).toBe(true)
    expect(allows(cards.lost, "permissions")).toBe(false)
  })

  test("AC-186: нажатие d вне состояния «Подключено» ничего не меняет и объясняет почему", () => {
    const act = source.slice(source.indexOf("async function act("))
    const guard = act.slice(0, act.indexOf("setBusy("))
    // Подсказка показывается до выхода: молчаливое бездействие неотличимо от зависшего интерфейса.
    expect(guard).toContain('t("connectors.notConnectedHint")')
    expect(guard.indexOf('t("connectors.notConnectedHint")')).toBeLessThan(guard.indexOf("if (!allows(card, action)) return"))
    // И само действие не выполняется: до вызова SDK дело не доходит.
    expect(guard).toContain("if (!allows(card, action)) return")
  })

  test("AC-186: клавиши d и x объявлены и подчинены набору действий карточки", () => {
    const text = keybindSource
    expect(text).toContain('"dialog.corp.disconnect": keybind("d"')
    expect(text).toContain('"dialog.corp.forget": keybind("x"')

    const block = source.slice(source.indexOf("actions={["), source.indexOf("dialog.corp.refresh"))
    const forget = block.slice(block.indexOf("dialog.corp.forget"))
    expect(forget.slice(0, forget.indexOf("onTrigger"))).toContain('!allows(option?.value, "forget")')
  })

  test("AC-185: подпись enter — «Повторить» в состоянии 3 и «Подключить» в состояниях 1 и 2", () => {
    const block = source.slice(source.indexOf("actions={["), source.indexOf("dialog.corp.disconnect"))
    expect(block).toContain('includes("reconnect") ? t("connectors.retry") : t("connectors.connect")')
    // Различие подписи опирается на набор действий общего модуля, а не на собственное правило.
    expect(cards.lost.actions).toContain("reconnect")
    expect(cards.never.actions).not.toContain("reconnect")
    expect(cards.failed.actions).not.toContain("reconnect")
  })

  test("AC-185, S-V18: подключённая карточка помечена маркером, читаемым без цвета", () => {
    const marker = source.slice(source.indexOf("const MARKER"), source.indexOf("function Status("))
    expect(marker).toMatch(/connected:\s*"[^"\s]/)
    // Маркер — символ, а не цвет: в монохромном терминале признак обязан читаться.
    expect(source).toContain('card.state === "connected" ? MARKER.connected : MARKER.other')
    // Ширина маркера одинакова у всех карточек — список не разъезжается.
    const connected = marker.match(/connected:\s*"([^"]*)"/)![1]!
    const other = marker.match(/other:\s*"([^"]*)"/)![1]!
    expect(other.length).toBe(connected.length)
    expect(other.trim()).toBe("")
  })

  test("AC-185: подписи состояний берутся из словаря TUI по состоянию карточки", () => {
    const table = source.slice(source.indexOf("const STATE_KEY"), source.indexOf("const MARKER"))
    expect(table).toContain('failed: "connectors.neverConnected"')
    expect(table).toContain('lost: "connectors.lost"')
    expect(table).toContain('disconnected: "connectors.disconnected"')
  })
})
