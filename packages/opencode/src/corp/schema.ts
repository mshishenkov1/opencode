import { Schema } from "effect"
import { Code } from "./errors"

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

const PermissionPresets = Schema.Struct({
  kind: Schema.Literals(["consent", "tool_filter"]),
  presets: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "CorpPermissionPresets" })

export const PermissionModel = Schema.Union([PermissionHeaderGroups, PermissionPresets]).annotate({
  identifier: "CorpPermissionModel",
  discriminator: "kind",
})
export type PermissionModel = Schema.Schema.Type<typeof PermissionModel>

export const Connection = Schema.Struct({
  status: ConnectionStatus,
  preset: Schema.optional(Schema.String),
  groups: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  created_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
}).annotate({ identifier: "CorpConnection" })
export type Connection = Schema.Schema.Type<typeof Connection>

export const CatalogServer = Schema.Struct({
  alias: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  contact: Schema.optional(Schema.String),
  docs_url: Schema.optional(Schema.String),
  status: ServerStatus,
  mode: ServerMode,
  mcp_url: Schema.String,
  permission_model: Schema.optional(PermissionModel),
  auth_kind: Schema.optional(Schema.String),
  connection: Schema.optional(Connection),
}).annotate({ identifier: "CorpCatalogServer" })
export type CatalogServer = Schema.Schema.Type<typeof CatalogServer>

export const Catalog = Schema.Struct({
  version: Schema.String,
  servers: Schema.mutable(Schema.Array(CatalogServer)),
}).annotate({ identifier: "CorpCatalog" })
export type Catalog = Schema.Schema.Type<typeof Catalog>

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

export const CatalogCacheFile = Schema.Struct({
  hub_url: Schema.String,
  fetched_at: Schema.Number,
  version: Schema.String,
  servers: Schema.mutable(Schema.Array(CatalogServer)),
}).annotate({ identifier: "CorpCatalogCacheFile" })
export type CatalogCacheFile = Schema.Schema.Type<typeof CatalogCacheFile>

// --- Статус карточки витрины (S-V6) ---

export const CardStatus = Schema.Literals(["connected", "needs_auth", "not_connected", "unavailable"])
export type CardStatus = Schema.Schema.Type<typeof CardStatus>

export const CardAction = Schema.Literals(["connect", "reconnect", "disconnect", "permissions", "open_hub"])
export type CardAction = Schema.Schema.Type<typeof CardAction>

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
  deprecated: Schema.Boolean,
  blocked: Schema.Boolean,
  configured: Schema.Boolean,
  error: Schema.optional(Schema.String),
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
}).annotate({ identifier: "CorpCatalogView" })
export type CatalogView = Schema.Schema.Type<typeof CatalogView>

export const ConnectorResult = Schema.Struct({
  alias: Schema.String,
  status: CardStatus,
  error: Schema.optional(Schema.String),
  hub_error: Schema.optional(Code),
}).annotate({ identifier: "CorpConnectorResult" })
export type ConnectorResult = Schema.Schema.Type<typeof ConnectorResult>

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
