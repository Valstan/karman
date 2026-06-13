// #036 dead-code-гигиена (мандат brain 06-10): однокнопочный прогон обоих сканеров.
//   knip     — мёртвые файлы / экспорты / зависимости (основной сигнал; понимает
//              Next-conventions, postcss и tailwind через встроенные плагины).
//   depcheck — кросс-проверка зависимостей (шумнее knip: не видит CSS-@import,
//              потому FP по tailwind-стеку — гасим их --ignores).
//
// Режим report-only: печатает КАНДИДАТОВ и ВСЕГДА выходит с кодом 0 — это гигиена,
// а не блокирующий гейт (FP фреймворков сделали бы гейт источником боли, #036).
// Кандидатов триажить по #028 (git-история символа), НЕ удалять молча: «живое, но
// не подключённое» — вход в re-триаж #033, решение за владельцем.
import { spawnSync } from 'node:child_process';

function run(title, cmd, args) {
  process.stdout.write(`\n─── ${title} ───\n`);
  spawnSync(cmd, args, { stdio: 'inherit', shell: true });
}

run('knip — мёртвый код, неиспользуемые экспорты и зависимости', 'knip', []);
// depcheck не видит использование через CSS/postcss → его FP по tailwind-стеку и
// нашим CLI-инструментам гасим явно, чтобы кросс-проверка несла сигнал, а не шум.
run('depcheck — кросс-проверка зависимостей-сирот', 'depcheck', [
  '--ignores=server-only,depcheck,knip,tailwindcss,@tailwindcss/postcss,tw-animate-css',
]);

process.stdout.write(
  '\n[deadcode] report-only — кандидатов выше триажить по #028 (git-история символа), не удалять молча.\n',
);
process.exit(0);
