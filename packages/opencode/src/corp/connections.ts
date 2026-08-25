import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { Global } from "@opencode-ai/core/global"
import type * as CorpSchema from "./schema"

/**
 * Признак «подключение состоялось» (S-V15, D-30).
 *
 * От признака зависит набор действий карточки (S-V16): сервер, который пользователь никогда не
 * подключал, и сервер, подключение которого было и сломалось, — разные состояния с разными
 * действиями. Запись `mcp.<alias>` в конфиге доказательством **не** является: её создаёт шаг 1 S-V7
 * до авторизации, и именно её прежние правила принимали за подключение (`BUG-I4-010`).
 *
 * Доказательств ровно два (S-V15 п.1):
 * (а) локальный статус MCP хотя бы раз наблюдался равным `connected` — в текущем или в любом прошлом
 *     запуске; это и хранит файл на диске;
 * (б) карточка каталога Hub содержит `connection.status ∈ {connected, needs_reauth}` — запись
 *     подключения Hub создаётся только после успешной авторизации (I-3 R-B), поэтому переживает
 *     переустановку и чистый профиль.
 *
 * Кэши разных `hub_url` изолированы именем файла, как и кэш каталога (S-V3).
 */

export function fileFor(hubUrl: string, dataDir: string = Global.Path.data) {
  const digest = createHash("sha256").update(hubUrl).digest("hex").slice(0, 16)
  return path.join(dataDir, "corp", `connections-${digest}.json`)
}

/** Запись об одном alias: момент **первого** наблюдения признака (повторные его не меняют). */
export interface AliasEntry {
  connected_at: string
}

export interface Entry {
  hubUrl: string
  aliases: Record<string, AliasEntry>
}

export interface ReadResult {
  entry: Entry
  /**
   * Файл есть, но прочитать его как признак не удалось (S-V15 п.4): битый JSON, чужая форма или
   * чужой `hub_url`. Трактуется как отсутствующий; вызывающий пишет предупреждение в лог и
   * продолжает — витрина обязана открыться (AC-179).
   */
  corrupted: boolean
}

function empty(hubUrl: string): Entry {
  return { hubUrl, aliases: {} }
}

/**
 * Разбор содержимого файла. Форма проверяется вручную, а не схемой: любое отклонение здесь означает
 * «признака нет», и различать виды поломки незачем — файл всё равно будет перезаписан (S-V15 п.4).
 */
function parse(value: unknown, hubUrl: string): Entry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw["hub_url"] !== hubUrl) return undefined
  const aliases = raw["aliases"]
  if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases)) return undefined
  const result: Record<string, AliasEntry> = {}
  for (const [alias, entry] of Object.entries(aliases as Record<string, unknown>)) {
    if (!alias) continue
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
    const at = (entry as Record<string, unknown>)["connected_at"]
    if (typeof at !== "string" || at === "") continue
    result[alias] = { connected_at: at }
  }
  return { hubUrl, aliases: result }
}

/** Читает признак; отсутствие файла — пустая запись без пометки о повреждении. */
export async function read(hubUrl: string, dataDir?: string): Promise<ReadResult> {
  const file = fileFor(hubUrl, dataDir)
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch {
    return { entry: empty(hubUrl), corrupted: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { entry: empty(hubUrl), corrupted: true }
  }
  const entry = parse(parsed, hubUrl)
  if (!entry) return { entry: empty(hubUrl), corrupted: true }
  return { entry, corrupted: false }
}

/** Перезаписывает файл признака; права — `0o600` (S-V15 п.2). Ошибка записи не фатальна. */
export async function write(entry: Entry, dataDir?: string): Promise<void> {
  const file = fileFor(entry.hubUrl, dataDir)
  const body = { hub_url: entry.hubUrl, aliases: entry.aliases }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(body), { mode: 0o600 })
    await fs.chmod(file, 0o600).catch(() => {})
  } catch {
    // Признак — накопительная память о наблюдениях: невозможность записи не должна ломать витрину.
    // Hub-доказательство (S-V15 п.1б) продолжает работать и без файла.
  }
}

/** Наблюдалось ли подключение прямо сейчас по данным Hub (S-V15 п.1б). */
export function provenByHub(connection: CorpSchema.ConnectionStatus | undefined): boolean {
  return connection === "connected" || connection === "needs_reauth"
}

/**
 * Наблюдалось ли подключение прямо сейчас (S-V15 п.1): локальный статус `connected` либо запись
 * подключения Hub. Именно это наблюдение и добавляется в файл.
 */
export function observed(input: { local?: string; connection?: CorpSchema.ConnectionStatus }): boolean {
  return input.local === "connected" || provenByHub(input.connection)
}

/**
 * Добавляет наблюдения в запись признака. `connected_at` первого наблюдения не меняется (S-V15 п.2).
 * Возвращает `undefined`, если писать нечего — тогда файл не трогается вовсе.
 */
export function remember(entry: Entry, aliases: Iterable<string>, now: Date = new Date()): Entry | undefined {
  const at = now.toISOString()
  let changed = false
  const next: Record<string, AliasEntry> = { ...entry.aliases }
  for (const alias of aliases) {
    if (next[alias]) continue
    next[alias] = { connected_at: at }
    changed = true
  }
  return changed ? { hubUrl: entry.hubUrl, aliases: next } : undefined
}

/**
 * Снимает признак с одного alias (S-V15 п.3). Единственный способ его снять — «Убрать из списка»
 * (S-V17): ни «Отключить», ни недоступность Hub, ни ошибка подключения признака не снимают.
 */
export function forget(entry: Entry, alias: string): Entry | undefined {
  if (!entry.aliases[alias]) return undefined
  const next = { ...entry.aliases }
  delete next[alias]
  return { hubUrl: entry.hubUrl, aliases: next }
}

/** Есть ли у alias запись о состоявшемся подключении. */
export function has(entry: Entry, alias: string): boolean {
  return entry.aliases[alias] !== undefined
}
