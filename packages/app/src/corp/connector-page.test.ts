import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Экран разрешений на странице коннектора (S-V9, S-V20, S-V21, S-V23, S-D11, S-I6;
 * AC-204, AC-205, AC-206, AC-207, AC-212, AC-214, AC-234).
 *
 * Правила экрана живут в `dialog-connector.tsx`, поэтому тела `rows`, `modesWith`, `rowMode` и
 * `aggregateMode` берутся из исходника и исполняются как есть — копии правила в тесте нет (тот же
 * приём, что в `packages/tui/src/corp/dialog-actions.test.ts`). Компонент при этом не рендерится:
 * проверяется наблюдаемое поведение — какие строки экран покажет, какое тело уйдёт в роут прав и
 * что показывает групповой селектор.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/connector-page.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "..")
const PAGE = path.join(APP, "components/corp/dialog-connector.tsx")
const source = fs.readFileSync(PAGE, "utf8")

/**
 * Тело функции или мемо страницы по её объявлению.
 *
 * `new Function` разбирает JavaScript, а не TypeScript, поэтому из тела снимаются `as const` и
 * аннотация типа объявления (`const modes: Record<…> = {}`). Оба снятия на поведение не влияют:
 * никакой другой правки тела нет, и исполняется тот же код, что в компоненте.
 */
function block(marker: string) {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker} на странице коннектора`).toBeGreaterThan(-1)
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

type Mode = "allow" | "ask" | "deny"
interface Row {
  id: string
  title: string
  description: string
  fallback: Mode
}

/** S-V23: действующий режим строки; `mixed` — не режим, а признак разнобоя. */
const rowMode = new Function("state", "row", block("export function rowMode(")) as (
  state: Record<string, string> | undefined,
  row: Row,
) => Mode | undefined

/** S-V23: агрегат группового селектора. */
const aggregateMode = new Function("modes", block("export function aggregateMode(")) as (
  modes: (Mode | undefined)[],
) => Mode | "mixed"

/** Словарь-заглушка: тексты проверяет `dictionary.test.ts`, здесь важен выбранный ключ. */
const language = { t: (key: string) => key }

/** S-V20: строки экрана — группы каталога в его порядке плюс «Остальное» последней. */
const rowsOf = new Function("props", "language", "REST_GROUP_ID", "DEFAULT_MODE", block("const rows = createMemo<")) as (
  props: { card: { permission_groups?: unknown } },
  language: { t: (key: string) => string },
  restId: string,
  defaultMode: Mode,
) => Row[]

/** S-V21: набор режимов, который уходит в роут прав, — все группы, а не одна изменённая. */
const modesWithOf = new Function(
  "override",
  "rows",
  "rowMode",
  "state",
  block("function modesWith("),
) as (
  override: Record<string, Mode>,
  rows: () => Row[],
  mode: typeof rowMode,
  state: () => Record<string, string> | undefined,
) => Record<string, Mode>

const rows = (groups: unknown) => rowsOf({ card: { permission_groups: groups } }, language, "rest", "ask")
const modesWith = (list: Row[], state: Record<string, string> | undefined, override: Record<string, Mode>) =>
  modesWithOf(
    override,
    () => list,
    rowMode,
    () => state,
  )

/** Словарь из пятнадцати групп — тексты русские, как их отдаёт корпоративный каталог (S-I6). */
const fifteen = {
  version: 1,
  groups: Array.from({ length: 15 }, (_, at) => ({
    id: `group_${at}`,
    title: `Группа номер ${at}`,
    description: `Что даёт делать группа ${at}`,
    default: (["allow", "ask", "deny"] as const)[at % 3],
    tools: [`tool_${at}`],
  })),
  rest: { title: "Остальные возможности", description: "Инструменты вне групп", default: "ask" as const },
}

describe("экран разрешений — состав строк (S-V9, S-V20; AC-204)", () => {
  test("AC-204: пятнадцать групп в порядке каталога плюс «Остальное» последней строкой", () => {
    const list = rows(fifteen)
    expect(list).toHaveLength(16)
    expect(list.slice(0, 15).map((row) => row.id)).toEqual(fifteen.groups.map((group) => group.id))
    expect(list[15]!.id).toBe("rest")
  })

  test("AC-204: в каждой строке title и description группы — данные каталога, как есть", () => {
    const list = rows(fifteen)
    expect(list[0]!.title).toBe("Группа номер 0")
    expect(list[0]!.description).toBe("Что даёт делать группа 0")
    expect(list[15]!.title).toBe("Остальные возможности")
    // Ни один текст группы не подменён ключом словаря (S-I6).
    for (const row of list.slice(0, 15)) expect(row.title).not.toContain("corp.")
  })

  test("AC-204: «Остальное» есть всегда, даже когда каталог блока rest не прислал", () => {
    const list = rows({ version: 1, groups: fifteen.groups })
    expect(list[list.length - 1]!.id).toBe("rest")
    // Тогда — и только тогда — её тексты берутся из словаря клиента (S-V20).
    expect(list[list.length - 1]!.title).toBe("corp.permissions.restTitle")
    expect(list[list.length - 1]!.description).toBe("corp.permissions.restDescription")
    expect(list[list.length - 1]!.fallback).toBe("ask")
  })

  test("AC-204: переключатель строки — три режима, выбор доступен каждой группе отдельно", () => {
    expect(source).toContain('const MODES: CorpPermissionMode[] = ["allow", "ask", "deny"]')
    const screen = source.slice(source.indexOf("const ConnectorPermissionGroups"))
    expect(screen).toContain("<SegmentedControlV2")
    expect(screen).toContain('data-group={row.id}')
    // Переключатель стоит внутри перебора строк — по одному на группу.
    const list = screen.indexOf("<For each={rows()}>")
    expect(list).toBeGreaterThan(-1)
    expect(screen.indexOf("<SegmentedControlV2")).toBeGreaterThan(list)
    for (const key of ["corp.permissions.allow", "corp.permissions.ask", "corp.permissions.deny"])
      expect(source, key).toContain(`"${key}"`)
  })

  test("AC-204: строки собраны на SettingsListV2/SettingsRowV2 — состав страницы S-D11 не выдуман", () => {
    expect(source).toContain("<SettingsListV2>")
    expect(source).toContain("<SettingsRowV2 title={row.title} description={row.description}>")
    expect(source).toContain('<SelectV2\n          appearance="inline"')
  })
})

describe("экран разрешений — групповой селектор (S-V23; AC-205, AC-214)", () => {
  const list = rows(fifteen)

  test("AC-214: одинаковый режим у всех групп — он и показан; разнобой — «Смешанно»", () => {
    const same = Object.fromEntries(list.map((row) => [row.id, "allow"]))
    expect(aggregateMode(list.map((row) => rowMode(same, row)))).toBe("allow")

    const mixed = { ...same, [list[3]!.id]: "deny" }
    expect(aggregateMode(list.map((row) => rowMode(mixed, row)))).toBe("mixed")
    // Группа в состоянии `mixed` конкретного режима не имеет — селектор тоже показывает «Смешанно».
    const groupMixed = { ...same, [list[3]!.id]: "mixed" }
    expect(rowMode(groupMixed, list[3]!)).toBeUndefined()
    expect(aggregateMode(list.map((row) => rowMode(groupMixed, row)))).toBe("mixed")
  })

  test("AC-214: «Смешанно» — только отображаемое значение, выбрать его нельзя", () => {
    const screen = source.slice(source.indexOf("const bulkOptions = createMemo("))
    // Пункт добавляется в список, только пока режимы расходятся.
    expect(screen).toContain('if (aggregate() === "mixed") options.push({ value: "mixed"')
    // И выбор этого пункта не делает ничего.
    const select = source.slice(source.indexOf("onSelect={(option) => {"))
    expect(select.slice(0, select.indexOf("}}"))).toContain('if (!option || option.value === "mixed") return')
  })

  test("AC-205: выбор в селекторе ставит режим всем группам сразу, включая «Остальное»", () => {
    const select = source.slice(source.indexOf("onSelect={(option) => {"))
    const body = select.slice(0, select.indexOf("}}"))
    expect(body).toContain("void apply(Object.fromEntries(rows().map((row) => [row.id, mode])))")

    // Наблюдаемо: тело запроса содержит один и тот же режим у каждой строки, «Остальное» в их числе.
    const override = Object.fromEntries(list.map((row) => [row.id, "deny" as const]))
    const modes = modesWith(list, { [list[0]!.id]: "allow" }, override)
    expect(Object.keys(modes).sort()).toEqual(list.map((row) => row.id).sort())
    expect(new Set(Object.values(modes))).toEqual(new Set(["deny"]))
    expect(modes["rest"]).toBe("deny")
  })

  test("AC-205: сохранение одно на весь набор — по группе за раз экран не пишет", () => {
    const screen = source.slice(source.indexOf("const ConnectorPermissionGroups"))
    // Единственное место записи — `apply`, и оно шлёт `modes` целиком одним вызовом.
    expect(screen.split("action.mutateAsync(").length - 1).toBe(1)
    expect(screen).toContain('kind: "permissionModes"')
    expect(screen).toContain("modes: modesWith(override)")
  })

  test("AC-205, S-V21: в теле идут все группы, а не одна изменённая", () => {
    const state = Object.fromEntries(list.map((row) => [row.id, "allow"]))
    const modes = modesWith(list, state, { [list[2]!.id]: "deny" })
    expect(Object.keys(modes)).toHaveLength(list.length)
    expect(modes[list[2]!.id]).toBe("deny")
    // Прочие группы сохраняют действующий режим, а не сбрасываются в умолчание.
    expect(modes[list[0]!.id]).toBe("allow")
    expect(modes["rest"]).toBe("allow")
  })

  test("AC-205: группа в состоянии mixed в набор не попадает — записи достанется default каталога", () => {
    const state = Object.fromEntries(list.map((row) => [row.id, "allow"]))
    state[list[4]!.id] = "mixed"
    const modes = modesWith(list, state, {})
    expect(modes[list[4]!.id]).toBeUndefined()
    expect(Object.keys(modes)).toHaveLength(list.length - 1)
  })
})

describe("экран разрешений — действующий режим, а не каталожный (S-V23; AC-214)", () => {
  const list = rows(fifteen)

  test("AC-214: режим строки берётся из permission_state сервера; клиент его не пересчитывает", () => {
    // `default` каталога у первой группы — allow, но действует deny из конфига.
    expect(fifteen.groups[0]!.default).toBe("allow")
    expect(rowMode({ [list[0]!.id]: "deny" }, list[0]!)).toBe("deny")
    const screen = source.slice(source.indexOf("const ConnectorPermissionGroups"))
    expect(screen).toContain("const state = createMemo(() => applied() ?? props.card.permission_state)")
    // Ответ роута — источник истины сразу после записи (S-V23).
    expect(screen).toContain('if (result && "permission_state" in result && result.permission_state)')
  })

  test("AC-214: пока конфига нет, показывается default каталога", () => {
    expect(rowMode(undefined, list[0]!)).toBe("allow")
    expect(rowMode({}, list[1]!)).toBe(list[1]!.fallback)
  })
})

/**
 * Деградация на прежний экран пресетов и заблокированный выбор (S-V9, S-V20; AC-206, AC-207).
 */
describe("страница коннектора — деградация экрана прав (AC-206, AC-207)", () => {
  test("AC-206: без permission_groups показывается прежний экран пресетов, блок остаётся", () => {
    const screen = source.slice(source.indexOf("{/* 6. «Разрешения»"), source.indexOf("{/* 7."))
    expect(screen).toContain("when={entry().permission_groups}")
    expect(screen).toContain("<ConnectorPresets card={entry()}")
    expect(screen).toContain("<ConnectorPermissionGroups card={entry()} />")
    // Блок есть всегда, когда действие «Права» доступно.
    expect(screen).toContain('<Show when={entry().actions.includes("permissions")}>')
    // Ревизия 1.11 добавила снаружи ветку «Hub в сборке нет» (S-C10 п.7) — прежняя развилка
    // «словарь групп либо пресеты» осталась внутри неё и не изменилась.
    expect(screen.indexOf("when={!entry().permissions_need_hub}")).toBeLessThan(
      screen.indexOf("when={entry().permission_groups}"),
    )
  })

  test("AC-206: подтверждение прежних видов по-прежнему уходит пресетом, а не режимами", () => {
    const presets = source.slice(source.indexOf("const ConnectorPresets"), source.indexOf("export const DialogConnectorPermissions"))
    expect(presets).toContain('action.mutate({ kind: "permissions", alias: props.card.alias, preset: option.value })')
    expect(presets).not.toContain("permissionModes")
  })

  test("AC-207: неизвестный вид модели прав — выбор заблокирован, причина названа", () => {
    const presets = source.slice(source.indexOf("const ConnectorPresets"), source.indexOf("export const DialogConnectorPermissions"))
    expect(presets).toContain("const unavailable = createMemo(() => options().length === 0)")
    // Причина названа всегда; ревизия 1.11 развела её на два текста по признаку «адрес Hub задан»
    // (S-C10 п.7): с Hub — прежний текст дословно, без Hub — та же причина без совета идти в Hub.
    expect(presets).toContain("language.t(permissionsUnavailableKey(props.hubConfigured))")
    const key = source.slice(source.indexOf("export function permissionsUnavailableKey("))
    const body = key.slice(0, key.indexOf("\n}"))
    expect(body).toContain('"corp.connectors.permissionsUnavailable"')
    expect(body).toContain('"corp.connectors.permissionsUnavailableNoHub"')
    // Прочие действия карточки экран прав не трогает: их набор считает общий модуль.
    expect(presets).not.toContain('kind: "connect"')
    expect(presets).not.toContain('kind: "disconnect"')
    expect(presets).not.toContain('kind: "forget"')
  })

  test("AC-207: «Открыть в Hub», «Подключить» и «Отключить» живут отдельно от блока разрешений", () => {
    // Ревизия 1.13 сдвинула нумерацию: блок подключения (S-D13) стал блоком 5, «Разрешения» — 6
    // (S-D13, S-D11). Верхняя граница здесь по-прежнему изолирует только блок 4 «Статус».
    const status = source.slice(source.indexOf("{/* 4. Статус"), source.indexOf("{/* 5."))
    expect(status).toContain('entry().actions.includes("connect")')
    expect(status).toContain('entry().actions.includes("disconnect")')
    expect(status).toContain('entry().actions.includes("open_hub")')
  })
})

/**
 * AC-212 в переформулировке диспута DISPUTE-I10-04-01 (S-V9, S-V21, S-V23, S-D11).
 *
 * У экрана вида `permission_groups` состояния «изменены, но не подтверждены» нет: состав страницы в
 * S-D11 п.5 — идиома экрана настроек с немедленным применением, а S-V23 прямо требует, чтобы
 * «Смешанно» исчезало из селектора **как только** пользователь выбрал режим. Проверяемая форма того
 * же смысла: пока пользователь не тронул ни один переключатель, не выполняется ни одной записи; и
 * Hub в этом виде не участвует ни при каком действии.
 */
describe("экран разрешений — отмена не пишет ничего (S-V9, S-V21; AC-212)", () => {
  /** Ровно компонент экрана разрешений: соседние компоненты страницы в срез не входят. */
  const screen = source.slice(
    source.indexOf("const ConnectorPermissionGroups"),
    source.indexOf("export const DialogConnector: Component"),
  )

  test("AC-212: запись выполняется только из обработчиков выбора режима", () => {
    // Единственный вызов роута — внутри `apply`.
    expect(screen.split("action.mutateAsync(").length - 1).toBe(1)
    const apply = screen.slice(screen.indexOf("async function apply("))
    expect(apply.slice(0, apply.indexOf("\n  }"))).toContain("action.mutateAsync(")

    // `apply` зовут ровно два обработчика: выбор в групповом селекторе и смена режима строки.
    const calls = [...screen.matchAll(/void apply\(/g)]
    expect(calls).toHaveLength(2)
    expect(screen).toContain("onSelect={(option) => {")
    expect(screen).toContain("onChange={(value) => {")
  })

  test("AC-212: открытие экрана и его отрисовка не выполняют ни одной записи", () => {
    // Ни один эффект, ни `onMount`, ни мемо записи не делают: экран при открытии только читает.
    expect(screen).not.toContain("onMount")
    expect(screen).not.toContain("createEffect")
    const memos = screen.slice(0, screen.indexOf("async function apply("))
    expect(memos).not.toContain("action.mutate")
  })

  test("AC-212: пустой выбор в переключателе ничего не отправляет", () => {
    const change = screen.slice(screen.indexOf("onChange={(value) => {"))
    expect(change.slice(0, change.indexOf("}}"))).toContain("if (!value) return")
  })

  test("AC-212, S-V9: вид permission_groups не отправляет в Hub ни одного запроса", () => {
    // Клиент зовёт только роут прав; тело — `modes`, и `preset` в нём не появляется (D-35).
    expect(screen).not.toContain('kind: "permissions"')
    expect(screen).not.toContain("preset")
    expect(screen).toContain('kind: "permissionModes"')
  })
})

/**
 * Причина «экран прав заблокирован» в двух сборках (S-V9, S-I1, S-C10 п.7, D-43; AC-274).
 *
 * Микроревизия 1.11.1 разводит текст последней строки таблицы S-V9 на два: причина одна («модель
 * прав не поддерживается этой версией приложения»), а совет «правами можно управлять в Hub» верен
 * только там, где Hub есть. Заменяется **только** совет — сообщение о деградации разбора (S-V14)
 * остаётся видимым в обеих сборках: оно про дефект данных, а не про Hub.
 */
describe("страница коннектора — причина блокировки в обеих сборках (AC-274)", () => {
  const key = source.slice(source.indexOf("export function permissionsUnavailableKey("))
  const body = key.slice(0, key.indexOf("\n}"))

  test("AC-274: в обеих сборках экран заблокирован и причина названа", () => {
    const presets = source.slice(
      source.indexOf("const ConnectorPresets"),
      source.indexOf("export const DialogConnectorPermissions"),
    )
    // Блокировка одна на обе сборки: выбора нет, когда нет пресетов.
    expect(presets).toContain("const unavailable = createMemo(() => options().length === 0)")
    expect(presets).toContain("<Show when={unavailable()}>")
    // Текст берётся всегда — ветви «молча ничего» нет.
    expect(presets).toContain("language.t(permissionsUnavailableKey(props.hubConfigured))")
    expect(body).toContain('"corp.connectors.permissionsUnavailable"')
    expect(body).toContain('"corp.connectors.permissionsUnavailableNoHub"')
  })

  test("AC-274: со сборкой С Hub показывается прежний текст ревизии 1.7 дословно", () => {
    // Ключ прежний и выбирается именно при заданном адресе Hub — проверки AC-166 остаются в силе.
    expect(body).toMatch(/hubConfigured\s*\?\s*"corp\.connectors\.permissionsUnavailable"/)
  })

  test("AC-274: признак — тот же, что у действия open_hub; build-константу оболочка не читает", () => {
    // Значение приходит из данных вьюшки (`hub_configured`), которую сервер заполняет тем же
    // признаком, каким убирает `open_hub` из наборов действий.
    expect(source).toContain("hubConfigured={catalog.data?.hub_configured !== false}")
    expect(source).toContain("const hubConfigured = createMemo(() => catalog.data?.hub_configured !== false)")
    // Второго чтения build-константы в корп-компонентах нет.
    expect(source).not.toContain("OPENCODE_CORP_HUB_URL")
    expect(source).not.toContain("import.meta.env")
  })

  test("AC-274: сообщение о деградации разбора видимо в обеих сборках", () => {
    // Предупреждение о числе отброшенных карточек и групп (S-V14 п.5) живёт на витрине и признаком
    // «есть ли Hub» не охраняется — иначе в сборке без Hub дефект данных стал бы невидимым.
    const view = fs.readFileSync(path.join(APP, "components/corp/dialog-connectors.tsx"), "utf8")
    const partial = view.slice(view.indexOf("const partial = createMemo("))
    const memo = partial.slice(0, partial.indexOf("\n  })"))
    expect(memo).toContain('language.t("corp.connectors.partial"')
    expect(memo).not.toContain("hubConfigured")
    expect(memo).not.toContain("hub_configured")
  })

  test("AC-274: блок «Разрешения» есть в обеих сборках, а причина «нет Hub» — отдельный текст", () => {
    const screen = source.slice(source.indexOf("{/* 6. «Разрешения»"), source.indexOf("{/* 7."))
    // «Эта сборка без Hub» и «эта версия не умеет» — разные беды и разные советы, и текстов два.
    expect(screen).toContain('language.t("corp.connectors.permissionsNeedHub")')
    expect(screen).toContain('language.t("corp.permissions.title")')
    // Признак карточный (`permissions_need_hub`), а не второе чтение адреса.
    expect(screen).toContain("when={!entry().permissions_need_hub}")
  })
})
