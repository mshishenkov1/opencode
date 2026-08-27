import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Витрина коннекторов Desktop: размер корп-окна и признак «Подключено»
 * (S-D10, S-V16, S-V17, S-V18, S-V19, S-Q9; AC-172, AC-177, AC-184).
 *
 * Разметку и стили проверяем двумя способами:
 *   - **каскад CSS** — настоящие файлы стилей (`packages/ui` + `dialog-shell.css`) грузятся в
 *     документ happy-dom, и вычисленные свойства читаются с тех же элементов, что строит `Dialog`.
 *     Так ловится и опечатка в селекторе, и потерянное правило. Раскладка (layout) в среде тестов
 *     не считается, поэтому проверяется наблюдаемый инвариант S-D10: **высота панели приходит от
 *     контейнера, а не от содержимого**, и объявление высоты контейнера у корп-окна и у окна
 *     настроек — одно и то же;
 *   - **исходник экрана** — то, чего в стилях не видно: какие элементы карточка показывает и при
 *     каком состоянии (S-V16, S-V18), и что `fit` окну не передаётся ни в одной ветке флага.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/connectors-view.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "..")
const ROOT = path.resolve(APP, "../../..")

const read = (file: string) => fs.readFileSync(file, "utf8")

const CSS = {
  dialog: read(path.join(ROOT, "packages/ui/src/components/dialog.css")),
  dialogV2: read(path.join(ROOT, "packages/ui/src/v2/components/dialog-v2.css")),
  corp: read(path.join(APP, "components/corp/dialog-shell.css")),
}

const SOURCE = {
  shell: read(path.join(APP, "components/corp/dialog-shell.tsx")),
  connectors: read(path.join(APP, "components/corp/dialog-connectors.tsx")),
  /** Страница коннектора (S-D11): туда ревизия 1.10 увела описание, кнопки и «Убрать из списка». */
  connector: read(path.join(APP, "components/corp/dialog-connector.tsx")),
}

/** Корп-компоненты целиком — по ним идут проверки контраста и запрета кириллицы (S-D12, S-I5). */
const CORP_COMPONENTS = fs
  .readdirSync(path.join(APP, "components/corp"))
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => ({ file, text: read(path.join(APP, "components/corp", file)) }))

/**
 * Тело функции витрины по её объявлению — исполняется без рендера компонента (тот же приём, что в
 * `packages/tui/src/corp/dialog-actions.test.ts`): копии правила в тесте нет.
 */
function viewFunction<T extends (...args: never[]) => unknown>(marker: string, ...args: string[]): T {
  const source = SOURCE.connectors
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker} в витрине`).toBeGreaterThan(-1)
  const open = source.indexOf("{", source.indexOf(")", at))
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth += 1
    else if (source[index] === "}") {
      depth -= 1
      if (depth === 0) return new Function(...args, source.slice(open + 1, index).replace(/\bas const\b/g, "")) as T
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

/**
 * Объявленная высота контейнера окна размера `x-large` — то, что задаёт высоту окна целиком.
 * Читается из настоящего файла стилей: happy-dom вложенные `&[data-size=…]`-селекторы не
 * раскрывает, поэтому объявление сверяется по тексту правила, а растяжение панели — каскадом.
 */
function containerSize(css: string) {
  const at = css.indexOf('&[data-size="x-large"] [data-slot="dialog-container"]')
  expect(at, "правило размера x-large не найдено").toBeGreaterThan(-1)
  const block = css.slice(at, css.indexOf("}", at))
  return {
    width: /width:\s*([^;]+);/.exec(block)![1]!.trim(),
    height: /height:\s*([^;]+);/.exec(block)![1]!.trim(),
  }
}

/** Ветки флага «New layout and designs»: прежний `Dialog` и `DialogV2` формата settings-v2. */
const BRANCHES = {
  legacy: { component: "dialog", corpClass: "corp-dialog" },
  v2: { component: "dialog-v2", corpClass: "corp-dialog-v2" },
} as const

interface Content {
  /** Сколько карточек в списке. */
  cards: number
  /** Баннер «Hub недоступен», предупреждение об отброшенных карточках, пустое состояние. */
  banner?: boolean
  partial?: boolean
  empty?: boolean
  /** Корп-окно или окно настроек той же ветки. */
  corp?: boolean
  /** Передан ли окну `fit` — контрольный случай: он снимает высоту контейнера. */
  fit?: boolean
}

/**
 * Строит ту же разметку, что и `Dialog`/`DialogV2` вокруг содержимого витрины, и возвращает
 * контейнер окна и его видимую панель.
 */
function render(branch: keyof typeof BRANCHES, content: Content) {
  const { component, corpClass } = BRANCHES[branch]
  document.head.innerHTML = `<style>${CSS.dialog}</style><style>${CSS.dialogV2}</style><style>${CSS.corp}</style>`
  const cards = Array.from({ length: content.cards }, (_, at) => `<div data-slot="list-item">коннектор ${at}</div>`)
  document.body.innerHTML = `
    <div data-component="${component}" data-size="x-large"${content.fit ? " data-fit" : ""}>
      <div data-slot="dialog-container">
        <div data-slot="dialog-content"${content.corp === false ? "" : ` class="${corpClass}"`}>
          <div data-slot="dialog-body">
            ${content.banner ? '<div data-slot="corp-banner">Hub недоступен</div>' : ""}
            ${content.partial ? '<div data-slot="corp-partial">часть карточек отброшена</div>' : ""}
            ${content.empty ? '<div data-slot="corp-empty">Каталог пуст</div>' : ""}
            <div data-slot="list">${cards.join("")}</div>
          </div>
        </div>
      </div>
    </div>`
  const container = document.querySelector('[data-slot="dialog-container"]') as HTMLElement
  const panel = document.querySelector('[data-slot="dialog-content"]') as HTMLElement
  return {
    container,
    panel,
    containerStyle: getComputedStyle(container),
    panelStyle: getComputedStyle(panel),
  }
}

describe("корп-окно витрины — размер не зависит от содержимого (S-D10; AC-184)", () => {
  for (const branch of ["legacy", "v2"] as const) {
    test(`AC-184: ${branch} — ноль, одна и полсотни карточек дают одну и ту же высоту окна`, () => {
      const panels = new Set<string>()
      for (const cards of [0, 1, 50]) {
        const view = render(branch, { cards })
        panels.add(`${view.panelStyle.height}|${view.panelStyle.minHeight}|${view.panelStyle.overflow}`)
      }
      expect(panels.size, [...panels].join(" / ")).toBe(1)
      // Высота панели приходит от контейнера: содержимое её не растит и не сжимает.
      const [panel] = [...panels]
      expect(panel).toBe("100%|0|hidden")
    })

    test(`AC-184: ${branch} — баннер, предупреждение и пустое состояние высоту не меняют`, () => {
      const base = render(branch, { cards: 12 })
      const panel = `${base.panelStyle.height}|${base.panelStyle.minHeight}|${base.panelStyle.overflow}`

      for (const extra of [{ banner: true }, { partial: true }, { empty: true }, { banner: true, partial: true }]) {
        const view = render(branch, { cards: extra.empty ? 0 : 12, ...extra })
        expect(
          `${view.panelStyle.height}|${view.panelStyle.minHeight}|${view.panelStyle.overflow}`,
          JSON.stringify(extra),
        ).toBe(panel)
      }
    })

    test(`AC-184: ${branch} — окно витрины и окно настроек одной ветки объявлены одним размером`, () => {
      // Высоту окна задаёт контейнер размера `x-large`; и корп-окно, и окно настроек просят
      // именно его, поэтому объявленная высота у них общая по построению.
      const size = containerSize(branch === "legacy" ? CSS.dialog : CSS.dialogV2)
      expect(size.height).toBe(branch === "legacy" ? "min(calc(100vh - 32px), 600px)" : "560px")
      expect(SOURCE.shell).toContain('size="x-large"')

      const settings = read(
        path.join(APP, "components", branch === "legacy" ? "dialog-settings.tsx" : "settings-v2/dialog-settings-v2.tsx"),
      )
      expect(settings, branch).toContain('size="x-large"')
    })

    test(`AC-184: ${branch} — список прокручивается внутри окна, само окно не прокручивается`, () => {
      const view = render(branch, { cards: 50 })
      expect(view.panelStyle.overflow).toBe("hidden")
    })
  }

  test("AC-184: высоты веток различны — сравниваются окна одной ветки, а не одна константа", () => {
    expect(containerSize(CSS.dialog).height).not.toBe(containerSize(CSS.dialogV2).height)
  })

  test("AC-184: `fit` корп-окну не передаётся ни в одной ветке флага", () => {
    // `fit` снимает высоту контейнера (`[data-fit] [data-slot="dialog-container"] { height: auto }`)
    // и вернул бы ровно тот дефект, который S-D10 исправляет.
    expect(CSS.dialog).toMatch(/&\[data-fit\]/)
    const shell = SOURCE.shell
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n")
    expect(shell).not.toMatch(/(^|\s)fit(\s|=|\}|$)/m)
    expect(shell).toContain('size="x-large"')
    expect(shell).toContain('class="corp-dialog"')
    expect(shell).toContain('class="corp-dialog-v2"')
  })

  test("S-D10: правило относится ко всем корп-окнам, а не только к витрине", () => {
    // Размер задаёт контейнер `CorpDialog`, а не отдельный экран: витрина, вход и права его
    // получают, ничего про размеры не зная (D-33).
    const text = read(path.join(APP, "components/corp", "dialog-connectors.tsx"))
    expect(text).toContain("CorpDialog")
    // Экран витрины про размеры не знает: ни размера, ни `fit` он контейнеру не задаёт.
    expect(text).not.toMatch(/<CorpDialog[^>]*size=/)
    expect(text).not.toMatch(/<CorpDialog[^>]*\bfit\b/)
  })

  test("S-D10: общие стили packages/ui ради витрины не правятся", () => {
    // Растяжение панели живёт в корп-файле стилей и адресовано корп-классу.
    expect(CSS.corp).toContain(".corp-dialog")
    expect(CSS.corp).toContain(".corp-dialog-v2")
    expect(CSS.dialog).not.toContain("corp-dialog")
    expect(CSS.dialogV2).not.toContain("corp-dialog")
  })
})

/**
 * Признак «Подключено» и объяснение ошибки после переезда (S-V18, S-V19, S-D11, S-D12;
 * AC-172, AC-177, AC-223, AC-224, AC-229, AC-231).
 *
 * Ревизия 1.10 переселила признак из бейджа в колонку «Статус», а действия и объяснение ошибки — на
 * страницу коннектора. Смысл прежних проверок сохранён и усилен: признак по-прежнему **положителен**
 * (показывается по состоянию 4, а не по отсутствию кнопки), подпись состояния по-прежнему берётся из
 * состояния и класса ошибки, а требование «мелкой подписи для признака недостаточно» превратилось из
 * «класс присутствует» в «этой пары классов нет ни разу» (S-D12).
 */
describe("витрина и страница — признак «Подключено» и объяснение ошибки (AC-177, AC-172, AC-223, AC-224)", () => {
  const source = SOURCE.connectors
  const page = SOURCE.connector

  test("AC-223, AC-177: колонка «Статус» несёт текст состояния и цветовую точку, а не только цвет", () => {
    const cell = source.slice(source.indexOf('data-slot="corp-status-cell"'), source.indexOf("</List>"))
    // Текст в ячейке есть всегда — точка его дублирует, а не заменяет.
    expect(cell).toContain("language.t(statusKey(card))")
    expect(cell).toContain('data-slot="corp-status-dot"')
    expect(cell).toContain("data-tone={statusTone(card)}")
    // Точка не читается вспомогательными технологиями: она дубликат, а не источник смысла.
    expect(cell).toContain('aria-hidden="true"')
    // Признак положительный: колонка заполняется по состоянию карточки, а не по отсутствию кнопки.
    expect(source).toContain('if (card.state === "connected") return "success"')
    expect(cell).not.toContain("!card")
  })

  test("AC-223: цвет точки — семантический токен темы, а не произвольный цвет", () => {
    for (const [tone, token] of [
      ["success", "--v2-state-fg-success"],
      ["warning", "--v2-state-fg-warning"],
      ["danger", "--v2-state-fg-danger"],
    ] as const) {
      const rule = CSS.corp.slice(CSS.corp.indexOf(`[data-slot="corp-status-dot"][data-tone="${tone}"]`))
      expect(rule.slice(0, rule.indexOf("}")), tone).toContain(`var(${token})`)
    }
    // «Не подключён» — цвет второстепенного текста, а не отдельный «серый» из воздуха.
    const weak = CSS.corp.slice(CSS.corp.indexOf('[data-slot="corp-status-dot"][data-tone="weak"]'))
    expect(weak.slice(0, weak.indexOf("}"))).toContain("var(--text-weak)")
  })

  test("AC-223: текст ячейки контрастен — «Подключено» сильнее прочих, text-text-weaker нет", () => {
    const cell = source.slice(source.indexOf('data-slot="corp-status-cell"'), source.indexOf("</List>"))
    expect(cell).toContain('"text-12-regular text-text-strong truncate"')
    expect(cell).toContain('"text-12-regular text-text-weak truncate"')
    expect(cell).not.toContain("text-text-weaker")
  })

  test("AC-224: бейдж остаётся признаком там, где колонки нет — на странице коннектора", () => {
    const status = page.slice(page.indexOf('entry().state === "connected"'))
    const badge = status.slice(0, status.indexOf("</Show>"))
    expect(badge).toContain("<Tag")
    expect(badge).toContain('language.t("corp.connectors.connected")')
    // Бейдж «устаревший» рисуется тем же средством — `Tag` без собственного размера.
    expect(page).toContain('<Tag>{language.t("corp.connectors.deprecated")}</Tag>')
    // На витрине бейджа «Подключено» больше нет; бейдж «устаревший» там остался (S-V18).
    expect(source).not.toContain('corp.connectors.connected")}</Tag>')
    expect(source).toContain('<Tag>{language.t("corp.connectors.deprecated")}</Tag>')
  })

  test("AC-177: у подключённого коннектора нет кнопки «Подключить» — набор действий её не даёт", () => {
    // Кнопки показываются строго по набору действий, а состояние 4 «connect» не содержит (S-V16).
    expect(page).toContain(
      '<Show when={entry().actions.includes("connect") || entry().actions.includes("reconnect")}>',
    )
    expect(page).toContain('<Show when={entry().actions.includes("disconnect")}>')
    expect(page).toContain('<Show when={entry().actions.includes("forget")}>')
    expect(page).toContain('<Show when={entry().actions.includes("permissions")}>')
    // Витрина действий не дублирует: кнопок на строке нет (S-D11).
    expect(source).not.toContain('language.t("corp.connectors.connect")')
    expect(source).not.toContain('language.t("corp.connectors.disconnect")')
  })

  test("AC-172: слово «Отключить» появляется только по действию disconnect", () => {
    expect(page.split('language.t("corp.connectors.disconnect")').length - 1).toBe(1)
    const before = page.slice(0, page.indexOf('language.t("corp.connectors.disconnect")'))
    // Ближайший охраняющий `Show` — именно про действие disconnect.
    expect(before.slice(before.lastIndexOf("<Show"))).toContain('entry().actions.includes("disconnect")')
  })

  test("AC-172, AC-229, S-V19: подпись состояния и объяснение ошибки берутся из состояния и класса", () => {
    const table = source.slice(
      source.indexOf("const STATE_KEY"),
      source.indexOf("} as const", source.indexOf("const STATE_KEY")),
    )
    expect(table).toContain('failed: "corp.connectors.neverConnected"')
    expect(table).toContain('lost: "corp.connectors.lost"')
    expect(table).toContain('disconnected: "corp.connectors.disconnected"')

    // Объяснение ошибки переехало в блок статуса страницы; правило S-V19 не изменилось.
    const explain = page.slice(page.indexOf("function explain("))
    expect(explain.slice(0, explain.indexOf("\n  }"))).toContain("connectErrorKey(entry.error_class)")
    // Предлагаемое действие показывается тем же элементом, которым выполняется: отдельной
    // «кнопки-совета» нет ни на витрине, ни на странице.
    expect(source).not.toContain("corp.connectors.advice")
    expect(page).not.toContain("corp.connectors.advice")
  })

  test("S-V17: «Убрать из списка» спрашивает подтверждение, отмена ничего не меняет", () => {
    const confirm = page.slice(page.indexOf("export const DialogForgetConnector"))
    const body = confirm.slice(0, confirm.indexOf("const ConnectorPermissionGroups"))
    expect(body).toContain('language.t("corp.connectors.forgetConfirm"')
    expect(body).toContain('language.t("common.cancel")')
    expect(body).toContain('action.mutate({ kind: "forget"')
    // Отмена закрывает окно и не вызывает мутацию.
    const cancel = body.slice(body.indexOf('variant="ghost"'), body.indexOf('variant="primary"'))
    expect(cancel).toContain("dialog.close()")
    expect(cancel).not.toContain("action.mutate")
  })
})

/**
 * Плоская таблица, вкладки и поиск (S-V11, S-V22, S-D6, S-Q9; AC-217, AC-218, AC-219, AC-225, AC-226).
 */
describe("витрина — плоская таблица, вкладки и поиск (AC-217, AC-218, AC-219)", () => {
  const source = SOURCE.connectors
  type Card = { alias: string; title: string; state: string; description?: string; owner?: string; type?: string }
  const matchesTab = viewFunction<(card: Card, tab: string) => boolean>(
    "export function matchesTab(",
    "card",
    "tab",
  )
  const matchesQuery = viewFunction<(card: Card, query: string) => boolean>(
    "export function matchesQuery(",
    "card",
    "query",
  )

  const catalog: Card[] = [
    { alias: "gitlab", title: "GitLab", state: "connected", owner: "AI Lab" },
    { alias: "tag", title: "ТЭГ", state: "connected", type: "Мессенджер" },
    { alias: "jira", title: "Jira", state: "failed", owner: "AI Lab" },
    { alias: "wiki", title: "Wiki", state: "never", owner: "Другая команда" },
    { alias: "old", title: "Old", state: "lost", owner: "AI Lab" },
  ]

  test("AC-217: список плоский — заголовков групп владельцев в исходнике витрины нет", () => {
    expect(source).not.toContain("groupBy")
    expect(source).not.toContain("owner]")
    // Строки идут порядком каталога: витрина только фильтрует, но не переупорядочивает.
    expect(source).toContain("cards().filter((card) => matchesTab(card, tab()) && matchesQuery(card, query()))")
    // Встроенный нечёткий поиск списка отключён — он ранжировал бы результаты по релевантности.
    expect(source).toContain("skipFilter={() => true}")
  })

  // AC-218 переформулирован ревизией 1.12 к двум вкладкам (см. блок ревизии 1.12 в начале
  // acceptance-criteria.yaml: «сценарий вкладок приведён к двум, прежние проверки умолчания и
  // неперсистентности сохранены дословно, добавлена проверка отсутствия третьей вкладки»). Тело
  // самого критерия AC-218 приведено к той же редакции резолюцией DISPUTE-I12-04-01 (98cc2658e3,
  // corp/disputes/dispute-I12-04-ac218-body-not-updated.resolution.json) — расхождение с телом
  // критерия закрыто, тест ниже проверяет действующую редакцию AC-218 напрямую.
  test("AC-218: «Подключённые» — две строки, «Все» — пять, третьей вкладки не существует", () => {
    const visible = (tab: string) => catalog.filter((card) => matchesTab(card, tab)).map((card) => card.alias)
    expect(visible("connected")).toEqual(["gitlab", "tag"])
    expect(visible("all")).toEqual(["gitlab", "tag", "jira", "wiki", "old"])
    // Порядок строк — порядок каталога при любой вкладке.
    expect(visible("all")).toEqual(catalog.map((card) => card.alias))
    // AC-221, S-Q9 п.(е): набор вкладок берётся из самого перечислимого типа (полная правая часть
    // объявления, а не подстрока в ней) — дописанный третий член меняет разбор и валит тест, а не
    // проходит незамеченным мимо `toContain` на префиксе прежнего объявления (F-5).
    const declaration = /export type ConnectorsTab = ([^\n]+)\n/.exec(source)
    expect(declaration, "объявление ConnectorsTab не найдено").not.toBeNull()
    const tabValues = declaration![1]!.split("|").map((part) => part.trim().replace(/^"|"$/g, ""))
    expect(tabValues).toEqual(["all", "connected"])
  })

  test("AC-218: умолчание — «Все», и выбор вкладки между запусками не сохраняется", () => {
    expect(source).toContain('createSignal<ConnectorsTab>("all")')
    // Ни записи, ни чтения сохранённого выбора: состояние живёт только в компоненте.
    expect(source).not.toContain("localStorage")
    expect(source).not.toContain("persist")
  })

  test("AC-219: поиск и вкладка перемножаются — видно то, что удовлетворяет обоим условиям", () => {
    const visible = (tab: string, query: string) =>
      catalog.filter((card) => matchesTab(card, tab) && matchesQuery(card, query)).map((card) => card.alias)
    expect(visible("connected", "ai lab")).toEqual(["gitlab"])
    expect(visible("all", "ai lab")).toEqual(["gitlab", "jira", "old"])
    // Поиск — подстрока без учёта регистра по title, alias, description, owner и «Типу» (S-V22).
    expect(matchesQuery(catalog[1]!, "мессендж")).toBe(true)
    expect(matchesQuery(catalog[1]!, "ТЭГ")).toBe(true)
    expect(matchesQuery(catalog[1]!, "gitlab")).toBe(false)
    expect(matchesQuery(catalog[1]!, "   ")).toBe(true)
  })

  test("AC-219: смена вкладки строку поиска не очищает, ввод в поиск вкладку не сбрасывает", () => {
    // Оба состояния независимы: обработчик вкладки трогает только `setTab`, обработчик поиска — `setQuery`.
    const tabs = source.slice(source.indexOf("<TabsV2"), source.indexOf("</TabsV2>"))
    expect(tabs).toContain("onChange={(value: string) => setTab(value as ConnectorsTab)}")
    expect(tabs).not.toContain("setQuery")
    const list = source.slice(source.indexOf("<List"), source.indexOf(">", source.indexOf("onFilter=")))
    expect(list).toContain("onFilter={setQuery}")
    expect(list).not.toContain("setTab")
    // «Показать все» переводит вкладку в «Все» и строку поиска не трогает (S-V12).
    const reset = source.slice(source.indexOf('state().action === "resetFilter"'))
    const button = reset.slice(0, reset.indexOf("</Show>"))
    expect(button).toContain('onClick={() => setTab("all")}')
    expect(button).not.toContain("setQuery")
  })

  test("AC-222: при «Hub недоступен» и «Требуется вход» вкладки не показываются", () => {
    expect(source).toContain(
      "() => cards().length === 0 && !catalog.isLoading && (!catalog.data || !!catalog.data.hub_error),",
    )
    expect(source).toContain("const showTable = createMemo(() => !hubEmpty())")
    // Вкладки и шапка таблицы охраняются одним и тем же признаком.
    expect(source.split("<Show when={showTable()}>").length - 1).toBe(2)
  })
})

/**
 * Композиция витрины: окно, вкладки, неподвижная шапка и одна сетка на шапку и строки
 * (S-D6, S-Q9; AC-225, AC-226).
 */
describe("витрина — композиция и неподвижная шапка (AC-225, AC-226)", () => {
  const source = SOURCE.connectors

  test("AC-225: окно — CorpDialog, фильтр — TabsV2 variant=pill с двумя вкладками, шапка на месте", () => {
    expect(source).toContain("<CorpDialog")
    expect(source).toContain('<TabsV2\n            variant="pill"')
    // AC-225 (ревизия 1.12): «ДВУМЯ вкладками» — литерально в теле критерия, третьей не существует.
    for (const value of ["all", "connected"]) expect(source, value).toContain(`<TabsV2.Trigger value="${value}">`)
    expect(source, "not_connected").not.toContain('<TabsV2.Trigger value="not_connected">')
    // Вкладки — единственный орган фильтрации: ни чекбоксов, ни выпадающих списков витрина не заводит.
    expect(source).not.toContain("<Checkbox")
    expect(source).not.toContain("<SelectV2")
    for (const key of ["columnName", "columnType", "columnStatus"])
      expect(source, key).toContain(`language.t("corp.connectors.${key}")`)
    // Список — существующий `List`, а не собственная реализация.
    expect(source).toContain("<List")
  })

  test("AC-225: ширины колонок объявлены одним grid-template-columns и общие у шапки и строк", () => {
    const rule = CSS.corp.slice(CSS.corp.indexOf('[data-slot="corp-connectors-header"],'))
    const block = rule.slice(0, rule.indexOf("}"))
    expect(block).toContain('[data-slot="corp-connectors-row"]')
    expect(block).toMatch(/grid-template-columns:/)
    // Второго объявления сетки в корп-CSS нет — расхождение сеток было бы дефектом.
    expect(CSS.corp.split("grid-template-columns:").length - 1).toBe(1)

    document.head.innerHTML = `<style>${CSS.corp}</style>`
    document.body.innerHTML = `<div class="corp-connectors">
      <div data-slot="corp-connectors-header"></div><div data-slot="corp-connectors-row"></div></div>`
    const header = getComputedStyle(document.querySelector('[data-slot="corp-connectors-header"]')!)
    const row = getComputedStyle(document.querySelector('[data-slot="corp-connectors-row"]')!)
    expect(header.gridTemplateColumns).toBe(row.gridTemplateColumns)
    expect(header.gridTemplateColumns.trim()).not.toBe("")
  })

  test("AC-226: шапка, вкладки, баннер и предупреждение не входят в область прокрутки списка", () => {
    // Все они — соседи `List`, а не его потомки: «остаются на месте» по построению, а не по z-index.
    const body = source.slice(source.indexOf('<div class="corp-connectors"'), source.indexOf("</CorpDialog>"))
    const list = body.indexOf("<List")
    for (const slot of ["corp-connectors-banner", "corp-connectors-partial", "corp-connectors-header"])
      expect(body.indexOf(slot), slot).toBeLessThan(list)
    expect(body.indexOf("corp-connectors-empty")).toBeGreaterThan(body.indexOf("</List>"))

    document.head.innerHTML = `<style>${CSS.corp}</style>`
    document.body.innerHTML = `<div class="corp-connectors"><div data-slot="corp-connectors-header"></div></div>`
    const header = getComputedStyle(document.querySelector('[data-slot="corp-connectors-header"]')!)
    expect(header.position).toBe("sticky")
    expect(header.top).toMatch(/^0(px)?$/)
    // Прокручивается только область строк списка.
    const scroll = CSS.corp.slice(CSS.corp.indexOf('.corp-connectors [data-slot="list-scroll"]'))
    expect(scroll.slice(0, scroll.indexOf("}"))).toContain("flex: 1 1 auto")
  })
})

/**
 * Стек диалогов и страница коннектора (S-D11, S-D10, S-V19, S-V17; AC-227, AC-228, AC-229, AC-230).
 */
describe("страница коннектора — стек диалогов и состав (AC-227, AC-228, AC-229, AC-230)", () => {
  const source = SOURCE.connectors
  const page = SOURCE.connector

  test("AC-227: строка открывает страницу через push, а не show — витрина остаётся в стеке", () => {
    const open = source.slice(source.indexOf("async function openConnector("))
    const body = open.slice(0, open.indexOf("\n  }"))
    expect(body).toContain("dialog.push(() => <module.DialogConnector alias={alias} />)")
    expect(body).not.toContain("dialog.show")
    expect(body).not.toContain("dialog.replace")
    // Основное действие строки — щелчок или Enter на выделенной строке: это `onSelect` списка.
    const select = source.slice(source.indexOf("onSelect={(card) => {"))
    expect(select.slice(0, select.indexOf("}}"))).toContain("void openConnector(card.alias)")
    // `show` в витрине остаётся только у экрана входа — он витрину действительно заменяет.
    expect(source.split("dialog.show(").length - 1).toBe(1)
    expect(source.slice(source.indexOf("async function openLogin("))).toContain("dialog.show(")
  })

  test("AC-227: возврат закрывает верхний диалог — Esc и кнопка «Назад» делают одно и то же", () => {
    // Кнопка «Назад» — в шапке самой страницы, а не в подтверждении «Убрать из списка».
    const screen = page.slice(page.indexOf("export const DialogConnector: Component"))
    const back = screen.slice(screen.indexOf("action={"), screen.indexOf("</Button>", screen.indexOf("action={")))
    expect(back).toContain("onClick={() => dialog.close()}")
    expect(back).toContain('language.t("corp.connector.back")')
    // Страница не пересоздаёт витрину: она просто закрывается, и живой компонент под ней всплывает.
    expect(page).not.toContain("<DialogConnectors")
  })

  test("AC-228: вкладка, строка поиска и позиция прокрутки живут в витрине и переживают возврат", () => {
    // Состояние принадлежит компоненту витрины, а страница монтируется поверх (`push`), а не вместо.
    expect(source).toContain('const [tab, setTab] = createSignal<ConnectorsTab>("all")')
    expect(source).toContain('const [query, setQuery] = createSignal("")')
    // Ни одного сброса состояния при открытии или закрытии страницы витрина не делает.
    const open = source.slice(source.indexOf("async function openConnector("))
    const body = open.slice(0, open.indexOf("\n  }"))
    expect(body).not.toContain("setTab(")
    expect(body).not.toContain("setQuery(")
    // Прокрутка принадлежит `List`, и он тоже не пересоздаётся: страница — отдельный диалог.
    expect(source).not.toContain("dialog.replace")
  })

  test("AC-229: состав страницы — описание, свойства, статус, «Разрешения» и «Убрать из списка»", () => {
    const order = [
      "entry().description",
      'language.t("corp.connector.type")',
      'language.t("corp.connector.owner")',
      'language.t("corp.connector.docs")',
      "language.t(statusKey(entry()))",
      "explain(entry())",
      'language.t("corp.permissions.title")',
      'language.t("corp.connectors.forget")',
    ]
    let previous = -1
    for (const marker of order) {
      const at = page.indexOf(marker, previous + 1)
      expect(at, marker).toBeGreaterThan(previous)
      previous = at
    }
    // Описание — то, чего нет на витрине (S-D6): в строке таблицы его не рисуют, хотя поиск по нему
    // остался (S-V11).
    const row = source.slice(source.indexOf('data-slot="corp-connectors-row"'), source.indexOf("</List>"))
    expect(row).not.toContain("card.description")
    expect(source.slice(source.indexOf("export function matchesQuery("))).toContain("card.description")
  })

  test("AC-229: отсутствующее свойство строки не рисует и пустой строки не оставляет", () => {
    for (const field of ["connectorType(entry())", "entry().owner", "entry().docs_url"]) {
      const at = page.indexOf(`<Show when={${field}}>`)
      expect(at, field).toBeGreaterThan(-1)
    }
    // Значение приходит внутрь `Show` аргументом, то есть строка рисуется только при его наличии.
    expect(page).not.toContain('{entry().owner ?? ""}')
    expect(page).not.toContain('{entry().docs_url ?? ""}')
  })

  test("AC-230: высота страницы не зависит от содержимого — прокручивается содержимое, не окно", () => {
    const rule = CSS.corp.slice(CSS.corp.indexOf(".corp-connector {"))
    const block = rule.slice(0, rule.indexOf("}"))
    expect(block).toContain("overflow-y: auto")
    expect(block).toContain("min-height: 0")
    expect(block).toContain("flex: 1")
    // Страница про размеры ничего не знает — их задаёт `CorpDialog` (S-D10, D-33).
    expect(page).toContain("CorpDialog")
    expect(page).not.toMatch(/<CorpDialog[^>]*size=/)
    expect(page).not.toMatch(/<CorpDialog[^>]*\bfit\b/)

    for (const branch of ["legacy", "v2"] as const) {
      const heights = new Set<string>()
      for (const groups of [1, 15]) {
        const { component, corpClass } = BRANCHES[branch]
        document.head.innerHTML = `<style>${CSS.dialog}</style><style>${CSS.dialogV2}</style><style>${CSS.corp}</style>`
        const rows = Array.from({ length: groups }, (_, at) => `<div data-slot="settings-row">группа ${at}</div>`)
        document.body.innerHTML = `
          <div data-component="${component}" data-size="x-large">
            <div data-slot="dialog-container">
              <div data-slot="dialog-content" class="${corpClass}">
                <div data-slot="dialog-body">
                  <div class="corp-connector"><p>описание</p>${rows.join("")}</div>
                </div>
              </div>
            </div>
          </div>`
        const panel = getComputedStyle(document.querySelector('[data-slot="dialog-content"]')!)
        heights.add(`${panel.height}|${panel.minHeight}|${panel.overflow}`)
      }
      expect(heights.size, `${branch}: высота страницы зависит от числа групп`).toBe(1)
      // И та же высота, что у витрины той же ветки — обе на одном контейнере.
      expect([...heights][0]).toBe(
        (() => {
          const view = render(branch, { cards: 12 })
          return `${view.panelStyle.height}|${view.panelStyle.minHeight}|${view.panelStyle.overflow}`
        })(),
      )
    }
  })
})

/**
 * Контраст корп-экранов (S-D12, S-Q9; AC-231) и тексты каталога как данные (S-I6; AC-234).
 */
describe("корп-экраны — контраст и запрещённые классы (AC-231, AC-234)", () => {
  test("AC-231: подстроки text-11-regular нет ни разу — класса нет в utilities.css", () => {
    const utilities = read(path.join(ROOT, "packages/ui/src/styles/utilities.css"))
    expect(utilities).not.toContain(".text-11-regular")
    for (const { file, text } of CORP_COMPONENTS) expect(text, file).not.toContain("text-11-regular")
  })

  test("AC-231: text-text-weaker для содержательного текста в корп-компонентах не используется", () => {
    for (const { file, text } of CORP_COMPONENTS) expect(text, file).not.toContain("text-text-weaker")
  })

  test("AC-231: каждый размерный класс корп-экранов объявлен в utilities.css", () => {
    const utilities = read(path.join(ROOT, "packages/ui/src/styles/utilities.css"))
    const used = CORP_COMPONENTS.flatMap(({ file, text }) =>
      [...text.matchAll(/\btext-\d+-[a-z]+\b/g)].map((match) => ({ file, value: match[0] })),
    )
    expect(used.length).toBeGreaterThan(10)
    for (const { file, value } of used)
      expect(utilities, `${file}: класс ${value} не объявлен и ничего не делает`).toContain(`.${value}`)
  })

  test("AC-231: второстепенный текст — text-12-regular text-text-weak, основной — text-14-regular", () => {
    // Обе допустимые замены в корп-экранах действительно применены.
    const all = CORP_COMPONENTS.map(({ text }) => text).join("\n")
    expect(all).toContain("text-12-regular text-text-weak")
    expect(all).toContain("text-14-regular text-text-strong")
    // Ни один текст не оформлен мелким шрифтом вместе с самым бледным цветом.
    for (const { file, text } of CORP_COMPONENTS) {
      expect(text, file).not.toMatch(/text-1[12]-regular\s+text-text-weaker/)
      expect(text, file).not.toContain("text-text-weaker")
    }
  })

  test("AC-234: русские значения каталога рисуются как есть, ключей на них в словарях нет", () => {
    // Значения группы и «Типа» подставляются напрямую, без обращения к словарю.
    expect(SOURCE.connector).toContain("<SettingsRowV2 title={row.title} description={row.description}>")
    expect(SOURCE.connector).toContain("title: group.title,")
    expect(SOURCE.connectors).toContain("{connectorType(card) ?? \"\"}")
    // Обрамление — из словаря: заголовки блоков «Тип», «Владелец», «Разрешения».
    for (const key of ["corp.connector.type", "corp.connector.owner", "corp.permissions.title"])
      expect(SOURCE.connector, key).toContain(`language.t("${key}")`)
  })
})
