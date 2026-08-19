import { TextAttributes } from "@opentui/core"
import type { CorpTeam } from "@opencode-ai/sdk/v2"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useClipboard } from "../../context/clipboard"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { errorText, t } from "../../corp/i18n"
import { useBindings } from "../../keymap"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { Link } from "../../ui/link"
import { useToast } from "../../ui/toast"
import { DialogProvider as DialogProviderList } from "../dialog-provider"
import { POLL_INTERVAL_MS } from "../../corp/state"

/**
 * Корп-экран входа по SSO для TUI (S-A6, S-T8).
 *
 * Шаги: старт → крупный код и ссылка → (при необходимости) выбор команды → успех либо ошибка.
 * `poll_secret` живёт на сервере (S-A2) — здесь его нет.
 */

type Step =
  | { kind: "starting" }
  | { kind: "waiting"; loginID: string; code: string; url: string }
  | { kind: "teams"; loginID: string; teams: CorpTeam[] }
  | { kind: "error"; code: string }

export function DialogCorpLogin() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const clipboard = useClipboard()

  const [step, setStep] = createSignal<Step>({ kind: "starting" })
  const [hub, setHub] = createSignal<string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  // S-A9: закрытие экрана прекращает опрос; сессия на сервере протухает сама по expires_in.
  onCleanup(() => {
    stopped = true
    if (timer) clearTimeout(timer)
  })

  async function finish(email: string) {
    stopped = true
    toast.show({ variant: "success", message: `${t("login.success")}: ${email}` })
    // Тот же порядок, что и в upstream-флоу провайдера (F6): сбросить инстанс и перечитать состояние.
    await sdk.client.instance.dispose().catch(() => undefined)
    await sync.bootstrap()
    dialog.clear()
  }

  async function poll(loginID: string) {
    if (stopped) return
    const result = await sdk.client.corp.login.poll({ loginID }).catch(() => undefined)
    if (stopped) return
    const data = result?.data
    if (!data) {
      setStep({ kind: "error", code: "hub_unavailable" })
      return
    }
    if (data.status === "pending") {
      timer = setTimeout(() => void poll(loginID), POLL_INTERVAL_MS)
      return
    }
    if (data.status === "team_selection_required") {
      setStep({ kind: "teams", loginID, teams: data.teams })
      return
    }
    if (data.status === "error") {
      setStep({ kind: "error", code: data.error })
      return
    }
    await finish(data.user.email)
  }

  async function start() {
    setStep({ kind: "starting" })
    stopped = false
    const status = await sdk.client.corp.status().catch(() => undefined)
    setHub(status?.data?.hub_url)
    const started = await sdk.client.corp.login.start().catch(() => undefined)
    if (stopped) return
    const data = started?.data
    if (!data) {
      const code = (started?.error as { error?: string } | undefined)?.error
      setStep({ kind: "error", code: code ?? "hub_unavailable" })
      return
    }
    setStep({ kind: "waiting", loginID: data.login_id, code: data.user_code, url: data.browser_url })
    void openBrowser(data.browser_url)
    timer = setTimeout(() => void poll(data.login_id), POLL_INTERVAL_MS)
  }

  async function openBrowser(url: string) {
    const open = await import("open").then((module) => module.default)
    await open(url).catch(() => {
      toast.show({ variant: "warning", message: t("login.browserFailed") })
    })
  }

  async function chooseTeam(loginID: string, teamID: string) {
    const sent = await sdk.client.corp.login.team({ loginID, team_id: teamID }).catch(() => undefined)
    const data = sent?.data
    if (!data) {
      setStep({ kind: "error", code: "hub_unavailable" })
      return
    }
    if (data.status === "error") {
      setStep({ kind: "error", code: data.error })
      return
    }
    if (data.status === "ready") {
      await finish(data.user.email)
      return
    }
    setStep({ kind: "waiting", loginID, code: "", url: "" })
    // Код и ссылка уже показывались на предыдущем шаге; возвращаемся к ожиданию (S-A6, шаг 3).
    timer = setTimeout(() => void poll(loginID), POLL_INTERVAL_MS)
  }

  onMount(() => void start())

  useBindings(() => ({
    bindings: [
      {
        key: "c",
        desc: t("login.copy"),
        group: "Dialog",
        cmd: () => {
          const current = step()
          if (current.kind !== "waiting" || !current.code) return
          clipboard
            .write?.(current.code)
            .then(() => toast.show({ message: t("login.copy"), variant: "info" }))
            .catch(toast.error)
        },
      },
      {
        key: "p",
        desc: t("login.otherProvider"),
        group: "Dialog",
        cmd: () => {
          stopped = true
          dialog.replace(() => <DialogProviderList />)
        },
      },
      {
        key: "r",
        desc: t("login.retry"),
        group: "Dialog",
        cmd: () => void start(),
      },
    ],
  }))

  return (
    <Show
      when={step().kind === "teams" ? (step() as Extract<Step, { kind: "teams" }>) : undefined}
      fallback={
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              {t("login.title")}
            </text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              esc
            </text>
          </box>
          <Show when={hub()}>
            {(value) => (
              <text fg={theme.textMuted}>
                {t("login.hub")}: {value()}
              </text>
            )}
          </Show>
          <Show when={step().kind === "starting"}>
            <text fg={theme.textMuted}>{t("login.waiting")}</text>
          </Show>
          <Show
            when={step().kind === "waiting" ? (step() as Extract<Step, { kind: "waiting" }>) : undefined}
            keyed
          >
            {(waiting) => (
              <box gap={1}>
                <Show when={waiting.code}>
                  <text attributes={TextAttributes.BOLD} fg={theme.primary}>
                    {t("login.code")}: {waiting.code}
                  </text>
                </Show>
                <Show when={waiting.url}>
                  <box gap={1}>
                    <text fg={theme.textMuted}>{t("login.open")}:</text>
                    <Link href={waiting.url} fg={theme.primary} />
                  </box>
                </Show>
                <text fg={theme.textMuted}>{t("login.waiting")}</text>
              </box>
            )}
          </Show>
          <Show
            when={step().kind === "error" ? (step() as Extract<Step, { kind: "error" }>) : undefined}
            keyed
          >
            {(failed) => (
              <text fg={theme.error}>
                {errorText(failed.code)} ({failed.code})
              </text>
            )}
          </Show>
          <text fg={theme.text}>
            c <span style={{ fg: theme.textMuted }}>{t("login.copy")}</span> r{" "}
            <span style={{ fg: theme.textMuted }}>{t("login.retry")}</span> p{" "}
            <span style={{ fg: theme.textMuted }}>{t("login.otherProvider")}</span>
          </text>
        </box>
      }
      keyed
    >
      {(teams) => (
        <DialogSelect
          title={t("login.teamTitle")}
          options={teams.teams.map((team) => ({ title: team.team_alias, value: team.team_id }))}
          onSelect={(option) => void chooseTeam(teams.loginID, option.value)}
        />
      )}
    </Show>
  )
}
