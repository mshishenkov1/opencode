import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Разрешимость CSS-токенов корп-окон в обеих темах (S-Q12, S-D12; AC-232, AC-235, AC-236).
 *
 * Тест, которого не хватало, чтобы поймать сломанный `SegmentedControlV2` (F50): прежние проверки
 * убеждались, что правило написано, а не что переменная во что-то разрешается. Приём — как в
 * `connectors-view.test.ts`: настоящие файлы тем и компонентов грузятся в документ happy-dom,
 * элементы монтируются там же, значения читаются через `getComputedStyle`. Сети и снимков экрана нет.
 *
 * Список переменных **собирается из файлов стилей**, а не перечисляется руками: иначе новый токен,
 * добавленный вместе с новым экраном, тест обошёл бы.
 *
 * Что нужно знать про happy-dom, чтобы читать этот файл:
 *   - значение переменной читается **пробой**: элементу ставится `--probe: var(--x, …)`, и обратно
 *     читается `--probe`. Пробовать `color` нельзя — happy-dom отбрасывает значения, не похожие на
 *     цвет, и токен размера или тени выглядел бы неразрешимым;
 *   - `@layer` happy-dom не разбирает, а `@media` внутри правила ломает разбор всего правила. Поэтому
 *     тексты тем нормализуются: слой разворачивается, а тёмная тема собирается **тем же способом,
 *     каким её различает сама тема** — раскрытием её `@media (prefers-color-scheme: dark)` и
 *     атрибутом `data-color-scheme="dark"` для `v2`. Ни одно объявление при этом не переписывается.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/tokens.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "..")
const ROOT = path.resolve(APP, "../../..")

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")

/** Файлы тем приложения — источник значений токенов в обеих ветках флага оформления. */
const THEME_FILES = [
  "packages/ui/src/styles/colors.css",
  "packages/ui/src/styles/theme.css",
  "packages/ui/src/v2/styles/colors.css",
  "packages/ui/src/v2/styles/theme.css",
]

/**
 * Компоненты, из которых построены корп-окна: витрина, экран входа, страница коннектора и экран
 * разрешений внутри неё. `dialog-shell.css` — корп-файл, остальные — общие.
 */
const COMPONENT_FILES = [
  "packages/ui/src/components/dialog.css",
  "packages/ui/src/v2/components/dialog-v2.css",
  "packages/ui/src/v2/components/tabs-v2.css",
  "packages/ui/src/v2/components/segmented-control-v2.css",
  "packages/ui/src/v2/components/select-v2.css",
  "packages/ui/src/components/list.css",
  "packages/ui/src/components/tag.css",
  "packages/ui/src/components/button.css",
  "packages/app/src/components/settings-v2/settings-v2.css",
  "packages/app/src/components/corp/dialog-shell.css",
]

const CORP_CSS = "packages/app/src/components/corp/dialog-shell.css"
const SEGMENTED_CSS = "packages/ui/src/v2/components/segmented-control-v2.css"

/** Семь переменных `SegmentedControlV2` без префикса `--v2-` (F50) — их чинят алиасы (S-D12). */
const SEGMENTED_ALIASES = [
  "--text-text-base",
  "--text-text-muted",
  "--background-bg-base",
  "--background-bg-layer-01",
  "--border-border-base",
  "--border-border-strong",
  "--border-border-focus",
]

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "")

/** Вырезает блок `{…}`, начинающийся с найденной позиции; `keep` — оставить ли его содержимое. */
function unwrap(css: string, pattern: RegExp, keep: boolean) {
  let out = css
  for (;;) {
    const at = out.search(pattern)
    if (at < 0) return out
    const open = out.indexOf("{", at)
    if (open < 0) return out
    let depth = 0
    let end = -1
    for (let index = open; index < out.length; index++) {
      if (out[index] === "{") depth += 1
      else if (out[index] === "}") {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    if (end < 0) return out
    out = out.slice(0, at) + (keep ? out.slice(open + 1, end) : "") + out.slice(end + 1)
  }
}

/** Текст темы для одной ветки: слой развёрнут, тёмный `@media` раскрыт или удалён целиком. */
function themeCss(dark: boolean) {
  return THEME_FILES.map((file) =>
    unwrap(
      unwrap(stripComments(read(file)), /@layer[^{]*\{/, true),
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/,
      dark,
    ),
  ).join("\n")
}

/** Полное выражение `var(--x)` или `var(--x, запас)` — запас сохраняется: он часть объявления. */
function varExpressions(css: string) {
  const found = new Map<string, string>()
  const text = stripComments(css)
  for (let at = text.indexOf("var("); at >= 0; at = text.indexOf("var(", at + 1)) {
    let depth = 0
    for (let index = at + 3; index < text.length; index++) {
      if (text[index] === "(") depth += 1
      else if (text[index] === ")") {
        depth -= 1
        if (depth === 0) {
          const expression = text.slice(at, index + 1)
          const name = /^var\(\s*(--[a-zA-Z0-9_-]+)/.exec(expression)?.[1]
          if (name) found.set(expression, name)
          break
        }
      }
    }
  }
  return found
}

/** Объявлена ли переменная в этом же файле — `--x: …` или `@property --x`. */
function declaredIn(css: string, name: string) {
  const text = stripComments(css)
  return new RegExp(`(^|[;{\\s])${name}\\s*:`).test(text) || text.includes(`@property ${name}`)
}

interface Token {
  /** Полное выражение из файла — его и пробуем. */
  expression: string
  name: string
  file: string
}

/**
 * Токены темы: переменные, которые компонент **берёт снаружи**. Переменная, объявленная в том же
 * файле, — внутренняя переменная компонента (`--menu-v2-accent`, `--bottom-fade`): её значение
 * компонент задаёт сам на своём же элементе, и тема за неё не отвечает.
 */
const themeTokens: Token[] = []
const localTokens: Token[] = []
for (const file of COMPONENT_FILES) {
  const css = read(file)
  for (const [expression, name] of varExpressions(css))
    (declaredIn(css, name) ? localTokens : themeTokens).push({ expression, name, file })
}

/**
 * Монтирует корп-окно и читает значение каждого выражения. `corpCss` подменяем, чтобы проверить
 * приёмочное свойство теста (AC-236): без алиасов он обязан падать.
 */
function resolve(tokens: Token[], dark: boolean, corpCss: string = read(CORP_CSS)) {
  const components = COMPONENT_FILES.map((file) => stripComments(file === CORP_CSS ? corpCss : read(file))).join("\n")
  document.head.innerHTML = `<style>${themeCss(dark)}</style><style>${components}</style>`
  document.documentElement.setAttribute("data-color-scheme", dark ? "dark" : "light")

  const probes = tokens
    .map((token, at) => `<span data-slot="probe" id="probe-${at}" style="--probe: ${token.expression}"></span>`)
    .join("")
  // Кнопка `variant="secondary"` в состоянии `disabled` — внутри корп-окна и вне его: по ней видно
  // и то, что алиас `--surface-disabled` работает, и то, что он не протекает наружу (AC-276, AC-277).
  const disabledButton = (id: string) =>
    `<button data-component="button" data-variant="secondary" id="${id}" disabled
       style="--probe: var(--surface-disabled)"></button>`
  document.body.innerHTML = `
    <div data-component="dialog-v2" data-size="x-large">
      <div data-slot="dialog-container">
        <div data-slot="dialog-content" class="corp-dialog corp-dialog-v2">
          <div data-slot="dialog-body">
            <div data-slot="segmented-control-v2">${probes}</div>
            ${disabledButton("button-inside")}
          </div>
        </div>
      </div>
    </div>
    <span id="outside" style="--probe: var(--text-text-base)"></span>
    ${disabledButton("button-outside")}`

  return tokens.map((token, at) => ({
    ...token,
    value: getComputedStyle(document.getElementById(`probe-${at}`)!).getPropertyValue("--probe"),
  }))
}

const unresolved = (dark: boolean, corpCss?: string) =>
  resolve(themeTokens, dark, corpCss).filter((token) => token.value.trim() === "")

describe("корп-окна — список токенов собран из файлов стилей (S-Q12; AC-235)", () => {
  test("AC-235: переменные вычитаны из CSS, а не перечислены в тесте", () => {
    // Семь переменных `SegmentedControlV2` попадают в список потому, что встречаются в его файле, —
    // ни одна из них в тесте не названа как источник списка.
    const own = [...varExpressions(read(SEGMENTED_CSS)).values()]
    expect([...new Set(own)].sort()).toEqual([...SEGMENTED_ALIASES].sort())
    for (const name of SEGMENTED_ALIASES) expect(themeTokens.map((token) => token.name)).toContain(name)
    // Список нетривиален и покрывает все перечисленные файлы корп-окон.
    expect(new Set(themeTokens.map((token) => token.name)).size).toBeGreaterThan(40)
    for (const file of COMPONENT_FILES)
      expect(
        [...themeTokens, ...localTokens].map((token) => token.file),
        file,
      ).toContain(file)
  })

  test("AC-235: значение var(--x, запас) проверяется по факту разрешения, а не по наличию запаса", () => {
    const withFallback = themeTokens.filter((token) => token.expression.includes(","))
    // Запас в выражении сохранён — иначе проверка сообщала бы о дефекте там, где его нет.
    for (const token of withFallback) expect(token.expression).toMatch(/^var\(\s*--[a-zA-Z0-9_-]+\s*,/)
    const resolved = resolve(withFallback, false)
    for (const token of resolved) expect(token.value.trim(), `${token.name} (${token.file})`).not.toBe("")
  })

  test("AC-235: обе темы действительно разные — тёмная ветка не повторяет светлую", () => {
    const light = resolve(themeTokens, false)
    const dark = resolve(themeTokens, true)
    const different = light.filter((token, at) => token.value !== dark[at]!.value)
    expect(different.length, "тёмная тема не отличается от светлой — проверена одна и та же").toBeGreaterThan(5)
  })
})

describe("корп-окна — каждый токен разрешается в обеих темах (S-Q12; AC-235)", () => {
  for (const dark of [false, true]) {
    test(`AC-235: ${dark ? "тёмная" : "светлая"} тема — неразрешимых переменных нет`, () => {
      const bad = unresolved(dark)
      // Провал называет каждую неразрешимую переменную и файл, в котором она встретилась.
      expect(bad.map((token) => `${token.name} (${token.file})`)).toEqual([])
    })
  }
})

/**
 * Приёмочное свойство теста (S-Q12): он обязан падать на состоянии `segmented-control-v2.css` до
 * того, как в корп-CSS появятся алиасы. Проверяется не рассказом, а делом — тем же прогоном по
 * тексту `dialog-shell.css` с вырезанным блоком алиасов.
 */
describe("корп-окна — тест ловит сломанный SegmentedControlV2 (S-Q12, S-D12; AC-236)", () => {
  const corpCss = read(CORP_CSS)
  const withoutAliases = corpCss.replace(/\.corp-dialog,\s*\n\.corp-dialog-v2\s*\{[^}]*\}/, "")

  test("AC-236: блок алиасов из корп-CSS вырезан — значит, есть что вырезать", () => {
    expect(withoutAliases).not.toBe(corpCss)
    for (const name of SEGMENTED_ALIASES) expect(withoutAliases).not.toContain(`${name}: var(--v2`)
  })

  test("AC-236: без алиасов тест падает и называет каждую из семи переменных", () => {
    for (const dark of [false, true]) {
      const bad = unresolved(dark, withoutAliases).map((token) => token.name)
      for (const name of SEGMENTED_ALIASES) expect(bad, `${name}, dark=${dark}`).toContain(name)
    }
  })

  test("AC-236: с алиасами семь переменных разрешаются в обеих темах", () => {
    for (const dark of [false, true]) {
      const seven = resolve(
        themeTokens.filter((token) => SEGMENTED_ALIASES.includes(token.name)),
        dark,
      )
      expect(seven.length).toBeGreaterThan(0)
      for (const token of seven) expect(token.value.trim(), `${token.name}, dark=${dark}`).not.toBe("")
    }
  })
})

describe("корп-окна — алиасы живут в корп-CSS, а не в packages/ui (S-D12; AC-232)", () => {
  const corpCss = read(CORP_CSS)

  test("AC-232: семь алиасов объявлены на контейнере корп-окна и указывают на --v2-*", () => {
    // Алиас указывает на одноимённый токен темы v2: `--text-text-base` → `--v2-text-text-base`.
    for (const name of SEGMENTED_ALIASES) expect(corpCss).toContain(`${name}: var(--v2${name.slice(1)});`)
    const block = /\.corp-dialog,\s*\n\.corp-dialog-v2\s*\{([^}]*)\}/.exec(corpCss)
    expect(block, "блок алиасов объявлен не на контейнере корп-окна").not.toBeNull()
    for (const name of SEGMENTED_ALIASES) expect(block![1]!).toContain(name)
  })

  test("AC-232: сам segmented-control-v2.css не изменён — правка живёт снаружи", () => {
    const segmented = read(SEGMENTED_CSS)
    expect(segmented).not.toContain("corp-dialog")
    // Компонент по-прежнему просит переменные без префикса — чинит их алиас, а не правка файла.
    for (const name of SEGMENTED_ALIASES) expect(segmented).toContain(`var(${name})`)
    expect(segmented).not.toContain("--v2-text-text-base")
  })

  test("AC-232: ни один CSS-файл packages/ui не изменён относительно базового тега", () => {
    const base = fs.readFileSync(path.join(ROOT, "corp/upstream-base"), "utf8").trim()
    const proc = Bun.spawnSync({
      cmd: ["git", "diff", "--name-only", base, "--", "packages/ui"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode, proc.stderr.toString()).toBe(0)
    const changed = proc.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    expect(changed.filter((file) => file.endsWith(".css"))).toEqual([])
  })

  test("AC-232: новых строк в corp/patches.md ревизия 1.10 не добавила для packages/ui", () => {
    const patches = fs.readFileSync(path.join(ROOT, "corp/patches.md"), "utf8")
    const listed = patches
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => /^`([^`]+)`$/.exec(line.split("|")[1]?.trim() ?? "")?.[1])
      .filter((file): file is string => file !== undefined)
    expect(listed).not.toContain(SEGMENTED_CSS)
    // Единственная строка `packages/ui` — глиф `mcp` ревизии 1.6 (S-D2a); CSS среди них нет.
    expect(listed.filter((file) => file.startsWith("packages/ui/"))).toEqual(["packages/ui/src/v2/components/icon.tsx"])
  })

  test("S-D12: алиасы ограничены поддеревом корп-окна и наружу не протекают", () => {
    resolve([], false)
    const outside = getComputedStyle(document.getElementById("outside")!).getPropertyValue("--probe")
    expect(outside.trim()).toBe("")
  })
})

/**
 * Восьмой алиас и граница приёма (S-D12, S-Q12, D-47, F57; AC-276, AC-277).
 *
 * `--surface-disabled` просит `button.css` в правиле `&:disabled` варианта `secondary`, и не
 * объявляет ни одна тема (BUG-I10-001). Микроревизия 1.11.1 закрывает пробел тем же приёмом, что и
 * семь переменных `SegmentedControlV2`, — алиасом на контейнере корп-окна, — и **называет границу
 * приёма явно**: вне корп-окна переменная по-прежнему не разрешается. Оба утверждения проверяются
 * делом, потому что второе легко нарушить, объявив алиас на `:root`.
 */
describe("корп-окна — восьмой алиас --surface-disabled (S-D12, S-Q12; AC-276, AC-277)", () => {
  const corpCss = read(CORP_CSS)
  const DISABLED = "--surface-disabled"

  test("AC-276: алиас объявлен в корп-CSS на контейнере корп-окна вместе с семью прежними", () => {
    const block = /\.corp-dialog,\s*\n\.corp-dialog-v2\s*\{([^}]*)\}/.exec(corpCss)
    expect(block, "блок алиасов объявлен не на контейнере корп-окна").not.toBeNull()
    expect(block![1]!).toContain(`${DISABLED}: var(--surface-weak);`)
    // Прежние семь никуда не делись — алиасов ровно восемь, и все в одном блоке.
    for (const name of SEGMENTED_ALIASES) expect(block![1]!, name).toContain(`${name}: var(`)
    const declared = [...block![1]!.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1]!)
    expect(declared.sort()).toEqual([...SEGMENTED_ALIASES, DISABLED].sort())
  })

  test("AC-276: переменная и фон отключённой кнопки непусты в обеих темах", () => {
    for (const dark of [false, true]) {
      resolve([], dark)
      const inside = getComputedStyle(document.getElementById("button-inside")!)
      expect(inside.getPropertyValue("--probe").trim(), `dark=${dark}`).not.toBe("")
      // Токен взят соседним объявленным токеном той же группы, а не выдуман: у него есть значение.
      expect(inside.getPropertyValue("--probe").trim(), `dark=${dark}`).not.toBe("var(--surface-weak)")
    }
  })

  test("AC-276: значение алиаса действительно приходит из темы и различается между темами", () => {
    resolve([], false)
    const light = getComputedStyle(document.getElementById("button-inside")!).getPropertyValue("--probe")
    resolve([], true)
    const dark = getComputedStyle(document.getElementById("button-inside")!).getPropertyValue("--probe")
    expect(light.trim()).not.toBe("")
    expect(dark.trim()).not.toBe("")
    expect(light).not.toBe(dark)
  })

  test("AC-277: вне контейнера корп-окна переменная не разрешается — алиас не протекает", () => {
    for (const dark of [false, true]) {
      resolve([], dark)
      const outside = getComputedStyle(document.getElementById("button-outside")!)
      expect(outside.getPropertyValue("--probe").trim(), `dark=${dark}`).toBe("")
      // Та же граница у семи прежних алиасов — она общая, а не частный случай восьмого.
      expect(
        getComputedStyle(document.getElementById("outside")!).getPropertyValue("--probe").trim(),
        `dark=${dark}`,
      ).toBe("")
    }
  })

  test("AC-277: алиас не объявлен на :root — иначе он молча изменил бы вид всего приложения", () => {
    // Ни в корп-CSS, ни в темах приложения объявления нет: пробел upstream замаскирован в корп-окнах,
    // а не починен (D-47).
    expect(corpCss).not.toMatch(/:root\s*\{[^}]*--surface-disabled/)
    for (const file of THEME_FILES) expect(read(file), file).not.toContain(`${DISABLED}:`)
  })

  test("AC-277: область проверки AC-235 не сужена — переменная осталась в общем списке токенов", () => {
    const names = themeTokens.map((token) => token.name)
    expect(names).toContain(DISABLED)
    // И проверяется тем же способом, что все прочие: она в наборе, по которому идёт AC-235.
    expect(unresolved(false).map((token) => token.name)).not.toContain(DISABLED)
    expect(unresolved(true).map((token) => token.name)).not.toContain(DISABLED)
  })

  test("AC-276: ни один файл packages/ui не изменён и новых строк в corp/patches.md нет", () => {
    const base = fs.readFileSync(path.join(ROOT, "corp/upstream-base"), "utf8").trim()
    const proc = Bun.spawnSync({
      cmd: ["git", "diff", "--name-only", base, "--", "packages/ui"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode, proc.stderr.toString()).toBe(0)
    const changed = proc.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    // Правка живёт снаружи: ни button.css, ни любой другой CSS packages/ui не тронут.
    expect(changed.filter((file) => file.endsWith(".css"))).toEqual([])
    expect(changed).not.toContain("packages/ui/src/components/button.css")

    const patches = fs.readFileSync(path.join(ROOT, "corp/patches.md"), "utf8")
    expect(patches).not.toContain("packages/ui/src/components/button.css")
    expect(patches).not.toContain(SEGMENTED_CSS)
  })
})
