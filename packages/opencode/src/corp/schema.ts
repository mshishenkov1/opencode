import { Option, Schema } from "effect"
import { Code, ErrorClass as ConnectErrorClass } from "./errors"

/**
 * Схемы корпоративного слоя (§3 спецификации).
 *
 * Один и тот же набор используется дважды: для валидации ответов Hub в `corp/hub.ts` (несоответствие →
 * `hub_invalid_response`, S-V2) и для описания корп-роутов HTTP API (S-A1, S-V1).
 */

// --- §3.1 Вход ---

export const CliStart = Schema.Struct({
  login_id: Schema.String,
  poll_secret: Schema.String,
  browser_url: Schema.String,
  user_code: Schema.String,
  expires_in: Schema.Number,
}).annotate({ identifier: "CorpCliStart" })
export type CliStart = Schema.Schema.Type<typeof CliStart>

export const Team = Schema.Struct({
  team_id: Schema.String,
  team_alias: Schema.String,
}).annotate({ identifier: "CorpTeam" })
export type Team = Schema.Schema.Type<typeof Team>

/**
 * Пользователь Hub (§3.1, §3.2, S-A13, D-19).
 *
 * Обязателен только `user_id`: корпоративный LiteLLM email при входе через SSO не возвращает, поэтому
 * Hub присылает поле `email` отсутствующим или со значением `null`. Такое тело схеме **соответствует**
 * и отбрасыванию по S-V2 не подлежит (BUG-I1-002: отброшенный ready-ответ означает потерянный ключ).
 */
export const HubUser = Schema.Struct({
  user_id: Schema.String,
  email: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "CorpHubUser" })
export type HubUser = Schema.Schema.Type<typeof HubUser>

export const KeyKind = Schema.Literals(["persistent", "jwt"])
export type KeyKind = Schema.Schema.Type<typeof KeyKind>

const CliPollPending = Schema.Struct({ status: Schema.Literal("pending") }).annotate({
  identifier: "CorpCliPollPending",
})
const CliPollTeamSelection = Schema.Struct({
  status: Schema.Literal("team_selection_required"),
  teams: Schema.mutable(Schema.Array(Team)),
}).annotate({ identifier: "CorpCliPollTeamSelection" })
const CliPollReady = Schema.Struct({
  status: Schema.Literal("ready"),
  key: Schema.String,
  key_kind: KeyKind,
  user: HubUser,
  team_id: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
}).annotate({ identifier: "CorpCliPollReady" })

export const CliPoll = Schema.Union([CliPollPending, CliPollTeamSelection, CliPollReady]).annotate({
  identifier: "CorpCliPoll",
  discriminator: "status",
})
export type CliPoll = Schema.Schema.Type<typeof CliPoll>

// --- §3.2 Каталог и подключения ---

export const ServerStatus = Schema.Literals(["beta", "ga", "deprecated"])
export type ServerStatus = Schema.Schema.Type<typeof ServerStatus>

export const ServerMode = Schema.Literals(["native", "facade"])
export type ServerMode = Schema.Schema.Type<typeof ServerMode>

export const ConnectionStatus = Schema.Literals(["not_connected", "connected", "needs_reauth"])
export type ConnectionStatus = Schema.Schema.Type<typeof ConnectionStatus>

export const PermissionGroup = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  preset: Schema.optional(Schema.String),
}).annotate({ identifier: "CorpPermissionGroup" })

const PermissionHeaderGroups = Schema.Struct({
  kind: Schema.Literal("header_groups"),
  groups: Schema.mutable(Schema.Array(PermissionGroup)),
  always: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
}).annotate({ identifier: "CorpPermissionHeaderGroups" })

/**
 * Пресет `tool_filter` (§3.2, R-P8 Hub): значение — **объект** `{tools: […]}`, а не строка.
 * Элементы `tools` — имена инструментов и шаблоны `fnmatch` (`whoami`, `get_*`, `*`).
 */
const PermissionToolFilterPreset = Schema.Struct({
  tools: Schema.mutable(Schema.Array(Schema.String)),
}).annotate({ identifier: "CorpPermissionToolFilterPreset" })

const PermissionToolFilter = Schema.Struct({
  kind: Schema.Literal("tool_filter"),
  presets: Schema.Record(Schema.String, PermissionToolFilterPreset),
}).annotate({ identifier: "CorpPermissionToolFilter" })

/**
 * Модель `consent` (§3.2): состав прав выбирается на экране согласия целевой системы, клиент
 * показывает только имена пресетов. Значение пресета клиентом не читается, поэтому его форма не
 * ограничивается: сузить её значило бы снова отказываться от карточки из-за поля, которое не нужно
 * ни для показа, ни для подключения (S-V14, D-26).
 */
const PermissionConsent = Schema.Struct({
  kind: Schema.Literal("consent"),
  presets: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "CorpPermissionConsent" })

export const PermissionModel = Schema.Union([PermissionHeaderGroups, PermissionToolFilter, PermissionConsent]).annotate(
  {
    identifier: "CorpPermissionModel",
    discriminator: "kind",
  },
)
export type PermissionModel = Schema.Schema.Type<typeof PermissionModel>

// --- S-V20: пятый вид модели прав — курируемый словарь групп (ревизия 1.10) ---

/** Режим группы разрешений (S-V20): ровно три значения, иное делает группу неразобранной. */
export const PermissionMode = Schema.Literals(["allow", "ask", "deny"]).annotate({
  identifier: "CorpPermissionMode",
})
export type PermissionMode = Schema.Schema.Type<typeof PermissionMode>

/**
 * Группа словаря разрешений (S-V20).
 *
 * `title` и `description` — **данные каталога** (S-I6, D-38): приходят по-русски, рендерятся как есть,
 * клиентом не переводятся и словарём не подменяются. `tools` — имена инструментов MCP-сервера в том
 * виде, в котором их отдаёт сервер; ключ `permission` из них считает клиент (S-V21).
 */
export const PermissionGroupDef = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  default: Schema.optional(PermissionMode),
  tools: Schema.mutable(Schema.Array(Schema.String)),
}).annotate({ identifier: "CorpPermissionGroupDef" })
export type PermissionGroupDef = Schema.Schema.Type<typeof PermissionGroupDef>

/**
 * Группа «Остальное» (S-V20): инструменты коннектора, не попавшие ни в одну группу.
 *
 * Блок необязателен; при его отсутствии действует `default: "ask"`, а тексты берутся из словаря
 * клиента (`corp.permissions.restTitle`, `…restDescription`) — единственное место, где тексты групп
 * не из каталога. Поэтому разбор оставляет `title`/`description` отсутствующими, а не подставляет
 * заглушку: подставить их — дело оболочки.
 */
export const PermissionGroupsRest = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  default: Schema.optional(PermissionMode),
}).annotate({ identifier: "CorpPermissionGroupsRest" })
export type PermissionGroupsRest = Schema.Schema.Type<typeof PermissionGroupsRest>

/**
 * Класс риска инструмента (S-V20, версия словаря 2): ровно три значения.
 *
 * Классы отвечают не на «о чём инструмент», а на «чем рискует пользователь, разрешив его»:
 * `read_only` — только читает, `write_delete` — меняет или удаляет данные, `interactive` — действует
 * от имени пользователя так, что это видят другие. Значение вне перечисления равносильно
 * отсутствующему (S-V14 п.3): непонятое слово не делает инструмент безопасным.
 */
export const PermissionToolClass = Schema.Literals(["read_only", "write_delete", "interactive"]).annotate({
  identifier: "CorpPermissionToolClass",
})
export type PermissionToolClass = Schema.Schema.Type<typeof PermissionToolClass>

/**
 * Инструмент в разделе `tools` словаря (S-V20, версия 2).
 *
 * `title` — человеческое имя инструмента, **данные каталога** (S-I6, D-38): приходит по-русски и
 * рендерится как есть. Поле необязательно: без него оболочка показывает техническое имя, а не
 * выдуманное. `class` в разобранной форме есть **всегда** — отсутствующий и непонятый класс
 * заполняется `interactive` (`PERMISSION_TOOL_CLASS_DEFAULT`), поэтому потребителю не приходится
 * гадать о неизвестном.
 */
export const PermissionToolDef = Schema.Struct({
  title: Schema.optional(Schema.String),
  class: PermissionToolClass,
}).annotate({ identifier: "CorpPermissionToolDef" })
export type PermissionToolDef = Schema.Schema.Type<typeof PermissionToolDef>

export const PermissionGroups = Schema.Struct({
  version: Schema.optional(Schema.Number),
  groups: Schema.mutable(Schema.Array(PermissionGroupDef)),
  rest: Schema.optional(PermissionGroupsRest),
  /**
   * Раздел `tools` версии 2 (S-V20): имя инструмента → человеческое имя и класс риска.
   *
   * Раздел необязателен и в словаре версии 1 его не бывает: тогда поля здесь нет, и экран прав
   * деградирует на прежний вид по группам. Пересечение раздела с группами не проверяется: и
   * инструмент группы, которого нет здесь, и инструмент отсюда, не попавший ни в одну группу, —
   * частичная порча, которая по S-V14 карточку не отбрасывает.
   */
  tools: Schema.optional(Schema.Record(Schema.String, PermissionToolDef)),
}).annotate({ identifier: "CorpPermissionGroups" })
export type PermissionGroups = Schema.Schema.Type<typeof PermissionGroups>

/**
 * Действующий режим группы (S-V23): свёртка режимов её инструментов по действующему конфигу.
 * `mixed` — инструменты группы разошлись; пустой группы не бывает (S-V20 требует непустой `tools`).
 */
export const PermissionStateMode = Schema.Literals(["allow", "ask", "deny", "mixed"]).annotate({
  identifier: "CorpPermissionStateMode",
})
export type PermissionStateMode = Schema.Schema.Type<typeof PermissionStateMode>

export const PermissionState = Schema.Record(Schema.String, PermissionStateMode).annotate({
  identifier: "CorpPermissionState",
})
export type PermissionState = Schema.Schema.Type<typeof PermissionState>

export const Connection = Schema.Struct({
  status: ConnectionStatus,
  preset: Schema.optional(Schema.String),
  groups: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  created_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
}).annotate({ identifier: "CorpConnection" })
export type Connection = Schema.Schema.Type<typeof Connection>

/**
 * Карточка каталога после разбора по S-V14.
 *
 * Обязательно только **ядро** (`alias`, `title`, `mode`, `mcp_url`) — поля, без которых карточку
 * нельзя ни показать, ни подключить. Всё остальное необязательно: неразобранное поле трактуется как
 * отсутствующее, а зависящая от него часть интерфейса становится недоступной.
 *
 * `permission_model` хранится **дословно, как пришло от Hub** (S-V3): вид, которого эта версия
 * клиента не понимает, обязан дожить до следующей версии неискажённым. Разобранная форма модели
 * вычисляется отдельно — `parsePermissionModel`.
 */
export const CatalogServer = Schema.Struct({
  alias: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  contact: Schema.optional(Schema.String),
  docs_url: Schema.optional(Schema.String),
  status: Schema.optional(ServerStatus),
  mode: ServerMode,
  mcp_url: Schema.String,
  permission_model: Schema.optional(Schema.Unknown),
  /**
   * Словарь разрешений (S-V20) — **дословно, как пришло от Hub**, ровно по тем же причинам, что
   * `permission_model` (S-V3): версия формата, которой эта сборка не понимает, обязана дожить до
   * следующей неискажённой. Разобранная форма считается отдельно — `parsePermissionGroups`.
   */
  permission_groups: Schema.optional(Schema.Unknown),
  /** Человеческий тип коннектора на языке каталога (S-V22): данные, а не код — клиент их не переводит. */
  type: Schema.optional(Schema.String),
  auth_kind: Schema.optional(Schema.String),
  /**
   * Способы подключения (S-V24 п.1) — **дословно, как пришло от источника** (S-V3, ревизия 1.13),
   * со всеми вложенными блоками и со всеми элементами, включая те, которых эта версия клиента не
   * разобрала и которые объявила недоступными. Разобранная форма считается отдельно —
   * `parseAuthMethods`: клиент, сохранивший только «понятые» им способы, при следующем обновлении
   * приложения показал бы обеднённый список вместо каталога.
   */
  auth_methods: Schema.optional(Schema.Unknown),
  /** Блок прямого подключения (S-V24 п.4) — тем же требованием дословности, что `auth_methods`. */
  upstream: Schema.optional(Schema.Unknown),
  connection: Schema.optional(Connection),
}).annotate({ identifier: "CorpCatalogServer" })
export type CatalogServer = Schema.Schema.Type<typeof CatalogServer>

export const Catalog = Schema.Struct({
  version: Schema.String,
  servers: Schema.mutable(Schema.Array(CatalogServer)),
}).annotate({ identifier: "CorpCatalog" })
export type Catalog = Schema.Schema.Type<typeof Catalog>

/** Отброшенный элемент списочного ответа Hub: `alias` — если удалось прочитать (S-V14 п.5). */
export const Dropped = Schema.Struct({
  alias: Schema.optional(Schema.String),
  reason: Schema.String,
}).annotate({ identifier: "CorpDropped" })
export type Dropped = Schema.Schema.Type<typeof Dropped>

// --- S-V14: трёхуровневый разбор списочных ответов Hub ---

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Непустая строка ядра карточки: `null`, пустая строка и любой другой тип — не разобрано. */
function coreString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Необязательная строка: неразобранное значение трактуется как отсутствующее (S-V14 п.3). */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function decode<S extends Schema.Codec<any, any, never, never>>(schema: S, value: unknown): S["Type"] | undefined {
  const decoded = Schema.decodeUnknownOption(schema)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

/**
 * Разбор модели прав (§3.2, S-V9).
 *
 * `undefined` означает «клиент этой модели не понял»: поле отсутствует, вид неизвестен либо форма
 * не совпала с контрактом. Карточка при этом остаётся в витрине — недоступным становится ровно
 * экран прав (S-V14 п.3, D-27).
 */
export function parsePermissionModel(value: unknown): PermissionModel | undefined {
  if (value === undefined || value === null) return undefined
  return decode(PermissionModel, value)
}

/**
 * Версия формата `permission_groups`, которую понимает эта сборка (S-V20).
 *
 * Версия 2 добавила раздел `tools`; версия 1 продолжает разбираться ровно как прежде — словарь без
 * раздела `tools` даёт прежний экран по группам, и это проверяется, а не подразумевается.
 */
export const PERMISSION_GROUPS_VERSION = 2

/** Версия, начиная с которой у словаря есть раздел `tools` (S-V20). */
export const PERMISSION_GROUPS_TOOLS_VERSION = 2

/**
 * Класс инструмента, у которого своего класса нет (S-V20, версия 2).
 *
 * Отсутствующий и непонятый класс — одно и то же и трактуется как `interactive`: про неизвестное
 * нельзя говорить «ничего не меняет», иначе непонятый инструмент попал бы в самую разрешительную
 * секцию экрана прав.
 */
export const PERMISSION_TOOL_CLASS_DEFAULT: PermissionToolClass = "interactive"

/** Режим группы «Остальное» по умолчанию, когда блок `rest` каталогом не прислан (S-V20). */
export const REST_DEFAULT_MODE: PermissionMode = "ask"

/** Идентификатор группы «Остальное» в `permission_state` и в теле роута прав (S-V23). */
export const REST_GROUP_ID = "rest"

export interface ParsedPermissionGroups {
  /** Разобранный словарь: только те группы, которые разобрались, в порядке каталога. */
  groups: PermissionGroups
  /**
   * Сколько групп выброшено разбором (S-V20, «частичная порча мягче»). Их инструменты отдельного
   * ключа не получают и потому подчиняются wildcard, то есть переходят в `rest` (S-V21).
   */
  dropped: number
}

/**
 * Разбор словаря разрешений (S-V20), по образцу `parsePermissionModel`.
 *
 * `undefined` — «клиент словаря не понял»: поля нет, нарушен конверт (`version` не число, `groups` не
 * массив), версия старше известной либо не разобралась **ни одна** группа. Карточка при этом не
 * отбрасывается (S-V14): экран прав деградирует на `permission_model` прежними видами (S-V9).
 *
 * Частичная порча мягче: неразобранная отдельная группа выбрасывается, остальные работают, а их
 * число возвращается наружу — оно доезжает до пользователя тем же средством, что число отброшенных
 * карточек (`corp.connectors.partial`, S-V14 п.5).
 */
export function parsePermissionGroups(value: unknown): ParsedPermissionGroups | undefined {
  if (value === undefined || value === null) return undefined
  const raw = record(value)
  if (!raw) return undefined
  const version = raw["version"]
  if (typeof version !== "number") return undefined
  // Формат новее известного разбирать нечем: экран деградирует, но дословное значение уцелело (S-V3).
  if (version > PERMISSION_GROUPS_VERSION) return undefined
  const rawGroups = raw["groups"]
  if (!Array.isArray(rawGroups)) return undefined

  const groups: PermissionGroupDef[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of rawGroups) {
    const group = parsePermissionGroup(entry, seen)
    if (group === undefined) {
      dropped += 1
      continue
    }
    seen.add(group.id)
    groups.push(group)
  }
  // Ни одна группа не разобралась — словарь бесполезен, действует деградация на прежний экран.
  if (groups.length === 0) return undefined

  // Раздел `tools` появился в версии 2; в словаре версии 1 он не читается — «версия 1 разбирается
  // как раньше» значит именно это, а не «как раньше плюс то, чего в том формате не было».
  const tools = version >= PERMISSION_GROUPS_TOOLS_VERSION ? parsePermissionTools(raw["tools"]) : undefined

  return {
    groups: {
      version,
      groups,
      rest: parsePermissionGroupsRest(raw["rest"]),
      ...(tools === undefined ? {} : { tools }),
    },
    dropped,
  }
}

/**
 * Разбор раздела `tools` (S-V20, версия 2).
 *
 * `undefined` — читать нечего: раздела нет, он не объект либо ни одна запись не разобралась. Это
 * **не** отбрасывает ни карточку, ни словарь: экран прав тогда показывает технические имена и
 * прежнюю разбивку по группам (S-V14 п.3).
 *
 * Отдельная испорченная запись выбрасывается поодиночке — тем же правилом, что испорченная группа.
 * Запись без `title` принимается: человеческого имени у инструмента может не быть, и показать
 * техническое честнее, чем выдумать. Запись без пригодного `class` принимается с классом
 * `interactive`.
 */
function parsePermissionTools(value: unknown): Record<string, PermissionToolDef> | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const tools: Record<string, PermissionToolDef> = {}
  for (const [name, entry] of Object.entries(raw)) {
    // Имя инструмента — ключ разрешения (S-V21); пустым ключом не разрешить ничего.
    if (name.length === 0) continue
    const def = record(entry)
    if (def === undefined) continue
    const title = coreString(def["title"])
    const cls = decode(PermissionToolClass, def["class"]) ?? PERMISSION_TOOL_CLASS_DEFAULT
    tools[name] = { class: cls, ...(title === undefined ? {} : { title }) }
  }
  return Object.keys(tools).length === 0 ? undefined : tools
}

/**
 * Разбор одной группы (S-V20). `undefined` — группа неразобрана: пустой `title` («строка без
 * названия — не выбор, а загадка»), `default` вне перечисления, пустой или нестроковый `tools`,
 * повторный `id` внутри карточки.
 */
function parsePermissionGroup(value: unknown, seen: ReadonlySet<string>): PermissionGroupDef | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const id = coreString(raw["id"])
  if (id === undefined || seen.has(id)) return undefined
  const title = coreString(raw["title"])
  if (title === undefined) return undefined
  const mode = decode(PermissionMode, raw["default"])
  if (mode === undefined) return undefined
  const rawTools = raw["tools"]
  if (!Array.isArray(rawTools)) return undefined
  const tools = rawTools.filter((tool): tool is string => typeof tool === "string" && tool.length > 0)
  if (tools.length === 0 || tools.length !== rawTools.length) return undefined
  const description = optionalString(raw["description"])
  return { id, title, default: mode, tools, ...(description === undefined ? {} : { description }) }
}

/**
 * Разбор блока `rest` (S-V20). Блок необязателен, а его порча группу «Остальное» не убирает: она
 * всегда есть, и без пригодного `default` действует `ask` — неизвестное спрашивает, а не разрешает.
 */
function parsePermissionGroupsRest(value: unknown): PermissionGroupsRest {
  const raw = record(value)
  const mode = raw === undefined ? undefined : decode(PermissionMode, raw["default"])
  const title = raw === undefined ? undefined : coreString(raw["title"])
  const description = raw === undefined ? undefined : optionalString(raw["description"])
  return {
    default: mode ?? REST_DEFAULT_MODE,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
}

// --- S-V24: способы подключения карточки и блок `upstream` (ревизия 1.13) ---

/** Тип способа подключения (S-V24 п.1): ровно два значения, третьего контракт не знает. */
export const AuthMethodType = Schema.Literals(["oauth2", "user_token"])
export type AuthMethodType = Schema.Schema.Type<typeof AuthMethodType>

/**
 * Причина недоступности **способа** (S-V28 п.1) — закрытый набор из трёх значений.
 *
 * Микроревизией 1.13.1 набор **не расширен**: запрет `mode:"native"` живёт на уровне карточки и
 * предъявляется полем `connect_mode_unavailable_code` (S-V28 п.2), а не четвёртым значением здесь.
 */
export const AuthMethodUnavailableCode = Schema.Literals(["catalog_unavailable", "oauth_disabled", "env_header"])
export type AuthMethodUnavailableCode = Schema.Schema.Type<typeof AuthMethodUnavailableCode>

/**
 * Описание поля ввода токена (S-V24 п.2) — то и только то, что нужно оболочке, чтобы нарисовать
 * форму. Секретов здесь не бывает: подпись, подсказка, ссылка на документацию и границы длины.
 */
export const AuthMethodField = Schema.Struct({
  label: Schema.String,
  secret: Schema.optional(Schema.Boolean),
  hint: Schema.optional(Schema.String),
  docs_url: Schema.optional(Schema.String),
  placeholder: Schema.optional(Schema.String),
  min_length: Schema.optional(Schema.Number),
  max_length: Schema.optional(Schema.Number),
}).annotate({ identifier: "CorpAuthMethodField" })
export type AuthMethodField = Schema.Schema.Type<typeof AuthMethodField>

/**
 * Способ подключения в ответе `GET /corp/catalog` (S-V24 п.7).
 *
 * Блоки `verify`, `exchange`, `revoke` и заголовки `upstream` наружу **не отдаются**: их исполняет
 * серверная часть, и оболочке они не нужны. `unavailable_reason` — текст каталога, показываемый
 * дословно (S-I6).
 */
export const AuthMethodView = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  type: AuthMethodType,
  available: Schema.Boolean,
  unavailable_code: Schema.NullOr(AuthMethodUnavailableCode),
  unavailable_reason: Schema.optional(Schema.String),
  field: Schema.optional(AuthMethodField),
}).annotate({ identifier: "CorpAuthMethodView" })
export type AuthMethodView = Schema.Schema.Type<typeof AuthMethodView>

/** Разобранное описание поля ввода с подставленными умолчаниями (S-V24 п.2). */
export interface AuthMethodFieldSpec {
  label: string
  /** Умолчание `true`: поле ввода маскируется, пока каталог явно не сказал обратного. */
  secret: boolean
  hint?: string
  docs_url?: string
  placeholder?: string
  min_length?: number
  max_length?: number
}

/** Блок проверки токена (S-V24 п.2, S-V25 п.2). Исполняется серверной частью и наружу не уходит. */
export interface AuthMethodVerify {
  url: string
  method: string
  headers: Record<string, string>
  /** Пустой массив означает «любой код 2xx» — умолчание `expect_status` (S-V24 п.2). */
  expect_status: number[]
  account_field?: string
  require_account: boolean
}

/** Блок обмена введённого токена на выпущенный (S-V25 п.5). */
export interface AuthMethodExchange {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
  description: string
  expect_status: number
  token_field: string
  token_id_field?: string
}

/** Блок отзыва выпущенного токена (S-V27 п.2). */
export interface AuthMethodRevoke {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

/**
 * Разобранный способ подключения (S-V24 п.1–3, п.6).
 *
 * Признаки недоступности здесь **не вычисляются**: строки таблицы S-V28 п.1 считает один общий
 * модуль `corp/status.ts` (S-V28 п.3), а разбор лишь называет факты, на которые та таблица смотрит.
 */
export interface ParsedAuthMethod {
  id: string
  title: string
  type: AuthMethodType
  /** Строка «а» таблицы S-V28 п.1: `available: false` в карточке каталога. */
  catalogAvailable: boolean
  /** Строка «б»: `available` присутствует и **не** булево — деградация в сторону запрета. */
  availableInvalid: boolean
  /** Текст причины из каталога; показывается дословно (S-I6). */
  unavailable_reason?: string
  /** Строка «г»: значение хотя бы одного заголовка способа начинается с `env:` (S-V24 п.6). */
  envHeader: boolean
  field?: AuthMethodFieldSpec
  verify?: AuthMethodVerify
  exchange?: AuthMethodExchange
  revoke?: AuthMethodRevoke
}

/**
 * Блок `upstream` карточки (S-V24 п.4): адрес MCP-сервера целевой системы и шаблоны заголовков.
 *
 * `envHeader` — тот же признак строки «г», что у способа: заголовок со значением `env:VAR`
 * приложению подставить нечем, и способ объявляется недоступным, а не подставляется литералом.
 */
export interface ParsedUpstream {
  url: string
  credential_headers: Record<string, string>
  static_headers?: Record<string, string>
  envHeader: boolean
}

/** Абсолютный адрес со схемой `http`/`https` — единственная пригодная форма адреса (S-V24 п.2, п.4). */
export function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/** Значение заголовка, которое приложению подставить нечем (S-V24 п.6): переменных сборки у него нет. */
export function isEnvReference(value: string): boolean {
  return value.startsWith("env:")
}

/**
 * Набор заголовков «имя → значение». Значения не-строк отбрасываются поэлементно (S-V14 п.3);
 * значение, не являющееся объектом, — как отсутствующее.
 */
function headerMap(value: unknown): Record<string, string> | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const headers: Record<string, string> = {}
  for (const [name, entry] of Object.entries(raw)) if (typeof entry === "string" && name !== "") headers[name] = entry
  return headers
}

function hasEnvHeader(...maps: (Record<string, string> | undefined)[]): boolean {
  return maps.some((map) => map !== undefined && Object.values(map).some(isEnvReference))
}

/** Ожидаемые коды ответа: число, массив чисел либо ничего («любой 2xx»). */
function expectStatuses(value: unknown): number[] {
  if (typeof value === "number") return [value]
  if (Array.isArray(value)) return value.filter((entry): entry is number => typeof entry === "number")
  return []
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Разбор блока `field` (S-V24 п.2): без непустой подписи форму нечем подписать — способ отбрасывается. */
function parseField(value: unknown): AuthMethodFieldSpec | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const label = coreString(raw["label"])
  if (label === undefined) return undefined
  const secret = typeof raw["secret"] === "boolean" ? raw["secret"] : true
  const hint = optionalString(raw["hint"])
  const docsUrl = optionalString(raw["docs_url"])
  const placeholder = optionalString(raw["placeholder"])
  const minLength = positiveNumber(raw["min_length"])
  const maxLength = positiveNumber(raw["max_length"])
  return {
    label,
    secret,
    ...(hint === undefined ? {} : { hint }),
    ...(docsUrl === undefined ? {} : { docs_url: docsUrl }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(minLength === undefined ? {} : { min_length: minLength }),
    ...(maxLength === undefined ? {} : { max_length: maxLength }),
  }
}

/** Разбор блока `verify` (S-V24 п.2): без пригодного адреса проверять токен нечем. */
function parseVerify(value: unknown): AuthMethodVerify | undefined {
  const raw = record(value)
  if (!raw) return undefined
  if (!isAbsoluteHttpUrl(raw["url"])) return undefined
  const accountField = coreString(raw["account_field"])
  return {
    url: raw["url"],
    method: coreString(raw["method"]) ?? "GET",
    headers: headerMap(raw["headers"]) ?? {},
    expect_status: expectStatuses(raw["expect_status"]),
    ...(accountField === undefined ? {} : { account_field: accountField }),
    require_account: raw["require_account"] === true,
  }
}

/** Разбор блока `revoke` (S-V27 п.2): без пригодного адреса отзыва у способа нет. */
function parseRevoke(value: unknown): AuthMethodRevoke | undefined {
  const raw = record(value)
  if (!raw) return undefined
  if (!isAbsoluteHttpUrl(raw["url"])) return undefined
  return {
    url: raw["url"],
    method: coreString(raw["method"]) ?? "POST",
    headers: headerMap(raw["headers"]) ?? {},
    ...(raw["body"] === undefined ? {} : { body: raw["body"] }),
  }
}

/** Разбор блока `exchange` (S-V25 п.5): без адреса и имени поля с токеном обмену неоткуда взяться. */
function parseExchange(value: unknown): AuthMethodExchange | undefined {
  const raw = record(value)
  if (!raw) return undefined
  if (!isAbsoluteHttpUrl(raw["url"])) return undefined
  const tokenField = coreString(raw["token_field"])
  if (tokenField === undefined) return undefined
  const tokenIdField = coreString(raw["token_id_field"])
  return {
    url: raw["url"],
    method: coreString(raw["method"]) ?? "POST",
    headers: headerMap(raw["headers"]) ?? {},
    ...(raw["body"] === undefined ? {} : { body: raw["body"] }),
    description: coreString(raw["description"]) ?? "OpenCode",
    expect_status: positiveNumber(raw["expect_status"]) ?? 200,
    token_field: tokenField,
    ...(tokenIdField === undefined ? {} : { token_id_field: tokenIdField }),
  }
}

/**
 * Разбор одного способа подключения (S-V24 п.1–3).
 *
 * `undefined` — ядро способа не разобрано: способ отбрасывается **поодиночке**, остальные элементы
 * массива принимаются, а карточка не отбрасывается никогда.
 */
export function parseAuthMethod(value: unknown): ParsedAuthMethod | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const id = coreString(raw["id"])
  if (id === undefined) return undefined
  const title = optionalString(raw["title"])
  if (title === undefined) return undefined
  const type = decode(AuthMethodType, raw["type"])
  if (type === undefined) return undefined

  const field = parseField(raw["field"])
  const verify = parseVerify(raw["verify"])
  // S-V24 п.2: у `user_token` подпись поля и адрес проверки — часть ядра способа.
  if (type === "user_token" && (field === undefined || verify === undefined)) return undefined

  const exchange = parseExchange(raw["exchange"])
  // S-V24 п.2: блок отзыва ищется в двух местах и в этом порядке — `exchange.revoke`, затем
  // `<способ>.revoke`. Первое найденное используется, второе не читается: в действующем каталоге
  // Hub блок лежит внутри `exchange`, а §3.2 перечисляет его на уровне способа.
  const exchangeRecord = record(raw["exchange"])
  const revoke = parseRevoke(exchangeRecord?.["revoke"]) ?? parseRevoke(raw["revoke"])

  // S-V24 п.3: `available`, не являющееся булевым, трактуется как `false` — деградация
  // неразобранного признака идёт **в сторону запрета** (единственное отступление от S-V14 п.3).
  const availablePresent = raw["available"] !== undefined
  const availableInvalid = availablePresent && typeof raw["available"] !== "boolean"
  const catalogAvailable = availableInvalid ? false : raw["available"] !== false
  const reason = optionalString(raw["unavailable_reason"])

  return {
    id,
    title,
    type,
    catalogAvailable,
    availableInvalid,
    ...(reason === undefined ? {} : { unavailable_reason: reason }),
    envHeader: hasEnvHeader(verify?.headers, exchange?.headers, revoke?.headers),
    ...(field === undefined ? {} : { field }),
    ...(verify === undefined ? {} : { verify }),
    ...(exchange === undefined ? {} : { exchange }),
    ...(revoke === undefined ? {} : { revoke }),
  }
}

/**
 * Разбор массива способов (S-V24 п.1). Значение, не являющееся массивом, трактуется как
 * отсутствующее (S-V14 п.3); неразобранный элемент выбрасывается поодиночке.
 */
export function parseAuthMethods(value: unknown): ParsedAuthMethod[] {
  if (!Array.isArray(value)) return []
  const methods: ParsedAuthMethod[] = []
  for (const entry of value) {
    const method = parseAuthMethod(entry)
    if (method) methods.push(method)
  }
  return methods
}

/**
 * Разбор блока `upstream` (S-V24 п.4).
 *
 * `undefined` — прямым режимом этот коннектор не подключается; карточка при этом **не**
 * отбрасывается и прочие её способы не ломаются.
 */
export function parseUpstream(value: unknown): ParsedUpstream | undefined {
  const raw = record(value)
  if (!raw) return undefined
  if (!isAbsoluteHttpUrl(raw["url"])) return undefined
  const credential = headerMap(raw["credential_headers"])
  if (!credential || Object.keys(credential).length === 0) return undefined
  const staticHeaders = headerMap(raw["static_headers"])
  return {
    url: raw["url"],
    credential_headers: credential,
    ...(staticHeaders === undefined ? {} : { static_headers: staticHeaders }),
    envHeader: hasEnvHeader(credential, staticHeaders),
  }
}

/** Подстановка `{{access_token}}` и прочих значений в шаблон заголовка или тела (S-V25 п.2, п.5). */
export function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : match,
  )
}

/** Тот же шаблонизатор для набора заголовков: имена не трогаются, подставляются только значения. */
export function substituteHeaders(
  headers: Record<string, string>,
  values: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) result[name] = substitute(value, values)
  return result
}

export type ServerResult = { ok: true; server: CatalogServer } | { ok: false; alias?: string; reason: string }

/**
 * Разбор одной карточки каталога (S-V14 п.2–4).
 *
 * Ядро — `alias`, `title`, `mode`, `mcp_url`; список закрыт и расширению без отдельного решения
 * спецификации не подлежит. Всё остальное деградирует. Неизвестные поля карточки игнорируются и
 * причиной отказа не являются. Ревизией 1.13 перечень ядра **не расширен** (S-V24 п.1): карточка
 * без `auth_methods` и без `upstream` принимается ровно как прежде, а неразобранный способ
 * выбрасывается поодиночке.
 */
export function parseCatalogServer(value: unknown): ServerResult {
  const raw = record(value)
  if (!raw) return { ok: false, reason: "server" }
  const alias = coreString(raw["alias"])
  const title = typeof raw["title"] === "string" ? raw["title"] : undefined
  const mode = decode(ServerMode, raw["mode"])
  const mcpUrl = coreString(raw["mcp_url"])
  if (alias === undefined) return { ok: false, reason: "alias" }
  if (title === undefined) return { ok: false, alias, reason: "title" }
  if (mode === undefined) return { ok: false, alias, reason: "mode" }
  if (mcpUrl === undefined) return { ok: false, alias, reason: "mcp_url" }

  const description = optionalString(raw["description"])
  const owner = optionalString(raw["owner"])
  const contact = optionalString(raw["contact"])
  const docsUrl = optionalString(raw["docs_url"])
  const status = decode(ServerStatus, raw["status"])
  // S-V22: значение неизвестного вида равносильно отсутствию поля и на приём карточки не влияет.
  const type = optionalString(raw["type"])
  const authKind = optionalString(raw["auth_kind"])
  const connection = raw["connection"] === undefined ? undefined : decode(Connection, raw["connection"])

  return {
    ok: true,
    server: {
      alias,
      title,
      mode,
      mcp_url: mcpUrl,
      ...(description === undefined ? {} : { description }),
      ...(owner === undefined ? {} : { owner }),
      ...(contact === undefined ? {} : { contact }),
      ...(docsUrl === undefined ? {} : { docs_url: docsUrl }),
      ...(status === undefined ? {} : { status }),
      ...(type === undefined ? {} : { type }),
      ...(authKind === undefined ? {} : { auth_kind: authKind }),
      // Дословно: разбирается модель отдельно, а в кэш и наружу уходит исходное значение Hub (S-V3).
      ...(raw["permission_model"] === undefined ? {} : { permission_model: raw["permission_model"] }),
      // То же требование ревизия 1.10 распространяет на словарь разрешений (S-V20, S-V3).
      ...(raw["permission_groups"] === undefined ? {} : { permission_groups: raw["permission_groups"] }),
      // Ревизия 1.13 — то же дословное хранение для способов подключения и блока `upstream`
      // (S-V24 п.5, S-V3): разбираются они отдельно, а в кэш и наружу уходит исходное значение.
      ...(raw["auth_methods"] === undefined ? {} : { auth_methods: raw["auth_methods"] }),
      ...(raw["upstream"] === undefined ? {} : { upstream: raw["upstream"] }),
      ...(connection === undefined ? {} : { connection }),
    },
  }
}

export interface ParsedCatalog {
  version: string
  servers: CatalogServer[]
  dropped: Dropped[]
}

/**
 * Разбор ответа `GET /api/catalog` (S-V14 п.1–2).
 *
 * `undefined` — нарушен **конверт** (тело не объект, нет `version`, `servers` не массив): только это
 * даёт `hub_invalid_response` и оставляет кэш нетронутым (S-V2, AC-160). Неразобранная карточка
 * отбрасывается поодиночке, остальные принимаются.
 *
 * `version` принимается строкой и числом (живой Hub отдаёт `1`): версия каталога нигде не
 * разбирается по составу, а отказ целого экрана из-за её формы — тот самый класс дефектов, который
 * закрывает S-V14.
 */
export function parseCatalog(value: unknown): ParsedCatalog | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const version = raw["version"]
  if (typeof version !== "string" && typeof version !== "number") return undefined
  const servers = raw["servers"]
  if (!Array.isArray(servers)) return undefined

  const accepted: CatalogServer[] = []
  const dropped: Dropped[] = []
  for (const entry of servers) {
    const parsed = parseCatalogServer(entry)
    if (parsed.ok) accepted.push(parsed.server)
    else
      dropped.push(
        parsed.alias === undefined ? { reason: parsed.reason } : { alias: parsed.alias, reason: parsed.reason },
      )
  }
  return { version: String(version), servers: accepted, dropped }
}

export interface ParsedConnections {
  items: MyConnection[]
  dropped: Dropped[]
}

export const Me = Schema.Struct({
  user_id: Schema.String,
  // S-A13: email необязателен и допускает `null` — обязателен только `user_id`.
  email: Schema.optional(Schema.NullOr(Schema.String)),
  key_kind: Schema.optional(KeyKind),
  created_at: Schema.optional(Schema.String),
}).annotate({ identifier: "CorpMe" })
export type Me = Schema.Schema.Type<typeof Me>

export const MyConnection = Schema.Struct({
  alias: Schema.String,
  status: ConnectionStatus,
  preset: Schema.optional(Schema.String),
  groups: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  created_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
}).annotate({ identifier: "CorpMyConnection" })
export type MyConnection = Schema.Schema.Type<typeof MyConnection>

export const MyConnections = Schema.mutable(Schema.Array(MyConnection))

/**
 * Разбор ответа `GET /api/me/connections` (S-V14 п.6).
 *
 * Ядро элемента — `alias` (непустая строка) и `status` (известное значение); неразобранный элемент
 * отбрасывается, остальные применяются. `undefined` — тело не массив (нарушен конверт).
 */
export function parseMyConnections(value: unknown): ParsedConnections | undefined {
  if (!Array.isArray(value)) return undefined
  const items: MyConnection[] = []
  const dropped: Dropped[] = []
  for (const entry of value) {
    const raw = record(entry)
    if (!raw) {
      dropped.push({ reason: "connection" })
      continue
    }
    const alias = coreString(raw["alias"])
    if (alias === undefined) {
      dropped.push({ reason: "alias" })
      continue
    }
    const status = decode(ConnectionStatus, raw["status"])
    if (status === undefined) {
      dropped.push({ alias, reason: "status" })
      continue
    }
    const preset = optionalString(raw["preset"])
    const groups = decode(Schema.mutable(Schema.Array(Schema.String)), raw["groups"])
    const createdAt = optionalString(raw["created_at"])
    const updatedAt = optionalString(raw["updated_at"])
    items.push({
      alias,
      status,
      ...(preset === undefined ? {} : { preset }),
      ...(groups === undefined ? {} : { groups }),
      ...(createdAt === undefined ? {} : { created_at: createdAt }),
      ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    })
  }
  return { items, dropped }
}

export const PermissionsUpdate = Schema.Struct({
  alias: Schema.String,
  status: ConnectionStatus,
  preset: Schema.optional(Schema.String),
  groups: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
}).annotate({ identifier: "CorpPermissionsUpdate" })
export type PermissionsUpdate = Schema.Schema.Type<typeof PermissionsUpdate>

export const DisconnectResult = Schema.Struct({
  alias: Schema.String,
  status: ConnectionStatus,
}).annotate({ identifier: "CorpDisconnectResult" })

// --- Кэш каталога на диске (S-V3) ---

/**
 * Файл кэша (S-V3). Карточки хранятся как есть, без схемы: разбор при чтении выполняет тот же
 * `parseCatalogServer`, что и ответ Hub, поэтому кэш, записанный другой версией клиента, не
 * отбрасывается целиком из-за одной карточки и не теряет дословный `permission_model`.
 */
export const CatalogCacheFile = Schema.Struct({
  hub_url: Schema.String,
  fetched_at: Schema.Number,
  version: Schema.String,
  servers: Schema.mutable(Schema.Array(Schema.Unknown)),
}).annotate({ identifier: "CorpCatalogCacheFile" })
export type CatalogCacheFile = Schema.Schema.Type<typeof CatalogCacheFile>

// --- Статус карточки витрины (S-V6) ---

export const CardStatus = Schema.Literals(["connected", "needs_auth", "not_connected", "unavailable"])
export type CardStatus = Schema.Schema.Type<typeof CardStatus>

/**
 * Действия карточки (S-V6, S-V16).
 *
 * Ревизия 1.9 добавила `forget` («Убрать из списка», S-V17) — действие с другим смыслом и другим
 * результатом, чем `disconnect`: оно **удаляет** запись `mcp.<alias>` из конфига, тогда как
 * «Отключить» её сохраняет ради повтора в один клик (D-31). Прежние значения сохранены.
 */
export const CardAction = Schema.Literals(["connect", "reconnect", "disconnect", "forget", "permissions", "open_hub"])
export type CardAction = Schema.Schema.Type<typeof CardAction>

/**
 * Пользовательское состояние карточки (S-V16) — то, что различает не подпись, а набор действий.
 *
 * `never` — состояние 1 «Не подключён»; `failed` — состояние 2 «Подключение не удалось»;
 * `lost` и `disconnected` — две подписи состояния 3 при одном наборе действий («Соединение
 * потеряно» и «Отключено вами»); `connected` — состояние 4 «Подключено».
 */
export const CardState = Schema.Literals(["never", "failed", "lost", "disconnected", "connected"])
export type CardState = Schema.Schema.Type<typeof CardState>

/**
 * Способ подключения карточки (S-V7, ревизия 1.13) — закрытый набор из четырёх значений.
 *
 * `"native"` из набора **не удалён** микроревизией 1.13.1 (S-V28 п.6): пока действует запрет,
 * сервер этого значения не отдаёт, но контракт его знает, а обе оболочки сохраняют его ветвь.
 */
export const ConnectMode = Schema.Literals(["direct", "native", "facade", "none"])
export type ConnectMode = Schema.Schema.Type<typeof ConnectMode>

/**
 * Причина отсутствия действия «Подключить» **на уровне карточки** (S-V28 п.2, микроревизия 1.13.1).
 *
 * Поле непусто только при `connect_mode: "none"`. `no_method` — тотализирующее умолчание: на данных
 * действующего контракта (`mode ∈ {native, facade}`) оно недостижимо и объявлено, чтобы разбор
 * оставался тотальным.
 */
export const ConnectModeUnavailableCode = Schema.Literals(["oauth_disabled", "facade_needs_hub", "no_method"])
export type ConnectModeUnavailableCode = Schema.Schema.Type<typeof ConnectModeUnavailableCode>

/** Исход проверки токена (S-V25 п.3) — закрытый набор из пяти значений. */
export const VerifyResult = Schema.Literals([
  "verified",
  "account_missing",
  "token_rejected",
  "verify_failed",
  "upstream_unreachable",
])
export type VerifyResult = Schema.Schema.Type<typeof VerifyResult>

/** Исход обмена токена (S-V25 п.5) — закрытый набор из четырёх значений. */
export const ExchangeResult = Schema.Literals([
  "exchanged",
  "exchange_denied",
  "exchange_failed",
  "exchange_unreachable",
])
export type ExchangeResult = Schema.Schema.Type<typeof ExchangeResult>

/** Исход отзыва выпущенного токена (S-V27 п.2) — закрытый набор из четырёх значений. */
export const RevokeResult = Schema.Literals(["skipped", "revoked", "not_revoked", "unreachable"])
export type RevokeResult = Schema.Schema.Type<typeof RevokeResult>

// --- Ответы корп-роутов (S-A1, S-V1) ---

export const LoginStart = Schema.Struct({
  login_id: Schema.String,
  user_code: Schema.String,
  browser_url: Schema.String,
  expires_in: Schema.Number,
}).annotate({ identifier: "CorpLoginStart" })
export type LoginStart = Schema.Schema.Type<typeof LoginStart>

/** Ответ на отмену входа (S-A9): сессия в памяти сервера освобождена. */
export const LoginCancel = Schema.Struct({
  cancelled: Schema.Boolean,
}).annotate({ identifier: "CorpLoginCancel" })
export type LoginCancel = Schema.Schema.Type<typeof LoginCancel>

const LoginPending = Schema.Struct({ status: Schema.Literal("pending") }).annotate({
  identifier: "CorpLoginPending",
})
const LoginTeamSelection = Schema.Struct({
  status: Schema.Literal("team_selection_required"),
  teams: Schema.mutable(Schema.Array(Team)),
}).annotate({ identifier: "CorpLoginTeamSelection" })
const LoginReady = Schema.Struct({
  status: Schema.Literal("ready"),
  user: HubUser,
  key_kind: KeyKind,
}).annotate({ identifier: "CorpLoginReady" })
const LoginError = Schema.Struct({
  status: Schema.Literal("error"),
  error: Schema.String,
  message: Schema.String,
  retry_after: Schema.optional(Schema.Number),
}).annotate({ identifier: "CorpLoginError" })

export const LoginPoll = Schema.Union([LoginPending, LoginTeamSelection, LoginReady, LoginError]).annotate({
  identifier: "CorpLoginPoll",
  discriminator: "status",
})
export type LoginPoll = Schema.Schema.Type<typeof LoginPoll>

/**
 * Корп-провайдер выключен личным конфигом пользователя (S-C9, S-C11) — и файл, где это записано.
 *
 * Поле присутствует **только** пока состояние держится; его отсутствие — обычное состояние, а не
 * «неизвестно» (S-A1, ревизия 1.12).
 */
export const ProviderDisabled = Schema.Struct({
  file: Schema.String,
}).annotate({ identifier: "CorpProviderDisabled" })
export type ProviderDisabled = Schema.Schema.Type<typeof ProviderDisabled>

export const CorpStatus = Schema.Struct({
  hub_url: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  authenticated: Schema.Boolean,
  user: Schema.optional(HubUser),
  key_kind: Schema.optional(KeyKind),
  hub_reachable: Schema.optional(Schema.Boolean),
  catalog_version: Schema.optional(Schema.String),
  catalog_cached_at: Schema.optional(Schema.Number),
  catalog_stale: Schema.optional(Schema.Boolean),
  provider_disabled: Schema.optional(ProviderDisabled),
  hub_error: Schema.optional(Code),
}).annotate({ identifier: "CorpStatus" })
export type CorpStatus = Schema.Schema.Type<typeof CorpStatus>

// --- S-A14, S-C11: выход и возврат провайдера (ревизия 1.12, микроревизия 1.12.1) ---

/**
 * Ответ Hub на `DELETE {hub}/api/me/key` (§3.1, R-L11.6; микроревизия 1.12.1).
 *
 * Неудача отзыва в LiteLLM ошибочным ответ **не** делает: Hub отвечает `200` с `revoked:false` и
 * кодом причины. Разбираются ровно два поля — `revoked` и `revoke_error` (S-A14 п.1); `status` и
 * `message` в разбор не входят намеренно: `message` пользователю не показывается и наружу не
 * пересылается (S-A5), а `status` дублирует HTTP-статус.
 *
 * `revoke_error` объявлен строкой, а не закрытым набором: значение переносится **дословно** (S-V3),
 * и неизвестный код обязан дойти до оболочки и до лога, а не превратить весь ответ в
 * `hub_invalid_response` — «неизвестная причина» и «ответ без смысла» это разные вещи.
 */
export const KeyRevoke = Schema.Struct({
  revoked: Schema.Boolean,
  revoke_error: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "CorpKeyRevoke" })
export type KeyRevoke = Schema.Schema.Type<typeof KeyRevoke>

/**
 * Исход серверной части выхода (S-A14 п.1) — закрытая таблица из **четырёх** значений
 * (микроревизия 1.12.1: прежняя редакция знала три и не различала «Hub ответил, но не отозвал» и
 * «Hub не ответил»).
 *
 * `revoked` — Hub подтвердил отзыв (или ответил `401`/`403`: ключ уже недействителен, цель
 * достигнута); `not_revoked` — Hub ответил `200` с `revoked:false`: своё состояние он убрал, но в
 * LiteLLM ключ **мог остаться живым**, а для корп-сборки это ключ модели (S-C4b); `unavailable` —
 * Hub не ответил (`5xx`, таймаут, сетевая ошибка, нечитаемое тело), и о судьбе ключа не известно
 * ничего; `skipped` — шага не было вовсе: либо ключа не было (п.5), либо адрес Hub не задан (п.6,
 * сборка без Hub).
 *
 * `not_revoked` и `unavailable` — **разные** исходы, и сливать их запрещено: в первом случае
 * известно, что ключ не отозван, и известна причина; во втором неизвестно ничего.
 */
export const LogoutHubOutcome = Schema.Literals(["revoked", "not_revoked", "unavailable", "skipped"]).annotate({
  identifier: "CorpLogoutHubOutcome",
})
export type LogoutHubOutcome = Schema.Schema.Type<typeof LogoutHubOutcome>

/**
 * Ответ `POST /corp/logout` (S-A1, S-A14): две части выхода описаны по отдельности, потому что они
 * по-разному надёжны. `key_removed:false` при `hub:"skipped"` — идемпотентный случай «ключа не было»
 * и не ошибка (п.5). Ключ, его часть и заголовок авторизации сюда не попадают (п.8).
 *
 * `hub_error` заполнен при `hub:"unavailable"` (код по S-A5), `revoke_error` — при
 * `hub:"not_revoked"` (код Hub дословно, S-V3). Одновременно они не появляются: это два разных
 * исхода, а не два поля одного.
 */
export const LogoutResult = Schema.Struct({
  key_removed: Schema.Boolean,
  hub: LogoutHubOutcome,
  hub_error: Schema.optional(Code),
  revoke_error: Schema.optional(Schema.String),
}).annotate({ identifier: "CorpLogoutResult" })
export type LogoutResult = Schema.Schema.Type<typeof LogoutResult>

/**
 * Почему действие «Включить» ничего не изменило (S-C11 п.4).
 *
 * `foreign_layer` — запись лежит в слое, который приложение не правит (конфиг проекта,
 * `OPENCODE_CONFIG`): молча править не свой слой — та же ошибка, что молча править чужой конфиг
 * (S-C7). `not_disabled` — провайдер уже не выключен: править нечего, и это не ошибка.
 */
export const ProviderEnableReason = Schema.Literals(["foreign_layer", "not_disabled"]).annotate({
  identifier: "CorpProviderEnableReason",
})
export type ProviderEnableReason = Schema.Schema.Type<typeof ProviderEnableReason>

/**
 * Ответ действия «Включить» (S-C11 п.4).
 *
 * `provider_disabled` — состояние **после** действия, тем же полем, что в `GET /corp/status`:
 * его отсутствие и означает, что предупреждение должно исчезнуть, — не потому что его закрыли, а
 * потому что исчезло состояние.
 */
export const ProviderEnableResult = Schema.Struct({
  changed: Schema.Boolean,
  provider_disabled: Schema.optional(ProviderDisabled),
  reason: Schema.optional(ProviderEnableReason),
}).annotate({ identifier: "CorpProviderEnableResult" })
export type ProviderEnableResult = Schema.Schema.Type<typeof ProviderEnableResult>

/** Карточка витрины: данные каталога Hub + вычисленное состояние (S-V5, S-V6). */
export const CatalogCard = Schema.Struct({
  alias: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  contact: Schema.optional(Schema.String),
  docs_url: Schema.optional(Schema.String),
  // Для alias, пропавшего из каталога (S-V6, правило 1), данных Hub нет — поля отсутствуют.
  server_status: Schema.optional(ServerStatus),
  mode: Schema.optional(ServerMode),
  mcp_url: Schema.optional(Schema.String),
  permission_model: Schema.optional(PermissionModel),
  /**
   * Разобранный словарь разрешений (S-V20). Отсутствие поля — деградация на прежний экран по
   * `permission_model` (S-V9), а не пустой экран. Предпочитается `permission_model`, если карточка
   * отдаёт оба (D-35).
   */
  permission_groups: Schema.optional(PermissionGroups),
  /** Действующий режим каждой группы по конфигу (S-V23); считает сервер, клиент его не вычисляет. */
  permission_state: Schema.optional(PermissionState),
  /** Значение колонки «Тип» (S-V22) — как пришло из каталога, без перевода. */
  type: Schema.optional(Schema.String),
  connection_status: Schema.optional(ConnectionStatus),
  preset: Schema.optional(Schema.String),
  status: CardStatus,
  actions: Schema.mutable(Schema.Array(CardAction)),
  /** Состояние карточки по признаку «подключение состоялось» (S-V15, S-V16). */
  state: CardState,
  /** Признак «подключение состоялось» (S-V15): от него зависит набор действий. */
  ever_connected: Schema.Boolean,
  deprecated: Schema.Boolean,
  blocked: Schema.Boolean,
  configured: Schema.Boolean,
  /**
   * Подключение этой карточки выполняется через Hub-фасад, а адрес Hub не задан (S-V7, S-C10 п.8).
   *
   * Действия `connect`/`reconnect` в наборе отсутствуют, а на месте кнопки оболочка показывает
   * причину недоступности (`corp.connectors.facadeNeedsHub`) — там же, где была бы кнопка.
   */
  connect_needs_hub: Schema.optional(Schema.Boolean),
  /**
   * Экран прав этой карточки Hub-зависим (`header_groups`/`tool_filter`/`consent`), а адрес Hub не
   * задан (S-V9, S-C10 п.7): экран показывается заблокированным с причиной
   * (`corp.connectors.permissionsNeedHub`). Вид `permission_groups` целиком локален, и признак у
   * него не выставляется.
   */
  permissions_need_hub: Schema.optional(Schema.Boolean),
  /**
   * Способ подключения карточки (S-V7, ревизия 1.13): по нему оболочка решает, показывать ли форму
   * ввода токена, вести ли в браузер или назвать причину. Вычисляет его общий модуль
   * `corp/status.ts`; ни Desktop, ни TUI второй копии условия не заводят (S-V28 п.3).
   */
  connect_mode: Schema.optional(ConnectMode),
  /**
   * Причина отсутствия действия «Подключить» на уровне карточки (S-V28 п.2, микроревизия 1.13.1).
   * Непусто **только** при `connect_mode: "none"`; по этому полю — а не по одному лишь
   * `connect_mode` — оболочка разводит неактивное действие (`oauth_disabled`) и прежнее поведение
   * ревизии 1.11 (`facade_needs_hub`).
   */
  connect_mode_unavailable_code: Schema.optional(ConnectModeUnavailableCode),
  /** Разобранные способы подключения с признаком доступности (S-V24 п.7). */
  auth_methods: Schema.optional(Schema.mutable(Schema.Array(AuthMethodView))),
  /**
   * Есть ли для этого alias сохранённые учётные данные (S-V26 п.6). Это **всё**, что о хранилище
   * видно снаружи: ни значения токена, ни его длины, ни производных наружу не уходит.
   */
  has_credentials: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.String),
  /** Класс ошибки состояний 2 и 3 таблицы S-V16 (S-V19): по нему карточка выбирает объяснение. */
  error_class: Schema.optional(ConnectErrorClass),
  hub_url: Schema.optional(Schema.String),
}).annotate({ identifier: "CorpCatalogCard" })
export type CatalogCard = Schema.Schema.Type<typeof CatalogCard>

export const CatalogView = Schema.Struct({
  version: Schema.String,
  /**
   * Источник каталога (S-V1, S-C10 п.3). `"static"` — ответ статического адреса `CATALOG_URL`,
   * `"hub"` — ответ `GET {hub}/api/catalog`, `"cache"` — отдача из дискового кэша независимо от
   * того, каким источником этот кэш был наполнен.
   */
  source: Schema.Literals(["hub", "static", "cache"]),
  /**
   * Задан ли адрес Hub в этой сборке (S-C10 п.7, D-43).
   *
   * По нему оболочка выбирает, каким источником называть недоступность («Hub недоступен» против
   * «Каталог недоступен», S-V12 п.3) и показывать ли причины `facadeNeedsHub`/`permissionsNeedHub`.
   * Признак вьюшный, а не карточный: он один на весь экран и не зависит от того, какой источник
   * ответил в этот раз. Поле необязательно только ради совместимости ответа: отсутствие значит
   * «сборка с Hub» — поведение до ревизии 1.11.
   */
  hub_configured: Schema.optional(Schema.Boolean),
  cached_at: Schema.optional(Schema.Number),
  stale: Schema.Boolean,
  servers: Schema.mutable(Schema.Array(CatalogCard)),
  hub_error: Schema.optional(Code),
  /** Карточки, отброшенные разбором (S-V14 п.5): `alias` — если удалось прочитать, `reason` — поле. */
  dropped: Schema.optional(Schema.mutable(Schema.Array(Dropped))),
}).annotate({ identifier: "CorpCatalogView" })
export type CatalogView = Schema.Schema.Type<typeof CatalogView>

export const ConnectorResult = Schema.Struct({
  alias: Schema.String,
  status: CardStatus,
  error: Schema.optional(Schema.String),
  /**
   * Класс ошибки подключения (S-V19): что показать пользователю и что ему предложить сделать.
   * `error` (код S-A5) он не заменяет — тот отвечает на другой вопрос.
   */
  error_class: Schema.optional(ConnectErrorClass),
  /**
   * Исход отзыва выпущенного токена при отключении прямо подключённой карточки (S-V27 п.2).
   * `skipped` («звать было некого») и `unreachable` («позвали, не ответил») — разные события.
   */
  revoke: Schema.optional(RevokeResult),
  hub_error: Schema.optional(Code),
}).annotate({ identifier: "CorpConnectorResult" })
export type ConnectorResult = Schema.Schema.Type<typeof ConnectorResult>

/**
 * Ответ прямого подключения токеном (S-V1 ревизии 1.13, S-V25).
 *
 * **Значение токена не возвращается ни в одном ответе, включая успешный** (S-V26 п.6): наружу о
 * хранилище видно ровно `credentials_saved` и, если целевая система его назвала, `account`.
 */
export const ConnectTokenResult = Schema.Struct({
  alias: Schema.String,
  status: CardStatus,
  /** `id` способа, которым выполнялось подключение (S-V25 п.1, строка 2). */
  auth_method: Schema.String,
  verify_result: VerifyResult,
  /** Код ответа целевой системы, когда он был; при `upstream_unreachable` поля нет. */
  verify_status: Schema.optional(Schema.Number),
  account: Schema.optional(Schema.String),
  /** `null` — блока `exchange` у способа нет: отсутствие обмена не исход и не предупреждение. */
  exchange_result: Schema.NullOr(ExchangeResult),
  credentials_saved: Schema.Boolean,
}).annotate({ identifier: "CorpConnectTokenResult" })
export type ConnectTokenResult = Schema.Schema.Type<typeof ConnectTokenResult>

/**
 * Ответ «Убрать из списка» (S-V17, S-V1).
 *
 * `removed` — запись `mcp.<alias>` из конфига удалена и признак подключения снят; `hub_error`
 * означает, что необязательный шаг обращения к Hub не выполнен, а локальные шаги 1–3 не откачены.
 */
export const ForgetResult = Schema.Struct({
  alias: Schema.String,
  status: CardStatus,
  removed: Schema.Boolean,
  /** Исход отзыва выпущенного токена (S-V27 п.2, п.4): те же четыре значения, что у «Отключить». */
  revoke: Schema.optional(RevokeResult),
  hub_error: Schema.optional(Code),
}).annotate({ identifier: "CorpForgetResult" })
export type ForgetResult = Schema.Schema.Type<typeof ForgetResult>

/**
 * Ответ роута прав (S-V1).
 *
 * Ревизия 1.10 сделала `preset` необязательным и добавила `permission_state`: у вида
 * `permission_groups` пресета нет вовсе — Hub в записи не участвует (D-35), а показывать нужно
 * пересчитанный по конфигу режим каждой группы (S-V23). Для прежних видов оба поля ведут себя как
 * прежде: `preset` заполнен, `permission_state` отсутствует.
 */
export const PermissionsResult = Schema.Struct({
  alias: Schema.String,
  status: CardStatus,
  preset: Schema.optional(Schema.String),
  reauth_required: Schema.Boolean,
  permission_state: Schema.optional(PermissionState),
  hub_error: Schema.optional(Code),
}).annotate({ identifier: "CorpPermissionsResult" })
export type PermissionsResult = Schema.Schema.Type<typeof PermissionsResult>

/** Код ошибки Hub в ответах корп-роутов (S-A5). */
export const HubErrorCode = Code

/** Класс ошибки подключения в ответах корп-роутов (S-V19). */
export const ConnectErrorClassCode = ConnectErrorClass
