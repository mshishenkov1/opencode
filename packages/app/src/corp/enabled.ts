/**
 * Признак корпоративной сборки веб-UI (S-C5, S-I2).
 *
 * `packages/app` собирается vite отдельно от бинарника, поэтому build-константы
 * `OPENCODE_CORP_*` сюда не попадают: корпоративная сборка передаёт адрес Hub через
 * `VITE_OPENCODE_CORP_HUB_URL` (см. `packages/opencode/script/build.ts`).
 *
 * Этот флаг нужен только там, где ответа сервера ещё нет — для языка по умолчанию (S-I2).
 * Всё остальное (регистрация команд, витрина) опирается на `GET /corp/status`, то есть на
 * действующий адрес Hub с учётом переменной окружения (S-C5).
 */
export const corpBuildHubUrl = import.meta.env.VITE_OPENCODE_CORP_HUB_URL || undefined

export const corpBuildEnabled = corpBuildHubUrl !== undefined
