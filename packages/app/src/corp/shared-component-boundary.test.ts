import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { mergeProps, splitProps } from "solid-js"

/**
 * Граница правки общего компонента `SegmentedControlV2` (S-D12, D-69, ревизия 1.14; AC-372).
 *
 * Это сторож ПОЛИТИКИ, а не вида. Правка файла `packages/ui` принята заказчиком с названной ценой —
 * постоянным расхождением с upstream, которое переносит каждая синхронизация, — и смягчение, на
 * котором она принята, ровно одно: **без нового пропса файл ведёт себя как upstream**. Сторож ловит
 * нарушение именно этого: как только правка начнёт менять компонент там, где корп-код его не
 * просил, здесь красное.
 *
 * Отсюда и способ проверки: не «в исходнике есть слово thumb», а сравнение с САМИМ upstream. Обе
 * версии файла берутся из git по базовому тегу `corp/upstream-base` и сравниваются тремя мерами:
 *
 *   1. **правила стилей** — каждое правило upstream доехало с тем же телом, ни одно не удалено, а
 *      каждое добавленное ограничено селектором пропса (либо относится к элементу подложки,
 *      которого без пропса в дереве нет);
 *   2. **каскад** — одна и та же разметка БЕЗ `data-thumb` даёт одни и те же вычисленные свойства
 *      под стилями upstream и под корп-стилями. Это та же проверка с другой стороны: она видит и
 *      правило, потерявшее ограничение, и правило, добавленное мимо реестра селекторов;
 *   3. **поведение** — обе версии компонента ИСПОЛНЯЮТСЯ (мини-рендерер ниже) с одними и теми же
 *      пропами без `thumb`, и сравниваются разметка, реакция на нажатия и на клавиши. Добавленный
 *      атрибут разметки допускается — но только инертный: ни одно правило стилей `packages/ui` его
 *      не выбирает.
 *
 * Непустота меры проверяется отдельно: с пропсом обе версии обязаны РАЗОЙТИСЬ. Мера, которая
 * молчит и на включённом пропсе, ничего не стерегла бы.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/shared-component-boundary.test.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..")
const COMPONENT = "packages/ui/src/v2/components/segmented-control-v2"
const BASE = fs.readFileSync(path.join(ROOT, "corp/upstream-base"), "utf8").trim()

function git(args: string[]) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString()
}

/** Файл таким, каким он был в базовом теге, — точка отсчёта «как upstream». */
const upstreamFile = (suffix: string) => git(["show", `${BASE}:${COMPONENT}.${suffix}`])
const corpFile = (suffix: string) => fs.readFileSync(path.join(ROOT, `${COMPONENT}.${suffix}`), "utf8")

const CSS = { upstream: upstreamFile("css"), corp: corpFile("css") }
const TSX = { upstream: upstreamFile("tsx"), corp: corpFile("tsx") }

/** Признак пропса в разметке и в стилях: по нему и опознаётся «ограничено пропсом». */
const THUMB_SCOPE = ["[data-thumb]", "segmented-control-v2-thumb"]

// ---------------------------------------------------------------- разбор стилей

interface Rule {
  media: string
  selector: string
  declarations: Record<string, string>
}

function declarations(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  let depth = 0
  let start = 0
  const push = (chunk: string) => {
    const at = chunk.indexOf(":")
    if (at === -1) return
    const name = chunk.slice(0, at).trim()
    if (name.length > 0) result[name] = chunk.slice(at + 1).replace(/\s+/g, " ").trim()
  }
  for (let index = 0; index < body.length; index++) {
    if (body[index] === "(") depth += 1
    else if (body[index] === ")") depth -= 1
    else if (body[index] === ";" && depth === 0) {
      push(body.slice(start, index))
      start = index + 1
    }
  }
  push(body.slice(start))
  return result
}

function parseCss(text: string): Rule[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "")
  const rules: Rule[] = []
  const walk = (body: string, media: string) => {
    let index = 0
    while (index < body.length) {
      const brace = body.indexOf("{", index)
      if (brace === -1) break
      const head = body.slice(index, brace).replace(/\s+/g, " ").trim()
      let depth = 0
      let end = brace
      for (; end < body.length; end++) {
        if (body[end] === "{") depth += 1
        else if (body[end] === "}") {
          depth -= 1
          if (depth === 0) break
        }
      }
      const inner = body.slice(brace + 1, end)
      if (head.startsWith("@")) walk(inner, media === "" ? head : `${media} ${head}`)
      else rules.push({ media, selector: head, declarations: declarations(inner) })
      index = end + 1
    }
  }
  walk(clean, "")
  return rules
}

const RULES = { upstream: parseCss(CSS.upstream), corp: parseCss(CSS.corp) }
const ruleKey = (rule: Rule) => `${rule.media}||${rule.selector}`

describe("правка общего компонента — стили upstream не изменены (S-D12, D-69; AC-372)", () => {
  test("AC-372: базовый тег и оба файла на месте — сравнение идёт с настоящим upstream", () => {
    expect(BASE).toBe("v1.17.9")
    expect(CSS.upstream.length).toBeGreaterThan(0)
    expect(TSX.upstream.length).toBeGreaterThan(0)
    // Правка вообще есть: иначе весь этот файл проверял бы равенство файла самому себе.
    expect(CSS.corp).not.toBe(CSS.upstream)
    expect(TSX.corp).not.toBe(TSX.upstream)
  })

  test("AC-372: каждое правило upstream доехало с тем же телом и ни одно не удалено", () => {
    const corp = new Map(RULES.corp.map((rule) => [ruleKey(rule), rule]))
    for (const rule of RULES.upstream) {
      const same = corp.get(ruleKey(rule))
      expect(same, `правило upstream пропало: ${rule.selector}`).toBeDefined()
      expect(same!.declarations, rule.selector).toEqual(rule.declarations)
    }
  })

  test("AC-372: каждое ДОБАВЛЕННОЕ правило ограничено селектором пропса", () => {
    const upstream = new Set(RULES.upstream.map(ruleKey))
    const added = RULES.corp.filter((rule) => !upstream.has(ruleKey(rule)))
    expect(added.length, "правка стилей исчезла — сравнивать нечего").toBeGreaterThan(0)
    for (const rule of added)
      expect(
        THUMB_SCOPE.some((scope) => rule.selector.includes(scope)),
        `правило вне области пропса: ${rule.media} ${rule.selector}`,
      ).toBe(true)
  })

  test("AC-372: корп-класс в общий компонент не протёк", () => {
    for (const [name, text] of [
      ["css", CSS.corp],
      ["tsx", TSX.corp],
    ] as const) {
      expect(text, name).not.toContain("corp-")
      // Алиасы токенов корп-окна объявляются в корп-CSS, а не здесь (S-D12).
      expect(text, name).not.toContain("--text-text-base:")
      expect(text, name).not.toContain("--surface-weak:")
    }
  })
})

// ---------------------------------------------------------------- каскад без пропса

/** Имена свойств, названные хоть где-то в любом из двух файлов: сравнивается ровно то, что задано. */
const PROPERTIES = [
  ...new Set([...RULES.upstream, ...RULES.corp].flatMap((rule) => Object.keys(rule.declarations))),
].sort()

/** Разметка компонента: три сегмента, один нажат, один отключён. Пропс — атрибутом на корне. */
function markup(thumb: boolean) {
  return `<div data-component="segmented-control-v2" data-slot="segmented-control-v2"${thumb ? " data-thumb" : ""}>
      ${thumb ? '<span data-slot="segmented-control-v2-thumb"></span>' : ""}
      <button data-slot="segmented-control-v2-item" data-value="allow"><span data-slot="segmented-control-v2-item-label">Разрешить</span></button>
      <button data-slot="segmented-control-v2-item" data-value="ask" data-pressed><span data-slot="segmented-control-v2-item-label">Спрашивать</span></button>
      <button data-slot="segmented-control-v2-item" data-value="deny" disabled><span data-slot="segmented-control-v2-item-label">Запретить</span></button>
    </div>`
}

const PROBES = [
  '[data-slot="segmented-control-v2"]',
  '[data-slot="segmented-control-v2-item"]',
  '[data-slot="segmented-control-v2-item"][data-pressed]',
  '[data-slot="segmented-control-v2-item"]:disabled',
  '[data-slot="segmented-control-v2-item-label"]',
]

/**
 * Токены темы, названные любым из двух файлов, — каждому своё приметное значение.
 *
 * Без объявления `var(--…)` в вычисленных свойствах не разрешается, и разные значения выглядели бы
 * одинаково пустыми: сравнение прошло бы, ничего не сравнив.
 */
const TOKENS = [...new Set([...(CSS.upstream + CSS.corp).matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!))].sort()
const TOKEN_STYLE = `:root { ${TOKENS.map((name, at) => `${name}: rgb(${at + 1}, ${at + 1}, ${at + 1});`).join(" ")} }`

/** Вычисленные свойства всех проб под указанными стилями. */
function computed(css: string, thumb: boolean) {
  document.head.innerHTML = `<style>${TOKEN_STYLE}</style><style>${css}</style>`
  document.body.innerHTML = markup(thumb)
  const snapshot: Record<string, Record<string, string>> = {}
  for (const probe of PROBES) {
    const el = document.querySelector(probe) as HTMLElement | null
    expect(el, `не найдена проба ${probe}`).not.toBeNull()
    const style = getComputedStyle(el!)
    snapshot[probe] = Object.fromEntries(PROPERTIES.map((name) => [name, style.getPropertyValue(name)]))
  }
  return snapshot
}

describe("правка общего компонента — каскад без пропса как у upstream (S-D12; AC-372)", () => {
  test("AC-372: без пропса вычисленные свойства совпадают с upstream у каждой пробы", () => {
    expect(PROPERTIES.length).toBeGreaterThan(5)
    expect(computed(CSS.corp, false)).toEqual(computed(CSS.upstream, false))
  })

  test("AC-372, НЕПУСТОТА: с пропсом каскад обязан разойтись — иначе мера ничего не видит", () => {
    const withProp = computed(CSS.corp, true)
    const without = computed(CSS.corp, false)
    expect(withProp).not.toEqual(without)
    // Ровно то, ради чего пропс заведён: у нажатого сегмента собственный фон погашен.
    const pressed = '[data-slot="segmented-control-v2-item"][data-pressed]'
    expect(withProp[pressed]!["background"]).not.toBe(without[pressed]!["background"])
    // А у самих кнопок и подписи всё остальное осталось прежним — гашение ограничено фоном и тенью.
    for (const property of PROPERTIES)
      if (!["background", "box-shadow", "position", "z-index"].includes(property))
        expect(withProp[pressed]![property], property).toBe(without[pressed]![property])
  })
})

// ---------------------------------------------------------------- поведение без пропса

/**
 * Мини-рендерер (тот же приём, что в `connector-visuals.test.ts` и по той же причине:
 * `solid-js/web` в среде bun разрешается в серверную сборку, и настоящий `render` недоступен).
 *
 * Компонент исполняется своим циклом — тело, дерево, эффекты, тело ещё раз, — а состояние сигналов
 * переживает перерисовку, как оно переживает её в настоящем Solid. Подменены `createSignal`,
 * `createMemo`, `createEffect`/`onMount` и контекст; `mergeProps` и `splitProps` настоящие. Граница
 * меры названа: планировщик Solid ею не проверяется, зато обе сравниваемые версии компонента
 * исполняются ОДНИМ И ТЕМ ЖЕ рендерером, поэтому расхождение между ними — расхождение компонентов.
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

function makeRuntime() {
  let context: unknown
  return {
    createSignal(initial: unknown) {
      const at = cursor++
      const cell = (cells[at] ??= { value: initial })
      return [
        () => cell.value,
        (next: unknown) =>
          (cell.value = typeof next === "function" ? (next as (p: unknown) => unknown)(cell.value) : next),
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
    createContext: () => ({
      Provider: (props: Record<string, any>) => {
        const previous = context
        context = props.value
        const rendered = tree(props.children)
        context = previous
        return rendered
      },
    }),
    useContext: () => context,
    Show: (props: Record<string, any>) => {
      const when = props.when
      if (!when) return props.fallback
      const child = props.children
      return typeof child === "function" && child.length > 0 ? child(() => when) : child
    },
  }
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
      for (const [property, value] of Object.entries(raw as Record<string, string>)) el.style.setProperty(property, value)
      continue
    }
    if (key === "classList" && raw && typeof raw === "object") {
      for (const [name, on] of Object.entries(raw as Record<string, unknown>)) if (on && name) el.classList.add(name)
      continue
    }
    if (raw === false) {
      // `aria-*` со значением `false` — не отсутствие атрибута, а его значение: именно им
      // скринридер отличает ненажатый сегмент от элемента, у которого состояния нет вовсе.
      if (key.startsWith("aria-")) el.setAttribute(key, "false")
      continue
    }
    if (raw === undefined || raw === null) continue
    if (key === "disabled") {
      ;(el as HTMLButtonElement).disabled = true
      continue
    }
    el.setAttribute(key, raw === true && !key.startsWith("aria-") ? "" : String(raw))
  }
  for (const child of host.children) toDom(child, []).forEach((n) => el.appendChild(n))
  refs.forEach((fn) => fn())
  into.push(el)
  return into
}

const MODULES = {
  upstream: (() => {
    const runtime = makeRuntime()
    return { runtime, module: evalComponentModule(TSX.upstream, { "solid-js": runtime }) }
  })(),
  corp: (() => {
    const runtime = makeRuntime()
    return { runtime, module: evalComponentModule(TSX.corp, { "solid-js": runtime }) }
  })(),
}

/** Один и тот же вызов компонента у обеих версий: три сегмента, третий отключён. */
function mount(side: "upstream" | "corp", props: Record<string, unknown>) {
  const { module } = MODULES[side]
  cells = []
  const changes: (string | null)[] = []
  const paint = () => {
    cursor = 0
    effects = []
    const built = tree(
      module.SegmentedControlV2({
        ...props,
        onChange: (value: string | null) => changes.push(value),
        get children() {
          return [
            __h(module.SegmentedControlItemV2, { value: "allow" }, "Разрешить"),
            __h(module.SegmentedControlItemV2, { value: "ask" }, "Спрашивать"),
            __h(module.SegmentedControlItemV2, { value: "deny", disabled: true }, "Запретить"),
          ]
        },
      }),
    )
    document.body.innerHTML = ""
    const dom = toDom(built, [])[0] as HTMLElement
    document.body.appendChild(dom)
    effects.forEach((fn) => fn())
    return dom
  }
  // Два прохода: эффекты Solid выполняются после первой отрисовки, и их результат виден на второй.
  paint()
  let dom = paint()
  return {
    get dom() {
      return dom
    },
    changes,
    repaint() {
      dom = paint()
      return dom
    },
  }
}

const item = (dom: HTMLElement, value: string) =>
  dom.querySelector(`button[data-value="${value}"]`) ??
  dom.querySelectorAll("button")[["allow", "ask", "deny"].indexOf(value)]!

/** Разметка без атрибутов, которых у upstream нет: сравнивается то, что upstream действительно рисует. */
function shaped(dom: HTMLElement, drop: Set<string>): unknown {
  const attributes = [...dom.attributes]
    .filter((attr) => !drop.has(attr.name))
    .map((attr) => `${attr.name}=${attr.value}`)
    .sort()
  return {
    tag: dom.tagName,
    attributes,
    children: [...dom.children].map((child) => shaped(child as HTMLElement, drop)),
    text: dom.children.length === 0 ? dom.textContent : undefined,
  }
}

function attributeNames(dom: Element, into = new Set<string>()) {
  for (const attr of dom.attributes) into.add(attr.name)
  for (const child of dom.children) attributeNames(child, into)
  return into
}

describe("правка общего компонента — поведение без пропса как у upstream (S-D12, D-69; AC-372)", () => {
  test("AC-372: без пропса подложки нет вовсе — ни атрибута, ни элемента", () => {
    const corp = mount("corp", {})
    expect(corp.dom.hasAttribute("data-thumb")).toBe(false)
    expect(corp.dom.querySelector('[data-slot="segmented-control-v2-thumb"]')).toBeNull()
    // И `thumb={false}` даёт ровно то же: умолчание пропса — выключено.
    expect(mount("corp", { thumb: false }).dom.outerHTML).toBe(corp.dom.outerHTML)
  })

  test("AC-372: без пропса разметка отличается от upstream только ДОБАВЛЕННЫМИ атрибутами", () => {
    const upstream = mount("upstream", { defaultValue: "ask" }).dom
    const corp = mount("corp", { defaultValue: "ask" }).dom
    const added = [...attributeNames(corp)].filter((name) => !attributeNames(upstream).has(name))
    // Ни один атрибут upstream не пропал и не изменил значения.
    expect(shaped(corp, new Set(added))).toEqual(shaped(upstream, new Set()))
    // Добавленное — только то, без чего подложка не найдёт активный сегмент.
    expect(added.sort()).toEqual(["data-value"])
  })

  test("AC-372: добавленный атрибут ИНЕРТЕН — ни одно правило стилей packages/ui его не выбирает", () => {
    const upstream = mount("upstream", { defaultValue: "ask" }).dom
    const corp = mount("corp", { defaultValue: "ask" }).dom
    const added = [...attributeNames(corp)].filter((name) => !attributeNames(upstream).has(name))

    const files = fs
      .readdirSync(path.join(ROOT, "packages/ui/src"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".css"))
    expect(files.length).toBeGreaterThan(5)
    for (const file of files)
      for (const rule of parseCss(fs.readFileSync(path.join(ROOT, "packages/ui/src", file), "utf8")))
        for (const name of added)
          if (rule.selector.includes(`[${name}`))
            expect(
              THUMB_SCOPE.some((scope) => rule.selector.includes(scope)),
              `${file}: правило ${rule.selector} читает добавленный атрибут ${name}`,
            ).toBe(true)
  })

  /**
   * Один и тот же сценарий на одном наборе пропов — снимок всего, что видно снаружи.
   *
   * Наборов НЕСКОЛЬКО намеренно. Первая редакция этой меры гоняла сценарий на одном наборе
   * (`allowDeselect: true`) и **не упала** на своей же инъекции: снятая охрана
   * `if (!local.allowDeselect …)` на таком наборе ничего не меняет. Мера, не падающая на инъекции,
   * мерой не является, поэтому сценарий идёт по перебору: выбор снимается и не снимается, группа
   * отключена и нет, компонент управляемый и нет.
   */
  const script = (side: "upstream" | "corp", props: Record<string, unknown>) => {
    const view = mount(side, props)
    const pressed = () => [...view.dom.querySelectorAll("button")].map((b) => b.getAttribute("aria-pressed"))
    const enabled = () => [...view.dom.querySelectorAll("button")].map((b) => b.disabled)
    const log: unknown[] = [pressed(), enabled()]

    for (const value of ["allow", "allow", "deny", "ask"]) {
      item(view.dom, value).dispatchEvent(new Event("click", { bubbles: true }))
      view.repaint()
      log.push(pressed())
    }

    // Клавиатура: стрелка вправо переводит фокус на соседний доступный сегмент.
    const first = item(view.dom, "allow") as HTMLButtonElement
    first.focus()
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    log.push([...document.querySelectorAll("button")].indexOf(document.activeElement as HTMLButtonElement))
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    log.push([...document.querySelectorAll("button")].indexOf(document.activeElement as HTMLButtonElement))

    return { log, changes: view.changes }
  }

  /** Наборы пропов, на которых сценарий гоняется целиком. `thumb` ни в одном из них нет. */
  const CASES: Record<string, Record<string, unknown>> = {
    "выбор снимается": { defaultValue: "ask", allowDeselect: true },
    "выбор не снимается": { defaultValue: "ask", allowDeselect: false },
    "умолчание allowDeselect": { defaultValue: "ask" },
    "пустой начальный выбор": {},
    "группа отключена": { defaultValue: "ask", disabled: true },
    "управляемый пустым значением": { value: null },
    "управляемый значением": { value: "deny", allowDeselect: true },
  }

  for (const [name, props] of Object.entries(CASES))
    test(`AC-372: без пропса нажатия и клавиши работают как у upstream — ${name}`, () => {
      const upstream = script("upstream", props)
      const corp = script("corp", props)
      expect(corp.changes, name).toEqual(upstream.changes)
      expect(corp.log, name).toEqual(upstream.log)
    })

  test("AC-372: управляемое значение, меняемое снаружи, ведёт себя как у upstream", () => {
    // Перебор наборов выше держит значение неизменным, и правка, ломающая ИМЕННО управляемый
    // режим (например, подставляющая внутреннее состояние вместо `null`), на нём не видна.
    const script = (side: "upstream" | "corp") => {
      const holder: { value: string | null } = { value: "ask" }
      const view = mount(side, {
        allowDeselect: true,
        // `defaultValue` в управляемом режиме не действует — и это тоже поведение upstream:
        // подстановка внутреннего состояния вместо пустого значения на нём и видна.
        defaultValue: "deny",
        get value() {
          return holder.value
        },
      })
      const pressed = () => [...view.dom.querySelectorAll("button")].map((b) => b.getAttribute("aria-pressed"))
      const log: unknown[] = [pressed()]
      // Нажатие в управляемом режиме само выбор не двигает — его двигает владелец значения.
      item(view.dom, "allow").dispatchEvent(new Event("click", { bubbles: true }))
      log.push(pressed(), pressed() === undefined)
      for (const next of ["allow", null, "deny"] as (string | null)[]) {
        holder.value = next
        view.repaint()
        log.push(pressed())
      }
      return { log, changes: view.changes }
    }
    const upstream = script("upstream")
    const corp = script("corp")
    expect(corp.changes).toEqual(upstream.changes)
    expect(corp.log).toEqual(upstream.log)
    // Мера не пуста: пустое значение снимает выбор со ВСЕХ сегментов, а не оставляет прежний.
    expect(upstream.log[0]).toEqual(["false", "true", "false"])
    expect(upstream.log[4]).toEqual(["false", "false", "false"])
    expect(upstream.log[5]).toEqual(["false", "false", "true"])
  })

  test("AC-372: перебор не пуст — сценарий действительно разводит наборы между собой", () => {
    const snapshot = (name: string) => JSON.stringify(script("upstream", CASES[name]!))
    // Наборы дают РАЗНЫЕ снимки: сценарий, одинаковый на всех, не отличал бы и версии компонента.
    // Совпасть позволено ровно одной паре — и она названа ниже как проверка умолчания.
    expect(new Set(Object.keys(CASES).map(snapshot)).size).toBe(Object.keys(CASES).length - 1)
    expect(snapshot("умолчание allowDeselect")).toBe(snapshot("выбор не снимается"))
    expect(snapshot("умолчание allowDeselect")).not.toBe(snapshot("выбор снимается"))

    // И на главном наборе снимок именно тот, которого ждут от контрола: выбор встал, снялся,
    // отключённый сегмент промолчал, стрелка и End увели фокус.
    const main = script("upstream", CASES["выбор снимается"]!)
    expect(main.changes).toEqual(["allow", null, "ask"])
    expect(main.log[0]).toEqual(["false", "true", "false"])
    expect(main.log[1]).toEqual([false, false, true])
    expect(main.log.slice(-2)).toEqual([1, 1])

    // А набор без снятия выбора отличается от главного ровно тем, чем должен.
    expect(script("upstream", CASES["выбор не снимается"]!).changes).toEqual(["allow", "ask"])
  })

  test("AC-372, НЕПУСТОТА: с пропсом корп-версия обязана разойтись с upstream", () => {
    const corp = mount("corp", { defaultValue: "ask", thumb: true })
    expect(corp.dom.hasAttribute("data-thumb")).toBe(true)
    expect(corp.dom.querySelector('[data-slot="segmented-control-v2-thumb"]')).not.toBeNull()
    // Upstream пропса не знает и подложки не рисует ни при каком значении.
    const upstream = mount("upstream", { defaultValue: "ask", thumb: true })
    expect(upstream.dom.hasAttribute("data-thumb")).toBe(false)
    expect(upstream.dom.querySelector('[data-slot="segmented-control-v2-thumb"]')).toBeNull()
  })
})
