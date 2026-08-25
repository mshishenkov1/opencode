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
      ...(authKind === undefined ? {} : { auth_kind: authKind }),
      // Дословно: разбирается модель отдельно, а в кэш и наружу уходит исходное значение Hub (S-V3).
      ...(raw["permission_model"] === undefined ? {} : { permission_model: raw["permission_model"] }),
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
  hub_error: Schema.optional(Code),
}).annotate({ identifier: "CorpStatus" })
export type CorpStatus = Schema.Schema.Type<typeof CorpStatus>

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
  error: Schema.optional(Schema.String),
  /** Класс ошибки состояний 2 и 3 таблицы S-V16 (S-V19): по нему карточка выбирает объяснение. */
  error_class: Schema.optional(ConnectErrorClass),
  hub_url: Schema.optional(Schema.String),
}).annotate({ identifier: "CorpCatalogCard" })
export type CatalogCard = Schema.Schema.Type<typeof CatalogCard>

export const CatalogView = Schema.Struct({
  version: Schema.String,
  source: Schema.Literals(["hub", "cache"]),
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

export const PermissionsResult = Schema.Struct({
  alias: Schema.String,
  status: CardStatus,
  preset: Schema.String,
  reauth_required: Schema.Boolean,
  hub_error: Schema.optional(Code),
}).annotate({ identifier: "CorpPermissionsResult" })
export type PermissionsResult = Schema.Schema.Type<typeof PermissionsResult>

/** Код ошибки Hub в ответах корп-роутов (S-A5). */
export const HubErrorCode = Code

/** Класс ошибки подключения в ответах корп-роутов (S-V19). */
export const ConnectErrorClassCode = ConnectErrorClass
