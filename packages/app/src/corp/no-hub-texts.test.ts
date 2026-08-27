import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { dict as en } from "../i18n/en"
import { dict as ru } from "../i18n/ru"

/**
 * В сборке без Hub слово «Hub» пользователю не показывается нигде (S-I1, S-C5, S-V9, D-43;
 * AC-273, AC-275, AC-278).
 *
 * Проверка идёт по **отрисованному тексту**, а не грепом по словарям: слово «Hub» в словаре законно
 * — оно показывается в сборке с Hub. Поэтому матрица ветвей интерфейса прогоняется дважды (сборка
 * без Hub и с ним) и в обоих языках, а ключ каждой ветви выбирает **сам код витрины и страницы
 * коннектора**: тела мемо и функций выбора ключа берутся из исходников и исполняются как есть.
 *
 * Полнота матрицы утверждена отдельно: перечни состояний карточки, статусов витрины, способов
 * подключения и классов ошибок читаются из тех же перечислимых типов, которыми они объявлены в коде,
 * поэтому новое значение без новой ветви матрицы валит тест.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/no-hub-texts.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "..")
const ROOT = path.resolve(APP, "../../..")
const read = (file: string) => fs.readFileSync(file, "utf8")

const viewSource = read(path.join(APP, "components/corp/dialog-connectors.tsx"))
const pageSource = read(path.join(APP, "components/corp/dialog-connector.tsx"))
const loginSource = read(path.join(APP, "components/corp/dialog-corp-login.tsx"))
const contextSource = read(path.join(APP, "context/corp.ts"))
const schemaSource = read(path.join(ROOT, "packages/opencode/src/corp/schema.ts"))

/** Значения перечислимого типа — прямо из объявления в коде, а не выписанные в тест. */
function literals(source: string, name: string): string[] {
  const found = new RegExp(`${name}\\s*=\\s*Schema\\.Literals\\((\\[[^\\]]*\\])\\)`).exec(source)
  expect(found, `перечисление ${name} не найдено`).not.toBeNull()
  return new Function("return " + found![1]!)() as string[]
}

const CARD_STATES = literals(schemaSource, "export const CardState")
const CARD_STATUSES = literals(schemaSource, "export const CardStatus")
const SERVER_MODES = literals(schemaSource, "export const ServerMode")
const ERROR_CLASSES = new Function(
  "return " + /const CONNECT_ERROR_CLASSES = (\[[^\]]*\])/.exec(contextSource)![1]!,
)() as string[]

/** Снимает TypeScript с извлечённого текста: `new Function` разбирает JavaScript. */
const js = (text: string) =>
  text
    // Утверждения типа (`as const`, `as \`шаблон\``, `as Имя`) и аннотации объявлений — это
    // TypeScript. Снимаются ровно они: на поведение не влияют, исполняется тот же код.
    .replace(/\s+as\s+`(?:[^`\\]|\\.)*`/g, "")
    .replace(/\bas const\b/g, "")
    .replace(/\s+as\s+[A-Za-z_$][\w$.]*(?:<[^>\n]*>)?(?:\[\])?/g, "")
    .replace(/\b(const|let)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, "$1 $2 =")
    .replace(/([\])\w])!(?=[\s;,)\].])/g, "$1")

/**
 * Тело мемо, записанного выражением: `createMemo(() => выражение)` без фигурных скобок. Возвращает
 * `return выражение` — тот же код, только пригодный для `new Function`.
 */
function expressionBody(source: string, marker: string) {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker}`).toBeGreaterThan(-1)
  const arrow = source.indexOf("=>", at)
  const open = source.indexOf("(", at)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "(") depth += 1
    else if (source[index] === ")") {
      depth -= 1
      // Висячая запятая перед закрывающей скобкой — след форматирования, а не часть выражения.
      if (depth === 0) return "return (" + js(source.slice(arrow + 2, index)).trim().replace(/,$/, "") + ")"
    }
  }
  throw new Error(`выражение ${marker} не закрыто`)
}

/** Тело функции или мемо по объявлению; из тела снимается TypeScript — исполняется тот же код. */
function body(source: string, marker: string) {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker}`).toBeGreaterThan(-1)
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
function table(source: string, name: string): Record<string, string | undefined> {
  const at = source.indexOf(`const ${name} = {`)
  expect(at, `таблица ${name} не найдена`).toBeGreaterThan(-1)
  const open = source.indexOf("{", at)
  const close = source.indexOf("} as const", open)
  return new Function("return {" + source.slice(open + 1, close) + "}")() as Record<string, string | undefined>
}

const STATE_KEY = table(viewSource, "STATE_KEY")
const STATUS_KEY = table(viewSource, "STATUS_KEY")

const statusKey = new Function("STATE_KEY", "STATUS_KEY", "card", body(viewSource, "export function statusKey(")) as (
  stateKey: typeof STATE_KEY,
  statusKey: typeof STATUS_KEY,
  card: { state: string; status: string },
) => string

const connectErrorKey = new Function(
  "CONNECT_ERROR_CLASSES",
  "errorClass",
  body(contextSource, "export function connectErrorKey("),
) as (classes: string[], errorClass: string | undefined) => string

const corpErrorKey = new Function("ERROR_KEYS", "code", body(contextSource, "export function corpErrorKey(")) as (
  keys: string[],
  code: string | undefined,
) => string
const ERROR_KEYS = new Function("return " + /const ERROR_KEYS = (\[[^\]]*\])/.exec(contextSource)![1]!)() as string[]

const permissionsUnavailableKey = new Function(
  "hubConfigured",
  body(pageSource, "export function permissionsUnavailableKey("),
) as (hubConfigured: boolean) => string

/** Подстановка `{{имя}}` — та же форма, что у словарей обеих оболочек (S-I1, S-I4). */
function render(dict: Record<string, string>, key: string, args: Record<string, unknown> = {}) {
  const text = dict[key]
  expect(text, `ключ ${key} отсутствует в словаре`).toBeString()
  return text!.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    args[name] === undefined ? match : String(args[name]),
  )
}

interface Branch {
  /** Что за ветвь — попадает в сообщение о провале. */
  name: string
  key: string
  args?: Record<string, unknown>
}

/** Ветви, ключ которых выбирает сам код витрины и страницы, — для одной сборки. */
function branches(hub: boolean, dict: Record<string, string>): Branch[] {
  const t = (key: string, args?: Record<string, unknown>) => render(dict, key, args)
  const language = { t }

  // Мемо записано выражением, а не блоком: берётся выражение целиком.
  const unavailableSource = new Function(
    "hubConfigured",
    "language",
    expressionBody(viewSource, "const unavailableSource = createMemo("),
  ) as (hubConfigured: () => boolean, language: { t: (key: string) => string }) => string
  const source = () => unavailableSource(() => hub, language)

  const emptyState = new Function(
    "catalog",
    "cards",
    "visible",
    "tab",
    "language",
    "dropped",
    "corpErrorKey",
    "unavailableSource",
    "hubConfigured",
    body(viewSource, "const empty = createMemo("),
  ) as (...args: unknown[]) => { text: string } | undefined

  const empty = (data: unknown, options: { tab?: string; dropped?: number; cards?: unknown[] } = {}) =>
    emptyState(
      { data, isLoading: false },
      () => options.cards ?? ((data as { servers?: unknown[] } | undefined)?.servers ?? []),
      () => [],
      () => options.tab ?? "all",
      language,
      () => options.dropped ?? 0,
      (code: string) => corpErrorKey(ERROR_KEYS, code),
      source,
      () => hub,
    )!.text

  const bannerMemo = new Function(
    "catalog",
    "language",
    "corpErrorKey",
    "unavailableSource",
    "hubConfigured",
    body(viewSource, "const banner = createMemo("),
  ) as (...args: unknown[]) => string | undefined
  const banner = (data: unknown) =>
    bannerMemo(
      { data },
      language,
      (code: string) => corpErrorKey(ERROR_KEYS, code),
      source,
      () => hub,
    )!

  const one = [{ alias: "tag" }]
  const list: Branch[] = [
    // Шесть пустых состояний (S-V12).
    { name: "пусто: каталог пуст", key: "", args: undefined },
  ]
  list.length = 0

  const literal = (name: string, text: string): Branch => ({ name, key: `<готовый текст> ${name}`, args: { text } })
  void literal

  const rendered: Branch[] = []
  const push = (name: string, text: string) => rendered.push({ name, key: name, args: { rendered: text } })

  push("S-V12 состояние 1 «Каталог пуст»", empty({ servers: [], dropped: [] }))
  push("S-V12 состояние 2 «Каталог не разобран»", empty({ servers: [], dropped: [{ reason: "alias" }] }, { dropped: 1 }))
  push("S-V12 состояние 3 «источник недоступен»", empty({ servers: [], hub_error: "hub_unavailable" }))
  push("S-V12 состояние 3 без ответа источника", empty(undefined))
  push("S-V12 состояние 4 «Требуется вход»", empty({ servers: [], hub_error: "unauthorized" }))
  push("S-V12 состояние 5 «вкладка Подключённые»", empty({ servers: one }, { tab: "connected", cards: one }))
  push("S-V12 состояние 6 «вкладка Неподключённые»", empty({ servers: one }, { tab: "not_connected", cards: one }))
  // Баннер над непустым списком: свежая ошибка и данные из кэша.
  push("баннер: источник недоступен", banner({ servers: one, hub_error: "hub_unavailable" }))
  push("баннер: данные из кэша", banner({ servers: one, hub_error: "hub_unavailable", cached_at: 1_700_000_000_000 }))
  // Четыре состояния карточки (S-V16) и строка 1 таблицы S-V6 — по перечислениям из кода.
  for (const state of CARD_STATES)
    for (const status of CARD_STATUSES)
      push(`строка витрины state=${state} status=${status}`, t(statusKey(STATE_KEY, STATUS_KEY, { state, status })))
  // Оба способа подключения (S-V7): в сборке без Hub facade называет причину.
  for (const mode of SERVER_MODES)
    push(
      `подключение mode=${mode}`,
      mode === "facade" && !hub ? t("corp.connectors.facadeNeedsHub") : t("corp.connectors.connect"),
    )
  // Пять видов модели прав (S-V9), включая неразобранную.
  push("права: вид не разобран", t(permissionsUnavailableKey(hub)))
  if (!hub) push("права: вид Hub-зависимый, Hub нет", t("corp.connectors.permissionsNeedHub"))
  for (const key of [
    "corp.permissions.title",
    "corp.permissions.allow",
    "corp.permissions.ask",
    "corp.permissions.deny",
    "corp.permissions.allowAll",
    "corp.permissions.denyAll",
    "corp.permissions.mixed",
    "corp.permissions.restTitle",
    "corp.permissions.restDescription",
  ])
    push(`права: вид permission_groups, ${key}`, t(key))
  // Экран входа (S-C5) в сборке без Hub называет причину.
  if (!hub) push("экран входа без Hub", t("corp.login.needsHub"))
  // Подтверждение «Убрать из списка» (S-V17).
  push("подтверждение «Убрать из списка»", t("corp.connectors.forgetConfirm", { title: "ТЭГ" }))
  // Четыре класса ошибок подключения (S-V19) — по перечислению из кода.
  for (const cls of ERROR_CLASSES)
    push(`ошибка подключения ${cls}`, t(connectErrorKey(ERROR_CLASSES, cls), { code: "E42" }))

  return rendered
}

const DICTS = { ru: ru as Record<string, string>, en: en as Record<string, string> }

describe("сборка без Hub — слово «Hub» не показывается нигде (S-I1, D-43; AC-275)", () => {
  for (const [locale, dict] of Object.entries(DICTS)) {
    test(`AC-275: ${locale} — ни одна ветвь интерфейса не показывает «Hub»`, () => {
      const found = branches(false, dict).filter((branch) => /hub/i.test(String(branch.args!["rendered"])))
      expect(found.map((branch) => `${branch.name}: ${branch.args!["rendered"]}`)).toEqual([])
    })
  }

  test("AC-275: матрица непуста и покрывает все перечислимые типы из кода", () => {
    const list = branches(false, DICTS.ru)
    expect(list.length).toBeGreaterThan(30)
    // Новое значение перечисления без новой ветви матрицы валит тест: ветви строятся по ним.
    expect(CARD_STATES.length * CARD_STATUSES.length).toBeGreaterThan(0)
    for (const state of CARD_STATES)
      expect(list.some((branch) => branch.name.includes(`state=${state}`)), state).toBe(true)
    for (const status of CARD_STATUSES)
      expect(list.some((branch) => branch.name.includes(`status=${status}`)), status).toBe(true)
    for (const mode of SERVER_MODES)
      expect(list.some((branch) => branch.name.includes(`mode=${mode}`)), mode).toBe(true)
    for (const cls of ERROR_CLASSES)
      expect(list.some((branch) => branch.name.includes(`ошибка подключения ${cls}`)), cls).toBe(true)
    // Шесть пустых состояний — все шесть в матрице и попарно различимы.
    const empties = list.filter((branch) => branch.name.startsWith("S-V12 состояние"))
    expect(empties.length).toBe(7)
    expect(new Set(empties.map((branch) => branch.args!["rendered"])).size).toBe(6)
    // Перечисления взяты из кода, а не выписаны: таблицы витрины совпадают с ними ключ в ключ.
    expect(Object.keys(STATE_KEY).sort()).toEqual([...CARD_STATES].sort())
    expect(Object.keys(STATUS_KEY).sort()).toEqual([...CARD_STATUSES].sort())
  })

  test("AC-275: те же ветви в сборке С Hub показывают прежние тексты", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      const withHub = branches(true, dict)
      // Прежние тексты не изменены: состояние 3 и заблокированный экран прав по-прежнему про Hub.
      const third = withHub.find((branch) => branch.name === "S-V12 состояние 3 «источник недоступен»")!
      expect(String(third.args!["rendered"]), locale).toContain(dict["corp.connectors.hubDown"]!)
      const permissions = withHub.find((branch) => branch.name === "права: вид не разобран")!
      expect(permissions.args!["rendered"], locale).toBe(dict["corp.connectors.permissionsUnavailable"])
      // И facade подключается как прежде — причина «нет Hub» в этой сборке не показывается.
      const facade = withHub.find((branch) => branch.name === "подключение mode=facade")!
      expect(facade.args!["rendered"], locale).toBe(dict["corp.connectors.connect"])
    }
  })

  test("AC-275: проверка идёт по отрисованному тексту — слово «Hub» в словаре законно", () => {
    // Ключи, которые слово «Hub» сохраняют, в словаре есть: тест их не запрещает, он запрещает им
    // быть достижимыми в сборке без Hub.
    for (const dict of Object.values(DICTS)) {
      expect(dict["corp.connectors.hubDown"]).toMatch(/hub/i)
      expect(dict["corp.connectors.forgetHubFailed"]).toMatch(/hub/i)
      expect(dict["corp.connectors.permissionsUnavailable"]).toMatch(/hub/i)
    }
  })
})

describe("сборка без Hub — экран входа называет причину (S-C5, S-I1; AC-273)", () => {
  test("AC-273: ключ corp.login.needsHub есть в обоих словарях и называет причину", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      const text = dict["corp.login.needsHub"]
      expect(text, `corp.login.needsHub отсутствует в ${locale}`).toBeString()
      expect(text!.trim().length, locale).toBeGreaterThan(0)
      // Причина названа, а слова «Hub» в тексте нет (D-43).
      expect(text!, locale).not.toMatch(/hub/i)
    }
    expect(DICTS.ru["corp.login.needsHub"]).not.toBe(DICTS.en["corp.login.needsHub"])
    // Русский текст — ровно тот, который цитирует критерий.
    expect(DICTS.ru["corp.login.needsHub"]).toBe("Вход по корпоративному SSO в этой сборке не настроен")
  })

  test("AC-273: экран входа показывает этот текст вместо пустого экрана и запроса на пустой адрес", () => {
    expect(loginSource).toContain('language.t("corp.login.needsHub")')
    // Показывается вместо формы входа: у экрана есть отдельный шаг «Hub в сборке нет», и текст
    // охраняется именно им, а не рисуется поверх обычного шага.
    const at = loginSource.indexOf('language.t("corp.login.needsHub")')
    const guard = loginSource.slice(0, at)
    expect(guard.slice(guard.lastIndexOf("<Show"))).toContain('step().kind === "no_hub"')
    // И на незаданный адрес запрос не уходит: старт входа живёт в другой ветви шага.
    expect(loginSource).toContain('"no_hub"')
  })

  test("AC-273: тот же ключ и тот же текст есть в словаре TUI", async () => {
    const specifier = "../../../tui/src/corp/i18n"
    const tui = (await import(specifier)) as {
      dictionaries: { ru: Record<string, string>; en: Record<string, string> }
    }
    const normalize = (value: string) =>
      value
        .replace(/\{\{[^}]+\}\}/g, "")
        .replace(/[«»"“”:.,\s]+/g, " ")
        .trim()
        .toLowerCase()
    for (const locale of ["ru", "en"] as const) {
      const text = tui.dictionaries[locale]["login.needsHub"]
      expect(text, `login.needsHub отсутствует в словаре TUI (${locale})`).toBeString()
      expect(text!, locale).not.toMatch(/hub/i)
      expect(normalize(text!), locale).toBe(normalize(DICTS[locale]["corp.login.needsHub"]!))
    }
    expect(tui.dictionaries.ru["login.needsHub"]).not.toBe(tui.dictionaries.en["login.needsHub"])
  })
})

/**
 * Четыре текста прежних ревизий, переформулированных микроревизией 1.11.1 (S-V17, S-V19, S-I1;
 * AC-278). Условных ключей на них не заведено: в обеих сборках показывается один и тот же текст.
 */
describe("тексты прежних ревизий без слова «Hub» (S-V17, S-V19; AC-278)", () => {
  const KEYS = [
    "corp.connectors.forgetConfirm",
    "corp.error.connect.token_rejected",
    "corp.error.connect.method_unavailable",
    "corp.error.connect.hub_unreachable",
  ]

  test("AC-278: ни в одном из четырёх текстов нет слова «Hub», в обоих языках", () => {
    for (const [locale, dict] of Object.entries(DICTS))
      for (const key of KEYS) {
        expect(dict[key], `${key} в ${locale}`).toBeString()
        expect(dict[key]!, `${key} в ${locale}`).not.toMatch(/hub/i)
      }
  })

  test("AC-278: условных ключей на эти четыре случая не заведено — текст один на обе сборки", () => {
    for (const dict of Object.values(DICTS))
      for (const key of KEYS) {
        expect(Object.keys(dict)).not.toContain(`${key}NoHub`)
        expect(Object.keys(dict)).not.toContain(`${key}Hub`)
      }
    // И код выбирает их без ветвления по признаку «адрес Hub задан».
    expect(pageSource).toContain("connectErrorKey(entry.error_class)")
    expect(contextSource).toContain('return `corp.error.connect.${known ?? "unknown"}`')
    const forget = pageSource.slice(pageSource.indexOf('language.t("corp.connectors.forgetConfirm"'))
    expect(forget.slice(0, forget.indexOf(")"))).not.toContain("hub")
  })

  test("AC-278: имена ключей и значения error_class не изменены — AC-180…AC-183 и AC-187 в силе", () => {
    expect(ERROR_CLASSES).toEqual(["token_rejected", "method_unavailable", "hub_unreachable", "unknown"])
    for (const cls of ERROR_CLASSES)
      expect(connectErrorKey(ERROR_CLASSES, cls)).toBe(`corp.error.connect.${cls}`)
    // Класс `hub_unreachable` остаётся именем значения — переименовали текст, а не контракт.
    expect(DICTS.ru["corp.error.connect.hub_unreachable"]).toBeString()
  })

  test("AC-278: объяснение остаётся верным в сборке с Hub — «сервер» покрывает и отказ Hub", () => {
    for (const dict of Object.values(DICTS)) {
      // Тексты не потеряли смысл: каждый по-прежнему называет и причину, и чью она сторону.
      expect(dict["corp.error.connect.token_rejected"]!.length).toBeGreaterThan(20)
      expect(dict["corp.error.connect.method_unavailable"]!.length).toBeGreaterThan(20)
      expect(dict["corp.error.connect.hub_unreachable"]!.length).toBeGreaterThan(20)
      expect(dict["corp.connectors.forgetConfirm"]).toContain("{{title}}")
    }
  })

  test("AC-278: словарь TUI несёт те же тексты по нормализации", async () => {
    const specifier = "../../../tui/src/corp/i18n"
    const tui = (await import(specifier)) as {
      dictionaries: { ru: Record<string, string>; en: Record<string, string> }
    }
    const normalize = (value: string) =>
      value
        .replace(/\{\{[^}]+\}\}/g, "")
        .replace(/[«»"“”:.,\s]+/g, " ")
        .trim()
        .toLowerCase()
    for (const locale of ["ru", "en"] as const)
      for (const key of ["corp.error.connect.token_rejected", "corp.error.connect.method_unavailable", "corp.error.connect.hub_unreachable"]) {
        const short = key.replace(/^corp\./, "")
        const text = tui.dictionaries[locale][short]
        expect(text, `${short} отсутствует в словаре TUI (${locale})`).toBeString()
        expect(text!, `${short} (${locale})`).not.toMatch(/hub/i)
        expect(normalize(text!), `${short} (${locale})`).toBe(normalize(DICTS[locale][key]!))
      }
  })
})
