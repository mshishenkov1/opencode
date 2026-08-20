import fs from "fs/promises"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { isRecord } from "@/util/record"
import { ConfigParse } from "@/config/parse"
import * as CorpConfig from "./config"

/**
 * Действующие значения корпоративного конфига для диагностики (S-C4a).
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

export interface Report {
  /** Действующая ссылка на модель (`provider/model`); `undefined` — модель не задана ни одним слоем. */
  model?: string
  /** Действующий адрес корпоративной модели по S-C4a. */
  baseURL?: string
}

/** Пустой отчёт: конфиг прочитать не удалось. */
export const EMPTY: Report = {}

/** Читает слои конфигурации и вычисляет действующие значения (S-C4a). */
export async function inspect(input: { directory: string }): Promise<Report> {
  const all = await layers(input.directory)

  // `model` и `baseURL`: побеждает самый верхний слой, задавший значение (S-C3).
  let model: string | undefined
  let baseURL: string | undefined
  for (const layer of all) {
    const value = layer.data["model"]
    if (typeof value === "string" && value.trim() !== "") model = value
    const url = CorpConfig.modelBaseUrlOf(layer.data as never)
    if (url !== undefined) baseURL = url
  }

  return {
    ...(model === undefined ? {} : { model }),
    ...(baseURL === undefined ? {} : { baseURL }),
  }
}
