/**
 * Признак корпоративной сборки веб-UI (S-C5, S-C10 п.2, S-I2).
 *
 * `packages/app` собирается vite отдельно от бинарника, поэтому build-константы
 * `OPENCODE_CORP_*` сюда не попадают: корпоративная сборка передаёт адреса через
 * `VITE_OPENCODE_CORP_HUB_URL` и `VITE_OPENCODE_CORP_CATALOG_URL`
 * (см. `packages/opencode/script/build.ts`).
 *
 * Этот флаг нужен только там, где ответа сервера ещё нет — для языка по умолчанию (S-I2).
 * Всё остальное (регистрация команд, витрина) опирается на `GET /corp/status`, то есть на
 * действующие адреса с учётом переменных окружения (S-C5, S-C10).
 *
 * **Ревизия 1.11.** Каталог перестал быть свойством Hub (D-40): сборка без Hub, но со статическим
 * каталогом — корпоративная, и русский язык по умолчанию ей полагается так же. Решение повторяет
 * `corpEnabled()` из `packages/core/src/corp/constants.ts` — «задан любой из двух адресов», — а не
 * заводит собственное правило.
 */
export const corpBuildHubUrl = import.meta.env.VITE_OPENCODE_CORP_HUB_URL || undefined

/** Адрес статического каталога корпоративной сборки веб-UI (S-C10 п.1). */
export const corpBuildCatalogUrl = import.meta.env.VITE_OPENCODE_CORP_CATALOG_URL || undefined

export const corpBuildEnabled = corpBuildHubUrl !== undefined || corpBuildCatalogUrl !== undefined
