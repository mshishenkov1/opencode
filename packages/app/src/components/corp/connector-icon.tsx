import { Component, createMemo, createSignal, Show } from "solid-js"
import { connectorMonogram } from "@opencode-ai/core/corp/constants"

/**
 * Значок коннектора (S-V22, ревизия 1.14) — один компонент на витрину и на страницу коннектора.
 *
 * Источник картинки один — поле `icon` карточки каталога. Своего значка оболочка не выдумывает и по
 * alias не угадывает: без картинки рисуется монограмма из букв названия. Битая ссылка не оставляет
 * дыры: `onError` возвращает монограмму — то же, что было бы без `icon`.
 *
 * Цвет подложки — тоже данные каталога (`icon_color`, макет заказчика от 30.08, экран 1): плитка с
 * монограммой на фирменном цвете, монограмма на ней белая. Таблицы «alias → цвет» здесь нет и быть
 * не должно — иначе каждый новый коннектор требовал бы сборки приложения. Без поля подложка
 * остаётся нейтральной, цветом темы, как была.
 *
 * Размеры не свои: `small` — 30×30 (строка витрины), `large` — 54×54 (шапка страницы), радиус и
 * шрифт задаёт `dialog-shell.css`.
 */

/**
 * Сторож на месте записи в стиль: цвет уходит прямо в `background`, поэтому сюда пропускается
 * ровно та запись, которую обещает контракт карточки, — `#RRGGBB`. Это не второй источник правды о
 * цвете (его по-прежнему называет каталог), а проверка у самой точки подстановки.
 */
const HEX = /^#[0-9a-fA-F]{6}$/

export const ConnectorIcon: Component<{
  title: string
  icon?: string
  color?: string
  size?: "small" | "large"
}> = (props) => {
  const [failed, setFailed] = createSignal(false)
  const monogram = createMemo(() => connectorMonogram(props.title))
  const source = createMemo(() => (failed() ? undefined : props.icon))
  const tint = createMemo(() => (props.color !== undefined && HEX.test(props.color) ? props.color : undefined))

  return (
    <span
      data-slot="corp-connector-icon"
      data-size={props.size ?? "small"}
      data-tinted={tint() === undefined ? undefined : ""}
      style={tint() === undefined ? undefined : { background: tint(), color: "#FFFFFF" }}
      aria-hidden="true"
    >
      <Show when={source()} fallback={<span data-slot="corp-connector-monogram">{monogram()}</span>}>
        {(value) => <img src={value()} alt="" onError={() => setFailed(true)} />}
      </Show>
    </span>
  )
}
