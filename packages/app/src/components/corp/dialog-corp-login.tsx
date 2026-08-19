import { Component, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { CorpTeam } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { corpErrorKey, useCorpInvalidate } from "@/context/corp"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

/**
 * Корп-экран входа по SSO для Desktop/web (S-A6, S-D3).
 *
 * Шаги те же, что и в TUI: старт → код и ссылка → (при необходимости) выбор команды → успех/ошибка.
 * `poll_secret` остаётся на сервере (S-A2). Внешние ссылки открывает серверная часть либо штатный
 * механизм платформы — корп-код не открывает их в окне приложения (S-D8).
 */

const POLL_INTERVAL_MS = 2000

type Step =
  | { kind: "starting" }
  | { kind: "waiting"; loginID: string; code: string; url: string }
  | { kind: "teams"; loginID: string; teams: CorpTeam[] }
  | { kind: "error"; code: string }

export const DialogCorpLogin: Component = () => {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const invalidate = useCorpInvalidate()

  const [step, setStep] = createSignal<Step>({ kind: "starting" })
  const [hub, setHub] = createSignal<string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  // S-A9: закрытие экрана прекращает опрос, ключ не сохраняется.
  onCleanup(() => {
    stopped = true
    if (timer) clearTimeout(timer)
  })

  async function finish(email: string) {
    stopped = true
    showToast({ variant: "success", title: language.t("corp.login.success", { email }) })
    await invalidate()
    dialog.close()
  }

  async function poll(loginID: string) {
    if (stopped) return
    const result = await sdk()
      .client.corp.login.poll({ loginID })
      .catch(() => undefined)
    if (stopped) return
    const data = result?.data
    if (!data) return setStep({ kind: "error", code: "hub_unavailable" })
    if (data.status === "pending") {
      timer = setTimeout(() => void poll(loginID), POLL_INTERVAL_MS)
      return
    }
    if (data.status === "team_selection_required") return setStep({ kind: "teams", loginID, teams: data.teams })
    if (data.status === "error") return setStep({ kind: "error", code: data.error })
    await finish(data.user.email)
  }

  async function start() {
    stopped = false
    setStep({ kind: "starting" })
    const status = await sdk()
      .client.corp.status()
      .catch(() => undefined)
    setHub(status?.data?.hub_url)
    const started = await sdk()
      .client.corp.login.start()
      .catch(() => undefined)
    if (stopped) return
    const data = started?.data
    if (!data) return setStep({ kind: "error", code: "hub_unavailable" })
    setStep({ kind: "waiting", loginID: data.login_id, code: data.user_code, url: data.browser_url })
    timer = setTimeout(() => void poll(data.login_id), POLL_INTERVAL_MS)
  }

  async function chooseTeam(loginID: string, teams: CorpTeam[], teamID: string) {
    const sent = await sdk()
      .client.corp.login.team({ loginID, team_id: teamID })
      .catch(() => undefined)
    const data = sent?.data
    // AC-26: ошибка выбора команды не завершает вход — список команд остаётся на экране.
    const stay = (code: string) => {
      showToast({ variant: "error", title: language.t(corpErrorKey(code)) })
      setStep({ kind: "teams", loginID, teams })
    }
    if (!data) return stay("hub_unavailable")
    if (data.status === "error") return stay(data.error)
    if (data.status === "ready") return finish(data.user.email)
    setStep({ kind: "waiting", loginID, code: "", url: "" })
    timer = setTimeout(() => void poll(loginID), POLL_INTERVAL_MS)
  }

  async function copyCode(code: string) {
    await navigator.clipboard?.writeText(code).catch(() => undefined)
    showToast({ variant: "success", title: language.t("corp.login.copied") })
  }

  async function openOtherProvider() {
    stopped = true
    const module = await import("@/components/dialog-select-provider")
    dialog.show(() => <module.DialogSelectProvider />)
  }

  onMount(() => void start())

  const waiting = () => (step().kind === "waiting" ? (step() as Extract<Step, { kind: "waiting" }>) : undefined)
  const teams = () => (step().kind === "teams" ? (step() as Extract<Step, { kind: "teams" }>) : undefined)
  const failed = () => (step().kind === "error" ? (step() as Extract<Step, { kind: "error" }>) : undefined)

  return (
    <Dialog
      title={language.t("corp.login.title")}
      description={hub() ? `${language.t("corp.login.hub")}: ${hub()}` : undefined}
      size="large"
    >
      <Show when={teams()}>
        {(value) => (
          <List
            class="px-3"
            search={{ placeholder: language.t("corp.login.teamTitle"), autofocus: true }}
            key={(team) => team?.team_id ?? ""}
            items={() => value().teams}
            filterKeys={["team_alias", "team_id"]}
            onSelect={(team) => {
              if (!team) return
              void chooseTeam(value().loginID, value().teams, team.team_id)
            }}
          >
            {(team) => (
              <div class="w-full flex items-center justify-between gap-x-3">
                <span class="truncate">{team.team_alias}</span>
                <span class="text-11-regular text-text-weaker">{team.team_id}</span>
              </div>
            )}
          </List>
        )}
      </Show>

      <Show when={!teams()}>
        <div class="px-3 pb-3 flex flex-col gap-4">
          <Show when={step().kind === "starting"}>
            <div class="text-14-regular text-text-base">{language.t("corp.login.waiting")}</div>
          </Show>

          <Show when={waiting()}>
            {(value) => (
              <div class="flex flex-col gap-3">
                <Show when={value().code}>
                  <div class="flex flex-col gap-1">
                    <div class="text-11-regular text-text-weaker">{language.t("corp.login.code")}</div>
                    <div class="text-24-medium text-text-strong tracking-widest">{value().code}</div>
                  </div>
                </Show>
                <Show when={value().url}>
                  <div class="flex flex-col gap-1">
                    <div class="text-11-regular text-text-weaker">{language.t("corp.login.open")}</div>
                    <a class="text-14-regular text-text-strong underline break-all" href={value().url} target="_blank">
                      {value().url}
                    </a>
                  </div>
                </Show>
                <div class="text-14-regular text-text-base">{language.t("corp.login.waiting")}</div>
                <div class="flex items-center gap-2">
                  <Show when={value().code}>
                    <Button size="large" onClick={() => void copyCode(value().code)}>
                      {language.t("corp.login.copy")}
                    </Button>
                  </Show>
                  <Button size="large" variant="ghost" onClick={() => void openOtherProvider()}>
                    {language.t("corp.login.otherProvider")}
                  </Button>
                </div>
              </div>
            )}
          </Show>

          <Show when={failed()}>
            {(value) => (
              <div class="flex flex-col gap-3">
                <div class="text-14-regular text-text-strong">{language.t(corpErrorKey(value().code))}</div>
                <div class="text-11-regular text-text-weaker">{value().code}</div>
                <div class="flex items-center gap-2">
                  <Button size="large" onClick={() => void start()}>
                    {language.t("corp.login.retry")}
                  </Button>
                  <Button size="large" variant="ghost" onClick={() => dialog.close()}>
                    {language.t("corp.login.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </Dialog>
  )
}
