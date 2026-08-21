import { $ } from "bun"
import { existsSync } from "node:fs"
import { CHANNELS, resolveChannel, type Channel } from "./utils"

const arg = process.argv[2]
// corp: неизвестный аргумент — ошибка, а не молчаливый откат к каналу из окружения (S-B10, D-25).
const channel: Channel = arg === undefined || arg === "" ? resolveChannel() : parseArg(arg)

function parseArg(raw: string): Channel {
  if (raw === "dev" || raw === "beta" || raw === "prod" || raw === "magnit") return raw
  throw new Error(`неизвестный канал сборки: ${raw}; допустимые: ${CHANNELS.join(", ")}`)
}

// corp: собственного набора иконок у канала `magnit` пока нет — берём `prod`, но сборка обязана
// проходить, а не падать на отсутствующем каталоге (S-B10).
const src = existsSync(`./icons/${channel}`) ? `./icons/${channel}` : "./icons/prod"
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied ${channel} icons from ${src} to ${dest}`)
