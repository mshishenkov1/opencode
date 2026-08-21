/**
 * Мостик к корневым корп-тестам (S-Q1, S-Q7, S-Q10).
 *
 * `corp/patches.test.ts` и `corp/build.test.ts` живут рядом с проверяемыми файлами в каталоге `corp/`,
 * а запускаются пакетом `opencode` (S-Q7: «тест реестра правок запускается в пакете opencode»).
 * Тем же способом подключены тесты конфигурации упаковки и рантайма Desktop: S-Q10 требует, чтобы
 * они лежали рядом с проверяемыми файлами в пакете `desktop`, а выполнялись в пакете `opencode`.
 * `bun test` сканирует только каталог пакета, поэтому файлы подключаются импортом.
 */
import "../../../../corp/patches.test"
import "../../../../corp/build.test"
import "../../../../corp/upstream-sync.test"
import "../../../../corp/verify-desktop-bundle.test"
import "../../../desktop/electron-builder.config.corp.test"
import "../../../desktop/src/main/updater.corp.test"
