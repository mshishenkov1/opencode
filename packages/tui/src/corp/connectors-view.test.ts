import { describe, expect, test } from "bun:test"
import path from "path"

/**
 * Витрина и страница коннектора в TUI (S-T10, S-V11, S-V12, S-V18, S-V22, S-D11;
 * AC-217…AC-224, AC-227, AC-228, AC-233).
 *
 * Ревизия 1.10 переносит в терминал **смысл**, а не раскладку Desktop: колонок, вкладок-«таблеток» и
 * стека диалогов здесь нет — вкладка переключается клавишей `f` и видна в заголовке, а страница
 * коннектора открывается `dialog.replace`. Проверяется то же наблюдаемое поведение, что у Desktop:
 * состав видимых строк по вкладке и поиску, шесть пустых состояний, признак подключения и
 * восстановление состояния при возврате.
 *
 * Экран не рендерится: правила берутся из исходника диалога и исполняются как есть — тот же приём,
 * что в `dialog-actions.test.ts`, механизм которого этот файл не трогает.
 *
 * Запуск: `bun --cwd packages/tui test src/corp/connectors-view.test.ts`.
 */

const DIALOG = path.resolve(import.meta.dirname, "../component/corp/dialog-connectors.tsx")
const source = await Bun.file(DIALOG).text()
const SELECT = path.resolve(import.meta.dirname, "../ui/dialog-select.tsx")
const selectSource = await Bun.file(SELECT).text()
const keybinds = await Bun.file(path.resolve(import.meta.dirname, "../config/keybind.ts")).text()

/** Тело функции диалога по её объявлению; `as const` и аннотация типа снимаются — это JS. */
function fn<T extends (...args: never[]) => unknown>(marker: string, ...args: string[]): T {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker} в витрине TUI`).toBeGreaterThan(-1)
  const open = source.indexOf("{", source.indexOf(")", at))
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth += 1
    else if (source[index] === "}") {
      depth -= 1
      if (depth === 0)
        return new Function(
          ...args,
          source
            .slice(open + 1, index)
            .replace(/\bas const\b/g, "")
            .replace(/\b(const|let)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, "$1 $2 =")
            // Утверждение «не null» — тоже TypeScript: снимается ровно оно, на поведение не влияет.
            .replace(/([\])\w])!(?=[\s;,)\].])/g, "$1"),
        ) as T
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

type Card = { alias: string; title: string; state: string; description?: string; owner?: string; type?: string }

const inTab = fn<(card: Card, tab: string) => boolean>("export function inTab(", "card", "tab")
const matches = fn<(card: Card, query: string) => boolean>("export function matches(", "card", "query")

/** Порядок вкладок читается из витрины, а не выписывается в тест: цикл клавиши `f` задаёт он. */
const TABS = new Function("return " + /export const TABS = (\[[^\]]*\])/.exec(source)![1]!)() as string[]
const nextTabOf = fn<(tabs: string[], tab: string) => string>("export function nextTab(", "TABS", "tab")
const nextTab = (tab: string) => nextTabOf(TABS, tab)

const catalog: Card[] = [
  { alias: "gitlab", title: "GitLab", state: "connected", owner: "AI Lab" },
  { alias: "tag", title: "ТЭГ", state: "connected", type: "Мессенджер" },
  { alias: "jira", title: "Jira", state: "failed", owner: "AI Lab" },
  { alias: "wiki", title: "Wiki", state: "never", owner: "Другая команда" },
  { alias: "old", title: "Old", state: "lost", owner: "AI Lab" },
]

describe("tui/corp — вкладки фильтра витрины (S-V11, S-T10; AC-217, AC-218)", () => {
  test("AC-218: «Подключённые» — состояние 4, «Неподключённые» — все прочие, «Все» — пять строк", () => {
    const visible = (tab: string) => catalog.filter((card) => inTab(card, tab)).map((card) => card.alias)
    expect(visible("connected")).toEqual(["gitlab", "tag"])
    expect(visible("not_connected")).toEqual(["jira", "wiki", "old"])
    expect(visible("all")).toEqual(catalog.map((card) => card.alias))
  })

  test("AC-218: клавиша f идёт циклом и возвращается к «Все»; умолчание — «Все»", () => {
    expect(nextTab("all")).toBe("connected")
    expect(nextTab("connected")).toBe("not_connected")
    expect(nextTab("not_connected")).toBe("all")
    expect(source).toContain('createSignal<ConnectorTab>(props.restore?.tab ?? "all")')
    // Клавиша объявлена и подписана той вкладкой, куда переключит нажатие.
    expect(keybinds).toContain('"dialog.corp.filter": keybind("f"')
    expect(source).toContain("title: t(TAB_KEY[nextTab(tab())])")
    // Выбор между запусками не сохраняется: ни чтения, ни записи состояния наружу нет.
    expect(source).not.toContain("localStorage")
    expect(source).not.toContain("kv.")
  })

  test("AC-217: список плоский — группировки по владельцу в исходнике витрины TUI нет", () => {
    expect(source).not.toContain("groupBy")
    expect(source).toContain("data.servers\n      .filter((card) => inTab(card, filter) && matches(card, needle))")
    // Отбор делает витрина, а не встроенный поиск списка: порядок обязан совпадать с каталогом.
    expect(source).toContain("skipFilter={true}")
  })

  test("AC-222: вкладки видны, только когда есть что фильтровать", () => {
    expect(source).toContain("const tabsVisible = createMemo(")
    const memo = source.slice(source.indexOf("const tabsVisible = createMemo("))
    const body = memo.slice(0, memo.indexOf("\n  })"))
    expect(body).toContain('data.hub_error === "unauthorized"')
    expect(body).toContain("data.servers.length > 0")
    // И клавиша `f` в этих состояниях спрятана — предлагать нечего.
    const action = source.slice(source.indexOf('command: "dialog.corp.filter"'))
    expect(action.slice(0, action.indexOf("},"))).toContain("hidden: !tabsVisible()")
  })
})

describe("tui/corp — поиск перемножается с вкладкой (S-V11, S-V22; AC-219)", () => {
  test("AC-219: строка видна, когда удовлетворяет и вкладке, и запросу", () => {
    const visible = (tab: string, query: string) =>
      catalog.filter((card) => inTab(card, tab) && matches(card, query)).map((card) => card.alias)
    expect(visible("connected", "ai lab")).toEqual(["gitlab"])
    expect(visible("all", "ai lab")).toEqual(["gitlab", "jira", "old"])
    expect(visible("not_connected", "ai lab")).toEqual(["jira", "old"])
  })

  test("AC-219: поиск — подстрока без учёта регистра по title, alias, description, owner и «Типу»", () => {
    expect(matches(catalog[1]!, "мессендж")).toBe(true)
    expect(matches(catalog[1]!, "ТЭГ")).toBe(true)
    expect(matches(catalog[1]!, "gitlab")).toBe(false)
    expect(matches(catalog[1]!, "  ")).toBe(true)
    expect(matches({ alias: "a", title: "A", state: "never", description: "Описание" }, "описан")).toBe(true)
  })

  test("AC-219: смена вкладки строку поиска не очищает, ввод в поиск вкладку не сбрасывает", () => {
    const filterAction = source.slice(source.indexOf('command: "dialog.corp.filter"'))
    expect(filterAction.slice(0, filterAction.indexOf("},"))).toContain("onTrigger: () => setTab(nextTab(tab()))")
    expect(filterAction.slice(0, filterAction.indexOf("},"))).not.toContain("setQuery")
    expect(source).toContain("onFilter={setQuery}")
  })
})

/**
 * Возврат со страницы коннектора (S-T10, S-D11; AC-227, AC-228).
 *
 * Стека диалогов в терминале нет: страница открывается `dialog.replace`, витрина пересоздаётся, и
 * состояние возвращается ей явно — вкладкой, запросом и alias выделенной строки. Строка поиска
 * восстанавливается в самом поле ввода: `DialogSelect` получил необязательный пропс `initialFilter`
 * (правка upstream в реестре `corp/patches.md`).
 */
describe("tui/corp — возврат со страницы коннектора (S-D11, S-T10; AC-227, AC-228)", () => {
  test("AC-227: enter на строке открывает страницу коннектора, а не подключает", () => {
    expect(source).toContain("onSelect={(option) => openConnector(option.value)}")
    // «Подключить» уехало с `return` на `c`: две команды на одной клавише разошлись бы поведением.
    expect(keybinds).toContain('"dialog.corp.connect": keybind("c"')
    expect(keybinds).not.toContain('"dialog.corp.connect": keybind("return"')
  })

  test("AC-228: возврат отдаёт витрине вкладку, запрос и alias выделенной строки", () => {
    const back = source.slice(source.indexOf("function backToList("))
    const body = back.slice(0, back.indexOf("\n  }"))
    expect(body).toContain("tab: tab()")
    expect(body).toContain("query: query()")
    expect(body).toContain("alias === undefined ? {} : { alias }")
    expect(body).toContain("dialog.replace(() => <DialogConnectors restore={restore} />)")
    // И витрина это состояние принимает — а не начинает с умолчаний.
    expect(source).toContain('createSignal<ConnectorTab>(props.restore?.tab ?? "all")')
    expect(source).toContain('createSignal(props.restore?.query ?? "")')
  })

  test("AC-228: прежний запрос возвращается в само поле ввода, а не только в фильтр", () => {
    expect(source).toContain("initialFilter={props.restore?.query}")
    // Пропс действительно ставит и внутреннее состояние поиска, и значение поля ввода.
    expect(selectSource).toContain('filter: props.initialFilter ?? ""')
    expect(selectSource).toContain("if (props.initialFilter) input.value = props.initialFilter")
    // Без пропса поведение диалога совпадает с upstream: прочие вызовы `DialogSelect` не затронуты.
    expect(selectSource).toContain("initialFilter?: string")
    expect(selectSource).not.toContain("value={props.initialFilter}")
  })

  test("AC-228: выделенная строка восстанавливается по alias, а не по ссылке на карточку", () => {
    const effect = source.slice(source.indexOf("let selectRef"), source.indexOf("const banner = createMemo("))
    expect(effect).toContain("option.value.alias === props.restore?.alias")
    expect(effect).toContain("selectRef?.moveTo(value)")
    // Восстановление однократно: повторные пересчёты списка курсор больше не двигают.
    expect(effect).toContain("if (restored) return")
    expect(effect).toContain("restored = true")
  })
})

describe("tui/corp — пустые состояния и признак подключения (S-V12, S-V18; AC-220, AC-221, AC-224)", () => {
  test("AC-220, AC-221: у вкладок свои тексты и своё предложение сбросить фильтр", () => {
    const memo = source.slice(source.indexOf("const empty = createMemo("))
    const body = memo.slice(0, memo.indexOf("\n  })"))
    expect(body).toContain("TAB_EMPTY_KEY[tab()]")
    expect(body).toContain('t("connectors.resetFilter")')
    // Вкладка «Все» своего пустого состояния не имеет: там причина — поиск.
    const table = source.slice(source.indexOf("const TAB_EMPTY_KEY"), source.indexOf("export function nextTab"))
    expect(table).toContain("all: undefined")
    expect(table).toContain('connected: "empty.tabConnected"')
    expect(table).toContain('not_connected: "empty.tabNotConnected"')
  })

  test("AC-222: прежние четыре состояния сохранены и различимы", () => {
    const memo = source.slice(source.indexOf("const empty = createMemo("))
    const body = memo.slice(0, memo.indexOf("\n  })"))
    for (const key of ["connectors.needsLogin", "empty.unparsed", "connectors.empty"]) expect(body, key).toContain(key)
    // Состояние 3 ревизией 1.11 стало называть недоступный **источник** каталога (S-V12 п.3), но
    // само состояние никуда не делось и по-прежнему отличается от остальных.
    expect(body).toContain("sourceDown()")
    const helper = source.slice(source.indexOf("function sourceDown("))
    const text = helper.slice(0, helper.indexOf("\n  }"))
    expect(text).toContain("connectors.hubDown")
    expect(text).toContain("connectors.catalogUnavailable")
  })

  test("AC-224: роль маркера TUI ревизией 1.10 не изменена — признак остаётся текстовым", () => {
    const marker = source.slice(source.indexOf("const MARKER"), source.indexOf("function Status("))
    expect(marker).toMatch(/connected:\s*"[^"\s]/)
    expect(source).toContain('card.state === "connected" ? MARKER.connected : MARKER.other')
    // Колонок в терминале нет, и точки-дубликата тоже: признак читается символом.
    expect(source).not.toContain("corp-status-dot")
    expect(source).not.toContain("columnStatus")
  })

  test("AC-215, AC-216: «Тип» показывается подписью строки и берётся из общего модуля", () => {
    expect(source).toContain('import { connectorType, corpUserLabel } from "@opencode-ai/core/corp/constants"')
    expect(source).toContain("const type = connectorType(card)")
    // Отсутствующий «Тип» строки не рисует — подписи просто нет.
    expect(source).toContain("...(type === undefined ? {} : { description: type })")
  })
})
