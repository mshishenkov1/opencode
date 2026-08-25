import fs from "fs/promises"
import os from "os"
import path from "path"
import { corpCliUpdateUrl, corpEnabled } from "@opencode-ai/core/corp/constants"

/**
 * Явный апгрейд CLI в корпоративной сборке (S-B14, D-34).
 *
 * Корп-умолчание `autoupdate: false` (S-C4) выключает **фоновую** проверку, но команду
 * `opencode upgrade` не касается: она вызывается пользователем явно и `autoupdate` не читает, а
 * `Installation.latest()` идёт в `api.github.com/repos/anomalyco/opencode/releases/latest` (F43).
 * Это ровно тот путь, которым ванильный артефакт попадает в корпоративную сборку, — тот же класс
 * дефекта, что общий `appId` и общий каталог кеша обновлений.
 *
 * Правило простое: **нет адреса — нет апгрейда**, с внятным сообщением и ненулевым кодом выхода
 * (то же умолчание, что у Desktop, D-24). Молчаливый успех («уже последняя версия») отвергнут: он
 * неотличим от работающего обновления и скрывает, что канал доставки не настроен.
 *
 * Модуль намеренно написан на промисах и не зависит от Effect: `fetch` и запуск процессов
 * подменяются в тестах без поднятия слоёв, как в `corp/hub.ts`.
 */

/** Хосты, к которым корпоративный апгрейд не обращается ни на одном шаге (S-B14, AC-193). */
export const FORBIDDEN_HOSTS = [
  "api.github.com",
  "github.com",
  "registry.npmjs.org",
  "formulae.brew.sh",
  "community.chocolatey.org",
  "raw.githubusercontent.com",
  "opencode.ai",
] as const

export type Plan =
  /** Ванильная сборка (S-C6): команда ведёт себя полностью как upstream. */
  | { mode: "upstream" }
  /** Корп-функции включены, адрес не задан: ни одного сетевого запроса, сообщение и код выхода 1. */
  | { mode: "disabled" }
  /** Корп-функции включены, адрес задан: версия и артефакт берутся только с него. */
  | { mode: "internal"; url: string }

/**
 * Что делает `opencode upgrade` в текущей сборке (S-B14).
 * `corpEnabled` и `updateUrl` подменяются в тестах — читать окружение здесь незачем.
 */
export function plan(options: { enabled?: boolean; url?: string | undefined } = {}): Plan {
  const enabled = options.enabled ?? corpEnabled()
  if (!enabled) return { mode: "upstream" }
  const url = options.url === undefined ? corpCliUpdateUrl() : options.url
  if (!url) return { mode: "disabled" }
  return { mode: "internal", url: url.replace(/\/+$/, "") }
}

/** Сообщение отключённого апгрейда (ключ `corp.upgrade.disabled`, S-I1). */
export const DISABLED_MESSAGE =
  "Обновление корпоративной сборки выполняется централизованно: новую версию нужно взять у распространителя сборки"

export type Failure = { ok: false; error: "unreachable" | "invalid_response" }
export type Success<T> = { ok: true; data: T }
export type Result<T> = Success<T> | Failure

/** Адрес определения целевой версии: `GET <base>/latest` → `{version}` (S-B14). */
export function latestUrl(base: string) {
  return `${base}/latest`
}

/**
 * Адрес артефакта той же сборки: `<base>/<версия>/opencode-<os>-<arch>.zip`.
 * Имя совпадает с именем артефакта сборки CLI (`packages/opencode/script/build.ts`).
 */
export function artifactUrl(
  base: string,
  version: string,
  platform: string = process.platform,
  arch: string = process.arch,
) {
  return `${base}/${encodeURIComponent(version)}/opencode-${platform}-${arch}.zip`
}

/**
 * Целевая версия с внутреннего источника (S-B14).
 *
 * Ответ разбирается по правилам S-V2: несоответствие схемы даёт понятную ошибку, а не падение, и
 * **не** приводит к обращению к запасному публичному источнику (AC-195).
 */
export async function latest(
  base: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Result<string>> {
  const doFetch = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await doFetch(latestUrl(base), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    })
  } catch {
    return { ok: false, error: "unreachable" }
  }
  if (!response.ok) return { ok: false, error: "unreachable" }
  const text = await response.text().catch(() => "")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: "invalid_response" }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, error: "invalid_response" }
  const version = (parsed as Record<string, unknown>)["version"]
  if (typeof version !== "string" || version.trim() === "") return { ok: false, error: "invalid_response" }
  return { ok: true, data: version.trim().replace(/^v/, "") }
}

/** Текст ошибки источника обновлений — называет и адрес, и что именно с ним не так (AC-195). */
export function sourceErrorMessage(base: string, error: Failure["error"]) {
  return error === "unreachable"
    ? `Источник обновлений ${latestUrl(base)} недоступен`
    : `Источник обновлений ${latestUrl(base)} вернул неожиданный ответ`
}

export interface InstallOptions {
  fetch?: typeof fetch
  /** Путь к заменяемому бинарнику; по умолчанию — текущий исполняемый файл. */
  binary?: string
  /** Запуск распаковщика; подменяется в тестах. */
  extract?: (archive: string, into: string) => Promise<void>
  platform?: string
  arch?: string
}

/** Распаковка архива: `unzip` там, где он есть, иначе `tar -xf` (bsdtar понимает zip). */
async function extractArchive(archive: string, into: string) {
  const unzip = Bun.spawnSync({ cmd: ["unzip", "-o", "-q", archive, "-d", into], stdout: "pipe", stderr: "pipe" })
  if (unzip.exitCode === 0) return
  const tar = Bun.spawnSync({ cmd: ["tar", "-xf", archive, "-C", into], stdout: "pipe", stderr: "pipe" })
  if (tar.exitCode !== 0) throw new Error(`не удалось распаковать ${archive}`)
}

/**
 * Скачивает артефакт с того же внутреннего хоста и заменяет бинарник (S-B14).
 *
 * Способ замены — как у метода `curl`: файл кладётся рядом, права выставляются, прежний бинарник
 * снимается. Публичные реестры и менеджеры пакетов не участвуют.
 */
export async function install(base: string, version: string, options: InstallOptions = {}): Promise<Result<string>> {
  const doFetch = options.fetch ?? globalThis.fetch
  const target = options.binary ?? process.execPath
  const url = artifactUrl(base, version, options.platform, options.arch)

  let response: Response
  try {
    response = await doFetch(url, { headers: { accept: "application/octet-stream" } })
  } catch {
    return { ok: false, error: "unreachable" }
  }
  if (!response.ok) return { ok: false, error: "unreachable" }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-corp-upgrade-"))
  const archive = path.join(dir, "opencode.zip")
  try {
    await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()))
    await (options.extract ?? extractArchive)(archive, dir)
    const unpacked = await locateBinary(dir, path.basename(target))
    if (!unpacked) return { ok: false, error: "invalid_response" }
    const staged = `${target}.corp-new`
    await fs.copyFile(unpacked, staged)
    await fs.chmod(staged, 0o755).catch(() => {})
    await fs.rename(staged, target)
    return { ok: true, data: version }
  } catch {
    return { ok: false, error: "invalid_response" }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Находит распакованный бинарник по имени: раскладка архива у сборки — `bin/opencode`. */
async function locateBinary(dir: string, name: string): Promise<string | undefined> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name !== name && entry.name !== "opencode" && entry.name !== "opencode.exe") continue
    return path.join(entry.parentPath ?? dir, entry.name)
  }
  return undefined
}
