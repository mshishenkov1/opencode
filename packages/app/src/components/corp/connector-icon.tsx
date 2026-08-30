import { Component, createMemo, createSignal, Show } from "solid-js"
import { connectorMonogram } from "@opencode-ai/core/corp/constants"

/**
 * Значок коннектора (S-V22, ревизия 1.14) — один компонент на витрину и на страницу коннектора.
 *
 * Источник картинки один — поле `icon` карточки каталога. Своего значка оболочка не выдумывает и по
 * alias не угадывает: без картинки рисуется монограмма из букв названия на нейтральной подложке
 * темы. Подложка нейтральная намеренно — цвет бренда взять неоткуда, а придуманный цвет говорил бы
 * о коннекторе то, чего каталог не говорил.
 *
 * Битая ссылка не оставляет дыры: `onError` возвращает монограмму — то же, что было бы без `icon`.
 * Размеры не свои: `small` — 30×30 (строка витрины), `large` — 54×54 (шапка страницы), радиус и
 * шрифт задаёт `dialog-shell.css`.
 */
export const ConnectorIcon: Component<{
  title: string
  icon?: string
  size?: "small" | "large"
}> = (props) => {
  const [failed, setFailed] = createSignal(false)
  const monogram = createMemo(() => connectorMonogram(props.title))
  const source = createMemo(() => (failed() ? undefined : props.icon))

  return (
    <span data-slot="corp-connector-icon" data-size={props.size ?? "small"} aria-hidden="true">
      <Show when={source()} fallback={<span data-slot="corp-connector-monogram">{monogram()}</span>}>
        {(value) => <img src={value()} alt="" onError={() => setFailed(true)} />}
      </Show>
    </span>
  )
}
