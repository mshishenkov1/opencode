/**
 * Решение об автооткрытии экрана входа при первом запуске (S-D4a, S-A7, D-18).
 *
 * Вынесено в чистую функцию, чтобы условие проверялось модульным тестом без рендера оболочки
 * приложения (S-Q9): в `layout.tsx` остаётся только эффект, который передаёт сюда текущие признаки
 * и открывает диалог `corp.login`.
 */

export interface CorpFirstRunInput {
  /** `enabled` из первого успешного ответа `GET /corp/status` (S-C5; недоступность роутов = `false`). */
  enabled: boolean
  /** `authenticated` оттуда же: при наличии ключа `magnit_prod` предлагать вход не нужно. */
  authenticated: boolean
  /** Показан ли сейчас какой-либо диалог — поверх чужого экрана вход не открываем. */
  dialogActive: boolean
  /** Было ли автооткрытие в текущем запуске процесса (признак живёт в памяти и не персистится). */
  alreadyOpened: boolean
}

/**
 * `true` — ровно в случае, когда корп-функции включены, ключа нет, другой диалог не показан
 * и автооткрытия в этом запуске ещё не было. Маршрут, состояние боковой панели, ширина окна
 * и `gettingStartedDismissed` на решение не влияют (S-D4a).
 */
export function shouldAutoOpenCorpLogin(input: CorpFirstRunInput): boolean {
  if (!input.enabled) return false
  if (input.authenticated) return false
  if (input.dialogActive) return false
  if (input.alreadyOpened) return false
  return true
}
