import { InputRenderable, TextAttributes } from "@opentui/core"
import type { CorpAuthMethodView, CorpCatalogCard, CorpConnectTokenResult } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useTuiConfig } from "../../config"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { format, t } from "../../corp/i18n"
import { useBindings } from "../../keymap"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"

/**
 * Прямое подключение токеном в терминале (S-T12, ревизия 1.13).
 *
 * Паритет с Desktop держится не договорённостью, а построением: экран отправляет **тот же** роут
 * `POST /corp/connectors/:alias/connect-token` с тем же телом, а проверка, обмен, сохранение и
 * запрет (S-V25, S-V26, S-V28) живут на сервере и здесь не дублируются ни строкой. Доступность
 * способа и `connect_mode` TUI берёт из ответа `GET /corp/catalog` и сам не вычисляет (S-V28 п.3).
 *
 * Браузер экран не открывает: адрес документации показывается **текстом** — в прямом режиме
 * открывать браузер нечем и незачем.
 *
 * Секреты: введённое значение не попадает ни в историю команд, ни в лог TUI, ни в заголовок окна,
 * ни в подпись строки списка (S-V26 п.6); поле никогда не предзаполняется.
 */

/** Символ маскирования секретного поля: значение на экране не видно, длина — видна. */
export const MASK = "•"

/**
 * Три случая выбора способа (S-V28 п.4) — то же правило, что в Desktop:
 * `single` — доступен ровно один способ и недоступных нет: выбора нет вовсе, сразу поле ввода;
 * `list` — способов больше одного в любом сочетании: список **всех**, недоступные с причиной;
 * `none` — доступных нет ни одного: поля ввода нет и подключаться нечем.
 */
export function methodChoice(methods: CorpAuthMethodView[]): "single" | "list" | "none" {
  const available = methods.filter((method) => method.available)
  if (available.length === 0) return "none"
  if (methods.length === 1) return "single"
  return "list"
}

/**
 * Ключ причины недоступности способа (S-V28 п.1, S-I4): три РАЗНЫХ текста, потому что причины
 * разные и советы разные. Неизвестный код падает в причину каталога — самую общую из трёх.
 */
export function methodUnavailableKey(code: string | null | undefined) {
  if (code === "oauth_disabled") return "connectors.methodUnavailable.oauthDisabled" as const
  if (code === "env_header") return "connectors.methodUnavailable.envHeader" as const
  return "connectors.methodUnavailable.catalog" as const
}

/** Текст причины: `unavailable_reason` каталога дословно, иначе — свой ключ (S-I6, S-V28 п.1). */
export function methodUnavailableText(method: CorpAuthMethodView) {
  return method.unavailable_reason ?? t(methodUnavailableKey(method.unavailable_code))
}

/** Экранное представление значения: секретное поле маскируется посимвольно (S-T12). */
export function maskedValue(value: string, secret: boolean) {
  return secret ? MASK.repeat(value.length) : value
}

/**
 * Правка маскированного поля: на экране лежат маркеры, и по разнице экранных значений
 * восстанавливается та же правка над настоящим значением.
 *
 * Считается общий префикс и общий суффикс: всё, что между ними, — только что введённое. Так
 * поддерживаются и ввод, и удаление, и вставка в середину, а настоящее значение при этом не
 * покидает состояния компонента.
 */
export function applyMaskedEdit(previous: string, screen: string, mask: string = MASK): string {
  const shown = mask.repeat(previous.length)
  let head = 0
  while (head < shown.length && head < screen.length && shown[head] === screen[head]) head += 1
  let tail = 0
  while (
    tail < shown.length - head &&
    tail < screen.length - head &&
    shown[shown.length - 1 - tail] === screen[screen.length - 1 - tail]
  )
    tail += 1
  const inserted = screen.slice(head, screen.length - tail)
  return previous.slice(0, head) + inserted + previous.slice(previous.length - tail)
}

/** Граница длины поля: нечисловое значение ничего не ограничивает (S-V24 п.2). */
function bound(value: number | string | undefined): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Проверка длины **до** сети (S-D13 п.4, S-T12): запрос не уходит вовсе. Прочих проверок значения
 * экран не делает — годность токена решает целевая система, а не догадка о его виде.
 */
export function lengthError(value: string, field: CorpAuthMethodView["field"]) {
  if (value === "") return undefined
  const min = bound(field?.min_length)
  const max = bound(field?.max_length)
  if (min !== undefined && value.length < min) return { key: "connect.tooShort" as const, n: min }
  if (max !== undefined && value.length > max) return { key: "connect.tooLong" as const, n: max }
  return undefined
}

/**
 * Ключ исхода проверки (S-V25 п.3) — по ключу на исход; общего «не получилось» среди них нет, и
 * ни одна пара не совпадает: «система сказала „нет“», «система ответила не то» и «ответа не было»
 * требуют от пользователя разного.
 */
export function verifyKey(result: string, account?: string) {
  if (result === "verified") return account ? "connect.verify.verifiedAs" : "connect.verify.verified"
  if (result === "account_missing") return "connect.verify.accountMissing" as const
  if (result === "token_rejected") return "connect.verify.tokenRejected" as const
  if (result === "verify_failed") return "connect.verify.verifyFailed" as const
  return "connect.verify.unreachable" as const
}

/** Ключ исхода обмена (S-V25 п.5); отсутствие обмена (`null`) не показывает ничего. */
export function exchangeKey(result: string | null | undefined) {
  if (result === "exchanged") return "connect.exchange.exchanged" as const
  if (result === "exchange_denied") return "connect.exchange.denied" as const
  if (result === "exchange_failed") return "connect.exchange.failed" as const
  if (result === "exchange_unreachable") return "connect.exchange.unreachable" as const
  return undefined
}

/**
 * Ключ исхода отзыва (S-V27 п.2). Исход `skipped` не показывает **ничего**: отзывать было нечего,
 * и говорить не о чем — ключа под него не заводится.
 */
export function revokeKey(result: string | null | undefined) {
  if (result === "revoked") return "connect.revoke.revoked" as const
  if (result === "not_revoked") return "connect.revoke.notRevoked" as const
  if (result === "unreachable") return "connect.revoke.unreachable" as const
  return undefined
}

export interface DialogConnectTokenProps {
  card: CorpCatalogCard
  /** Возврат на экран, с которого открыли: витрина или страница коннектора. */
  onDone?: () => void
}

export function DialogConnectToken(props: DialogConnectTokenProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const tuiConfig = useTuiConfig()

  const methods = createMemo(() => props.card.auth_methods ?? [])
  const available = createMemo(() => methods().filter((method) => method.available))
  const choice = createMemo(() => methodChoice(methods()))

  const [chosen, setChosen] = createSignal<string | undefined>()
  const method = createMemo(() => available().find((entry) => entry.id === chosen()) ?? available()[0])
  const secret = createMemo(() => method()?.field?.secret !== false)

  /** Настоящее значение живёт только здесь: на экране лежат маркеры, а в лог оно не уходит. */
  const [token, setToken] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<CorpConnectTokenResult>()
  const [failure, setFailure] = createSignal<string>()
  /** Выбор способа показывается первым шагом, когда способов больше одного (S-V28 п.4, случай 2). */
  const [picking, setPicking] = createSignal(choice() === "list")

  const connected = createMemo(() => result()?.verify_result === "verified")
  const length = createMemo(() => lengthError(token(), method()?.field))

  let field: InputRenderable | undefined

  function reset() {
    setToken("")
    setResult(undefined)
    setFailure(undefined)
    if (field && !field.isDestroyed) field.value = ""
  }

  function onInput(screen: string) {
    if (!secret()) {
      setToken(screen)
      return
    }
    const next = applyMaskedEdit(token(), screen)
    setToken(next)
    const shown = maskedValue(next, true)
    if (field && !field.isDestroyed && field.value !== shown) field.value = shown
  }

  async function submit() {
    // Пустое поле и непройденная проверка длины запроса не создают; повторное нажатие во время
    // запроса второго запроса не создаёт (S-D13 п.4–5, S-T12).
    if (connected()) {
      // После успеха то же действие открывает ту же ПУСТУЮ форму (S-D13 п.7).
      reset()
      return
    }
    if (busy() || token() === "" || length()) return
    const chosenMethod = method()
    if (!chosenMethod) return
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await sdk.client.corp.connectorConnectToken({
        alias: props.card.alias,
        body: {
          ...(methods().length > 1 ? { method: chosenMethod.id } : {}),
          token: token(),
        },
      })
      const data = response?.data
      if (!data) {
        setFailure(t("connect.storageUnavailable"))
        return
      }
      setResult(data)
      // Исход показывается в этом же экране, а не тостом на витрине (S-D13 п.6, S-T12).
      if (data.verify_result !== "verified") return
      setToken("")
      if (field && !field.isDestroyed) field.value = ""
    } catch (error) {
      // Отказ роута — не исход проверки: сюда попадают предпроверки и отказ хранилища (S-V25 п.1).
      const body = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined
      const code = body?.["error"]
      const unavailable = body?.["unavailable_code"]
      if (code === "storage_unavailable") setFailure(t("connect.storageUnavailable"))
      else if (code === "auth_method_unavailable")
        setFailure(t(methodUnavailableKey(typeof unavailable === "string" ? unavailable : undefined)))
      else setFailure(t("connect.noMethod"))
    } finally {
      setBusy(false)
    }
  }

  useBindings(() => ({
    commands: [
      {
        name: "dialog.prompt.submit",
        title: "Submit dialog prompt",
        category: "Dialog",
        run: () => void submit(),
      },
    ],
    bindings: tuiConfig.keybinds.gather("dialog.prompt", ["dialog.prompt.submit"]),
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!field || field.isDestroyed) return
      field.focus()
    }, 1)
  })

  // Шаг 1: выбор способа (S-V28 п.4, случай 2). Недоступный способ **показан** строкой с текстом
  // причины и выбран быть не может: спрятанный способ неотличим от несуществующего.
  return (
    <Show
      when={!picking()}
      fallback={
        <DialogSelect
          title={`${t("connect.chooseMethod")}: ${props.card.title}`}
          renderFilter={false}
          skipFilter={true}
          options={methods().map((entry) => ({
            // Подпись способа — данные каталога, клиент их не переводит (S-I6).
            title: entry.title,
            value: entry.id,
            ...(entry.available ? {} : { description: methodUnavailableText(entry) }),
          }))}
          onSelect={(option) => {
            const picked = methods().find((entry) => entry.id === option.value)
            if (!picked || !picked.available) {
              // Строку выбрать нельзя, и почему — сказано тем же текстом, что стоит рядом с ней.
              toast.show({ variant: "warning", message: picked ? methodUnavailableText(picked) : "" })
              return
            }
            setChosen(picked.id)
            setPicking(false)
          }}
          footerHints={[{ title: t("connector.back"), label: "esc" }]}
        />
      }
    >
      <box paddingLeft={2} paddingRight={2} gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            {t("connect.title")}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        {/* Название коннектора — данные каталога (S-I6). */}
        <text fg={theme.textMuted}>{props.card.title}</text>

        {/* Случай 3 таблицы S-V28 п.4: доступных способов нет ни одного — поля ввода нет вовсе. */}
        <Show when={choice() === "none"}>
          <box gap={1}>
            {methods().map((entry) => (
              <box>
                <text fg={theme.textMuted}>{entry.title}</text>
                <text fg={theme.textMuted}>{methodUnavailableText(entry)}</text>
              </box>
            ))}
            <Show when={methods().length === 0}>
              <text fg={theme.textMuted}>{t("connect.noMethod")}</text>
            </Show>
          </box>
        </Show>

        <Show when={choice() !== "none" && !connected()}>
          <box gap={1}>
            {/* Подпись поля — из каталога (S-I6); отсутствующее необязательное поле строки не рисует. */}
            <text fg={theme.text}>{method()?.field?.label ?? ""}</text>
            <input
              ref={(value: InputRenderable) => {
                field = value
                value.traits = { status: "TOKEN" }
              }}
              placeholder={method()?.field?.placeholder ?? ""}
              placeholderColor={theme.textMuted}
              textColor={busy() ? theme.textMuted : theme.text}
              focusedTextColor={busy() ? theme.textMuted : theme.text}
              cursorColor={theme.text}
              onInput={(value: string) => onInput(value)}
              onSubmit={() => void submit()}
            />
            <Show when={method()?.field?.hint}>
              {(hint) => <text fg={theme.textMuted}>{hint()}</text>}
            </Show>
            {/* Адрес документации — ТЕКСТОМ: браузер TUI не открывает (S-T12). */}
            <Show when={method()?.field?.docs_url}>
              {(docs) => (
                <text fg={theme.textMuted}>
                  {t("connect.docs")}: {docs()}
                </text>
              )}
            </Show>
            <Show when={length()}>
              {(error) => <text fg={theme.error}>{format(error().key, { n: error().n })}</text>}
            </Show>
          </box>
        </Show>

        {/* S-D13 п.7: после успеха экран показывает признак «Подключено» и строку с account, а то же
            действие открывает ту же ПУСТУЮ форму. Значение токена не показывается нигде. */}
        <Show when={connected()}>
          <box gap={1}>
            <text fg={theme.success}>
              {result()?.account
                ? format("connect.verify.verifiedAs", { account: result()!.account! })
                : t("connect.verify.verified")}
            </text>
            <Show when={exchangeKey(result()?.exchange_result)}>
              {(key) => <text fg={theme.warning}>{t(key())}</text>}
            </Show>
            <text fg={theme.textMuted}>{t("connect.replace")}</text>
          </box>
        </Show>

        {/* Неуспешный исход проверки — ошибка; неуспешный исход обмена — предупреждение (S-V25). */}
        <Show when={connected() ? undefined : result()}>
          {(outcome) => (
            <text fg={theme.error}>
              {format(verifyKey(outcome().verify_result), { status: String(outcome().verify_status ?? "") })}
            </text>
          )}
        </Show>
        <Show when={failure()}>{(text) => <text fg={theme.error}>{text()}</text>}</Show>
        <Show when={busy()}>
          <text fg={theme.textMuted}>{t("connect.submit")}…</text>
        </Show>
      </box>
    </Show>
  )
}
