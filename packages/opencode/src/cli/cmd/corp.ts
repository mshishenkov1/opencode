import { Auth } from "@/auth"
import * as CorpCatalogCache from "@/corp/catalog-cache"
import * as CorpDiagnostics from "@/corp/diagnostics"
import * as CorpHub from "@/corp/hub"
import * as CorpLogin from "@/corp/login"
import * as CorpLogout from "@/corp/logout"
import type * as CorpSchema from "@/corp/schema"
import {
  CORP_PROVIDER_ID,
  corpCatalogUrl,
  corpHubUrl,
  corpUserEmail,
  corpUserLabel,
} from "@opencode-ai/core/corp/constants"
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

/**
 * Сборка без Hub, но со статическим каталогом (S-C5, S-C10 п.2): корп-функции включены, а вход по
 * SSO зависит от Hub и потому недоступен. Причина называется вслух — вместо запроса на незаданный
 * адрес и вместо неправды «корпоративный режим не настроен».
 */
const SSO_DISABLED = "Вход по корпоративному SSO в этой сборке не настроен: адрес Hub не задан"

const println = (message: string) => Effect.sync(() => UI.println(message))
const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL
const openBrowser = (url: string) =>
  Effect.promise(() =>
    open(url)
      .then(() => true)
      .catch(() => false),
  )

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
    const catalog = corpCatalogUrl()
    // S-C10 п.2: выключено только при отсутствии обоих адресов.
    if (!url && !catalog) {
      yield* println(DISABLED)
      return yield* fail(DISABLED)
    }

    if (url) yield* println(`Hub: ${url}`)
    else {
      // Сборка без Hub: строки о доступности Hub, ключе и пользователе относятся к Hub и потому не
      // печатаются вовсе — вместо них назван действующий источник каталога (S-C10 п.3, D-43).
      yield* println(`Каталог: ${catalog}`)
      yield* println(SSO_DISABLED)
    }

    // S-A11a: сразу после строки «Hub: …» — адрес модели по S-C4a; конфликты личного конфига (S-C9)
    // читаются здесь же, потому что для них нужен кэш каталога Hub.
    // Кэш каталога ключуется адресом источника (S-V3, S-C10 п.3): в сборке без Hub это адрес
    // статического каталога.
    const cached = yield* Effect.promise(() => CorpCatalogCache.read(url ?? catalog!))
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

    // Строки о Hub печатаются только в сборке с Hub: в сборке без него они отвечали бы на вопрос,
    // которого пользователь не задавал (S-C10 п.7, D-43).
    const hub = url ? CorpHub.make({ hubUrl: url, ...(key === undefined ? {} : { key }) }) : undefined
    if (hub) {
      const health = yield* Effect.promise(() => hub.health())
      yield* println(`Доступность Hub: ${health.ok ? "доступен (ok)" : "недоступен"}`)
      yield* println(`Корпоративный ключ: ${key ? "есть" : "нет"}`)
    }

    if (hub && key) {
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
    // S-C11 п.2: у выключенного провайдера прежняя строка сохранена дословно и дополнена подсказкой
    // о действии — чинить конфиг сама команда по-прежнему не вправе (S-C7).
    if (report.providerDisabled) yield* println(CorpDiagnostics.LINES.providerDisabledHint)

    // Ключ нужен Hub, а не каталогу: в сборке без Hub его отсутствие не ошибка (S-C10 п.6).
    if (url && !key) return yield* fail("Ключ не найден: выполните opencode corp login")
    if (CorpDiagnostics.hasConflicts(report)) return yield* fail("")
  }),
})

/**
 * Построчный контракт вывода `opencode corp logout` (S-A15), по образцу S-A11a.
 *
 * Две строки — по одной на часть выхода, чтобы исход каждой был виден отдельно. В сборке без Hub
 * (S-C10) строки о сервере нет вовсе: сервера в этой сборке нет, и говорить о нём нечего (D-43).
 * Формулировки — часть контракта: правятся одновременно со спекой и `cli.test.ts`.
 */
export const LOGOUT_LINES = {
  revoked: "Ключ отозван на сервере.",
  /** Микроревизия 1.12.1: сервер ответил и **не** отозвал (`hub:"not_revoked"`), причина известна. */
  notRevoked: (reason: string) =>
    `Ключ на сервере не отозван: ${reason}. Он может продолжать работать до истечения срока.`,
  revokeFailed: (reason: string) => `Отозвать ключ на сервере не удалось: ${reason}.`,
  removed: "Локальный ключ удалён.",
  notSignedIn: "Ключ не найден: выход не требуется.",
  removeFailed: (reason: string) => `Локальный ключ удалить не удалось: ${reason}.`,
} as const

/**
 * Причина отказа отзыва по коду `revoke_error` (S-A14 п.1, S-I1) — **закрытый набор**.
 *
 * Неизвестный код человеку не показывается: он не объясняет ничего, — показывается текст
 * «неожиданного ответа», а сам код называет лог сервера (`corp logout` в `Effect.logInfo`).
 * Текст `message` ответа Hub не пересылается и не показывается (S-A5).
 */
export function revokeReasonText(code: string | undefined): string {
  switch (code) {
    case "not_permitted":
      return "отзыв ключа не разрешён"
    case "upstream_unavailable":
      return "сервис ключей недоступен"
    default:
      return "сервис ключей вернул неожиданный ответ"
  }
}

export const CorpLogoutCommand = effectCmd({
  command: "logout",
  describe: "выход из корпоративного SSO: отзыв ключа на сервере и удаление его локально",
  instance: false,
  builder: withHub,
  handler: Effect.fn("Cli.corp.logout")(function* (args: HubArgs) {
    const url = corpHubUrl(args.hub)
    // S-C10 п.2: режим выключен только при отсутствии обоих адресов; со статическим каталогом
    // выход осмыслен — ключ мог остаться от сборки с Hub.
    if (!url && !corpCatalogUrl()) {
      yield* println(DISABLED)
      return yield* fail(DISABLED)
    }

    const authSvc = yield* Auth.Service
    const outcome = yield* CorpLogout.perform({ auth: authSvc, ...(url === undefined ? {} : { hubUrl: url }) })

    if (!outcome.keyRemoved && outcome.removeError === undefined) {
      // Идемпотентный случай: ключа не было. Про сервер не говорится — запроса к нему и не было.
      yield* println(LOGOUT_LINES.notSignedIn)
      return
    }

    // Строка серверной части печатается по своему фактическому исходу и код выхода не определяет.
    // Исходов четыре (S-A14 п.1), и `not_revoked` со `unavailable` сливать нельзя: первое —
    // «сервер ответил и точно не отозвал, причина такая-то», второе — «о судьбе ключа не известно».
    if (outcome.hub === "revoked") yield* println(LOGOUT_LINES.revoked)
    else if (outcome.hub === "not_revoked")
      yield* println(LOGOUT_LINES.notRevoked(revokeReasonText(outcome.revokeError)))
    else if (outcome.hub === "unavailable")
      yield* println(LOGOUT_LINES.revokeFailed(errorText(outcome.hubError ?? "hub_unavailable")))

    if (outcome.removeError !== undefined) {
      // D-49: код выхода определяется локальной частью — и только ею.
      const line = LOGOUT_LINES.removeFailed(outcome.removeError)
      yield* println(line)
      return yield* fail(line)
    }
    yield* println(LOGOUT_LINES.removed)
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
      // S-C5: без обоих адресов режим не настроен вовсе; со статическим каталогом — не настроен
      // именно вход, и путать эти два ответа нельзя.
      const message = corpCatalogUrl() ? SSO_DISABLED : DISABLED
      yield* println(message)
      return yield* fail(message)
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
  describe: "корпоративный режим: вход по SSO, выход и статус",
  builder: (yargs) =>
    yargs.command(CorpLoginCommand).command(CorpLogoutCommand).command(CorpStatusCommand).demandCommand(),
  async handler() {},
})
