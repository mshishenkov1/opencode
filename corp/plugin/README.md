# corp/plugin

Каталог зарезервирован под корпоративные плагины OpenCode. В итерации I-4 плагинов нет — намеренно.

Обоснование — решение **D-1** спецификации (`corp/docs/spec.md`, §12):

- контракт `AuthHook` (`packages/plugin/src/index.ts`) описывает ровно один шаг
  `authorize() → {url, instructions}` и один `callback()`; шага «выбор команды»
  (`team_selection_required`, I-1 R-L3) в нём выразить нечем;
- TUI-экран `AutoMethod` (`packages/tui/src/component/dialog-provider.tsx`) вызывает `callback()` один раз
  в `onMount` и не умеет ничего спросить у пользователя;
- плагин не может зарегистрировать HTTP-маршрут сервера, а браузерный UI (`packages/app`) не может ходить
  в Hub напрямую — CORS в Hub не включён (I-1 R-A7).

Поэтому вход по SSO и витрина коннекторов реализованы корп-роутами сервера
(`packages/opencode/src/server/routes/instance/httpapi/groups/corp.ts`) и корп-экранами.
Каталог остаётся местом для будущих хуков (`config`, `tool`), которые в этот контракт укладываются.
