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

export const PermissionGroups = Schema.Struct({
  version: Schema.optional(Schema.Number),
  groups: Schema.mutable(Schema.Array(PermissionGroupDef)),
  rest: Schema.optional(PermissionGroupsRest),
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

/** Версия формата `permission_groups`, которую понимает эта сборка (S-V20). */
export const PERMISSION_GROUPS_VERSION = 1

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

  return { groups: { version, groups, rest: parsePermissionGroupsRest(raw["rest"]) }, dropped }
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

export type ServerResult = { ok: true; server: CatalogServer } | { ok: false; alias?: string; reason: string }

/**
 * Разбор одной карточки каталога (S-V14 п.2–4).
 *
 * Ядро — `alias`, `title`, `mode`, `mcp_url`; список закрыт и расширению без отдельного решения
 * спецификации не подлежит. Всё остальное деградирует. Неизвестные поля карточки (`auth_methods`
 * и любые будущие) игнорируются и причиной отказа не являются.
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

// --- S-A14, S-C11: выход и возврат провайдера (ревизия 1.12) ---

/**
 * Исход серверной части выхода (S-A14 п.1).
 *
 * `revoked` — Hub подтвердил отзыв (или ответил `401`/`403`: ключ уже недействителен, цель
 * достигнута); `unavailable` — Hub не ответил, и ключ остался живым на сервере; `skipped` — шага
 * не было вовсе: либо ключа не было (п.5), либо адрес Hub не задан (п.6, сборка без Hub).
 */
export const LogoutHubOutcome = Schema.Literals(["revoked", "unavailable", "skipped"]).annotate({
  identifier: "CorpLogoutHubOutcome",
})
export type LogoutHubOutcome = Schema.Schema.Type<typeof LogoutHubOutcome>

/**
 * Ответ `POST /corp/logout` (S-A1, S-A14): две части выхода описаны по отдельности, потому что они
 * по-разному надёжны. `key_removed:false` при `hub:"skipped"` — идемпотентный случай «ключа не было»
 * и не ошибка (п.5). Ключ, его часть и заголовок авторизации сюда не попадают (п.8).
 */
export const LogoutResult = Schema.Struct({
  key_removed: Schema.Boolean,
  hub: LogoutHubOutcome,
  hub_error: Schema.optional(Code),
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
  hub_error: Schema.optional(Code),
}).annotate({ identifier: "CorpConnectorResult" })
export type ConnectorResult = Schema.Schema.Type<typeof ConnectorResult>

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
