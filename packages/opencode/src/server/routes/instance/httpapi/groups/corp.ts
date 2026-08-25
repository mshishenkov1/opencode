import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as CorpSchema from "@/corp/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

/**
 * Корпоративные роуты (S-A1, S-V1).
 *
 * Весь обмен с Hub идёт отсюда (D-2): UI знает только эти маршруты, `poll_secret` и ключ провайдера
 * наружу не отдаются. При выключенных корп-функциях (S-C5) каждый маршрут отвечает
 * `501 {"error":"corp_disabled"}`.
 */

export class CorpDisabledError extends Schema.ErrorClass<CorpDisabledError>("CorpDisabledError")(
  { error: Schema.Literal("corp_disabled") },
  { httpApiStatus: 501 },
) {}

/** Ошибка обращения к Hub со стабильным кодом (S-A5); тексты Hub наружу не пересылаются. */
export class CorpHubError extends Schema.ErrorClass<CorpHubError>("CorpHubError")(
  { error: CorpSchema.HubErrorCode, retry_after: Schema.optional(Schema.Number) },
  { httpApiStatus: 502 },
) {}

export const TeamPayload = Schema.Struct({ team_id: Schema.String })
export const ConnectPayload = Schema.Struct({ preset: Schema.optional(Schema.String) })
export const PermissionsPayload = Schema.Struct({
  preset: Schema.String,
  groups: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

export const CatalogQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  refresh: Schema.optional(Schema.String),
})

export const CorpPaths = {
  loginStart: "/corp/login/start",
  loginPoll: "/corp/login/poll/:loginID",
  loginTeam: "/corp/login/poll/:loginID/team",
  loginCancel: "/corp/login/poll/:loginID",
  status: "/corp/status",
  catalog: "/corp/catalog",
  connect: "/corp/connectors/:alias/connect",
  disconnect: "/corp/connectors/:alias/disconnect",
  // corp: «Убрать из списка» (S-V17) — DELETE самой записи, а не подчинённого ресурса: действие
  // удаляет `mcp.<alias>` из конфига, чего «Отключить» не делает.
  forget: "/corp/connectors/:alias",
  permissions: "/corp/connectors/:alias/permissions",
} as const

export const CorpApi = HttpApi.make("corp")
  .add(
    HttpApiGroup.make("corp")
      .add(
        HttpApiEndpoint.post("loginStart", CorpPaths.loginStart, {
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.LoginStart, "Корпоративный вход начат"),
          error: [CorpDisabledError, CorpHubError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.login.start",
            summary: "Start corporate SSO login",
            description: "Начинает вход через корпоративный SSO: возвращает код и адрес для браузера.",
          }),
        ),
        HttpApiEndpoint.get("loginPoll", CorpPaths.loginPoll, {
          params: { loginID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.LoginPoll, "Состояние входа"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.login.poll",
            summary: "Poll corporate SSO login",
            description: "Опрашивает Hub о состоянии входа; poll_secret наружу не отдаётся.",
          }),
        ),
        HttpApiEndpoint.post("loginTeam", CorpPaths.loginTeam, {
          params: { loginID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: TeamPayload,
          success: described(CorpSchema.LoginPoll, "Команда выбрана"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.login.team",
            summary: "Select team for corporate SSO login",
            description: "Отправляет выбранную команду в Hub и возвращает состояние входа.",
          }),
        ),
        HttpApiEndpoint.delete("loginCancel", CorpPaths.loginCancel, {
          params: { loginID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.LoginCancel, "Сессия входа освобождена"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.login.cancel",
            summary: "Cancel corporate SSO login",
            description: "Освобождает сессию входа в памяти сервера при закрытии экрана (S-A9).",
          }),
        ),
        HttpApiEndpoint.get("status", CorpPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.CorpStatus, "Состояние корпоративного режима"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.status",
            summary: "Corporate mode status",
            description: "Адрес Hub, наличие ключа, версия и свежесть кэша каталога.",
          }),
        ),
        HttpApiEndpoint.get("catalog", CorpPaths.catalog, {
          query: CatalogQuery,
          success: described(CorpSchema.CatalogView, "Каталог коннекторов"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.catalog",
            summary: "Connector catalog",
            description: "Каталог корпоративных MCP-серверов с состоянием карточек и деградацией на кэш.",
          }),
        ),
        HttpApiEndpoint.post("connect", CorpPaths.connect, {
          params: { alias: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: ConnectPayload,
          success: described(CorpSchema.ConnectorResult, "Коннектор подключён"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.connect",
            summary: "Connect connector",
            description: "Пишет mcp.<alias> в глобальный конфиг и запускает штатный MCP-OAuth.",
          }),
        ),
        HttpApiEndpoint.post("disconnect", CorpPaths.disconnect, {
          params: { alias: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.ConnectorResult, "Коннектор отключён"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.disconnect",
            summary: "Disconnect connector",
            description: "Снимает OAuth-токены, гасит MCP и снимает подключение в Hub.",
          }),
        ),
        HttpApiEndpoint.delete("forget", CorpPaths.forget, {
          params: { alias: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.ForgetResult, "Коннектор убран из списка"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.forget",
            summary: "Forget connector",
            description: "Удаляет запись mcp.<alias> из конфига, снимает признак подключения и подключение в Hub.",
          }),
        ),
        HttpApiEndpoint.put("permissions", CorpPaths.permissions, {
          params: { alias: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: PermissionsPayload,
          success: described(CorpSchema.PermissionsResult, "Права обновлены"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.permissions",
            summary: "Update connector permissions",
            description: "Обновляет пресет прав в Hub и, для mode:facade, oauth.scope в конфиге.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "corp",
          description: "Корпоративные роуты: вход по SSO и витрина коннекторов.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
