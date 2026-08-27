import { describe, expect, test } from "bun:test"
import path from "path"

/**
 * Экран разрешений по группам в TUI (S-V9, S-V20, S-V21, S-V23, S-T10, S-I6;
 * AC-204, AC-205, AC-207, AC-212, AC-214, AC-233).
 *
 * Пятый вид модели прав (S-V9): вместо пресетов Hub — курируемый словарь групп из карточки каталога.
 * Паритет с Desktop держится смыслом, а не раскладкой: колонок и сегментированных переключателей в
 * терминале нет, режим выбирается в подсписке, но состав строк, тело запроса и агрегат селектора —
 * те же. Экран не рендерится: правила берутся из исходника и исполняются как есть.
 *
 * Запуск: `bun --cwd packages/tui test src/corp/permissions-view.test.ts`.
 */

const SCREEN = path.resolve(import.meta.dirname, "../component/corp/dialog-permissions.tsx")
const source = await Bun.file(SCREEN).text()
const DIALOG = path.resolve(import.meta.dirname, "../component/corp/dialog-connectors.tsx")
const dialogSource = await Bun.file(DIALOG).text()

/** Тело функции или мемо экрана; `as const`, аннотации типов и `!` снимаются — `new Function` — это JS. */
function fn<T extends (...args: never[]) => unknown>(marker: string, ...args: string[]): T {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker} на экране разрешений TUI`).toBeGreaterThan(-1)
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
            .replace(/\b(let)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+(?=[;\n])/g, "$1 $2")
            .replace(/([\])\w])!(?=[\s;,)\].])/g, "$1"),
        ) as T
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

type Mode = "allow" | "ask" | "deny"
interface Entry {
  id: string
  title: string
  description?: string
  fallback: Mode
}

/** Словарь-заглушка: тексты проверяет `i18n.test.ts`, здесь важен выбранный ключ. */
const t = (key: string) => key

/** S-V20: строки экрана — группы каталога в его порядке, «Остальное» последней. */
const entriesOf = fn<(props: { card: { permission_groups?: unknown } }, t: (key: string) => string, rest: string, fallback: Mode) => Entry[]>(
  "const entries = createMemo<",
  "props",
  "t",
  "REST_ID",
  "FALLBACK_MODE",
)

/** S-V21: тело роута прав — режим у **каждой** группы, а не у одной изменённой. */
const modesForOf = fn<
  (changes: Record<string, Mode>, entries: () => Entry[], state: () => Record<string, string>) => Record<string, Mode>
>("function modesFor(", "changes", "entries", "state")

const dictionary = {
  version: 1,
  groups: [
    {
      id: "read_posts",
      title: "Читать сообщения и треды",
      description: "Чтение переписки в каналах",
      default: "allow",
      tools: ["get_post", "get_thread"],
    },
    { id: "write_posts", title: "Писать сообщения", description: "Публикация", default: "ask", tools: ["create_post"] },
    { id: "admin", title: "Администрирование", default: "deny", tools: ["delete_post"] },
  ],
  rest: { title: "Остальные возможности", description: "Инструменты вне групп", default: "ask" },
}

const entries = (groups: unknown = dictionary) => entriesOf({ card: { permission_groups: groups } }, t, "rest", "ask")
const modesFor = (changes: Record<string, Mode>, state: Record<string, string> = {}) =>
  modesForOf(
    changes,
    () => entries(),
    () => state,
  )

describe("tui/corp — состав экрана разрешений (S-V20, S-I6; AC-204)", () => {
  test("AC-204: группы идут порядком каталога, «Остальное» последней", () => {
    const list = entries()
    expect(list.map((entry) => entry.id)).toEqual(["read_posts", "write_posts", "admin", "rest"])
  })

  test("AC-204: title и description групп — данные каталога, клиент их не переводит", () => {
    const list = entries()
    expect(list[0]!.title).toBe("Читать сообщения и треды")
    expect(list[0]!.description).toBe("Чтение переписки в каналах")
    // У группы без описания подписи просто нет — пустой строки экран не рисует.
    expect(list[2]!.description).toBeUndefined()
    for (const entry of list.slice(0, 3)) expect(entry.title).not.toContain("permissions.")
  })

  test("AC-204: «Остальное» есть всегда; без блока rest её тексты берутся из словаря TUI", () => {
    const list = entries({ version: 1, groups: dictionary.groups })
    const rest = list[list.length - 1]!
    expect(rest.id).toBe("rest")
    expect(rest.title).toBe("permissions.restTitle")
    expect(rest.description).toBe("permissions.restDescription")
    expect(rest.fallback).toBe("ask")
  })

  test("AC-204: у каждой строки подсписок ровно из трёх режимов с отметкой действующего", () => {
    expect(source).toContain('const MODES: readonly CorpPermissionMode[] = ["allow", "ask", "deny"]')
    const options = source.slice(source.indexOf("const options = createMemo<"))
    expect(options).toContain("MODES.map((mode)")
    // Отметка читается и в монохромном терминале: она символ, а не цвет.
    expect(source).toContain('const MARK = "* "')
    expect(options).toContain("active === mode ? MARK")
  })

  test("AC-204: групповой селектор — отдельная строка над списком групп", () => {
    const options = source.slice(source.indexOf("const options = createMemo<"))
    const list = options.slice(0, options.indexOf("\n  })"))
    expect(list.indexOf('t("permissions.title")')).toBeLessThan(list.indexOf("...entries().map("))
    expect(list).toContain('value: { kind: "all" }')
  })
})

describe("tui/corp — групповой селектор и агрегат (S-V23; AC-205, AC-214)", () => {
  test("AC-214: одинаковый режим у всех групп — он и показан, разнобой — «Смешанно»", () => {
    const same = { read_posts: "allow", write_posts: "allow", admin: "allow", rest: "allow" }
    const aggregate = fn<(entries: () => Entry[], shown: (entry: Entry) => string) => string>(
      "const aggregate = createMemo<",
      "entries",
      "shown",
    )
    const shownWith = (state: Record<string, string>) => (entry: Entry) => state[entry.id] ?? entry.fallback
    expect(aggregate(() => entries(), shownWith(same))).toBe("allow")
    expect(aggregate(() => entries(), shownWith({ ...same, admin: "deny" }))).toBe("mixed")
    // Без конфига действуют `default` каталога, а они у групп разные — значит «Смешанно».
    expect(aggregate(() => entries(), shownWith({}))).toBe("mixed")
  })

  test("AC-214: «Смешанно» — только отображаемое значение, отдельного режима у него нет", () => {
    expect(source).toContain('if (mode === "mixed") return t("permissions.mixed")')
    // В подсписке выбора его нет: перебираются ровно три режима.
    const options = source.slice(source.indexOf("const options = createMemo<"))
    expect(options).not.toContain('"mixed"')
  })

  test("AC-205: выбор в селекторе ставит режим всем группам сразу, включая «Остальное»", () => {
    const choose = source.slice(source.indexOf("function choose("))
    const body = choose.slice(0, choose.indexOf("\n  }"))
    expect(body).toContain("for (const entry of entries()) changes[entry.id] = row.mode")
    expect(body).toContain("void apply(changes)")

    // Наблюдаемо: в теле запроса один и тот же режим у каждой строки.
    const modes = modesFor({ read_posts: "deny", write_posts: "deny", admin: "deny", rest: "deny" })
    expect(Object.keys(modes).sort()).toEqual(["admin", "read_posts", "rest", "write_posts"])
    expect(new Set(Object.values(modes))).toEqual(new Set(["deny"]))
  })

  test("AC-205, S-V21: в теле идут все группы — «отправить только правку» экран не умеет", () => {
    const modes = modesFor({ admin: "allow" }, { read_posts: "deny", write_posts: "ask", rest: "ask" })
    expect(Object.keys(modes).sort()).toEqual(["admin", "read_posts", "rest", "write_posts"])
    expect(modes["admin"]).toBe("allow")
    // Нетронутые группы сохраняют действующий режим.
    expect(modes["read_posts"]).toBe("deny")
    expect(modes["write_posts"]).toBe("ask")
  })

  test("AC-205: нетронутая группа без действующего режима наследует default каталога", () => {
    const modes = modesFor({}, { read_posts: "mixed" })
    // `mixed` конкретным режимом не является — берётся `default` этой группы из каталога (S-V20).
    expect(modes["read_posts"]).toBe("allow")
    expect(modes["write_posts"]).toBe("ask")
    expect(modes["admin"]).toBe("deny")
    expect(modes["rest"]).toBe("ask")
  })

  test("AC-205: сохранение одно на весь набор — по группе за раз экран не пишет", () => {
    expect(source.split("sdk.client.corp.permissions(").length - 1).toBe(1)
    expect(source).toContain("sdk.client.corp.permissions({ alias: props.card.alias, modes })")
  })
})

describe("tui/corp — состояние показывается пересчитанное сервером (S-V23; AC-214)", () => {
  test("AC-214: после записи экран берёт permission_state ответа, а не выбор пользователя", () => {
    const apply = source.slice(source.indexOf("async function apply("))
    const body = apply.slice(0, apply.indexOf("\n  }"))
    expect(body).toContain("setState(data.permission_state ?? modes)")
    // До первой записи состояние приходит с карточкой, а её `default` — только фолбэк.
    expect(source).toContain("...(props.card.permission_state ?? {})")
    expect(source).toContain("return state()[entry.id] ?? entry.fallback")
  })
})

/**
 * AC-212 в переформулировке диспута DISPUTE-I10-04-01: у экрана нет состояния «изменены, но не
 * подтверждены» — режим применяется сразу (S-D11 п.5, S-V23). Проверяемая форма того же смысла:
 * `esc` без выбора режима не пишет ничего, и Hub в этом виде не участвует ни при каком действии.
 */
describe("tui/corp — отмена не пишет ничего (S-V9, S-V21; AC-212)", () => {
  test("AC-212: единственный источник записи — выбор режима в подсписке", () => {
    const choose = source.slice(source.indexOf("function choose("))
    const body = choose.slice(0, choose.indexOf("\n  }"))
    // Строка группы и строка селектора только открывают подсписок — они ничего не пишут.
    expect(body).toContain('if (row.kind === "all") {')
    expect(body).toContain("setEditing(ALL_ID)")
    expect(body).toContain('if (row.kind === "group") {')
    expect(body).toContain("setEditing(row.id)")
    // `apply` зовётся только из ветки `kind: "mode"`.
    expect(body.indexOf("void apply(")).toBeGreaterThan(body.indexOf('if (row.kind === "group")'))
  })

  test("AC-212: открытие экрана ничего не записывает — ни onMount, ни эффекта записи нет", () => {
    expect(source).not.toContain("onMount")
    expect(source).not.toContain("createEffect")
    const head = source.slice(0, source.indexOf("async function apply("))
    expect(head).not.toContain("sdk.client.corp.permissions")
  })

  test("AC-212: esc из подсписка возвращает к списку групп и режима не ставит", () => {
    const bindings = source.slice(source.indexOf("bindings={"))
    const body = bindings.slice(0, bindings.indexOf("}\n      footerHints"))
    expect(body).toContain("cmd: () => setEditing(undefined)")
    expect(body).not.toContain("apply(")
  })

  test("AC-212, S-V9: вид permission_groups не отправляет в Hub ни одного запроса", () => {
    // Клиент зовёт только роут прав телом `modes`; пресета в нём нет вовсе (D-35).
    expect(source).not.toContain("preset")
    expect(source).toContain("modes })")
  })

  test("AC-207: витрина открывает этот экран только при разобранном словаре групп", () => {
    const open = dialogSource.slice(dialogSource.indexOf("async function openPermissions("))
    const body = open.slice(0, open.indexOf("const options = presetOptions("))
    expect(body).toContain('if (!allows(card, "permissions")) return')
    expect(body).toContain("if (groups && groups.groups.length > 0)")
    expect(body).toContain("<DialogPermissions card={card} />")
    // Иначе — прежний экран пресетов, а при пустом их списке названная причина (S-V9, строка 4).
    const rest = open.slice(open.indexOf("const options = presetOptions("))
    expect(rest).toContain('t("connectors.permissionsUnavailable")')
  })
})

/**
 * Причина «экран прав заблокирован» в двух сборках TUI (S-V9, S-I1, S-C10 п.7, D-43; AC-274).
 *
 * Паритет с Desktop держится тем же признаком: сервер убирает `open_hub` из набора действий ровно
 * при незаданном адресе Hub, и оболочка выбирает текст по нему, а не по второму чтению
 * build-константы.
 */
describe("tui/corp — причина блокировки экрана прав в обеих сборках (AC-274)", () => {
  const open = dialogSource.slice(dialogSource.indexOf("async function openPermissions("))
  const guard = open.slice(open.indexOf("const options = presetOptions("), open.indexOf("const preset = await"))

  test("AC-274: в обеих сборках экран не открывается и причина названа", () => {
    expect(guard).toContain("options.length === 0")
    expect(guard).toContain("toast.show({ variant: \"warning\", message: reason })")
    expect(guard).toContain("return")
    // Текст показывается всегда — ветви «молча ничего» нет.
    expect(guard).toContain('t("connectors.permissionsUnavailable")')
    expect(guard).toContain('t("connectors.permissionsUnavailableNoHub")')
  })

  test("AC-274: признак — тот же, которым определяется наличие действия «Открыть в Hub»", () => {
    expect(guard).toContain('allows(card, "open_hub")')
    // Второго чтения build-константы в корп-компоненте TUI нет.
    expect(dialogSource).not.toContain("OPENCODE_CORP_HUB_URL")
    expect(dialogSource).not.toContain("process.env")
  })

  test("AC-274: сообщение о деградации разбора видимо в обеих сборках", () => {
    // Предупреждение о числе отброшенных карточек и групп (S-V14 п.5) признаком «есть ли Hub» не
    // охраняется: оно про дефект данных, а не про Hub.
    const partial = dialogSource.slice(dialogSource.indexOf("const partial = createMemo("))
    const memo = partial.slice(0, partial.indexOf("\n  })"))
    expect(memo).toContain('format("connectors.partial"')
    expect(memo).not.toContain("hubConfigured")
  })

  test("AC-274: у Hub-зависимых видов модели прав отдельная причина «в сборке нет Hub»", () => {
    // «Эта сборка без Hub» и «эта версия приложения не умеет» — разные беды и разные советы.
    expect(dialogSource).toContain("export function permissionsNeedHub(card: CorpCatalogCard)")
    expect(dialogSource).toContain("card.permissions_need_hub === true")
    expect(dialogSource).toContain('t("connectors.permissionsNeedHub")')
    // Вид `permission_groups` целиком локален, и признак у него не выставляется — экран открывается.
    const groups = open.slice(0, open.indexOf("const options = presetOptions("))
    expect(groups).toContain("if (groups && groups.groups.length > 0)")
  })
})
