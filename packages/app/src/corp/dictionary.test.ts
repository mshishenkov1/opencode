import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { dict as en } from "../i18n/en"
import { dict as ru } from "../i18n/ru"

/**
 * Словари корпоративного слоя Desktop/web (S-I1, S-I3, S-I5; AC-93, AC-98, AC-99).
 */

const APP_SRC = path.resolve(import.meta.dirname, "..")

const corpKeys = (dict: Record<string, string>) =>
  Object.keys(dict)
    .filter((key) => key.startsWith("corp."))
    .sort()

/** Коды ошибок корп-роутов (S-A5). */
const ERROR_CODES = [
  "corp_disabled",
  "hub_unavailable",
  "hub_invalid_response",
  "login_expired",
  "forbidden",
  "invalid_team",
  "team_selection_not_required",
  "rate_limited",
  "litellm_unavailable",
  "litellm_invalid_response",
  "unauthorized",
]

describe("i18n corp.* (AC-93, AC-99)", () => {
  test("AC-93: множества ключей corp.* в en.ts и ru.ts совпадают", () => {
    const enKeys = corpKeys(en as Record<string, string>)
    const ruKeys = corpKeys(ru as Record<string, string>)
    expect(enKeys.length).toBeGreaterThan(0)
    expect(ruKeys).toEqual(enKeys)
  })

  test("AC-93: ни одно значение corp.* в ru.ts не равно значению en.ts", () => {
    for (const key of corpKeys(en as Record<string, string>)) {
      const enValue = (en as Record<string, string>)[key]!
      const ruValue = (ru as Record<string, string>)[key]!
      expect(ruValue, key).not.toBe(enValue)
    }
  })

  test("AC-99: для каждого кода ошибки S-A5 есть русский и английский текст", () => {
    for (const code of ERROR_CODES) {
      const key = `corp.error.${code}`
      expect((en as Record<string, string>)[key], key).toBeString()
      expect((ru as Record<string, string>)[key], key).toBeString()
    }
    expect((en as Record<string, string>)["corp.error.unknown"]).toBeString()
    expect((ru as Record<string, string>)["corp.error.unknown"]).toBeString()
  })

  test("AC-93: тексты витрины, входа и пресетов есть в обоих словарях", () => {
    for (const key of [
      "corp.login.title",
      "corp.login.code",
      "corp.login.waiting",
      "corp.login.teamTitle",
      "corp.connectors.title",
      "corp.connectors.empty",
      "corp.connectors.hubDown",
      "corp.connectors.needsLogin",
      "corp.connectors.connect",
      "corp.connectors.disconnect",
      "corp.connectors.permissions",
      "corp.connectors.openHub",
      "corp.status.connected",
      "corp.status.needs_auth",
      "corp.status.not_connected",
      "corp.status.unavailable",
      "corp.preset.readonly",
      "corp.preset.readwrite",
    ]) {
      expect((en as Record<string, string>)[key], key).toBeString()
      expect((ru as Record<string, string>)[key], key).toBeString()
    }
  })
})

describe("корп-экраны Desktop/web (AC-85, AC-98)", () => {
  test("AC-98, AC-233: в корп-экранах нет строковых литералов с кириллицей", () => {
    // Ревизия 1.10 добавила корп-компоненты (страница коннектора, экран разрешений), поэтому список
    // расширен до всего каталога `components/corp/**`: перечислять файлы поимённо значило бы
    // пропускать каждый новый экран.
    const corp = fs
      .readdirSync(path.join(APP_SRC, "components/corp"))
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => path.join(APP_SRC, "components/corp", file))
    const files = [path.join(APP_SRC, "corp/enabled.ts"), path.join(APP_SRC, "context/corp.ts"), ...corp]
    // Проверяются все экраны, а не «какие-то»: пустой список молча прошёл бы.
    expect(corp.length).toBeGreaterThanOrEqual(4)

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8")
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
      const literals = withoutComments.match(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g) ?? []
      expect(
        literals.filter((literal) => /[А-Яа-яЁё]/.test(literal)),
        path.basename(file),
      ).toEqual([])
    }
  })

  test("AC-85: маршрут /connectors в роутер не добавлен, порядок upstream-маршрутов прежний", () => {
    const source = fs.readFileSync(path.join(APP_SRC, "app.tsx"), "utf8")
    expect(source).not.toContain('path="/connectors"')
    const routes = [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1])
    expect(routes).toEqual(["/", "/:dir", "/", "/session/:id?", "/new-session"])
  })
})

/**
 * Ключи ревизии 1.7 (S-I1, S-I3, S-I5; AC-166): экран прав недоступен, состав среза инструментов,
 * предупреждение о неполном каталоге и четвёртое пустое состояние витрины.
 */
const REVISION_17_KEYS = [
  "corp.connectors.permissionsUnavailable",
  "corp.connectors.toolsPreview",
  "corp.connectors.partial",
  "corp.empty.unparsed",
]

describe("i18n corp.* — тексты устойчивого разбора каталога (AC-166)", () => {
  test("AC-166: четыре новых ключа есть в en.ts и ru.ts, значения не совпадают", () => {
    for (const key of REVISION_17_KEYS) {
      const enValue = (en as Record<string, string>)[key]
      const ruValue = (ru as Record<string, string>)[key]
      expect(enValue, key).toBeString()
      expect(ruValue, key).toBeString()
      expect(enValue, key).not.toBe("")
      expect(ruValue, key).not.toBe("")
      expect(ruValue, key).not.toBe(enValue)
    }
  })

  test("AC-166: тексты витрины подставляются из словаря, а не захардкожены в коде", () => {
    // Ревизией 1.10 экран прав и предупреждение о неполном каталоге разъехались по двум файлам
    // (S-D11), поэтому ключ ищется во всём каталоге корп-компонентов, а не в одной витрине.
    // Требование при этом усилено: тексты не должны встречаться **ни в одном** корп-компоненте.
    const sources = fs
      .readdirSync(path.join(APP_SRC, "components/corp"))
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => ({ file, text: fs.readFileSync(path.join(APP_SRC, "components/corp", file), "utf8") }))
    const all = sources.map((entry) => entry.text).join("\n")

    for (const key of REVISION_17_KEYS) {
      // Ключ используется каким-то из корп-экранов...
      expect(all, key).toContain(key)
      // ...а его тексты не встречаются ни в одном из них ни на одном языке.
      for (const { file, text } of sources) {
        expect(text, `${file}: ${key} (ru)`).not.toContain((ru as Record<string, string>)[key]!)
        expect(text, `${file}: ${key} (en)`).not.toContain((en as Record<string, string>)[key]!)
      }
    }
  })

  test("AC-166: пустое состояние «Каталог не разобран» отличается текстом от «Каталог пуст»", () => {
    for (const dict of [en, ru] as Record<string, string>[]) {
      expect(dict["corp.empty.unparsed"]).not.toBe(dict["corp.connectors.empty"])
      expect(dict["corp.empty.unparsed"]).not.toBe(dict["corp.connectors.hubDown"])
      // Число отброшенных карточек — часть текста (S-V12).
      expect(dict["corp.empty.unparsed"]).toContain("{{dropped}}")
      expect(dict["corp.connectors.partial"]).toContain("{{dropped}}")
      expect(dict["corp.connectors.toolsPreview"]).toContain("{{preset}}")
    }
  })
})

/**
 * Словари состояний карточки, классов ошибок подключения и отключённого апгрейда
 * (S-I1, S-I3, S-I4, S-V19; AC-187).
 *
 * Ключи обязаны быть в обоих словарях Desktop/web, значения `ru` не равны значениям `en`, и те же
 * тексты есть в словаре TUI: обе оболочки говорят пользователю одно и то же (S-T10).
 */
describe("i18n corp.* — состояния карточки и классы ошибок (AC-187)", () => {
  /** Ключи, добавленные ревизией 1.9. */
  const KEYS = [
    "corp.connectors.connected",
    "corp.connectors.retry",
    "corp.connectors.forget",
    "corp.connectors.forgetConfirm",
    "corp.connectors.forgetHubFailed",
    "corp.connectors.neverConnected",
    "corp.connectors.lost",
    "corp.connectors.disconnected",
    "corp.error.connect.token_rejected",
    "corp.error.connect.method_unavailable",
    "corp.error.connect.hub_unreachable",
    "corp.error.connect.unknown",
    "corp.upgrade.disabled",
  ] as const

  const dictEn = en as Record<string, string>
  const dictRu = ru as Record<string, string>

  test("AC-187: все тринадцать ключей есть в en.ts и в ru.ts", () => {
    for (const key of KEYS) {
      expect(dictEn[key], `${key} отсутствует в en.ts`).toBeDefined()
      expect(dictRu[key], `${key} отсутствует в ru.ts`).toBeDefined()
      expect(String(dictEn[key]).trim().length, key).toBeGreaterThan(0)
      expect(String(dictRu[key]).trim().length, key).toBeGreaterThan(0)
    }
  })

  test("AC-187: значения ru не равны значениям en — перевод не забыт", () => {
    for (const key of KEYS) expect(dictRu[key], key).not.toBe(dictEn[key])
  })

  test("AC-187: те же тексты есть в словаре TUI", async () => {
    // Спецификатор собирается переменной по той же причине, что в `channel.test.ts`: словарь TUI
    // лежит вне `include` пакета `app`, и статический импорт ломает `tsgo -b`.
    const specifier = "../../../tui/src/corp/i18n"
    const tui = (await import(specifier)) as {
      dictionaries: { ru: Record<string, string>; en: Record<string, string> }
    }
    /** Ключ TUI получается из ключа Desktop снятием префикса `corp.` (S-I4). */
    const tuiKey = (key: string) => key.replace(/^corp\./, "")
    /** Сравнение по смыслу: регистр подписи действия и подстановки `{{…}}` у оболочек свои. */
    const normalize = (value: string) =>
      value
        .replace(/\{\{[^}]+\}\}/g, "")
        .replace(/[«»"“”:.,\s]+/g, " ")
        .trim()
        .toLowerCase()

    for (const key of KEYS) {
      const short = tuiKey(key)
      expect(tui.dictionaries.ru[short], `${short} отсутствует в словаре TUI (ru)`).toBeDefined()
      expect(tui.dictionaries.en[short], `${short} отсутствует в словаре TUI (en)`).toBeDefined()
    }

    // Тексты состояний и классов ошибок совпадают дословно: их читает пользователь, и расходиться
    // между оболочками они не должны. Подписи действий и подтверждение — короче в терминале.
    const sameText = [
      "corp.connectors.connected",
      "corp.connectors.neverConnected",
      "corp.connectors.lost",
      "corp.connectors.disconnected",
      "corp.error.connect.token_rejected",
      "corp.error.connect.method_unavailable",
      "corp.error.connect.hub_unreachable",
      "corp.upgrade.disabled",
    ]
    for (const key of sameText) {
      expect(normalize(tui.dictionaries.ru[tuiKey(key)]!), key).toBe(normalize(dictRu[key]!))
      expect(normalize(tui.dictionaries.en[tuiKey(key)]!), key).toBe(normalize(dictEn[key]!))
    }
  })

  test("AC-187: у класса unknown есть свой текст — «ошибки без объяснения» не существует", () => {
    for (const dict of [dictEn, dictRu]) {
      const unknown = dict["corp.error.connect.unknown"]!
      expect(unknown.trim().length).toBeGreaterThan(0)
      // Текст называет ошибку с её кодом (S-V19, строка `unknown`).
      expect(unknown).toContain("{{code}}")
    }
  })
})

/**
 * Тексты оболочки ревизии 1.10 (S-I1, S-I3, S-I5, S-I6; AC-233, AC-234).
 *
 * Подписи вкладок, колонок, режимов разрешений, пустых состояний вкладок и свойств страницы
 * коннектора — тексты **оболочки**: они есть в обоих языках, различаются между ними и присутствуют в
 * словаре TUI. Значения каталога (`title`/`description` групп, `type`) сюда не входят — это данные,
 * и ключей на них в словарях нет (S-I6).
 */
describe("i18n corp.* — тексты витрины-таблицы и экрана разрешений (AC-233)", () => {
  const dictEn = en as Record<string, string>
  const dictRu = ru as Record<string, string>

  /**
   * Ключи, добавленные ревизией 1.10, — по разделам состава страницы и витрины.
   *
   * `corp.connectors.tabNotConnected` и `corp.empty.tabNotConnected` ревизией 1.12 удалены вместе
   * со вкладкой «Неподключённые» (S-I1: «Удаление ключа из словарей не является удалением
   * идентификатора S- или AC- и правил стабильности спецификации не нарушает»; AC-221 отдельно требует
   * их ОТСУТСТВИЯ во всех трёх словарях) — держать их в списке обязательных ключей значило бы
   * требовать того, что спека явно запретила.
   */
  const KEYS = [
    "corp.connectors.tabAll",
    "corp.connectors.tabConnected",
    "corp.connectors.columnName",
    "corp.connectors.columnType",
    "corp.connectors.columnStatus",
    "corp.connectors.resetFilter",
    "corp.empty.tabConnected",
    "corp.connector.back",
    "corp.connector.type",
    "corp.connector.owner",
    "corp.connector.docs",
    "corp.permissions.title",
    "corp.permissions.allow",
    "corp.permissions.ask",
    "corp.permissions.deny",
    "corp.permissions.allowAll",
    "corp.permissions.denyAll",
    "corp.permissions.mixed",
    "corp.permissions.restTitle",
    "corp.permissions.restDescription",
  ] as const

  /** Ключи ревизии 1.10, снятые ревизией 1.12 (D-53) — обязаны отсутствовать во всех словарях (AC-221). */
  const REMOVED_KEYS = ["corp.connectors.tabNotConnected", "corp.empty.tabNotConnected"] as const

  test("AC-221: снятые ключи вкладки «Неподключённые» отсутствуют в обоих словарях", () => {
    for (const key of REMOVED_KEYS) {
      expect(dictEn[key as keyof typeof dictEn], `${key} остался в en.ts`).toBeUndefined()
      expect(dictRu[key as keyof typeof dictRu], `${key} остался в ru.ts`).toBeUndefined()
    }
  })

  test("AC-233: все ключи есть в обоих словарях и непусты", () => {
    for (const key of KEYS) {
      expect(dictEn[key], `${key} отсутствует в en.ts`).toBeString()
      expect(dictRu[key], `${key} отсутствует в ru.ts`).toBeString()
      expect(String(dictEn[key]).trim().length, key).toBeGreaterThan(0)
      expect(String(dictRu[key]).trim().length, key).toBeGreaterThan(0)
    }
  })

  test("AC-233: значения ru не равны значениям en — перевод не забыт", () => {
    for (const key of KEYS) expect(dictRu[key], key).not.toBe(dictEn[key])
  })

  test("AC-233: три названия режима различимы между собой в обоих языках", () => {
    for (const dict of [dictEn, dictRu]) {
      const modes = [dict["corp.permissions.allow"], dict["corp.permissions.ask"], dict["corp.permissions.deny"]]
      expect(new Set(modes).size).toBe(3)
      // Групповой селектор говорит «всё»: он ставит режим всем группам сразу (S-V23).
      expect(dict["corp.permissions.allowAll"]).not.toBe(dict["corp.permissions.allow"])
      expect(dict["corp.permissions.denyAll"]).not.toBe(dict["corp.permissions.deny"])
      // «Смешанно» — отдельный текст, а не один из трёх режимов.
      expect(modes).not.toContain(dict["corp.permissions.mixed"])
    }
  })

  // Было «три подписи вкладок»: третьей вкладки не существует с ревизии 1.12 (D-53), а прежняя
  // формулировка проходила «случайно» — `corp.connectors.tabNotConnected` даёт `undefined`, и
  // `new Set([...,"a","b",undefined])` тоже имеет размер 3, так что удаление ключа тест не красило.
  // Найдено попутно при разборе AC-233, не входит в перечень 11 падений итерации.
  test("AC-233: две подписи вкладок и три заголовка колонок различимы", () => {
    for (const dict of [dictEn, dictRu]) {
      const tabs = [dict["corp.connectors.tabAll"], dict["corp.connectors.tabConnected"]]
      expect(new Set(tabs).size).toBe(2)
      const columns = [
        dict["corp.connectors.columnName"],
        dict["corp.connectors.columnType"],
        dict["corp.connectors.columnStatus"],
      ]
      expect(new Set(columns).size).toBe(3)
    }
  })

  // S-V12 (ревизия 1.12): было шесть пустых состояний, стало пять — шестое («Подключено всё» во
  // вкладке «Неподключённые») исчезло вместе с самой вкладкой (D-53).
  test("AC-233: пять пустых состояний различимы текстом в обоих языках", () => {
    for (const dict of [dictEn, dictRu]) {
      const texts = [
        dict["corp.connectors.empty"],
        dict["corp.empty.unparsed"],
        dict["corp.connectors.hubDown"],
        dict["corp.connectors.needsLogin"],
        dict["corp.empty.tabConnected"],
      ]
      expect(texts.filter(Boolean)).toHaveLength(5)
      expect(new Set(texts).size).toBe(5)
    }
  })

  test("AC-233: те же тексты есть в словаре TUI — обе оболочки говорят одно и то же", async () => {
    // Спецификатор собирается переменной по той же причине, что в `channel.test.ts`.
    const specifier = "../../../tui/src/corp/i18n"
    const tui = (await import(specifier)) as {
      dictionaries: { ru: Record<string, string>; en: Record<string, string> }
    }
    const tuiKey = (key: string) => key.replace(/^corp\./, "")
    for (const key of KEYS) {
      const short = tuiKey(key)
      expect(tui.dictionaries.ru[short], `${short} отсутствует в словаре TUI (ru)`).toBeString()
      expect(tui.dictionaries.en[short], `${short} отсутствует в словаре TUI (en)`).toBeString()
      expect(tui.dictionaries.ru[short], short).not.toBe(tui.dictionaries.en[short])
    }
  })

  test("AC-234: ключей на значения каталога в словарях нет — это данные, а не тексты оболочки", () => {
    // «Мессенджер», «Трекер задач» и прочие значения `type` (S-V22) и названия групп разрешений
    // приходят из каталога и в словарь не попадают: словарь клиента не может содержать ключа на
    // каждое значение каталога.
    for (const dict of [dictEn, dictRu]) {
      const corp = Object.keys(dict).filter((key) => key.startsWith("corp."))
      expect(corp.filter((key) => key.startsWith("corp.type."))).toEqual([])
      expect(corp.filter((key) => /^corp\.permissions\.group\./.test(key))).toEqual([])
    }
    // Единственные тексты групп в словаре — «Остальное»: её каталог присылать не обязан (S-V20).
    expect(dictRu["corp.permissions.restTitle"]).toBeString()
    expect(dictRu["corp.permissions.restDescription"]).toBeString()
  })
})

/**
 * Тексты выхода и возврата провайдера (ревизия 1.12, микроревизия 1.12.1; S-I1; AC-297).
 *
 * Закрытый набор ключей S-I1: `corp.logout.*` (включая `corp.logout.reason.*` из 1.12.1) и
 * `corp.provider.*`. Присутствие в трёх словарях, непустота, различие ru/en и раздельность
 * «Войти»/«Выйти» проверяются как для любого другого ключа `corp.*` (S-I3).
 */
describe("i18n corp.* — выход и возврат провайдера (S-I1; AC-297)", () => {
  const dictEn = en as Record<string, string>
  const dictRu = ru as Record<string, string>

  const LOGOUT_KEYS = [
    "corp.logout.action",
    "corp.logout.confirm",
    "corp.logout.confirmLocal",
    "corp.logout.done",
    "corp.logout.doneLocal",
    "corp.logout.revokeFailed",
    "corp.logout.notSignedIn",
    "corp.logout.notRevoked",
    "corp.logout.reason.notPermitted",
    "corp.logout.reason.upstreamUnavailable",
    "corp.logout.reason.invalidResponse",
    "corp.logout.reason.unreachable",
  ] as const

  const PROVIDER_KEYS = [
    "corp.provider.disabledTitle",
    "corp.provider.enable",
    "corp.provider.enableConfirm",
    "corp.provider.enableForeignLayer",
  ] as const

  test("AC-297: все ключи присутствуют в en и ru, непусты и различаются между языками", () => {
    for (const key of [...LOGOUT_KEYS, ...PROVIDER_KEYS]) {
      expect(dictEn[key], `${key} отсутствует в en.ts`).toBeString()
      expect(dictRu[key], `${key} отсутствует в ru.ts`).toBeString()
      expect(String(dictEn[key]).trim().length, key).toBeGreaterThan(0)
      expect(String(dictRu[key]).trim().length, key).toBeGreaterThan(0)
      expect(dictRu[key], key).not.toBe(dictEn[key])
    }
  })

  test("AC-297: «Войти» и «Выйти» — разные ключи с разными значениями, а не один с подстановкой", () => {
    expect(dictRu["corp.connectors.login"]).toBeString()
    expect(dictRu["corp.logout.action"]).toBeString()
    expect(dictRu["corp.connectors.login"]).not.toBe(dictRu["corp.logout.action"])
    expect(dictEn["corp.connectors.login"]).not.toBe(dictEn["corp.logout.action"])
    // Единственная условная пара словарей — corp.logout.*/corp.logout.*Local (S-I1, микроревизия
    // 1.11.1): «Войти»/«Выйти» в эту пару не входят и своей Local-версии не имеют.
    expect(dictRu["corp.connectors.loginLocal" as keyof typeof dictRu]).toBeUndefined()
    expect(dictRu["corp.logout.actionLocal" as keyof typeof dictRu]).toBeUndefined()
  })

  test("AC-297: причины revoke_error — закрытый набор из четырёх, попарно различимы", () => {
    for (const dict of [dictEn, dictRu]) {
      const reasons = [
        dict["corp.logout.reason.notPermitted"],
        dict["corp.logout.reason.upstreamUnavailable"],
        dict["corp.logout.reason.invalidResponse"],
        dict["corp.logout.reason.unreachable"],
      ]
      expect(new Set(reasons).size).toBe(4)
    }
  })

  test("AC-297: те же ключи есть в словаре TUI (нормализация — без префикса corp.)", async () => {
    const tui = (await import("../../../tui/src/corp/i18n")) as {
      dictionaries: { ru: Record<string, string>; en: Record<string, string> }
    }
    const tuiKey = (key: string) => key.replace(/^corp\./, "")
    for (const key of [...LOGOUT_KEYS, ...PROVIDER_KEYS]) {
      const short = tuiKey(key)
      expect(tui.dictionaries.ru[short], `${short} отсутствует в словаре TUI (ru)`).toBeString()
      expect(tui.dictionaries.en[short], `${short} отсутствует в словаре TUI (en)`).toBeString()
      expect(tui.dictionaries.ru[short], short).not.toBe(tui.dictionaries.en[short])
    }
  })
})
