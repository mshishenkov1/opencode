import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as uk } from "./uk"
import { dict as th } from "./th"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import { dict as tr } from "./tr"

const locales = [ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, uk, th, tr, zh, zht]
const keys = ["command.session.previous.unseen", "command.session.next.unseen"] as const

const placeholders = (value: string) => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort()

describe("i18n parity", () => {
  test("non-English locales translate targeted unseen session keys", () => {
    for (const locale of locales) {
      for (const key of keys) {
        expect(locale[key]).toBeDefined()
        expect(locale[key]).not.toBe(en[key])
      }
    }
  })

  // corp (F29): русский — язык корпоративной сборки, поэтому ru обязан покрывать en целиком.
  // Пропущенный ключ молча падает на английскую базу, и на экране появляется английская строка.
  test("ru covers every English key", () => {
    const missing = Object.keys(en).filter((key) => !(key in ru))
    expect(missing).toEqual([])
  })

  test("ru has no keys that English does not", () => {
    const extra = Object.keys(ru).filter((key) => !(key in en))
    expect(extra).toEqual([])
  })

  test("ru keeps the same placeholders as English", () => {
    const keys = Object.keys(en) as (keyof typeof en)[]
    const mismatched = keys
      .filter((key) => key in ru)
      .filter((key) => placeholders(ru[key]).join(",") !== placeholders(en[key]).join(","))
    expect(mismatched).toEqual([])
  })
})
