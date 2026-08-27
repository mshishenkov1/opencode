import type { CorpLogoutResult } from "@opencode-ai/sdk/v2"
import { createSignal, onMount } from "solid-js"
import { useSDK } from "../../context/sdk"
import { errorText, format, revokeReasonText, t } from "../../corp/i18n"
import { setCorpKey } from "../../corp/state"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { DialogCorpLogin } from "./dialog-corp-login"

/**
 * Выход из корпоративного аккаунта для TUI (S-A14, S-A16, S-T11).
 *
 * Паритет с Desktop держится тем же способом, что у витрины: обе оболочки зовут **один** роут
 * `POST /corp/logout` и сами ничего не вычисляют — ни порядка частей, ни исхода. Здесь только
 * подтверждение, вызов и показ результата.
 *
 * Выход состоит из двух частей — отзыв ключа на сервере и удаление ключа у себя, — и они
 * по-разному надёжны. Поэтому подтверждение называет обе, а исход показывается обеими: отказ
 * отзыва при удалённом ключе — предупреждение, а не ошибка (S-A16, D-49).
 */

export function DialogCorpLogout(props: {
  /**
   * Погасить возврат на витрину: экран выхода уходит своим ходом и возвращаться ему не нужно.
   *
   * Стека диалогов в терминале нет (S-T10) — экран выхода **заменяет** витрину, и возврат на неё
   * описывается вызывающей стороной (`leaving()` в `dialog-connectors.tsx`). Пропс нужен ровно
   * одному переходу — на экран входа: туда уходят вместо витрины, а не поверх неё. Открытый
   * командой `corp.logout` (палитра, слэш `logout`) экран возвращать некуда — пропса у него нет.
   */
  onLeave?: () => void
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  /** Задан ли адрес Hub: без него говорить о сервере нечего, и слова «Hub» в текстах нет (D-43). */
  const [hub, setHub] = createSignal<boolean>()
  const [busy, setBusy] = createSignal(false)

  onMount(() => void loadHub())

  async function loadHub() {
    const status = await sdk.client.corp.status().catch(() => undefined)
    setHub(status?.data?.hub_url !== undefined)
  }

  /**
   * Исход выхода построчно (S-A15, S-A16): по строке на часть, чтобы каждая была видна отдельно.
   * Ключа не было — идемпотентный случай S-A14 п.5: «уже вышел» не ошибка.
   *
   * Различимых исхода три (микроревизия 1.12.1): успех целиком; «на сервере не отозван» с причиной
   * по `revoke_error`; «связаться с сервером не удалось». Сливать второй с третьим запрещено.
   */
  function outcome(data: CorpLogoutResult) {
    if (!data.key_removed && data.hub === "skipped")
      return { variant: "info" as const, message: t("logout.notSignedIn") }
    if (data.hub === "not_revoked")
      // Сервер ответил и ключ НЕ отозвал: причина известна, ключ модели может остаться живым
      // (S-A14 п.1). Предупреждение, а не ошибка: действие выполнено (D-49).
      return {
        variant: "warning" as const,
        message: format("logout.notRevoked", { reason: revokeReasonText(data.revoke_error) }),
      }
    if (data.hub === "unavailable")
      // О судьбе ключа не известно ничего — и это другой текст, а не тот же самый (S-A16).
      return {
        variant: "warning" as const,
        message: format("logout.revokeFailed", { reason: t("logout.reason.unreachable") }),
      }
    // `skipped` при удалённом ключе — сборка без Hub: серверной части не существует (S-A14 п.6).
    return { variant: "info" as const, message: t(data.hub === "revoked" ? "logout.done" : "logout.doneLocal") }
  }

  async function run() {
    if (busy()) return
    setBusy(true)
    const result = await sdk.client.corp.logout().catch(() => undefined)
    const data = result?.data
    if (!data) {
      toast.show({ variant: "error", message: errorText(undefined) })
      setBusy(false)
      dialog.clear()
      return
    }
    // Ключа больше нет — подсветка команды входа обязана это увидеть без перезапуска (S-A3).
    if (data.key_removed) setCorpKey(false)
    toast.show(outcome(data))
    setBusy(false)
    // S-A16, S-T11: после выхода приложение предлагает вход — существующим экраном, новый не
    // заводится, — но **открывает его само только там, где этому экрану есть что предложить**:
    // при заданном адресе Hub. В сборке без Hub экран входа по S-C5 называет лишь причину, по
    // которой вход не настроен, а диалог в терминале **один**: подменив им витрину, «продолжать
    // работать» ей было бы нечем, а витрина при статическом каталоге работает и после выхода —
    // ключа он не требует (S-A16, S-C10 п.6). Тогда экран выхода просто уходит, возвращая
    // оболочку туда, откуда её позвали. Тот же смысл у Desktop: он витрину не заменяет вовсе, а
    // вход предлагает кнопкой по наличию ключа. Действие «Войти» остаётся и здесь — разница вся в
    // том, кто открывает экран: пользователь или приложение за него.
    //
    // Признак спрашивается явным сравнением: «адрес не известен» (статус ещё не получен либо
    // запрос не удался) — не «адрес задан», и подменять витрину на этом основании тем более нечем.
    if (data.key_removed && hub() === true) {
      // `dialog.replace` зовёт обработчик закрытия текущего экрана — тот самый, что вернул бы
      // витрину; уходя на экран входа, гасим его заранее (приём страницы коннектора, S-D11).
      props.onLeave?.()
      dialog.replace(() => <DialogCorpLogin />)
    } else dialog.clear()
  }

  return (
    <DialogSelect
      // Подтверждение называет обе части выхода; в сборке без Hub — только локальную (S-A16, D-43).
      title={hub() === false ? t("logout.confirmLocal") : t("logout.confirm")}
      renderFilter={false}
      skipFilter={true}
      locked={busy()}
      options={[
        { title: t("logout.action"), value: true },
        { title: t("login.cancelled"), value: false },
      ]}
      // Отмена не меняет ни ключа, ни экрана (S-A16).
      onSelect={(option) => (option.value ? void run() : dialog.clear())}
    />
  )
}
