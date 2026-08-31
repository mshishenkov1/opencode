import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { mergeProps, splitProps } from "solid-js"
import { connectorMonogram } from "@opencode-ai/core/corp/constants"
import { dict as en } from "../i18n/en"
import { dict as ru } from "../i18n/ru"

/**
 * Значок, монограмма, бейдж способа подключения и абзацы описания (S-V22, S-D11, ревизия 1.14;
 * AC-357, AC-358, AC-359, AC-361).
 *
 * До этого файла у четырёх названных критериев не было ни одного сторожа: `connector-icon.tsx`,
 * `connectorMonogram`, `connectModeKey` и `descriptionParagraphs` в тестах не упоминались вовсе
 * (перечень «сторожа нет» в блоке ревизии 1.14).
 *
 * Как проверяется. Три из четырёх правил — обычные функции, и они берутся такими, какие есть:
 * `connectorMonogram` импортируется из ядра, `connectModeKey` и `descriptionParagraphs` живут в
 * `.tsx`, который в тесте не импортируется (`solid-js/web` в среде bun разрешается в серверную
 * сборку), поэтому их тела извлекаются из исходника и исполняются — тот же приём, что в
 * `connector-page.test.ts` и `dialog-actions.test.ts`. Копии правила в тесте нет.
 *
 * Четвёртое — `ConnectorIcon` — правило не арифметическое, а про **ветвление разметки**: без
 * `icon` и после неудачной загрузки показывается монограмма, при пригодном `icon` — картинка.
 * Утверждать это по тексту исходника значило бы пересказывать его, поэтому компонент здесь
 * **исполняется**: настоящий файл транспилируется в классический JSX и выполняется мини-рендерером
 * (ниже), а результат — настоящее DOM-дерево, по которому и идут проверки. Событие `error`
 * посылается элементу по-настоящему.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/connector-visuals.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "..")
const read = (file: string) => fs.readFileSync(path.join(APP, file), "utf8")

const SOURCE = {
  icon: read("components/corp/connector-icon.tsx"),
  connectors: read("components/corp/dialog-connectors.tsx"),
  connector: read("components/corp/dialog-connector.tsx"),
}

// ---------------------------------------------------------------- тела функций из исходника

/**
 * Тело функции по её объявлению — исполняется как есть, без рендера компонента.
 *
 * `new Function` разбирает JavaScript, поэтому из тела снимаются `as const` и аннотации типов у
 * объявлений. Ничего другого из тела не удаляется: исполняется тот же код, что в компоненте.
 */
function body(source: string, marker: string) {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker}`).toBeGreaterThan(-1)
  const open = source.indexOf("{", source.indexOf(")", at))
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth += 1
    else if (source[index] === "}") {
      depth -= 1
      if (depth === 0)
        return source
          .slice(open + 1, index)
          .replace(/\bas const\b/g, "")
          .replace(/\b(const|let)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, "$1 $2 =")
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

// ---------------------------------------------------------------- мини-рендерер Solid-компонента

/**
 * Мини-рендерер: настоящий компонент, настоящий DOM, предсказуемая перерисовка.
 *
 * Зачем он нужен. `solid-js/web` в среде `bun test` разрешается в **серверную** сборку (условия
 * `browser` у `test:unit` нет), поэтому настоящий `render` в этих тестах недоступен, а серверный
 * `createMemo` считает значение один раз — реактивность там поддельная. Поэтому компонент
 * исполняется своим циклом: тело компонента вызывается, дерево строится, эффекты выполняются,
 * тело вызывается ещё раз. Состояние сигналов при этом **переживает** перерисовку — так же, как
 * оно переживает её в настоящем Solid, где замыкание компонента живёт одно на все обновления.
 *
 * Что здесь настоящее: исходник компонента, его ветвления, монограмма, обработчик `onError` и сам
 * DOM (happy-dom). Что подменено: `createSignal` (ячейка, живущая столько же, сколько инстанс),
 * `createMemo` (пересчёт при каждом чтении — кэшу негде устареть, потому что дерево строится
 * заново) и `Show` (та же семантика, что у Solid: `fallback`, ребёнок-функция получает геттер).
 * Планировщик Solid тем самым из проверки выпадает — это осознанная граница меры, и дефект,
 * который виден только на настоящем планировщике, ею не ловится.
 */
const TSCONFIG = JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "__h", jsxFragmentFactory: "__F" } })

interface HostNode {
  tag: string
  props: Record<string, unknown>
  children: unknown[]
}

let cells: { value: unknown }[] = []
let cursor = 0
let effects: (() => void)[] = []

const runtime = {
  createSignal(initial: unknown) {
    const at = cursor++
    const cell = (cells[at] ??= { value: initial })
    return [
      () => cell.value,
      (next: unknown) => (cell.value = typeof next === "function" ? (next as (p: unknown) => unknown)(cell.value) : next),
    ]
  },
  createMemo: (fn: () => unknown) => fn,
  createEffect: (fn: () => void) => void effects.push(fn),
  createRenderEffect: (fn: () => void) => void effects.push(fn),
  onMount: (fn: () => void) => void effects.push(fn),
  onCleanup: () => {},
  untrack: (fn: () => unknown) => fn(),
  mergeProps,
  splitProps,
  /** Та же семантика, что у `Show` Solid: `when` ложно — `fallback`; ребёнок-функция получает геттер. */
  Show: (props: Record<string, any>) => {
    const when = props.when
    if (!when) return props.fallback
    const child = props.children
    return typeof child === "function" && child.length > 0 ? child(() => when) : child
  },
}

function __h(type: any, props: any, ...kids: any[]) {
  return () => {
    if (typeof type === "string") return { tag: type, props: props ?? {}, children: kids } satisfies HostNode
    const merged: any = { ...(props ?? {}) }
    if (kids.length > 0)
      Object.defineProperty(merged, "children", {
        get: () => (kids.length === 1 ? kids[0] : kids),
        enumerable: true,
        configurable: true,
      })
    return type(merged)
  }
}

function importLine(clause: string, spec: string) {
  const request = `__require(${JSON.stringify(spec)})`
  const trimmed = clause.trim()
  if (trimmed.startsWith("{")) return `const ${trimmed} = ${request};`
  if (trimmed.startsWith("*")) return `const ${trimmed.replace(/^\*\s*as\s*/, "")} = ${request};`
  return `const { default: ${trimmed} } = ${request};`
}

/** Настоящий файл компонента, исполненный: импорты заменены заглушками, JSX — вызовами `__h`. */
function evalComponentModule(source: string, requires: Record<string, unknown>): Record<string, any> {
  const transpiler = new Bun.Transpiler({ loader: "tsx", tsconfig: TSCONFIG })
  const exported = transpiler.scan(source).exports
  const js = transpiler
    .transformSync(source)
    .replace(/^\s*import\s*"[^"]+";?\s*$/gm, "")
    .replace(/^\s*import\s+([^;]*?)\s+from\s+"([^"]+)";?\s*$/gm, (_m, clause, spec) => importLine(clause, spec))
    .replace(/^export\s+/gm, "")
  const require_ = (spec: string) => {
    if (spec in requires) return requires[spec]
    if (spec.endsWith(".css")) return {}
    throw new Error(`нет заглушки для импорта ${spec}`)
  }
  return new Function("__require", "__h", "__F", `${js}\nreturn { ${exported.join(", ")} };`)(require_, __h, "fragment")
}

function resolve(value: unknown): unknown {
  let current = value
  for (let guard = 0; typeof current === "function" && guard < 50; guard++) current = (current as () => unknown)()
  return current
}

/** Разрешённое дерево: только узлы разметки, текст и массивы — никаких отложенных вызовов. */
function tree(value: unknown): unknown {
  const node = resolve(value)
  if (node === null || node === undefined || typeof node === "boolean") return undefined
  if (Array.isArray(node)) return node.map(tree).filter((item) => item !== undefined)
  if (typeof node === "object" && typeof (node as HostNode).tag === "string") {
    const host = node as HostNode
    return { tag: host.tag, props: host.props, children: host.children.map(tree).filter((i) => i !== undefined) }
  }
  return String(node)
}

function toDom(node: unknown, into: Node[]): Node[] {
  if (node === undefined) return into
  if (Array.isArray(node)) {
    for (const item of node) toDom(item, into)
    return into
  }
  if (typeof node === "string") {
    into.push(document.createTextNode(node))
    return into
  }
  const host = node as HostNode
  const el = document.createElement(host.tag)
  const refs: (() => void)[] = []
  for (const [key, raw] of Object.entries(host.props)) {
    if (key === "children") continue
    if (key === "ref") {
      if (typeof raw === "function") refs.push(() => (raw as (e: Element) => void)(el))
      continue
    }
    if (/^on[A-Z]/.test(key) && typeof raw === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), raw as EventListener)
      continue
    }
    if (key === "style" && raw && typeof raw === "object") {
      for (const [prop, value] of Object.entries(raw as Record<string, string>)) el.style.setProperty(prop, value)
      continue
    }
    if (key === "classList" && raw && typeof raw === "object") {
      for (const [name, on] of Object.entries(raw as Record<string, unknown>)) if (on && name) el.classList.add(name)
      continue
    }
    if (raw === undefined || raw === null || raw === false) continue
    el.setAttribute(key, raw === true ? "" : String(raw))
  }
  for (const child of host.children) toDom(child, []).forEach((n) => el.appendChild(n))
  refs.forEach((fn) => fn())
  into.push(el)
  return into
}

/** Инстанс компонента: состояние живёт между перерисовками, `paint()` строит дерево заново. */
function mount<P>(component: (props: P) => unknown, props: P) {
  cells = []
  const paint = () => {
    cursor = 0
    effects = []
    const built = tree(component(props))
    const dom = toDom(built, [])[0] as HTMLElement
    effects.forEach((fn) => fn())
    return { built, dom }
  }
  let last = paint()
  return {
    get dom() {
      return last.dom
    },
    get built() {
      return last.built as HostNode
    },
    repaint() {
      last = paint()
      return last.dom
    },
  }
}

const icons = evalComponentModule(SOURCE.icon, {
  "solid-js": runtime,
  "@opencode-ai/core/corp/constants": { connectorMonogram },
})

/** Один значок: дерево и DOM того же инстанса. */
const icon = (props: { title: string; icon?: string; size?: "small" | "large" }) => mount(icons.ConnectorIcon, props)

/** Все узлы разметки дерева — по ним видно, какие пропы у элемента ЕСТЬ, а не только что он есть. */
function nodes(node: unknown, found: HostNode[] = []): HostNode[] {
  if (node === undefined || typeof node === "string") return found
  if (Array.isArray(node)) {
    for (const item of node) nodes(item, found)
    return found
  }
  const host = node as HostNode
  found.push(host)
  for (const child of host.children) nodes(child, found)
  return found
}

/**
 * Глубина условной отрисовки в точке разметки: сколько `<Show>` над ней открыто и не закрыто.
 *
 * Ноль значит «рисуется всегда». Проверять это подстрокой нельзя: условие может стоять и далеко
 * выше элемента, и мера, читающая только его открывающий тег, такого не увидит.
 */
function showDepthAt(source: string, from: string, marker: string) {
  const start = source.indexOf(from)
  expect(start, `не найдено начало области ${from}`).toBeGreaterThan(-1)
  const at = source.indexOf(marker, start)
  expect(at, `не найдено ${marker} внутри ${from}`).toBeGreaterThan(-1)
  const region = source.slice(start, at)
  return (region.split("<Show").length - 1) - (region.split("</Show>").length - 1)
}

/** Настоящие корп-стили: по ним видно, что монограмма видима, а подложка держит размер значка. */
const CORP_CSS = read("components/corp/dialog-shell.css")

/** Значение токена подложки: своё, приметное — по нему видно, что подложку красит именно тема. */
const SURFACE_WEAK = "rgb(240, 241, 242)"

function styled(dom: HTMLElement) {
  document.head.innerHTML = `<style>:root { --surface-weak: ${SURFACE_WEAK}; }</style><style>${CORP_CSS}</style>`
  document.body.innerHTML = ""
  document.body.appendChild(dom)
  return dom
}

// ---------------------------------------------------------------- AC-357: значок коннектора

describe("значок коннектора (S-V22, ревизия 1.14; AC-357)", () => {
  test("AC-357: пригодный icon — картинка каталога, монограммы нет", () => {
    const view = icon({ title: "Mattermost Dev", icon: "https://catalog/mm.png" })
    const img = view.dom.querySelector("img")
    expect(img, view.dom.outerHTML).not.toBeNull()
    expect(img!.getAttribute("src")).toBe("https://catalog/mm.png")
    expect(view.dom.querySelector('[data-slot="corp-connector-monogram"]')).toBeNull()
  })

  test("AC-357: без icon — монограмма из букв названия, картинки нет", () => {
    const view = icon({ title: "Mattermost Dev" })
    const monogram = view.dom.querySelector('[data-slot="corp-connector-monogram"]')
    expect(monogram, view.dom.outerHTML).not.toBeNull()
    expect(monogram!.textContent).toBe("MD")
    expect(view.dom.querySelector("img")).toBeNull()
  })

  test("AC-357: ссылка не загрузилась — ровно то же, что было бы без icon; дыры не остаётся", () => {
    const view = icon({ title: "Mattermost Dev", icon: "https://catalog/404.png" })
    view.dom.querySelector("img")!.dispatchEvent(new Event("error"))
    const after = view.repaint()

    expect(after.querySelector("img")).toBeNull()
    expect(after.querySelector('[data-slot="corp-connector-monogram"]')!.textContent).toBe("MD")
    // «Ровно то же» проверяется сравнением разметки, а не пересказом: неудача возвращает состояние
    // карточки без `icon` целиком, а не «что-то вместо картинки».
    expect(after.outerHTML).toBe(icon({ title: "Mattermost Dev" }).dom.outerHTML)
  })

  test("AC-357, ГРАНИЦА: успешно загруженная пустая картинка монограммой не заменяется", () => {
    const view = icon({ title: "Mattermost Dev", icon: "https://catalog/empty.png" })
    // Событие успешной загрузки — не признак неудачи, и порога «пустая ли картинка» у оболочки нет.
    view.dom.querySelector("img")!.dispatchEvent(new Event("load"))
    expect(view.repaint().querySelector("img")).not.toBeNull()

    // И это видно по составу обработчиков: у картинки нет ни одного события, кроме `error`.
    const img = nodes(view.built).find((node) => node.tag === "img")!
    expect(Object.keys(img.props).filter((key) => /^on[A-Z]/.test(key))).toEqual(["onError"])
    // Размеров и содержимого картинки компонент не читает — признака «пустая» у него нет.
    for (const probe of ["naturalWidth", "naturalHeight", "getImageData", "complete"])
      expect(SOURCE.icon).not.toContain(probe)
  })

  test("AC-357: значок скрыт от скринридера во всех трёх случаях", () => {
    const broken = icon({ title: "ТЭГ", icon: "https://catalog/404.png" })
    broken.dom.querySelector("img")!.dispatchEvent(new Event("error"))
    for (const view of [icon({ title: "ТЭГ", icon: "https://catalog/tag.png" }), icon({ title: "ТЭГ" }), broken]) {
      const root = view.repaint()
      expect(root.getAttribute("aria-hidden")).toBe("true")
      const img = root.querySelector("img")
      if (img) expect(img.getAttribute("alt")).toBe("")
    }
  })

  test("AC-357: один и тот же значок стоит и в строке витрины, и в шапке страницы коннектора", () => {
    for (const [file, source, expected] of [
      ["dialog-connectors.tsx", SOURCE.connectors, "card"],
      ["dialog-connector.tsx", SOURCE.connector, "entry()"],
    ] as const) {
      const at = source.indexOf("<ConnectorIcon")
      expect(at, `${file}: значок не отрисован`).toBeGreaterThan(-1)
      const tag = source.slice(at, source.indexOf(">", at))
      // Источник картинки один — поле `icon` карточки, имя для монограммы — её же `title`.
      expect(tag, file).toContain(`title={${expected}.title}`)
      expect(tag, file).toContain(`icon={${expected}.icon}`)
      // Своей разметки значка ни у витрины, ни у страницы нет — иначе правило разошлось бы надвое.
      expect(source, file).not.toContain("<img")
      expect(source, file).not.toContain("corp-connector-monogram")
    }
    // И он рисуется БЕЗУСЛОВНО в обоих местах: значок, спрятанный под условие «есть картинка»,
    // вернул бы ту самую дыру, ради отсутствия которой заведена монограмма.
    expect(showDepthAt(SOURCE.connectors, 'data-slot="corp-connectors-row"', "<ConnectorIcon")).toBe(0)
    expect(showDepthAt(SOURCE.connector, 'data-slot="corp-connector-hero"', "<ConnectorIcon")).toBe(0)
  })

  test("AC-357: дыры не остаётся и на экране — подложка держит размер во всех трёх случаях", () => {
    const broken = icon({ title: "ТЭГ", icon: "https://catalog/404.png" })
    broken.dom.querySelector("img")!.dispatchEvent(new Event("error"))
    broken.repaint()

    const boxes = new Set<string>()
    for (const view of [icon({ title: "ТЭГ", icon: "https://catalog/tag.png" }), icon({ title: "ТЭГ" }), broken]) {
      const style = getComputedStyle(styled(view.dom))
      boxes.add(`${style.width}|${style.height}|${style.borderRadius}`)
      // Подложка нейтральная — токен темы, а не выдуманный цвет бренда.
      expect(style.backgroundColor).toBe(SURFACE_WEAK)
    }
    expect(boxes.size, [...boxes].join(" / ")).toBe(1)
    expect([...boxes][0]).toBe("30px|30px|8px")

    // Монограмма при этом видима, а не «нарисована и спрятана».
    const monogram = styled(icon({ title: "ТЭГ" }).dom).querySelector('[data-slot="corp-connector-monogram"]')!
    const style = getComputedStyle(monogram as HTMLElement)
    expect(style.display).not.toBe("none")
    expect(style.visibility).not.toBe("hidden")
    expect(monogram.textContent).toBe("ТЭГ")
  })

  test("AC-357: шапка страницы просит крупный размер, строка витрины — обычный", () => {
    expect(getComputedStyle(styled(icon({ title: "ТЭГ", size: "large" }).dom)).width).toBe("54px")
    expect(getComputedStyle(styled(icon({ title: "ТЭГ" }).dom)).width).toBe("30px")
    expect(SOURCE.connector.slice(SOURCE.connector.indexOf("<ConnectorIcon")).slice(0, 120)).toContain('size="large"')
  })
})

// ---------------------------------------------------------------- AC-358: монограмма

describe("монограмма коннектора (S-V22, ревизия 1.14; AC-358)", () => {
  test("AC-358: шесть названий критерия дают ровно ожидаемые монограммы", () => {
    expect(connectorMonogram("ТЭГ")).toBe("ТЭГ")
    expect(connectorMonogram("Mattermost Dev")).toBe("MD")
    expect(connectorMonogram("GitLab Платформа")).toBe("GL")
    expect(connectorMonogram("Confluence")).toBe("C")
    expect(connectorMonogram("jira")).toBe("J")
    expect(connectorMonogram("")).toBe("")
  })

  test("AC-358: правило берёт ЗАГЛАВНЫЕ, а не первые буквы слов", () => {
    // Первые буквы слов дали бы «GП» — латиницу и кириллицу рядом.
    expect(connectorMonogram("GitLab Платформа")).not.toBe("GП")
    // Обе заглавные могут быть из одного слова…
    expect(connectorMonogram("GitLab")).toBe("GL")
    // …и из разных, и порядок — порядок названия.
    expect(connectorMonogram("Mattermost Dev")).toBe("MD")
  })

  test("AC-358: заглавных меньше двух — первая буква названия, приведённая к заглавной", () => {
    expect(connectorMonogram("Confluence")).toBe("C")
    expect(connectorMonogram("jira")).toBe("J")
    expect(connectorMonogram("почта")).toBe("П")
  })

  test("AC-358: у пустого названия монограммы нет — выдуманной буквы на подложке не появляется", () => {
    expect(connectorMonogram("")).toBe("")
    expect(connectorMonogram("   ")).toBe("")
    // И на экране это пустая подложка, а не подложка с буквой.
    const view = icon({ title: "" })
    expect(view.dom.querySelector('[data-slot="corp-connector-monogram"]')!.textContent).toBe("")
  })

  test("AC-358: короткое слово из заглавных остаётся собой целиком, а длинное — нет", () => {
    expect(connectorMonogram("ТЭГ")).toBe("ТЭГ")
    // Аббревиатура — короткое слово; длинное имя из заглавных под это правило не попадает и
    // сокращается общим способом.
    expect(connectorMonogram("MATTERMOST")).toBe("MA")
  })
})

// ---------------------------------------------------------------- AC-359: бейдж способа подключения

/** Правило бейджа берётся из витрины и исполняется как есть. */
const connectModeKey = new Function("card", body(SOURCE.connectors, "export function connectModeKey(")) as (card: {
  mode?: string
}) => string

/** Ячейка «Тип» строки витрины — тот кусок разметки, в котором живёт бейдж. */
const typeCell = (() => {
  const at = SOURCE.connectors.indexOf('<span data-slot="corp-type-cell">')
  expect(at, "ячейка «Тип» на витрине не найдена").toBeGreaterThan(-1)
  return SOURCE.connectors.slice(at, SOURCE.connectors.indexOf("</span>", SOURCE.connectors.indexOf("<Tag", at)))
})()

describe("бейдж способа подключения (S-V22, ревизия 1.14; AC-359)", () => {
  const STATES = [
    { state: "connected", status: "ok" },
    { state: "lost", status: "ok" },
    { state: "failed", status: "unavailable" },
    { state: "never", status: "needs_auth" },
  ]
  const HUB = [{ hub_url: "https://hub.corp" }, {}]

  test("AC-359: facade — «Через Hub», native — «Напрямую», без mode и вне перечисления — «Локальный»", () => {
    expect(connectModeKey({ mode: "facade" })).toBe("corp.connectors.viaHub")
    expect(connectModeKey({ mode: "native" })).toBe("corp.connectors.viaDirect")
    expect(connectModeKey({})).toBe("corp.connectors.viaLocal")
    expect(connectModeKey({ mode: "gateway" })).toBe("corp.connectors.viaLocal")

    // Тексты — те самые, что названы решением заказчика.
    const texts = ru as Record<string, string>
    expect(texts["corp.connectors.viaHub"]).toBe("Через Hub")
    expect(texts["corp.connectors.viaDirect"]).toBe("Напрямую")
    expect(texts["corp.connectors.viaLocal"]).toBe("Локальный")
    for (const key of ["viaHub", "viaDirect", "viaLocal"])
      expect((en as Record<string, string>)[`corp.connectors.${key}`], key).toBeTruthy()
  })

  test("AC-359: у одной и той же карточки бейдж одинаков во всех состояниях и в обеих сборках", () => {
    for (const mode of ["facade", "native", undefined, "gateway"]) {
      const seen = new Set<string>()
      for (const state of STATES)
        for (const hub of HUB)
          for (const blocked of [true, false])
            seen.add(connectModeKey({ ...state, ...hub, blocked, ...(mode === undefined ? {} : { mode }) } as any))
      expect(seen.size, `mode=${mode}: ${[...seen].join(" / ")}`).toBe(1)
    }
  })

  test("AC-359, ГРАНИЦА: «записи в каталоге нет» и «режим вне перечисления» — оба «Локальный»", () => {
    expect(connectModeKey({})).toBe(connectModeKey({ mode: "gateway" }))
    expect(connectModeKey({ mode: undefined })).toBe(connectModeKey({ mode: "" }))
  })

  test("AC-359: бейдж стоит рядом с колонкой «Тип» и рисуется всегда, без условий", () => {
    expect(typeCell).toContain("connectorType(card)")
    expect(typeCell).toContain('data-slot="corp-connect-mode"')
    expect(typeCell).toContain("connectModeKey(card)")
    // Ни одного условия внутри ячейки: состояние связи бейдж не прячет и не подменяет.
    expect(typeCell).not.toContain("<Show")
    expect(typeCell).not.toContain("card.state")
    expect(typeCell).not.toContain("card.status")
    // И ни одного условия НАД ячейкой — иначе бейдж пропадал бы в части состояний, а мера,
    // читающая только саму ячейку, этого не увидела бы.
    expect(showDepthAt(SOURCE.connectors, 'data-slot="corp-connectors-row"', 'data-slot="corp-type-cell"')).toBe(0)
  })

  test("AC-359: бейдж ничего не разрешает — набор действий его не спрашивает", () => {
    // Единственное употребление правила — сам бейдж; действия считаются по `connect_mode` (S-V16).
    const uses = SOURCE.connectors.split("connectModeKey(").length - 1
    expect(uses).toBe(2) // объявление + одно употребление в разметке
    expect(SOURCE.connector).not.toContain("connectModeKey")
  })
})

// ---------------------------------------------------------------- AC-361: описание абзацами

const descriptionParagraphs = new Function(
  "description",
  body(SOURCE.connector, "export function descriptionParagraphs("),
) as (description: string | undefined) => string[]

/** Блок описания страницы коннектора — от его охраны до закрытия. */
const descriptionBlock = (() => {
  const at = SOURCE.connector.indexOf("<Show when={descriptionParagraphs(")
  expect(at, "блок описания на странице коннектора не найден").toBeGreaterThan(-1)
  return SOURCE.connector.slice(at, SOURCE.connector.indexOf("</Show>", at))
})()

describe("описание страницы коннектора абзацами (S-D11, ревизия 1.14; AC-361)", () => {
  test("AC-361: два абзаца через пустую строку — два абзаца", () => {
    expect(descriptionParagraphs("Первый абзац.\n\nВторой абзац.")).toEqual(["Первый абзац.", "Второй абзац."])
  })

  test("AC-361: один абзац без пустых строк остаётся одним — одиночный перенос абзаца не начинает", () => {
    expect(descriptionParagraphs("Одна строка.")).toEqual(["Одна строка."])
    expect(descriptionParagraphs("Строка одна.\nСтрока два.")).toEqual(["Строка одна.\nСтрока два."])
  })

  test("AC-361: лишние пустые строки пустых абзацев не порождают", () => {
    expect(descriptionParagraphs("Раз.\n\n\n\nДва.\n\n   \n\nТри.")).toEqual(["Раз.", "Два.", "Три."])
    expect(descriptionParagraphs("\n\nРаз.\n\n")).toEqual(["Раз."])
  })

  test("AC-361: пустое и отсутствующее описание не дают ни одного абзаца", () => {
    expect(descriptionParagraphs("")).toEqual([])
    expect(descriptionParagraphs(undefined)).toEqual([])
    expect(descriptionParagraphs("\n\n   \n")).toEqual([])
  })

  test("AC-361: блок не рисуется вовсе, когда абзацев нет, — пустого места не остаётся", () => {
    // Охрана стоит НАД контейнером: пустой `div` с отступами на странице не появляется.
    expect(descriptionBlock.startsWith("<Show when={descriptionParagraphs(entry().description).length > 0}>")).toBe(true)
    const container = descriptionBlock.indexOf('data-slot="corp-connector-description"')
    expect(container).toBeGreaterThan(-1)
    expect(descriptionBlock.slice(0, container)).not.toContain("</div>")
    // Абзацы рисуются по одному на элемент, а не одной склеенной строкой.
    expect(descriptionBlock).toContain("<For each={descriptionParagraphs(entry().description)}>")
    expect(descriptionBlock).toContain("<p ")
    expect(descriptionBlock).not.toContain(".join(")
  })
})
