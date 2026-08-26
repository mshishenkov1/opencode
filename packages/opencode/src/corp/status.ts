import * as CorpErrors from "./errors"
import type * as CorpSchema from "./schema"

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
  const connection = input.server?.connection?.status

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
