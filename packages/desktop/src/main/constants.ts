import { app } from "electron"

// corp: канал `magnit` — корпоративная раздача (S-B10). Неизвестное значение — ошибка, а не
// молчаливый откат в `dev`: молчаливый откат уже стоил раздачи под именем «OpenCode Dev» (D-25).
// Незаданная константа означает `dev` — режим локальной разработки.
const CHANNELS = ["dev", "beta", "prod", "magnit"] as const
type Channel = (typeof CHANNELS)[number]

// Тип константы намеренно расширен: `define` подставляет её при сборке, а в режиме разработки
// (electron-vite dev) значения может не быть вовсе.
const raw: string | undefined = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = ((): Channel => {
  if (raw === undefined || raw === "") return "dev"
  if (raw === "dev" || raw === "beta" || raw === "prod" || raw === "magnit") return raw
  throw new Error(`неизвестный канал сборки: ${raw}; допустимые: ${CHANNELS.join(", ")}`)
})()

// corp: адрес внутреннего сервера обновлений (S-B11, D-24) — build-константа из
// CORP_DESKTOP_UPDATE_URL. Пустая строка означает «адрес не задан».
const rawUpdateUrl: string | undefined = import.meta.env.OPENCODE_CORP_UPDATE_URL
export const UPDATE_URL = (rawUpdateUrl ?? "").trim()

// corp: без адреса обновлений апдейтер выключен целиком — он не должен обращаться ни к каким
// релизам, в том числе к релизам ванильного апстрима (S-B11, AC-146).
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && !!UPDATE_URL
