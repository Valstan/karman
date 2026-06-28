import next from 'eslint-config-next';

// eslint-config-next 16 экспортирует нативный flat-config (next/core-web-vitals +
// typescript-парсер + global ignores .next/out/build/next-env.d.ts уже внутри).
// FlatCompat не нужен (несовместим с ESLint 10).
const eslintConfig = [...next];

export default eslintConfig;
