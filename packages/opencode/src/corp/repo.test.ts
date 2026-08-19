/**
 * Мостик к корневым корп-тестам (S-Q1, S-Q7).
 *
 * `corp/patches.test.ts` и `corp/build.test.ts` живут рядом с проверяемыми файлами в каталоге `corp/`,
 * а запускаются пакетом `opencode` (S-Q7: «тест реестра правок запускается в пакете opencode»).
 * `bun test` сканирует только каталог пакета, поэтому файлы подключаются импортом.
 */
import "../../../../corp/patches.test"
import "../../../../corp/build.test"
import "../../../../corp/upstream-sync.test"
