import type { DesktopMenuLabelKey, DesktopMenuTranslate } from "@opencode-ai/app/desktop-menu"

import { dict as appEn } from "../../../app/src/i18n/en"
import { dict as appRu } from "../../../app/src/i18n/ru"

import { getStore } from "./store"

/**
 * Переводчик подписей нативного меню для ГЛАВНОГО процесса (F30).
 *
 * Зачем отдельный от `renderer/i18n`: меню строится в главном процессе и **до того**, как оболочка
 * смонтирована, — спросить `useLanguage()` не у кого. Язык при этом главному процессу доступен без
 * оболочки: на Desktop настройки витрины лежат не в `localStorage`, а в `electron-store`
 * (`utils/persist.ts` → `platform.storage`), то есть в том же файле, который читает и пишет сам
 * главный процесс через `store-get`/`store-set`. Поэтому язык берётся синхронно, и первое же
 * нарисованное меню уже на нужном языке — английской вспышки при запуске нет.
 *
 * Словарей здесь два, а не девятнадцать: русский обязан покрывать английский целиком (F29,
 * `parity.test.ts`), а прочие локали частичны и по построению падают на английскую базу — тащить их
 * в главный процесс значило бы удвоить его размер ради строк, которых в нём не будет.
 */

/** Имя хранилища и ключ — те же, что у витрины (`Persist.global("language")`, `GLOBAL_STORAGE`). */
const LANGUAGE_STORE = "opencode.global.dat"
const LANGUAGE_KEY = "language"

/* Словари плоские (ключ → строка), поэтому склейка — обычный spread: пропущенный в ru ключ
   падает на английскую базу ровно так же, как в витрине. */
const base: Record<string, string> = appEn
const russian: Record<string, string> = { ...appEn, ...appRu }

/**
 * Язык из хранилища настроек. Значение лежит там строкой JSON вида `{"locale":"ru"}` — так его
 * пишет `persisted(...)` витрины; на всякий случай понимается и голая строка `"ru"`.
 *
 * Хранилища нет, значение битое или локаль незнакомая — английский: это та же деградация, что у
 * витрины, где неизвестный ключ падает на английскую базу.
 */
export function storedMenuLocale(): "en" | "ru" {
  try {
    const raw = getStore(LANGUAGE_STORE).get(LANGUAGE_KEY)
    return parseMenuLocale(raw)
  } catch {
    return "en"
  }
}

/** Разбор значения хранилища отдельно от чтения — чтобы его можно было проверить без Electron. */
export function parseMenuLocale(raw: unknown): "en" | "ru" {
  const value = typeof raw === "string" ? safeParse(raw) : raw
  if (value === "ru") return "ru"
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const locale = (value as Record<string, unknown>)["locale"]
    if (locale === "ru") return "ru"
  }
  return "en"
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Переводчик для текущего языка хранилища. Пересоздаётся при каждой сборке меню. */
export function menuTranslate(locale: "en" | "ru" = storedMenuLocale()): DesktopMenuTranslate {
  const dict = locale === "ru" ? russian : base
  // Подстановок в подписях меню нет ни одной, поэтому шаблонизатор не нужен: ключ, которого нет в
  // словаре, возвращается сам собой — пустой подписи в меню не появляется.
  return (key: DesktopMenuLabelKey) => dict[key] ?? key
}

/** Подписка на смену языка в настройках витрины: меню перестраивается, а не ждёт перезапуска. */
export function onMenuLocaleChange(handler: () => void): () => void {
  try {
    return getStore(LANGUAGE_STORE).onDidChange(LANGUAGE_KEY, () => handler())
  } catch {
    return () => {}
  }
}
