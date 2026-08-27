import { Component, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { CorpHubUser, CorpTeam } from "@opencode-ai/sdk/v2"
import { corpUserLabel } from "@opencode-ai/core/corp/constants"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { corpErrorKey, useCorpInvalidate } from "@/context/corp"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

/**
 * Корп-экран входа по SSO для Desktop/web (S-A6, S-D3).
 *
 * Шаги те же, что и в TUI: старт → код и ссылка → (при необходимости) выбор команды → успех/ошибка.
 * `poll_secret` остаётся на сервере (S-A2). Браузер по `browser_url` открывает серверная часть при
 * `POST /corp/login/start` — тем же механизмом, что MCP-OAuth (S-A6 шаг 2, S-D8, F15); ссылка на
 * экране остаётся запасным путём, если открыть не удалось. Корп-код не открывает внешние ссылки
 * в окне приложения.
 */

const POLL_INTERVAL_MS = 2000

type Step =
  | { kind: "starting" }
  | { kind: "waiting"; loginID: string; code: string; url: string }
  | { kind: "teams"; loginID: string; teams: CorpTeam[] }
  | { kind: "error"; code: string }
  /**
   * Сборка без Hub (S-C5, S-C10 п.2): корп-функции включены каталогом, а вход по SSO зависит от
   * Hub и потому недоступен. Причина называется вслух — вместо запроса на незаданный адрес и
   * вместо неправды «корпоративный режим не настроен».
   */
  | { kind: "no_hub" }

export const DialogCorpLogin: Component = () => {
  // Экран открывается из `Layout` — директорного SDK-контекста там нет, корп-роуты его и не требуют
  // (BUG-I4-002).
  const sdk = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const invalidate = useCorpInvalidate()

  const [step, setStep] = createSignal<Step>({ kind: "starting" })
  const [hub, setHub] = createSignal<string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Незавершённая сессия входа: её нужно освободить на сервере при закрытии экрана (S-A9). */
  let pending: string | undefined

  // S-A9: закрытие экрана прекращает опрос, освобождает сессию в памяти сервера и не сохраняет ключ.
  onCleanup(() => {
    stopped = true
    if (timer) clearTimeout(timer)
    cancel()
  })

  function cancel() {
    const loginID = pending
    if (!loginID) return
    pending = undefined
    void sdk()
      .client.corp.login.cancel({ loginID })
      .catch(() => undefined)
  }

  // S-A13: подстановка в `corp.login.success` — email, а при неизвестном email — `user_id` (AC-129).
  async function finish(user: CorpHubUser) {
    stopped = true
    // Сессия уже освобождена сервером при `ready` (S-A3) — отменять нечего.
    pending = undefined
    showToast({ variant: "success", title: language.t("corp.login.success", { email: corpUserLabel(user) }) })
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
    await finish(data.user)
  }

  async function start() {
    cancel()
    stopped = false
    setStep({ kind: "starting" })
    const status = await sdk()
      .client.corp.status()
      .catch(() => undefined)
    setHub(status?.data?.hub_url)
    // S-C10 п.2: корп-режим включён, но адреса Hub нет — стартовать вход нечем и незачем.
    // `enabled` без `hub_url` бывает только в сборке, где каталог статический (S-C10 п.7).
    if (status?.data?.enabled && !status.data.hub_url) return setStep({ kind: "no_hub" })
    const started = await sdk()
      .client.corp.login.start()
      .catch(() => undefined)
    const data = started?.data
    if (!data) {
      if (stopped) return
      return setStep({ kind: "error", code: "hub_unavailable" })
    }
    pending = data.login_id
    // Экран могли закрыть, пока Hub отвечал: сессию освобождаем сразу (S-A9).
    if (stopped) return cancel()
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
    if (data.status === "ready") return finish(data.user)
    setStep({ kind: "waiting", loginID, code: "", url: "" })
    timer = setTimeout(() => void poll(loginID), POLL_INTERVAL_MS)
  }

  async function copyCode(code: string) {
    await navigator.clipboard?.writeText(code).catch(() => undefined)
    showToast({ variant: "success", title: language.t("corp.login.copied") })
  }

  async function openOtherProvider() {
    stopped = true
    cancel()
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
                <span class="text-12-regular text-text-weak">{team.team_id}</span>
              </div>
            )}
          </List>
        )}
      </Show>

      <Show when={!teams()}>
        <div class="px-3 pb-3 flex flex-col gap-4">
          {/* S-C5, S-C10 п.2: в сборке без Hub формы входа нет — вместо неё названа причина.
              «Другой провайдер» остаётся: вход в саму модель этой сборкой не запрещён. */}
          <Show when={step().kind === "no_hub"}>
            <div class="flex flex-col gap-3">
              <div class="text-14-regular text-text-strong">{language.t("corp.login.needsHub")}</div>
              <div class="flex items-center gap-2">
                <Button size="large" onClick={() => void openOtherProvider()}>
                  {language.t("corp.login.otherProvider")}
                </Button>
                <Button size="large" variant="ghost" onClick={() => dialog.close()}>
                  {language.t("corp.login.cancel")}
                </Button>
              </div>
            </div>
          </Show>

          <Show when={step().kind === "starting"}>
            <div class="text-14-regular text-text-base">{language.t("corp.login.waiting")}</div>
          </Show>

          <Show when={waiting()}>
            {(value) => (
              <div class="flex flex-col gap-3">
                <Show when={value().code}>
                  <div class="flex flex-col gap-1">
                    <div class="text-12-regular text-text-weak">{language.t("corp.login.code")}</div>
                    <div class="text-20-medium text-text-strong tracking-widest">{value().code}</div>
                  </div>
                </Show>
                <Show when={value().url}>
                  <div class="flex flex-col gap-1">
                    <div class="text-12-regular text-text-weak">{language.t("corp.login.open")}</div>
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
                <div class="text-12-regular text-text-weak">{value().code}</div>
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
