import { Auth } from "@/auth"
import * as CorpCatalogCache from "@/corp/catalog-cache"
import * as CorpDiagnostics from "@/corp/diagnostics"
import * as CorpHub from "@/corp/hub"
import * as CorpLogin from "@/corp/login"
import type * as CorpSchema from "@/corp/schema"
import { CORP_PROVIDER_ID, corpHubUrl, corpUserEmail, corpUserLabel } from "@opencode-ai/core/corp/constants"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Option } from "effect"
import open from "open"
import { effectCmd, fail } from "../effect-cmd"
import * as Prompt from "../effect/prompt"
import { UI } from "../ui"
import { cmd } from "./cmd"

/**
 * Команды `opencode corp login|status` (S-A10, S-A11, S-A12).
 *
 * Ключ, `poll_secret` и токены не печатаются никогда. При выключенных корп-функциях (S-C5) обе
 * команды печатают «Корпоративный режим не настроен» и завершаются с кодом 1.
 */

const DISABLED = "Корпоративный режим не настроен: не задан адрес Hub (--hub, OPENCODE_CORP_HUB_URL или сборка)"

const println = (message: string) => Effect.sync(() => UI.println(message))
const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL
const openBrowser = (url: string) => Effect.promise(() => open(url).then(() => true).catch(() => false))

interface HubArgs {
  hub?: string
}

const withHub = (yargs: import("yargs").Argv) =>
  yargs.option("hub", {
    describe: "адрес корпоративного Hub (перекрывает OPENCODE_CORP_HUB_URL и build-константу)",
    type: "string" as const,
  })

/** Сообщение по коду ошибки (S-A5); совпадает по смыслу со словарём UI. */
export function errorText(code: string): string {
  switch (code) {
    case "hub_unavailable":
      return "Hub недоступен"
    case "hub_invalid_response":
      return "Hub вернул неожиданный ответ"
    case "login_expired":
      return "Сессия входа истекла"
    case "forbidden":
      return "Доступ запрещён"
    case "invalid_team":
      return "Неизвестная команда"
    case "team_selection_not_required":
      return "Выбор команды не требуется"
    case "rate_limited":
      return "Слишком много попыток, повторите позже"
    case "litellm_unavailable":
      return "Сервис ключей недоступен"
    case "litellm_invalid_response":
      return "Сервис ключей вернул неожиданный ответ"
    case "unauthorized":
      return "Нужен вход: ключ не найден"
    case "not_found":
      return "Не найдено"
    case "invalid_request":
      return "Некорректный запрос"
    default:
      return code
  }
}

export const CorpStatusCommand = effectCmd({
  command: "status",
  describe: "состояние корпоративного режима: Hub, ключ, кэш каталога",
  instance: false,
  builder: withHub,
  handler: Effect.fn("Cli.corp.status")(function* (args: HubArgs) {
    const url = corpHubUrl(args.hub)
    if (!url) {
      yield* println(DISABLED)
      return yield* fail(DISABLED)
    }

    yield* println(`Hub: ${url}`)

    // S-A11a: сразу после строки «Hub: …» — адрес модели по S-C4a; конфликты личного конфига (S-C9)
    // читаются здесь же, потому что для них нужен кэш каталога Hub.
    const cached = yield* Effect.promise(() => CorpCatalogCache.read(url))
    const report = yield* Effect.promise(() =>
      CorpDiagnostics.inspect({
        directory: process.cwd(),
        ...(cached === undefined ? {} : { catalog: cached.servers }),
      }).catch(() => CorpDiagnostics.EMPTY),
    )
    yield* println(CorpDiagnostics.LINES.model(report.model ?? "не задана", report.baseURL ?? "адрес не задан"))

    const authSvc = yield* Auth.Service
    const record = yield* authSvc.get(CORP_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
    const key = record?.type === "api" ? record.key : undefined

    const hub = CorpHub.make({ hubUrl: url, ...(key === undefined ? {} : { key }) })
    const health = yield* Effect.promise(() => hub.health())
    yield* println(`Доступность Hub: ${health.ok ? "доступен (ok)" : "недоступен"}`)
    yield* println(`Корпоративный ключ: ${key ? "есть" : "нет"}`)

    if (key) {
      const me = yield* Effect.promise(() => hub.me())
      if (me.ok) {
        // S-A11a / S-A13: email известен — `Пользователь: <email> <user_id>`, иначе `Пользователь: <user_id>`.
        const email = corpUserEmail(me.data)
        yield* println(
          email === undefined ? `Пользователь: ${me.data.user_id}` : `Пользователь: ${email} ${dim(me.data.user_id)}`,
        )
        if (me.data.key_kind) yield* println(`Тип ключа: ${me.data.key_kind}`)
      } else {
        yield* println(`Пользователь: ${errorText(me.code)}`)
      }
    }

    if (!cached) {
      yield* println("Каталог: кэша нет")
    } else {
      const stale = CorpCatalogCache.isStale(cached, Date.now())
      const at = new Date(cached.fetchedAt).toISOString()
      yield* println(`Каталог: версия ${cached.version}, кэш от ${at}${stale ? " (протух)" : ""}`)
    }

    // S-C9: конфликты личного конфига называются, но не чинятся; любой из них даёт код выхода 1.
    for (const line of CorpDiagnostics.conflictLines(report)) yield* println(line)

    if (!key) return yield* fail("Ключ не найден: выполните opencode corp login")
    if (CorpDiagnostics.hasConflicts(report)) return yield* fail("")
  }),
})

export const CorpLoginCommand = effectCmd({
  command: "login",
  describe: "вход через корпоративный SSO",
  instance: false,
  builder: (yargs) =>
    withHub(yargs).option("team", {
      describe: "идентификатор команды (для неинтерактивного режима)",
      type: "string" as const,
    }),
  handler: Effect.fn("Cli.corp.login")(function* (args: HubArgs & { team?: string }) {
    const url = corpHubUrl(args.hub)
    if (!url) {
      yield* println(DISABLED)
      return yield* fail(DISABLED)
    }

    const authSvc = yield* Auth.Service
    const hub = CorpHub.make({ hubUrl: url })

    yield* Prompt.intro("Вход через корпоративный SSO")
    yield* Prompt.log.info(`Hub: ${url}`)

    const started = yield* Effect.promise(() => hub.cliStart(CorpHub.clientDescriptor(InstallationVersion)))
    if (!started.ok) return yield* fail(errorText(started.code))

    const { login_id: loginId, poll_secret: pollSecret, browser_url: browserUrl, user_code: userCode } = started.data
    yield* Prompt.log.info(`Откройте: ${browserUrl}`)
    yield* Prompt.log.info(`Код: ${userCode}`)
    const opened = yield* openBrowser(browserUrl)
    if (!opened) yield* Prompt.log.warn("Не удалось открыть браузер — перейдите по адресу выше вручную")

    const deadline = Date.now() + (started.data.expires_in || CorpLogin.DEFAULT_EXPIRES_IN_S) * 1000
    let hubErrors = 0
    let teamSent = false

    const spinner = Prompt.spinner()
    yield* spinner.start("Ожидание подтверждения…")

    while (true) {
      if (Date.now() > deadline) {
        yield* spinner.stop("Сессия входа истекла", 1)
        return yield* fail(errorText("login_expired"))
      }

      const result = yield* Effect.promise(() => hub.cliPoll(loginId, pollSecret))

      if (!result.ok) {
        let code: string = result.code
        if (code === "hub_unavailable" || code === "litellm_unavailable") {
          hubErrors += 1
          if (hubErrors < CorpLogin.MAX_CONSECUTIVE_HUB_ERRORS) {
            yield* Effect.sleep(CorpLogin.POLL_INTERVAL_MS)
            continue
          }
          // S-A4: бюджет сетевых ошибок исчерпан — наружу всегда hub_unavailable.
          code = "hub_unavailable"
        }
        yield* spinner.stop(errorText(code), 1)
        return yield* fail(errorText(code))
      }
      hubErrors = 0

      const data = result.data
      if (data.status === "pending") {
        yield* Effect.sleep(CorpLogin.POLL_INTERVAL_MS)
        continue
      }

      if (data.status === "team_selection_required") {
        if (teamSent) {
          yield* spinner.stop("Hub повторно требует выбор команды", 1)
          return yield* fail(errorText("invalid_team"))
        }
        yield* spinner.stop("Требуется выбор команды")
        const teamId = yield* selectTeam(data.teams, args.team)
        if (teamId === undefined) return yield* fail("Выбор команды отменён")
        const sent = yield* Effect.promise(() => hub.cliTeam(loginId, pollSecret, teamId))
        if (!sent.ok) return yield* fail(errorText(sent.code))
        teamSent = true
        yield* spinner.start("Ожидание подтверждения…")
        yield* Effect.sleep(CorpLogin.POLL_INTERVAL_MS)
        continue
      }

      yield* authSvc
        .set(CORP_PROVIDER_ID, {
          type: "api",
          key: data.key,
          metadata: CorpLogin.authMetadata({
            hubUrl: url,
            keyKind: data.key_kind,
            userId: data.user.user_id,
            ...(data.team_id === undefined ? {} : { teamId: data.team_id }),
          }),
        })
        .pipe(Effect.orDie)

      // S-A13: при неизвестном email пользователь показывается по `user_id` (AC-129).
      yield* spinner.stop(`Вход выполнен: ${corpUserLabel(data.user)}`)
      yield* Prompt.log.info(`Тип ключа: ${data.key_kind}`)
      yield* Prompt.outro("Готово")
      return
    }
  }),
})

/** Выбор команды: `--team` в неинтерактивном режиме, иначе нумерованный список (S-A10). */
const selectTeam = Effect.fnUntraced(function* (teams: CorpSchema.Team[], preselected?: string) {
  if (preselected) {
    const found = teams.find((team) => team.team_id === preselected)
    if (!found) {
      yield* Prompt.log.error(`Команда ${preselected} не найдена. Доступны: ${teams.map((t) => t.team_id).join(", ")}`)
      return undefined
    }
    return found.team_id
  }
  if (!process.stdin.isTTY) {
    yield* Prompt.log.error(
      `Требуется выбор команды. Повторите с --team <id>. Доступны: ${teams.map((t) => `${t.team_id} (${t.team_alias})`).join(", ")}`,
    )
    return undefined
  }
  const selected = yield* Prompt.select({
    message: "Выберите команду",
    options: teams.map((team) => ({ value: team.team_id, label: `${team.team_alias} ${team.team_id}` })),
  })
  return Option.isNone(selected) ? undefined : selected.value
})

export const CorpCommand = cmd({
  command: "corp",
  describe: "корпоративный режим: вход по SSO и статус",
  builder: (yargs) => yargs.command(CorpLoginCommand).command(CorpStatusCommand).demandCommand(),
  async handler() {},
})
