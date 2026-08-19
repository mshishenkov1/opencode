import { createSignal } from "solid-js"
import { corpEnabled } from "@opencode-ai/core/corp/constants"

/**
 * Общее состояние корпоративных экранов TUI (S-T1, S-T2, S-V13).
 *
 * Здесь только то, что нужно нескольким экранам: период опроса входа и кэш названий каталога,
 * которым upstream-диалог `/mcps` подписывает alias.
 */

/** Период опроса входа (S-A4, R-L10). */
export const POLL_INTERVAL_MS = 2000

/**
 * Есть ли в auth-store ключ `magnit_prod` (S-T2).
 *
 * Значение приходит из `GET /corp/status` (поле `authenticated`) и обновляется после входа:
 * подсветка команды входа опирается на отсутствие корп-ключа, а не на upstream-признак
 * «есть хоть какой-то подключённый провайдер».
 */
const [corpKey, setCorpKeySignal] = createSignal(false)

export function hasCorpKey() {
  return corpKey()
}

export function setCorpKey(value: boolean) {
  setCorpKeySignal(value)
}

export { corpEnabled }

const titles = new Map<string, string>()

/** Запоминает названия карточек, чтобы `/mcps` мог подписать alias (S-V13). */
export function rememberTitles(cards: { alias: string; title: string }[]) {
  for (const card of cards) titles.set(card.alias, card.title)
}

/** Название карточки для alias или `undefined`, если каталог ещё не читался (S-V13). */
export function titleFor(alias: string) {
  return titles.get(alias)
}

export function hasTitles() {
  return titles.size > 0
}
