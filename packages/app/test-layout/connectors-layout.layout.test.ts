import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { expect, test, type Page } from "@playwright/test"

/**
 * Раскладка витрины коннекторов — измерением, а не чтением исходника
 * (S-D6, S-D10, S-V11, S-V12, S-V18; AC-184, AC-217, AC-218, AC-225, AC-226, AC-230; BUG-I10-002).
 *
 * Зачем этот файл. Всё прежнее покрытие витрины проверяло **текст исходника** (есть ли в файле
 * нужные подстроки) и разрешимость CSS-переменных на синтетической разметке в happy-dom, который
 * раскладку не считает. Ни то, ни другое не может поймать элемент, занявший всё окно: именно так
 * `TabsV2` с `height: 100%` съел панель, список схлопнулся в ноль, а поиск и шапка уехали за нижний
 * край — при 541 зелёном тесте (BUG-I10-002). Здесь витрина собирается вайтом теми же плагинами,
 * что и приложение, поднимается в настоящем браузере и **измеряется**.
 *
 * Что именно измеряется (по `requested_test` баг-репорта):
 *   1. каждая строка каталога имеет ненулевую высоту, а её прямоугольник лежит внутри панели окна;
 *   2. порядок блоков сверху вниз строго «вкладки < поиск < шапка < область прокрутки»;
 *   3. высота вкладок не больше 48px и заведомо меньше высоты панели — это ловит `height: 100%`;
 *   4. область прокрутки имеет ненулевую высоту;
 *   5. левые края ячеек шапки и первой строки совпадают попиксельно (S-D6: одна сетка на обе);
 *   6. ни один элемент оболочки не выходит за границы панели.
 *
 * Прогон идёт в обеих ветках флага оформления при 0, 1 и 50 карточках и на всех пяти пустых
 * состояниях (S-V12, ревизия 1.12: было шесть — вместе со вкладкой «Неподключённые» исчезло её
 * пустое состояние, D-53) — это заодно закрывает AC-184 и AC-230 наблюдаемо, по измеренной высоте
 * панели, а не по объявленной высоте контейнера.
 *
 * Запуск: `bun --cwd packages/app x playwright test --config test-layout/playwright.config.ts`
 * (скрипта `test:layout` в `packages/app/package.json` нет и не заводится — см. `README.md` рядом).
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, "..")
const DIST = path.join(here, "fixture/dist")

type Branch = "legacy" | "v2"

interface ShellOptions {
  branch: Branch
  cards: number
  empty?: { text: string; action: "refresh" | "login" | "resetFilter" }
  banner?: string
  partial?: string
  table?: boolean
}

interface Rect {
  top: number
  bottom: number
  left: number
  right: number
  width: number
  height: number
}

interface Measurement {
  /** Контейнер окна: именно он задаёт высоту, а панель обязана её занять целиком (S-D10). */
  container: Rect | null
  panel: Rect | null
  tabs: Rect | null
  search: Rect | null
  header: Rect | null
  scroll: Rect | null
  empty: Rect | null
  rows: Rect[]
  headerCells: number[]
  firstRowCells: number[]
  /** Сколько строк целиком помещается в область прокрутки — то, что пользователь видит сразу. */
  visibleRows: number
}

let bundle: { js: string; css: string }

test.beforeAll(() => {
  // Фикстура собирается теми же плагинами, что и приложение (`packages/app/vite.js`): алиас `@`,
  // tailwind и `vite-plugin-solid`. Значит, и JSX, и CSS — ровно те, что уезжают в бандл.
  const build = spawnSync("bun", ["x", "vite", "build", "--config", "test-layout/fixture/vite.config.ts"], {
    cwd: APP,
    encoding: "utf8",
  })
  if (build.status !== 0) throw new Error(`сборка фикстуры не удалась:\n${build.stderr}${build.stdout}`)
  bundle = {
    js: fs.readFileSync(path.join(DIST, "shell.js"), "utf8"),
    css: fs.readFileSync(path.join(DIST, "shell.css"), "utf8"),
  }
})

async function open(page: Page) {
  await page.setContent("<!doctype html><html><head></head><body></body></html>")
  await page.addStyleTag({ content: bundle.css })
  await page.addScriptTag({ content: bundle.js })
}

async function measure(page: Page, options: ShellOptions): Promise<Measurement> {
  return page.evaluate(async (input: ShellOptions) => {
    await (window as unknown as { renderCorpShell: (o: ShellOptions) => Promise<void> }).renderCorpShell(input)

    const rect = (selector: string): Rect | null => {
      const node = document.querySelector(selector)
      if (!node) return null
      const box = node.getBoundingClientRect()
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
      }
    }
    const rects = (selector: string): Rect[] =>
      [...document.querySelectorAll(selector)].map((node) => {
        const box = node.getBoundingClientRect()
        return {
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
          width: box.width,
          height: box.height,
        }
      })
    const cells = (selector: string): number[] =>
      [...(document.querySelector(selector)?.children ?? [])].map((node) =>
        Math.round(node.getBoundingClientRect().left),
      )

    const scroll = rect('[data-slot="list-scroll"]')
    const rows = rects('[data-slot="corp-connectors-row"]')
    const visibleRows = scroll
      ? rows.filter((row) => row.height > 0 && row.top >= scroll.top - 0.5 && row.bottom <= scroll.bottom + 0.5).length
      : 0

    return {
      container: rect('[data-slot="dialog-container"]'),
      panel: rect('[data-slot="dialog-content"]'),
      tabs: rect('[data-component="tabs-v2"]'),
      search: rect('[data-slot="list-search-wrapper"]'),
      header: rect('[data-slot="corp-connectors-header"]'),
      scroll,
      empty: rect('[data-slot="corp-connectors-empty"]'),
      rows,
      headerCells: cells('[data-slot="corp-connectors-header"]'),
      firstRowCells: cells('[data-slot="corp-connectors-row"]'),
      visibleRows,
    }
  }, options)
}

/** Прямоугольник `inner` целиком лежит внутри `outer` — с допуском в полпикселя на округление. */
function inside(inner: Rect, outer: Rect, label: string) {
  expect(inner.top, `${label}: верх выше панели`).toBeGreaterThanOrEqual(outer.top - 0.5)
  expect(inner.bottom, `${label}: низ ниже панели`).toBeLessThanOrEqual(outer.bottom + 0.5)
  expect(inner.left, `${label}: левый край левее панели`).toBeGreaterThanOrEqual(outer.left - 0.5)
  expect(inner.right, `${label}: правый край правее панели`).toBeLessThanOrEqual(outer.right + 0.5)
}

/** Общие для всех сценариев утверждения оболочки витрины. */
function assertShell(view: Measurement, options: ShellOptions) {
  const panel = view.panel
  expect(panel, "панель окна не найдена").not.toBeNull()
  expect(panel!.height, "панель окна нулевой высоты").toBeGreaterThan(200)

  const table = options.table !== false
  if (table) {
    expect(view.tabs, "вкладки не найдены").not.toBeNull()
    expect(view.search, "строка поиска не найдена").not.toBeNull()
    expect(view.header, "шапка таблицы не найдена").not.toBeNull()
  }
  expect(view.scroll, "область прокрутки списка не найдена").not.toBeNull()

  // (3) Высота вкладок — их собственная, а не высота окна. Ровно это ловит `height: 100%`.
  if (table) {
    expect(view.tabs!.height, "вкладки выше разумного предела в 48px").toBeLessThanOrEqual(48)
    expect(view.tabs!.height, "вкладки заняли всю панель").toBeLessThan(panel!.height / 2)
    expect(view.tabs!.height, "вкладки схлопнулись в ноль").toBeGreaterThan(0)
  }

  // (2) Порядок блоков сверху вниз строго «вкладки → поиск → шапка → область прокрутки».
  if (table) {
    expect(view.tabs!.top, "вкладки не выше строки поиска").toBeLessThan(view.search!.top)
    expect(view.search!.top, "строка поиска не выше шапки").toBeLessThan(view.header!.top)
    expect(view.header!.top, "шапка не выше области прокрутки").toBeLessThan(view.scroll!.top)
  }

  // (4) Области прокрутки досталась ненулевая высота — там, где ей есть что показывать. В пустом
  // состоянии корп-CSS намеренно отдаёт место блоку `corp-connectors-empty`
  // (`.corp-connectors[data-empty] [data-slot="list-scroll"] { flex: 0 0 auto }`), поэтому здесь
  // ненулевую высоту обязано иметь именно пустое состояние — иначе пользователь не увидит ни строк,
  // ни объяснения, почему их нет.
  if (options.empty) {
    expect(view.empty, "пустое состояние не отрисовано").not.toBeNull()
    expect(view.empty!.height, "пустое состояние нулевой высоты").toBeGreaterThan(0)
  } else {
    expect(view.scroll!.height, "область прокрутки нулевой высоты").toBeGreaterThan(0)
  }

  // (6) Ни один элемент оболочки не выходит за границы панели.
  if (table) {
    inside(view.tabs!, panel!, "вкладки")
    inside(view.search!, panel!, "строка поиска")
    inside(view.header!, panel!, "шапка")
  }
  inside(view.scroll!, panel!, "область прокрутки")
  if (view.empty) inside(view.empty, panel!, "пустое состояние")
}

const BRANCHES: Branch[] = ["legacy", "v2"]
const COUNTS = [0, 1, 50]

/**
 * Пять пустых состояний витрины (S-V12, ревизия 1.12): у первых двух показана таблица (нет данных
 * вовсе / карточки отброшены разбором), у третьего и четвёртого — нет (источник или авторизация), у
 * пятого — таблица показана, пуста только вкладка.
 *
 * Ревизия 1.12 (D-53) убрала вкладку «Неподключённые» вместе с её пустым состоянием «Подключено
 * всё» — шестого состояния (`corp.empty.tabNotConnected`) в `dialog-connectors.tsx` больше нет:
 * ветка `tab() === "connected"` — единственная, что возвращает `action: "resetFilter"` (см.
 * guard-тест ниже, который считает эти вхождения в исходнике и проверяет, что список здесь не
 * разошёлся с их числом).
 */
const EMPTY_STATES: { name: string; options: Omit<ShellOptions, "branch"> }[] = [
  { name: "1 «Каталог пуст»", options: { cards: 0, empty: { text: "Каталог пуст", action: "refresh" } } },
  {
    name: "2 «Каталог не разобран»",
    options: { cards: 0, empty: { text: "Каталог не разобран: отброшены все карточки (2)", action: "refresh" } },
  },
  {
    name: "3 «Источник недоступен»",
    options: { cards: 0, table: false, empty: { text: "Каталог недоступен", action: "refresh" } },
  },
  {
    name: "4 «Требуется вход»",
    options: { cards: 0, table: false, empty: { text: "Требуется вход", action: "login" } },
  },
  {
    name: "5 «Пока ничего не подключено»",
    options: { cards: 0, empty: { text: "Пока ничего не подключено", action: "resetFilter" } },
  },
]

test.describe("витрина коннекторов — измеренная раскладка (BUG-I10-002)", () => {
  for (const branch of BRANCHES) {
    for (const cards of COUNTS) {
      test(`AC-225, AC-226: ${branch}, ${cards} карточек — порядок блоков, вкладки своей высоты, список не схлопнут`, async ({
        page,
      }) => {
        await open(page)
        const view = await measure(page, { branch, cards })
        assertShell(view, { branch, cards })

        // (1) Все строки каталога имеют ненулевую высоту.
        expect(view.rows.length, "строки каталога не отрисованы").toBe(cards)
        for (const [at, row] of view.rows.entries())
          expect(row.height, `строка ${at} нулевой высоты`).toBeGreaterThan(0)

        if (cards > 0) {
          // Первая строка целиком внутри панели окна и внутри области прокрутки.
          inside(view.rows[0]!, view.panel!, "первая строка")
          expect(view.visibleRows, "ни одна строка не помещается в область прокрутки").toBeGreaterThan(0)
          // (5) Левые края ячеек шапки и первой строки совпадают попиксельно — одна сетка (S-D6).
          expect(view.headerCells.length, "у шапки не три ячейки").toBe(3)
          expect(view.firstRowCells.length, "у строки не три ячейки").toBe(3)
          expect(view.firstRowCells, "колонки шапки и строки разъехались").toEqual(view.headerCells)
        }
      })
    }
  }

  test("AC-184, AC-230: высота панели не зависит от числа карточек и от пустого состояния", async ({ page }) => {
    await open(page)
    const measured = new Map<Branch, number>()
    for (const branch of BRANCHES) {
      const heights = new Set<number>()
      for (const cards of COUNTS) {
        const view = await measure(page, { branch, cards })
        heights.add(Math.round(view.panel!.height))
      }
      for (const state of EMPTY_STATES) {
        const view = await measure(page, { branch, ...state.options })
        heights.add(Math.round(view.panel!.height))
      }
      // Баннер и предупреждение о неполном каталоге высоту окна тоже не меняют (S-D10).
      const banner = await measure(page, {
        branch,
        cards: 12,
        banner: "Каталог недоступен",
        partial: "Часть карточек каталога не разобрана и не показана: 2",
      })
      heights.add(Math.round(banner.panel!.height))

      expect(heights.size, `${branch}: высота панели зависит от содержимого — ${[...heights].join(" / ")}`).toBe(1)
      measured.set(branch, [...heights][0]!)

      // S-D10: высоту задаёт контейнер, а панель обязана занять её целиком — иначе окно окажется
      // ниже окна настроек ровно так, как это было до ревизии 1.9 (F45).
      const full = await measure(page, { branch, cards: 12 })
      expect(Math.round(full.container!.height), `${branch}: контейнер нулевой высоты`).toBeGreaterThan(400)
      expect(
        Math.round(full.panel!.height),
        `${branch}: панель не растянута на всю высоту контейнера`,
      ).toBe(Math.round(full.container!.height))
    }

    // Ветки флага объявлены разными размерами — сравниваются окна одной ветки, а не одна константа.
    expect(measured.get("legacy"), "высоты веток совпали — сравнивается не то").not.toBe(measured.get("v2"))
  })

  for (const branch of BRANCHES) {
    for (const state of EMPTY_STATES) {
      test(`AC-184, S-V12: ${branch}, пустое состояние ${state.name} — оболочка на месте, ничего не выехало`, async ({
        page,
      }) => {
        await open(page)
        const view = await measure(page, { branch, ...state.options })
        assertShell(view, { branch, ...state.options })
        expect(view.empty, "пустое состояние не отрисовано").not.toBeNull()
        expect(view.empty!.height, "пустое состояние нулевой высоты").toBeGreaterThan(0)
        expect(view.rows.length, "при пустом состоянии строк быть не должно").toBe(0)
      })
    }
  }

  test("S-D6: баннер и предупреждение стоят над вкладками и не входят в область прокрутки", async ({ page }) => {
    await open(page)
    for (const branch of BRANCHES) {
      const view = await measure(page, {
        branch,
        cards: 12,
        banner: "Каталог недоступен",
        partial: "Часть карточек каталога не разобрана и не показана: 2",
      })
      assertShell(view, { branch, cards: 12 })
      const above = await page.evaluate(() => {
        const top = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? NaN
        return {
          banner: top('[data-slot="corp-connectors-banner"]'),
          partial: top('[data-slot="corp-connectors-partial"]'),
          tabs: top('[data-component="tabs-v2"]'),
        }
      })
      expect(above.banner, `${branch}: баннер не над предупреждением`).toBeLessThan(above.partial)
      expect(above.partial, `${branch}: предупреждение не над вкладками`).toBeLessThan(above.tabs)
      expect(view.visibleRows, `${branch}: строки не видны при баннере`).toBeGreaterThan(0)
    }
  })

  /**
   * Фикстура обязана оставаться слепком витрины: если витрина переименует слот или заведёт четвёртую
   * колонку, тест должен упасть, а не продолжать мерить устаревшую разметку.
   */
  test("фикстура повторяет разметку витрины: те же слоты и те же три колонки", () => {
    const view = fs.readFileSync(path.join(APP, "src/components/corp/dialog-connectors.tsx"), "utf8")
    const fixture = fs.readFileSync(path.join(here, "fixture/shell.tsx"), "utf8")
    for (const slot of [
      "corp-connectors-row",
      "corp-connectors-header",
      "corp-connectors-banner",
      "corp-connectors-partial",
      "corp-connectors-empty",
      "corp-status-cell",
      "corp-status-dot",
    ]) {
      expect(view, `витрина не содержит слот ${slot}`).toContain(slot)
      expect(fixture, `фикстура не содержит слот ${slot}`).toContain(slot)
    }
    // Класс контейнера, вкладки и их вариант — тоже одни и те же.
    for (const marker of ['class="corp-connectors"', '<TabsV2', 'variant="pill"', "<List"]) {
      expect(view, `витрина не содержит ${marker}`).toContain(marker)
      expect(fixture, `фикстура не содержит ${marker}`).toContain(marker)
    }
    // Три колонки — ровно столько, сколько объявляет единственная сетка в корп-CSS.
    const css = fs.readFileSync(path.join(APP, "src/components/corp/dialog-shell.css"), "utf8")
    const grid = /grid-template-columns:\s*([^;]+);/.exec(css)
    expect(grid, "объявление сетки колонок не найдено").not.toBeNull()
    expect(grid![1]!.split("minmax").length - 1, "колонок в сетке не три").toBe(3)
  })

  /**
   * Сторож геометрической фикстуры (см. отчёт по разбору фикстуры, задача 2).
   *
   * Прежняя проверка выше подтверждает только **присутствие** нужных строк — она зелёная и тогда,
   * когда в фикстуре есть ЛИШНЕЕ сверх исходника (лишняя вкладка, лишняя строка внутри ряда), потому
   * что `toContain` не видит того, чего в исходнике уже нет. Из-за этого 21 сценарий этого файла
   * мерил геометрию разметки, которой у витрины не было: три вкладки вместо двух (вкладка
   * «Неподключённые» убрана ревизией 1.12, D-53) и двустрочная строка каталога вместо однострочной
   * (подпись `alias` второй строкой убрана той же ревизией) — набор оставался зелёным, потому что
   * само подобие никогда не проверялось.
   *
   * Приём: ожидание в обоих утверждениях ниже вычисляется **из текста исходника** регулярным
   * выражением при каждом прогоне, а не переписано сюда второй раз литералом. Так фикстура не может
   * разойтись с исходником незаметно — расхождение с любой стороны (исходник изменился, а фикстура
   * нет, или наоборот) валит тест, потому что сравниваются между собой два независимо прочитанных
   * факта, а не факт против чьей-то догадки о нём.
   */
  test("фикстура повторяет разметку витрины: вкладки и однострочный ряд вычислены из исходника", () => {
    const view = fs.readFileSync(path.join(APP, "src/components/corp/dialog-connectors.tsx"), "utf8")
    const fixture = fs.readFileSync(path.join(here, "fixture/shell.tsx"), "utf8")

    // (1) Набор и порядок вкладок — `value` каждого `<TabsV2.Trigger>`, а не подписи (тексты вкладок
    // в витрине идут через `language.t(TAB_KEY.*)` и не совпадают литералом с фикстурой намеренно —
    // паритет словарей проверяют i18n-тесты, а не этот файл).
    const tabValues = (source: string) => [...source.matchAll(/<TabsV2\.Trigger value="([^"]+)">/g)].map((m) => m[1])
    const viewTabs = tabValues(view)
    const fixtureTabs = tabValues(fixture)
    expect(viewTabs.length, "в исходнике не найдено ни одной вкладки — регэксп разошёлся с разметкой").toBeGreaterThan(0)
    expect(fixtureTabs, "набор вкладок фикстуры разошёлся с исходником (TabsV2.Trigger value)").toEqual(viewTabs)

    // (2) Ряд каталога — один текстовый уровень или два. В исходнике имя коннектора обёрнуто
    // непосредственно `<div class="flex items-center gap-2 min-w-0">` (одна строка, ревизия 1.12);
    // прежде было `flex flex-col …` с отдельной строкой `alias` под именем. Сравниваются классы
    // первого `<div>` сразу после открытия `data-slot="corp-connectors-row"` в обоих файлах — если
    // один из них когда-нибудь снова станет двустрочным, а другой нет, тест это увидит.
    const rowWrapperClass = (source: string) => {
      // Между открытием ряда и первым `<div>` в исходнике стоит поясняющий JSX-комментарий
      // (`{/* … */}`) — он необязателен и пропускается, чтобы регэксп не зависел от того, есть ли
      // комментарий в конкретном файле.
      const match = /data-slot="corp-connectors-row"[^>]*>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<div class="([^"]+)"/.exec(
        source,
      )
      return match?.[1]
    }
    const viewRowClass = rowWrapperClass(view)
    const fixtureRowClass = rowWrapperClass(fixture)
    expect(viewRowClass, "в исходнике не найден обёрточный div ряда сразу после corp-connectors-row").toBeDefined()
    expect(fixtureRowClass, "в фикстуре не найден обёрточный div ряда сразу после corp-connectors-row").toBeDefined()
    expect(fixtureRowClass, "обёртка ряда в фикстуре разошлась с исходником (однострочность/flex-col)").toBe(
      viewRowClass,
    )

    // (3) Число вкладок-фильтров (все, кроме «Все») равно числу пустых состояний вкладки
    // (`action: "resetFilter" as const`, S-V12): у каждой филируемой вкладки может быть своё пустое
    // состояние сброса фильтра, и ровно столько их сейчас и объявлено в исходнике — если появится
    // вторая филируемая вкладка без своего состояния (или наоборот), тест увидит расхождение чисел.
    const resetFilterStates = [...view.matchAll(/action:\s*"resetFilter"\s*as const/g)].length
    const filterableTabs = viewTabs.length - 1
    expect(resetFilterStates, "число resetFilter-состояний в исходнике неожиданно").toBeGreaterThan(0)
    expect(
      EMPTY_STATES.filter((state) => state.options.empty?.action === "resetFilter").length,
      "число resetFilter-состояний в EMPTY_STATES разошлось с числом филируемых вкладок исходника",
    ).toBe(filterableTabs)
    expect(filterableTabs, "число филируемых вкладок разошлось с числом resetFilter-состояний в исходнике").toBe(
      resetFilterStates,
    )
  })
})
