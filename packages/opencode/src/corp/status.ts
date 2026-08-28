import * as CorpErrors from "./errors"
import * as CorpSchema from "./schema"

/**
 * Вычисление статуса карточки витрины (S-V6, S-Q9).
 *
 * Чистый модуль без ввода-вывода: общий для корп-роутов, TUI и Desktop/web, чтобы правило было
 * ровно одно и проверялось модульным тестом.
 */

/** Локальный статус MCP-сервера (F14). */
export type LocalStatus = "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"

export interface Input {
  alias: string
  /** Карточка каталога Hub; `undefined` — alias в каталоге отсутствует (скрыт/`unconfigured`). */
  server?: CorpSchema.CatalogServer
  /** Есть ли запись `mcp.<alias>` в действующем конфиге. */
  configured: boolean
  /** Локальный статус MCP из `GET /mcp`; `undefined` — сервер локально неизвестен. */
  local?: LocalStatus
  /** Текст ошибки локального статуса `failed` / `needs_client_registration`. */
  localError?: string
  /**
   * Признак «подключение состоялось» из персистентного артефакта (S-V15 п.1а): локальный статус
   * `connected` наблюдался в этом или в любом прошлом запуске. Доказательство по данным Hub
   * (S-V15 п.1б) правило выводит само из `server.connection.status` — оно уже здесь.
   */
  everConnectedLocally?: boolean
  /** Каталог отдан из протухшего кэша (S-V3). */
  stale: boolean
  /**
   * Карточка подключена **прямым** способом (S-V29 п.4): для alias есть применимая запись
   * хранилища (S-V26 п.3) и `mcp.<alias>.url` равен `upstream.url`.
   *
   * Тогда поле `connection` карточки каталога на её состояние не влияет **вовсе**: запись
   * подключения на стороне Hub описывает другое подключение того же пользователя, а не это.
   * Признак «подключение состоялось» (S-V15) ставится по локальному наблюдению `connected` —
   * ветка (б) правила для прямо подключённой карточки не применяется.
   */
  directConnected?: boolean
  /**
   * Задан ли адрес Hub в этой сборке (S-C10 п.7, S-V16, D-43).
   *
   * `false` убирает `open_hub` из **всех** наборов действий — заблокированным оно не показывается:
   * ссылка, которая никуда не ведёт, хуже её отсутствия. У карточек `mode:"facade"` тем же
   * признаком снимаются `connect`/`reconnect` (S-V7, S-C10 п.8).
   *
   * Умолчание — «Hub задан»: сборка с Hub ревизией 1.11 не меняется ни в одном наборе дословно.
   */
  hubConfigured?: boolean
}

export interface Card {
  alias: string
  status: CorpSchema.CardStatus
  actions: CorpSchema.CardAction[]
  /** Пользовательское состояние карточки (S-V16): им определяются и действия, и подпись. */
  state: CorpSchema.CardState
  /** Признак «подключение состоялось» (S-V15) с учётом обоих доказательств. */
  everConnected: boolean
  /** Бейдж «устаревший» — независимо от статуса (S-V6). */
  deprecated: boolean
  /** Действия «Подключить»/«Переподключить»/«Права» заблокированы: каталог протух (S-V6, правило 2). */
  blocked: boolean
  /** Подпись карточки: текст ошибки локального статуса. */
  error?: string
  /**
   * Класс ошибки состояний 2 и 3 (S-V19): по нему карточка показывает объяснение и предлагаемое
   * действие, не дожидаясь новой попытки подключения. У состояний без ошибки поля нет.
   */
  errorClass?: CorpErrors.ErrorClass
  /**
   * Подключение доступно только через Hub-фасад, а Hub в этой сборке нет (S-V7, S-C10 п.8):
   * действие снято из набора, и на его месте оболочка называет причину.
   */
  connectNeedsHub?: boolean
}

const NEEDS_AUTH_LOCAL: ReadonlySet<string> = new Set(["needs_auth", "needs_client_registration"])

/**
 * Действия по состоянию (S-V16). Таблица здесь одна на обе оболочки: и TUI, и Desktop берут набор
 * отсюда и сами его не вычисляют (S-T10), поэтому разойтись они не могут по построению.
 *
 * «Отключить» существует ровно в состоянии 4, «Убрать из списка» — ровно в состоянии 3.
 */
const ACTIONS: Record<CorpSchema.CardState, CorpSchema.CardAction[]> = {
  // Состояние 1 «Не подключён» и состояние 2 «Подключение не удалось» отличаются только подписью
  // и объяснением ошибки: убирать у них нечего, отключать тоже (D-31).
  never: ["connect", "open_hub"],
  failed: ["connect", "open_hub"],
  // Состояние 3: подпись «Повторить» честно называет, что попытка уже была (S-V16).
  lost: ["reconnect", "forget", "open_hub"],
  disconnected: ["reconnect", "forget", "open_hub"],
  // Состояние 4: кнопки «Подключить» нет — вместо неё явный признак «Подключено» (S-V18).
  connected: ["permissions", "disconnect", "open_hub"],
}

/**
 * Удаление действий, которых в сборке без Hub не существует (S-C10 п.7, D-43).
 *
 * `open_hub` уходит из набора целиком: заблокированный элемент обещает, что когда-нибудь
 * заработает, а ссылка в никуда не заработает никогда. Условие проверяется здесь — в том же общем
 * модуле, что и сам набор, — поэтому TUI и Desktop разойтись по этому вопросу не могут.
 */
function withoutHubActions(actions: CorpSchema.CardAction[], input: Input) {
  if (input.hubConfigured !== false) return actions
  return actions.filter((action) => action !== "open_hub")
}

/**
 * Подключение карточки `mode:"facade"` идёт через Hub-фасад (`user_token`), и без адреса Hub его
 * выполнить нечем (S-V7, S-C10 п.8). Карточка остаётся в витрине со статусом по S-V6, но действие
 * из набора снимается: запись `mcp.<alias>` создавать нельзя, а кнопка, которая гарантированно
 * не сработает, — та же ссылка в никуда. `mode:"native"` от источника каталога не зависит вовсе.
 */
function facadeNeedsHub(input: Input) {
  return input.hubConfigured === false && input.server?.mode === "facade"
}

export function compute(input: Input): Card {
  const deprecated = input.server?.status === "deprecated"
  // S-V29 п.4: у прямо подключённой карточки запись подключения Hub не читается вовсе — ни как
  // доказательство признака S-V15, ни как повод объявить состояние «Соединение потеряно».
  const connection = input.directConnected === true ? undefined : input.server?.connection?.status

  // S-V15 п.1: признак истинен по локальной истории (а) либо по записи подключения Hub (б).
  // Запись `mcp.<alias>` в конфиге признаком не является — она появляется и у неудачной попытки.
  const everConnected =
    input.everConnectedLocally === true || connection === "connected" || connection === "needs_reauth"

  // Правило 1: alias отсутствует в каталоге, но есть в конфиге. Ревизией 1.9 не затрагивается
  // (AC-50): карточки в каталоге Hub нет вовсе, и заказчиком эта строка не оспаривалась.
  if (!input.server && input.configured) {
    return {
      alias: input.alias,
      status: "unavailable",
      // S-C10 п.7: ветка правила 1 теряет `open_hub` вместе с Hub — прочие действия дословно те же.
      actions: withoutHubActions(["disconnect", "open_hub"], input),
      state: input.local === "connected" ? "connected" : everConnected ? "lost" : "never",
      everConnected,
      deprecated,
      blocked: false,
    }
  }

  // Правило 2 применяется поверх результата правил 3–7: блокируем действия, но статус считаем как обычно.
  const blocked = input.stale

  // Столбец «Статус витрины» строк 3–7 таблицы S-V6 ревизией 1.9 не изменён.
  let status: CorpSchema.CardStatus
  let error: string | undefined

  if (input.local === "failed") {
    // Правило 3 (D-11): `failed` ближе к «недоступен», чем к «требуется авторизация».
    status = "unavailable"
    error = input.localError
  } else if ((input.local && NEEDS_AUTH_LOCAL.has(input.local)) || connection === "needs_reauth") {
    // Правило 4.
    status = "needs_auth"
    error = input.local === "needs_client_registration" ? input.localError : undefined
  } else if (input.local === "connected") {
    // Правило 5.
    status = "connected"
  } else {
    // Правила 6 и 7 дают одинаковый результат; различие только в происхождении записи.
    status = "not_connected"
  }

  // Состояние карточки (S-V16). Порядок проверок и есть таблица.
  //
  // Первым идёт `connection.status = "needs_reauth"` — ровно тем же приоритетом, каким строка 4
  // таблицы S-V6 идёт выше строки 5: Hub пометил подключение требующим повторной авторизации, и
  // работающее локальное соединение этого не отменяет (BUG-I4-011). S-V16 прямо перечисляет
  // `needs_reauth` среди условий состояния 3 и относит его к подписи «Соединение потеряно» —
  // связь сломалась сама, пользователь ничего не отключал. Пропустить эту проверку значит выдать
  // штатному исходу расширения прав (S-V9/AC-64) состояние 4: бейдж «Подключено» рядом с подписью
  // «Требуется авторизация» и ни одного способа пройти повторную авторизацию.
  const state: CorpSchema.CardState =
    connection === "needs_reauth"
      ? "lost"
      : input.local === "connected"
        ? "connected"
        : everConnected
          ? // Состояние 3 при одном наборе действий имеет две подписи: «Отключено вами» — когда
            // пользователь отключил сервер сам (S-V8 гасит запись конфига и её сохраняет),
            // «Соединение потеряно» — когда связь сломалась сама. Запись конфига без локального
            // статуса — тот же случай «отключено вами»: «Убрать из списка» её бы удалило (S-V17).
            input.local === "disabled" || (input.local === undefined && input.configured)
            ? "disconnected"
            : "lost"
          : input.local === "failed" || (input.local !== undefined && NEEDS_AUTH_LOCAL.has(input.local))
            ? "failed"
            : "never"

  let actions: CorpSchema.CardAction[] = [...ACTIONS[state]]

  // Карточка `deprecated`: «Подключить» доступно только как переподключение уже настроенного alias.
  if (deprecated && !input.configured) actions = actions.filter((action) => action !== "connect")

  // Правило 2 S-V6: на протухшем каталоге «Подключить», «Повторить» и «Права» заблокированы.
  // «Убрать из списка» остаётся: она нужна пользователю именно тогда, когда Hub недоступен, и
  // шаг обращения к Hub в ней необязателен (S-V16, S-V17 п.4).
  if (blocked)
    actions = actions.filter((action) => action !== "connect" && action !== "permissions" && action !== "reconnect")

  // S-C10 п.7–8: сборка без Hub теряет «Открыть в Hub» у всех состояний, а карточка `facade` —
  // ещё и «Подключить»/«Повторить». Причину показывает оболочка по признаку `connectNeedsHub`.
  actions = withoutHubActions(actions, input)
  const needsHubToConnect = facadeNeedsHub(input)
  if (needsHubToConnect) actions = actions.filter((action) => action !== "connect" && action !== "reconnect")

  const card: Card = {
    alias: input.alias,
    status,
    actions,
    state,
    everConnected,
    deprecated,
    blocked,
    ...(needsHubToConnect ? { connectNeedsHub: true } : {}),
  }

  // S-V19: неудачная попытка не оставляет пользователя без ответа на два вопроса — что пошло не так
  // и что теперь делать. Класс считается и здесь, а не только в ответе `connect`: карточка обязана
  // объяснять ошибку и после перезапуска приложения, когда свежей попытки не было.
  const failedState = state === "failed" || state === "lost"
  const errorClass =
    failedState && (error !== undefined || input.local !== undefined || connection === "needs_reauth")
      ? CorpErrors.connectErrorClass({
          ...(input.local === undefined ? {} : { local: input.local }),
          ...(connection === undefined ? {} : { connection }),
          ...(error === undefined ? {} : { message: error }),
        })
      : undefined

  return {
    ...card,
    ...(error === undefined ? {} : { error }),
    ...(errorClass === undefined ? {} : { errorClass }),
  }
}

/** Поиск по подстроке без учёта регистра по `title`, `alias`, `description`, `owner` (S-V11). */
export function matches(server: CorpSchema.CatalogServer, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [server.title, server.alias, server.description, server.owner].some(
    (value) => typeof value === "string" && value.toLowerCase().includes(needle),
  )
}

/**
 * Группировка по владельцу с сохранением порядка каталога Hub (S-V11, I-1 R-A3).
 * Порядок групп определяется первым вхождением владельца, порядок карточек внутри группы — исходный.
 */
export function groupByOwner<T extends { owner?: string }>(servers: T[]): { owner: string; servers: T[] }[] {
  const groups: { owner: string; servers: T[] }[] = []
  const index = new Map<string, number>()
  for (const server of servers) {
    const owner = server.owner ?? ""
    const at = index.get(owner)
    if (at === undefined) {
      index.set(owner, groups.length)
      groups.push({ owner, servers: [server] })
      continue
    }
    groups[at].servers.push(server)
  }
  return groups
}

/** Пресет по умолчанию (D-6, I-3 R-49). */
export const DEFAULT_PRESET = "readonly"

/**
 * Значение `mcp.<alias>.oauth.scope` (D-5): только для `mode: "facade"`.
 * Для `mode: "native"` права выбираются экраном согласия самого сервера.
 */
export function oauthScope(server: Pick<CorpSchema.CatalogServer, "alias" | "mode">, preset: string) {
  return server.mode === "facade" ? `${server.alias}:${preset}` : undefined
}

// --- S-V28: программный запрет OAuth-путей подключения (ревизия 1.13, микроревизия 1.13.1) ---

/**
 * Действует ли запрет OAuth-путей подключения (S-V28 п.7, D-62).
 *
 * **Одна** чистая функция без аргументов, и её спрашивают ровно две точки: строка «в» таблицы
 * S-V28 п.1 (способ `type:"oauth2"`) — через {@link methodAvailability} — и признак уровня
 * карточки S-V28 п.2 (режим `mode:"native"`) — через {@link nativeConnectDisabled}.
 * Второго условия, второго флага и второй переменной сборки нет: когда OAuth-приложения целевых
 * систем будут выданы, запрет снимается изменением **этой** функции и ничем больше — ни экраны,
 * ни роуты, ни словари, ни контракт каталога править не требуется.
 *
 * Оба запрета снимаются вместе, а не по отдельности: у них одна причина («OAuth-приложения не
 * выданы») и одно событие снятия. Раздельные переключатели создали бы состояния, за которыми не
 * стоит ни одного факта, а частичное снятие молча вернуло бы браузерный путь, который заказчик
 * закрыл. Если события когда-нибудь разойдутся, предикат расщепляется на два **в этой же**
 * функции — обе точки вызова уже готовы принять разные ответы (заранее закладывать это правило
 * запрещает: неиспользуемая гибкость здесь дороже однострочной правки потом).
 */
export function oauthDisabled(): boolean {
  return true
}

/**
 * Снятие запрета в вызове (S-V28 п.7, AC-314, AC-342): **одно** значение на обе таблицы.
 *
 * Умолчание — ответ предиката; явное значение передают тесты снятия запрета, и оно обязано
 * доходить до обеих точек, иначе «снятие одним переключением» проверить было бы нечем.
 */
export interface OauthBanOptions {
  oauthDisabled?: boolean
}

function banActive(options: OauthBanOptions | undefined): boolean {
  return options?.oauthDisabled ?? oauthDisabled()
}

/** Доступность способа подключения (S-V28 п.1): признак и его причина. */
export interface MethodAvailability {
  available: boolean
  /** `null` у доступного способа; иначе — первая подошедшая строка таблицы S-V28 п.1. */
  unavailableCode: CorpSchema.AuthMethodUnavailableCode | null
}

/**
 * Доступность одного способа (S-V28 п.1). Порядок строк таблицы — порядок проверок, и при
 * нескольких выполненных условиях берётся **первая** строка:
 * а) `available: false` в карточке каталога → `catalog_unavailable`;
 * б) `available` присутствует и не булево → `catalog_unavailable` (деградация в сторону запрета);
 * в) `type: "oauth2"` — **безусловно, независимо от `available`** → `oauth_disabled`;
 * г) значение любого заголовка способа или блока `upstream` начинается с `env:` → `env_header`.
 *
 * Строка «в» **спрашивает предикат** (п.7), а не повторяет условие у себя: второго места, где
 * записано «OAuth выключен», в коде нет.
 */
export function methodAvailability(
  method: CorpSchema.ParsedAuthMethod,
  input: { upstreamEnvHeader?: boolean } & OauthBanOptions = {},
): MethodAvailability {
  if (!method.catalogAvailable) return { available: false, unavailableCode: "catalog_unavailable" }
  if (method.availableInvalid) return { available: false, unavailableCode: "catalog_unavailable" }
  if (method.type === "oauth2" && banActive(input)) return { available: false, unavailableCode: "oauth_disabled" }
  if (method.envHeader || input.upstreamEnvHeader === true)
    return { available: false, unavailableCode: "env_header" }
  return { available: true, unavailableCode: null }
}

/** Данные карточки, по которым считается способ подключения (S-V7, S-V28 п.2). */
export interface ConnectInput {
  /** Карточка каталога; `undefined` — alias в каталоге отсутствует (правило 1 S-V6). */
  server?: CorpSchema.CatalogServer
  /** Задан ли адрес Hub в этой сборке (S-C10 п.7): от него зависит строка 3 таблицы S-V7. */
  hubConfigured?: boolean
}

/** Разобранные способы карточки вместе с их доступностью (S-V24 п.7, S-V28 п.1). */
export function authMethods(
  input: ConnectInput & OauthBanOptions,
): { method: CorpSchema.ParsedAuthMethod; availability: MethodAvailability }[] {
  const upstream = CorpSchema.parseUpstream(input.server?.upstream)
  return CorpSchema.parseAuthMethods(input.server?.auth_methods).map((method) => ({
    method,
    availability: methodAvailability(method, {
      ...(upstream?.envHeader === true ? { upstreamEnvHeader: true } : {}),
      ...(input.oauthDisabled === undefined ? {} : { oauthDisabled: input.oauthDisabled }),
    }),
  }))
}

/**
 * Закрыта ли карточка запретом OAuth-путей **на уровне режима** (S-V28 п.2, п.5, п.7).
 *
 * Это и есть тот признак уровня карточки, который называет S-V28 п.2: «`mode: "native"` **и**
 * запрет действует». Он считается **здесь и только здесь**, а `connectMode` (строка 2 таблицы
 * S-V7), `connectModeUnavailableCode` (строка «б» таблицы S-V28 п.2) и охранники корп-роутов
 * (S-V28 п.5) его **спрашивают** — второй копии условия в коде нет (S-V28 п.3).
 *
 * **Почему роут спрашивает этот признак, а не `connectModeUnavailableCode`.** Код причины —
 * величина **производная**: по строке «а» таблицы S-V28 п.2 он равен `null` у любой карточки, чей
 * `connect_mode` вычислился не в `"none"`. У `native`-карточки, где разобран блок `upstream` и
 * есть доступный способ `user_token`, строка 1 таблицы S-V7 даёт `"direct"` — и код причины
 * становится `null` на карточке, которую запрет закрывает. Охранник, спрашивающий код причины,
 * на такой карточке молча пропускает браузерный шаг S-V7; охранник, спрашивающий **этот**
 * предикат, пути стать `null` не имеет. Такую форму данных Hub не выпускает (R-U8.1 п.4:
 * `user_token` при `mode: "native"` запрещён схемой), но статический каталог (S-C10 п.3) пишется
 * руками, а S-V24 п.6 запрещает опираться на добросовестность источника.
 *
 * Поле `connect_mode_unavailable_code` при этом **не меняется**: у `direct`-карточки оно
 * по-прежнему `null` (строка «а» обязательна — форма ввода токена на такой карточке работает и
 * запретом не закрыта: прямое подключение браузера не открывает и OAuth не касается).
 *
 * **Карточка обязательна, и это часть охранника.** Признак отвечает на вопрос «закрыт ли **этот**
 * режим», поэтому карточки, которой нет, он не описывает: на пустом входе честного ответа у него
 * нет, а прежняя сигнатура (`server?`) заставляла его отвечать `false` — «не запрещено» — там, где
 * режим **неизвестен**. Ровно этим ответом роут `permissions` пропускал шаг 2 правила S-V7 у
 * alias, чья карточка из каталога исчезла. Требование непустого `server` в типе делает эту форму
 * вызова ошибкой сборки, а не поведением: вызывающий обязан назвать сторону деградации сам —
 * и по S-V28 п.10б она одна, в сторону **запрета** («неизвестное запрещено»: ответ «не запрещено»
 * допустим только при разобранной карточке с известным `mode`; тот же принцип раньше был назван
 * строкой «б» таблицы п.1, где неразобранное `available` даёт `catalog_unavailable`, а не
 * «доступен»).
 */
export function nativeConnectDisabled(
  input: ConnectInput & OauthBanOptions & { server: CorpSchema.CatalogServer },
): boolean {
  return input.server.mode === "native" && banActive(input)
}

/**
 * Способ подключения карточки (S-V7, таблица ревизии 1.13). Порядок строк — порядок проверок:
 * 1) разобран `upstream` **и** есть хотя бы один доступный способ `user_token` → `"direct"`;
 * 2) иначе `mode: "native"` **и** запрет OAuth снят → `"native"`;
 * 3) иначе `mode: "facade"` и адрес Hub задан → `"facade"`;
 * 4) иначе → `"none"`.
 *
 * Прямой режим сильнее фасада: при обоих применимых вариантах побеждает строка 1 — сборка
 * переходного периода обязана вести себя как сборка целевого состояния.
 */
export function connectMode(input: ConnectInput & OauthBanOptions): CorpSchema.ConnectMode {
  const server = input.server
  if (!server) return "none"
  const upstream = CorpSchema.parseUpstream(server.upstream)
  const direct =
    upstream !== undefined &&
    authMethods(input).some((entry) => entry.method.type === "user_token" && entry.availability.available)
  if (direct) return "direct"
  // Строка 2 спрашивает тот же предикат, что строка «в» таблицы S-V28 п.1 (п.7), — через общий
  // признак уровня карточки: при действующем запрете строка не срабатывает и выбор идёт дальше —
  // до строки 4.
  if (server.mode === "native") return nativeConnectDisabled({ ...input, server }) ? "none" : "native"
  if (server.mode === "facade" && input.hubConfigured !== false) return "facade"
  return "none"
}

/**
 * Причина отсутствия действия «Подключить» на уровне карточки (S-V28 п.2). Порядок строк «а»–«г»
 * обязателен, и берётся первая подошедшая:
 * а) `connect_mode` вычислился не в `"none"` → `null`: действие «Подключить» работает;
 * б) `mode: "native"` **и** запрет действует → `"oauth_disabled"`;
 * в) `mode: "facade"` и адрес Hub не задан → `"facade_needs_hub"` (прежнее поведение ревизии 1.11);
 * г) иначе → `"no_method"`.
 *
 * Отдельного кода причины для `native` не заводится (D-62): пользователю строка «б» говорит ровно
 * то же, что строка «в» таблицы S-V28 п.1, и снимается тем же одним предикатом. Различие
 * «способ» / «карточка» несёт **имя поля**, а не второе значение.
 */
export function connectModeUnavailableCode(
  input: ConnectInput & OauthBanOptions,
): CorpSchema.ConnectModeUnavailableCode | null {
  if (connectMode(input) !== "none") return null
  const server = input.server
  // Карточки нет — строка «б» неприменима: код причины описывает карточку, а её нет. Ответ идёт в
  // строку «г» (`no_method`), как и прежде: это **предъявление**, а не охранник, и запрещать здесь
  // нечего — вход в браузерный шаг закрывают роуты (S-V28 п.5), а не текст причины.
  if (server !== undefined && nativeConnectDisabled({ ...input, server })) return "oauth_disabled"
  if (server?.mode === "facade" && input.hubConfigured === false) return "facade_needs_hub"
  return "no_method"
}

/**
 * Способы карточки в наблюдаемой форме (S-V24 п.7): то и только то, что уходит в ответ
 * `GET /corp/catalog`.
 *
 * Блоки `verify`, `exchange`, `revoke` и заголовки `upstream` сюда **не попадают**: их исполняет
 * серверная часть, и оболочке они не нужны. Способ `oauth2` присутствует со своими `id`, `title` и
 * `type` и при этом недоступен: «не разобран» и «недоступен» — разные состояния, и реализация,
 * выбрасывающая такие способы при разборе, правило нарушает (S-V28 п.6).
 *
 * `unavailable_reason` показывается **только** там, где его называет каталог (строка «а» таблицы
 * S-V28 п.1): у прочих строк текст берётся из словаря, а не из данных.
 */
export function authMethodViews(input: ConnectInput & OauthBanOptions): CorpSchema.AuthMethodView[] {
  return authMethods(input).map(({ method, availability }) => {
    const fromCatalog =
      availability.unavailableCode === "catalog_unavailable" && !method.availableInvalid
        ? method.unavailable_reason
        : undefined
    return {
      id: method.id,
      title: method.title,
      type: method.type,
      available: availability.available,
      unavailable_code: availability.unavailableCode,
      ...(fromCatalog === undefined || fromCatalog === "" ? {} : { unavailable_reason: fromCatalog }),
      ...(method.field === undefined
        ? {}
        : {
            field: {
              label: method.field.label,
              secret: method.field.secret,
              ...(method.field.hint === undefined ? {} : { hint: method.field.hint }),
              ...(method.field.docs_url === undefined ? {} : { docs_url: method.field.docs_url }),
              ...(method.field.placeholder === undefined ? {} : { placeholder: method.field.placeholder }),
              ...(method.field.min_length === undefined ? {} : { min_length: method.field.min_length }),
              ...(method.field.max_length === undefined ? {} : { max_length: method.field.max_length }),
            },
          }),
    }
  })
}
