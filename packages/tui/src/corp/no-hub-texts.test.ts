import { describe, expect, test } from "bun:test"
import path from "path"
import { dictionaries } from "./i18n"

/**
 * В сборке без Hub слово «Hub» не показывается нигде и в терминале (S-I1, S-C5, S-V9, D-43;
 * AC-273, AC-275, AC-278).
 *
 * Паритет с Desktop проверяется тем же способом: матрица ветвей прогоняется по **отрисованному
 * тексту** в обоих языках, ключ каждой ветви выбирает сам код витрины (тела мемо и функций берутся
 * из исходника и исполняются как есть), а перечни состояний и классов ошибок читаются из тех же
 * перечислимых типов, которыми они объявлены в коде.
 *
 * Запуск: `bun --cwd packages/tui test src/corp/no-hub-texts.test.ts`.
 */

const DIALOG = path.resolve(import.meta.dirname, "../component/corp/dialog-connectors.tsx")
const source = await Bun.file(DIALOG).text()
const LOGIN = path.resolve(import.meta.dirname, "../component/corp/dialog-corp-login.tsx")
const loginSource = await Bun.file(LOGIN).text()
const SCHEMA = path.resolve(import.meta.dirname, "../../../opencode/src/corp/schema.ts")
const schemaSource = await Bun.file(SCHEMA).text()

/** Снимает TypeScript с извлечённого текста: `new Function` разбирает JavaScript. */
const js = (text: string) =>
  text
    .replace(/\s+as\s+`(?:[^`\\]|\\.)*`/g, "")
    .replace(/\bas const\b/g, "")
    .replace(/\s+as\s+[A-Za-z_$][\w$.]*(?:<[^>\n]*>)?(?:\[\])?/g, "")
    .replace(/\b(const|let)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, "$1 $2 =")
    .replace(/([\])\w])!(?=[\s;,)\].])/g, "$1")

function body(marker: string) {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker} в витрине TUI`).toBeGreaterThan(-1)
  const open = source.indexOf("{", source.indexOf(")", at))
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth += 1
    else if (source[index] === "}") {
      depth -= 1
      if (depth === 0) return js(source.slice(open + 1, index))
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

/** Таблица ключей из исходника (`const X = { … } as const`) — исполняется как есть. */
function table(name: string): Record<string, string | undefined> {
  const at = source.indexOf(`const ${name} = {`)
  expect(at, `таблица ${name} не найдена`).toBeGreaterThan(-1)
  const open = source.indexOf("{", at)
  const close = source.indexOf("} as const", open)
  return new Function("return {" + source.slice(open + 1, close) + "}")() as Record<string, string | undefined>
}

/** Значения перечислимого типа — прямо из объявления в коде сервера, а не выписанные в тест. */
function literals(name: string): string[] {
  const found = new RegExp(`${name}\\s*=\\s*Schema\\.Literals\\((\\[[^\\]]*\\])\\)`).exec(schemaSource)
  expect(found, `перечисление ${name} не найдено`).not.toBeNull()
  return new Function("return " + found![1]!)() as string[]
}

const CARD_STATES = literals("export const CardState")
const CARD_STATUSES = literals("export const CardStatus")
const SERVER_MODES = literals("export const ServerMode")
/** Классы ошибок подключения (S-V19) — из их единственного объявления в `corp/errors.ts`. */
const ERROR_CLASSES = new Function(
  "return " +
    /export const ERROR_CLASSES = (\[[^\]]*\])/.exec(
      await Bun.file(path.resolve(import.meta.dirname, "../../../opencode/src/corp/errors.ts")).text(),
    )![1]!,
)() as string[]

const STATUS_KEY = table("STATUS_KEY")
const STATE_KEY = table("STATE_KEY")
const TAB_EMPTY_KEY = table("TAB_EMPTY_KEY")

type Dict = Record<string, string>

/** Ветви, ключ которых выбирает сам код витрины, — для одной сборки и одного языка. */
function branches(hub: boolean, dict: Dict): { name: string; text: string }[] {
  const t = (key: string) => {
    const value = dict[key]
    expect(value, `ключ ${key} отсутствует в словаре TUI`).toBeString()
    return value!
  }
  const format = (key: string, values: Record<string, unknown>) =>
    t(key).replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      values[name] === undefined ? match : String(values[name]),
    )
  const errorText = (code: string | undefined) => (code ? t(`error.${code}`) : t("error.unknown"))
  const connectErrorText = (cls: string | undefined) => {
    const key = `error.connect.${cls ?? "unknown"}`
    return key in dict ? t(key) : t("error.connect.unknown")
  }
  const hubConfigured = (view: unknown) => (view as { hub_configured?: boolean } | undefined)?.hub_configured !== false

  const sourceDown = new Function("view", "t", "errorText", "hubConfigured", body("function sourceDown(")) as (
    view: () => unknown,
    t: (key: string) => string,
    errorText: (code: string | undefined) => string,
    hubConfigured: (view: unknown) => boolean,
  ) => string

  const bannerOf = new Function("view", "t", "errorText", "hubConfigured", "sourceDown", body("const banner = createMemo(")) as (
    ...args: unknown[]
  ) => string | undefined
  const emptyOf = new Function(
    "view",
    "loading",
    "t",
    "format",
    "errorText",
    "hubConfigured",
    "sourceDown",
    "tab",
    "TAB_EMPTY_KEY",
    body("const empty = createMemo("),
  ) as (...args: unknown[]) => string | undefined

  const withHub = (data: Record<string, unknown> | undefined) =>
    data === undefined ? undefined : { hub_configured: hub, ...data }
  const down = (data: Record<string, unknown> | undefined) =>
    sourceDown(() => withHub(data), t, errorText, hubConfigured)
  const banner = (data: Record<string, unknown>) =>
    bannerOf(() => withHub(data), t, errorText, hubConfigured, () => down(data))
  const empty = (data: Record<string, unknown> | undefined, tab = "all") =>
    emptyOf(
      () => withHub(data),
      () => false,
      t,
      format,
      errorText,
      hubConfigured,
      () => down(data),
      () => tab,
      TAB_EMPTY_KEY,
    )

  const one = [{ alias: "tag" }]
  const list: { name: string; text: string }[] = []
  const push = (name: string, text: string | undefined) => {
    expect(text, `ветвь «${name}» не дала текста`).toBeString()
    list.push({ name, text: text! })
  }

  // Шесть пустых состояний (S-V12).
  push("S-V12 состояние 1 «Каталог пуст»", empty({ servers: [], dropped: [] }))
  push("S-V12 состояние 2 «Каталог не разобран»", empty({ servers: [], dropped: [{ reason: "alias" }] }))
  push("S-V12 состояние 3 «источник недоступен»", empty({ servers: [], hub_error: "hub_unavailable" }))
  push("S-V12 состояние 4 «Требуется вход»", empty({ servers: [], hub_error: "unauthorized" }))
  push("S-V12 состояние 5 «вкладка Подключённые»", empty({ servers: one }, "connected"))
  push("S-V12 состояние 6 «вкладка Неподключённые»", empty({ servers: one }, "not_connected"))
  // Баннер над непустым списком: свежая ошибка и данные из кэша.
  push("баннер: источник недоступен", banner({ servers: one, hub_error: "hub_unavailable" }))
  push("баннер: данные из кэша", banner({ servers: one, hub_error: "hub_unavailable", cached_at: 1_700_000_000_000 }))
  // Предупреждение о неполном каталоге — оно про дефект данных и есть в обеих сборках.
  push("предупреждение о неполном каталоге", format("connectors.partial", { dropped: 2 }))
  // Четыре состояния карточки (S-V16) и строка 1 таблицы S-V6 — по перечислениям из кода.
  for (const status of CARD_STATUSES) push(`строка витрины status=${status}`, t(STATUS_KEY[status]!))
  for (const state of CARD_STATES) {
    const key = STATE_KEY[state]
    if (key) push(`строка витрины state=${state}`, t(key))
    else list.push({ name: `строка витрины state=${state}`, text: "" })
  }
  // Оба способа подключения (S-V7).
  for (const mode of SERVER_MODES)
    push(`подключение mode=${mode}`, mode === "facade" && !hub ? t("connectors.facadeNeedsHub") : t("connectors.connect"))
  // Пять видов модели прав (S-V9), включая неразобранную.
  push("права: вид не разобран", t(hub ? "connectors.permissionsUnavailable" : "connectors.permissionsUnavailableNoHub"))
  if (!hub) push("права: вид Hub-зависимый, Hub нет", t("connectors.permissionsNeedHub"))
  for (const key of [
    "permissions.title",
    "permissions.allow",
    "permissions.ask",
    "permissions.deny",
    "permissions.allowAll",
    "permissions.denyAll",
    "permissions.mixed",
    "permissions.restTitle",
    "permissions.restDescription",
  ])
    push(`права: вид permission_groups, ${key}`, t(key))
  // Экран входа (S-C5).
  if (!hub) push("экран входа без Hub", t("login.needsHub"))
  // Подтверждение «Убрать из списка» (S-V17).
  push("подтверждение «Убрать из списка»", t("connectors.forgetConfirm"))
  // Четыре класса ошибок подключения (S-V19) — по перечислению из кода.
  for (const cls of ERROR_CLASSES) push(`ошибка подключения ${cls}`, connectErrorText(cls))

  return list
}

const DICTS: Record<string, Dict> = { ru: dictionaries.ru, en: dictionaries.en }

describe("tui/corp — сборка без Hub не показывает слово «Hub» (S-I1, D-43; AC-275)", () => {
  for (const [locale, dict] of Object.entries(DICTS)) {
    test(`AC-275: ${locale} — ни одна ветвь интерфейса TUI не показывает «Hub»`, () => {
      const found = branches(false, dict).filter((branch) => /hub/i.test(branch.text))
      expect(found.map((branch) => `${branch.name}: ${branch.text}`)).toEqual([])
    })
  }

  test("AC-275: матрица покрывает все перечислимые типы из кода", () => {
    const list = branches(false, DICTS.ru!)
    expect(list.length).toBeGreaterThan(30)
    for (const status of CARD_STATUSES)
      expect(list.some((branch) => branch.name.includes(`status=${status}`)), status).toBe(true)
    for (const state of CARD_STATES)
      expect(list.some((branch) => branch.name.includes(`state=${state}`)), state).toBe(true)
    for (const mode of SERVER_MODES)
      expect(list.some((branch) => branch.name.includes(`mode=${mode}`)), mode).toBe(true)
    for (const cls of ERROR_CLASSES)
      expect(list.some((branch) => branch.name.includes(`ошибка подключения ${cls}`)), cls).toBe(true)
    // Таблицы витрины совпадают с перечислениями сервера ключ в ключ — новое значение валит тест.
    expect(Object.keys(STATUS_KEY).sort()).toEqual([...CARD_STATUSES].sort())
    expect(Object.keys(STATE_KEY).sort()).toEqual([...CARD_STATES].sort())
    // Шесть пустых состояний — все шесть и попарно различимы.
    const empties = list.filter((branch) => branch.name.startsWith("S-V12 состояние"))
    expect(empties.length).toBe(6)
    expect(new Set(empties.map((branch) => branch.text)).size).toBe(6)
  })

  test("AC-275: те же ветви в сборке С Hub показывают прежние тексты", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      const withHub = branches(true, dict)
      const third = withHub.find((branch) => branch.name === "S-V12 состояние 3 «источник недоступен»")!
      expect(third.text, locale).toContain(dict["connectors.hubDown"]!)
      const permissions = withHub.find((branch) => branch.name === "права: вид не разобран")!
      expect(permissions.text, locale).toBe(dict["connectors.permissionsUnavailable"])
      const facade = withHub.find((branch) => branch.name === "подключение mode=facade")!
      expect(facade.text, locale).toBe(dict["connectors.connect"])
    }
  })
})

describe("tui/corp — экран входа без Hub называет причину (S-C5; AC-273)", () => {
  test("AC-273: текст показан вместо формы входа и запроса на незаданный адрес", () => {
    expect(loginSource).toContain('t("login.needsHub")')
    const at = loginSource.indexOf('t("login.needsHub")')
    const guard = loginSource.slice(0, at)
    // Ветвь охраняется отдельным шагом экрана, а не рисуется поверх обычного.
    expect(guard.slice(guard.lastIndexOf("<Show"))).toContain('step().kind === "unavailable"')
    // И запрос на незаданный адрес не уходит: шаг ставится ДО вызова старта входа.
    const start = loginSource.slice(loginSource.indexOf("async function start("))
    const head = start.slice(0, start.indexOf("sdk.client.corp.login.start()"))
    expect(head).toContain('setStep({ kind: "unavailable" })')
    expect(head).toContain("return")
  })

  test("AC-273: ключ есть в обоих языках, значения непусты и различаются", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      expect(dict["login.needsHub"], locale).toBeString()
      expect(dict["login.needsHub"]!.trim().length, locale).toBeGreaterThan(0)
      expect(dict["login.needsHub"]!, locale).not.toMatch(/hub/i)
    }
    expect(DICTS.ru!["login.needsHub"]).not.toBe(DICTS.en!["login.needsHub"])
  })
})

describe("tui/corp — четыре текста прежних ревизий без слова «Hub» (AC-278)", () => {
  const KEYS = [
    "connectors.forgetConfirm",
    "error.connect.token_rejected",
    "error.connect.method_unavailable",
    "error.connect.hub_unreachable",
  ]

  test("AC-278: ни в одном из четырёх текстов нет слова «Hub», в обоих языках", () => {
    for (const [locale, dict] of Object.entries(DICTS))
      for (const key of KEYS) {
        expect(dict[key], `${key} в ${locale}`).toBeString()
        expect(dict[key]!, `${key} в ${locale}`).not.toMatch(/hub/i)
      }
  })

  test("AC-278: условных ключей на эти четыре случая не заведено", () => {
    for (const dict of Object.values(DICTS))
      for (const key of KEYS) {
        expect(Object.keys(dict)).not.toContain(`${key}NoHub`)
        expect(Object.keys(dict)).not.toContain(`${key}Hub`)
      }
  })

  test("AC-278: имя значения error_class hub_unreachable не изменено — AC-187 в силе", () => {
    expect(ERROR_CLASSES).toContain("hub_unreachable")
    for (const dict of Object.values(DICTS)) expect(dict["error.connect.hub_unreachable"]).toBeString()
  })

  test("AC-278: ключи, сохраняющие слово «Hub», в сборке без Hub недостижимы", () => {
    // Они есть в словаре — это законно, — но ни одна ветвь матрицы их не показывает.
    for (const dict of Object.values(DICTS)) {
      expect(dict["connectors.forgetHubFailed"]).toMatch(/hub/i)
      expect(dict["connectors.permissionsUnavailable"]).toMatch(/hub/i)
      expect(dict["connectors.hubDown"]).toMatch(/hub/i)
    }
    const texts = branches(false, DICTS.ru!).map((branch) => branch.text)
    for (const key of ["connectors.forgetHubFailed", "connectors.permissionsUnavailable", "connectors.hubDown"])
      expect(texts, key).not.toContain(DICTS.ru![key]!)
  })
})
