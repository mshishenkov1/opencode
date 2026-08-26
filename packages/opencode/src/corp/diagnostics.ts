import fs from "fs/promises"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { isRecord } from "@/util/record"
import { ConfigParse } from "@/config/parse"
import * as CorpCatalogCache from "./catalog-cache"
import * as CorpConfig from "./config"
import { corpCatalogUrl, corpEnabled, corpHubUrl, CORP_PROVIDER_ID } from "./config"
import type * as CorpSchema from "./schema"

/**
 * Диагностика личного конфига пользователя (S-C9, D-22) и действующий адрес модели (S-C4a).
 *
 * Корп-слой лежит ниже всех пользовательских слоёв (S-C3), поэтому личный конфиг сильнее корп-умолчаний
 * и способен молча отменить корпоративный сценарий. Правило требует **назвать** такую ситуацию, а не
 * чинить её: файл пользователя здесь только читается (S-C7).
 *
 * Модуль намеренно не поднимает `Config` и не требует `InstanceContext`: `opencode corp status` —
 * диагностическая команда, она не должна ни создавать `.gitignore`, ни ставить зависимости, ни
 * инициализировать плагины. Слои читаются в порядке S-C3; слой `.well-known`/`remote-config` Hub
 * пропущен — он требует сети и auth-записи, а на диагностируемые ключи не влияет.
 */

/**
 * Построчный контракт вывода `opencode corp status` в части ревизии 1.5 (S-A11a).
 * Формулировки — часть контракта: правятся одновременно со спекой и `cli.test.ts`.
 */
export const LINES = {
  model: (model: string, baseURL: string) => `Модель: ${model} на ${baseURL}`,
  providerDisabled: (file: string) =>
    `Провайдер ${CORP_PROVIDER_ID}: выключен в конфиге пользователя (disabled_providers): ${file}`,
  connectorsOverridden: (aliases: string[], file: string) =>
    `Коннекторы, переопределённые локально: ${aliases.join(", ")}: ${file}`,
} as const

/** Слой конфигурации: `file` отсутствует только у корп-слоя (он приходит из build-константы). */
interface Layer {
  file?: string
  data: Record<string, unknown>
}

function parse(text: string, source: string): Record<string, unknown> | undefined {
  try {
    const data = ConfigParse.jsonc(text, source)
    return isRecord(data) ? data : undefined
  } catch {
    // Разбор чужого конфига — не задача диагностики: неверный JSON назовёт загрузка конфига (AC-06).
    return undefined
  }
}

async function fileLayer(file: string): Promise<Layer | undefined> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined || text.trim() === "") return undefined
  const data = parse(text, file)
  return data === undefined ? undefined : { file, data }
}

const exists = (file: string) => fs.stat(file).then(() => true, () => false)

/**
 * Файлы конфига проекта от дальнего предка к ближнему: ближний сильнее (порядок `ConfigPaths.files`).
 * Подъём останавливается на корне рабочего дерева git — так же, как `stop: worktree` у загрузки конфига.
 */
async function projectFiles(directory: string): Promise<string[]> {
  const found: string[] = []
  let current = path.resolve(directory)
  while (true) {
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      const file = path.join(current, name)
      if (await exists(file)) found.push(file)
    }
    if (await exists(path.join(current, ".git"))) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return found.reverse()
}

/**
 * Слои конфигурации в порядке возрастания приоритета (S-C3):
 * корп-слой < глобальный конфиг пользователя < `OPENCODE_CONFIG` < конфиг проекта.
 */
async function layers(directory: string): Promise<Layer[]> {
  const result: Layer[] = []

  const corpText = CorpConfig.configText()
  if (corpText) {
    const data = parse(corpText, CorpConfig.CONFIG_SOURCE)
    if (data) {
      const override = CorpConfig.modelBaseUrlOverride()
      if (override && "url" in override) CorpConfig.applyModelBaseUrl(data as never, override.url)
      result.push({ data })
    }
  }

  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const layer = await fileLayer(path.join(Global.Path.config, name))
    if (layer) result.push(layer)
  }

  if (Flag.OPENCODE_CONFIG) {
    const layer = await fileLayer(Flag.OPENCODE_CONFIG)
    if (layer) result.push(layer)
  }

  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    for (const file of await projectFiles(directory)) {
      const layer = await fileLayer(file)
      if (layer) result.push(layer)
    }
  }

  return result
}

/** Значение `mcp.<alias>` в слое. */
function mcpEntry(layer: Layer, alias: string): Record<string, unknown> | undefined {
  const mcp = layer.data["mcp"]
  if (!isRecord(mcp)) return undefined
  const entry = mcp[alias]
  return isRecord(entry) ? entry : undefined
}

export interface Report {
  /** Действующая ссылка на модель (`provider/model`); `undefined` — модель не задана ни одним слоем. */
  model?: string
  /** Действующий адрес корпоративной модели по S-C4a. */
  baseURL?: string
  /** `disabled_providers` действующего конфига выключает корп-провайдера: файл, где это записано (S-C9). */
  providerDisabled?: { file: string }
  /** Alias'ы каталога Hub, чья действующая запись `mcp.<alias>` расходится с каталогом (S-C9). */
  connectorsOverridden: { file: string; aliases: string[] }[]
}

/** Пустой отчёт: ни одной диагностируемой ситуации. */
export const EMPTY: Report = { connectorsOverridden: [] }

export function hasConflicts(report: Report): boolean {
  return report.providerDisabled !== undefined || report.connectorsOverridden.length > 0
}

/**
 * Читает слои конфигурации и вычисляет отчёт (S-C4a, S-C9).
 * `catalog` — карточки каталога Hub (из кэша S-V3); без него локальные переопределения не проверяются.
 */
export async function inspect(input: {
  directory: string
  catalog?: readonly CorpSchema.CatalogServer[]
}): Promise<Report> {
  const all = await layers(input.directory)
  const userLayers = all.filter((layer): layer is Layer & { file: string } => layer.file !== undefined)

  // `model` и `baseURL`: побеждает самый верхний слой, задавший значение (S-C3).
  let model: string | undefined
  let baseURL: string | undefined
  for (const layer of all) {
    const value = layer.data["model"]
    if (typeof value === "string" && value.trim() !== "") model = value
    const url = CorpConfig.modelBaseUrlOf(layer.data as never)
    if (url !== undefined) baseURL = url
  }

  // `disabled_providers` — массив: при слиянии он заменяется целиком, поэтому действует значение
  // самого верхнего слоя, который его задал.
  let providerDisabled: { file: string } | undefined
  for (let index = all.length - 1; index >= 0; index--) {
    const layer = all[index]!
    const value = layer.data["disabled_providers"]
    if (!Array.isArray(value)) continue
    if (value.includes(CORP_PROVIDER_ID) && layer.file !== undefined) providerDisabled = { file: layer.file }
    break
  }

  // `mcp.<alias>` — объект: слияние идёт по полям (F38), поэтому личная запись не заменяет запись
  // каталога Hub, а смешивается с ней. Расхождение по `type` или `url` и есть «переопределено локально».
  const byFile = new Map<string, string[]>()
  for (const server of input.catalog ?? []) {
    const owners = userLayers.filter((layer) => mcpEntry(layer, server.alias) !== undefined)
    if (owners.length === 0) continue
    const effective = owners.reduce<Record<string, unknown>>(
      (acc, layer) => ({ ...acc, ...mcpEntry(layer, server.alias)! }),
      {},
    )
    if (effective["type"] === "remote" && effective["url"] === server.mcp_url) continue
    const file = owners[owners.length - 1]!.file
    const aliases = byFile.get(file)
    if (aliases) aliases.push(server.alias)
    else byFile.set(file, [server.alias])
  }

  return {
    ...(model === undefined ? {} : { model }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(providerDisabled === undefined ? {} : { providerDisabled }),
    connectorsOverridden: [...byFile.entries()].map(([file, aliases]) => ({ file, aliases })),
  }
}

/** Каталоги, для которых предупреждение уже написано: S-C9 требует ровно одну запись при старте. */
const warned = new Set<string>()

/**
 * Предупреждения о конфликтах личного конфига при старте (S-C9 п. 2): тот же текст и тот же путь к
 * файлу, что и в `corp status`. Для каждого каталога вычисляются один раз за время жизни процесса;
 * в ванильной сборке (S-C6) корп-текстов нет вовсе.
 */
export async function startupWarnings(directory: string): Promise<string[]> {
  if (!corpEnabled()) return []
  if (warned.has(directory)) return []
  warned.add(directory)
  // Кэш каталога ключуется адресом источника (S-V3, S-C10 п.3): в сборке без Hub — адресом
  // статического каталога. Без обоих адресов кэша нет и читать нечего.
  const url = corpHubUrl() ?? corpCatalogUrl()
  const cached = url === undefined ? undefined : await CorpCatalogCache.read(url).catch(() => undefined)
  const report = await inspect({
    directory,
    ...(cached === undefined ? {} : { catalog: cached.servers }),
  }).catch(() => EMPTY)
  return conflictLines(report)
}

/** Строки диагностики для вывода `corp status` (S-A11a); пустой массив — конфликтов нет. */
export function conflictLines(report: Report): string[] {
  const lines: string[] = []
  if (report.providerDisabled) lines.push(LINES.providerDisabled(report.providerDisabled.file))
  for (const item of report.connectorsOverridden) lines.push(LINES.connectorsOverridden(item.aliases, item.file))
  return lines
}
