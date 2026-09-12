import { describe, expect, it } from 'vitest';
import { parseEcosystemMap } from './map';

const valid = {
  asOf: '2026-09-11',
  groups: [
    {
      title: 'Бокс 1',
      rows: [{ project: 'KARMAN', site: 'внутренний', port: ':3002' }],
    },
  ],
};

describe('parseEcosystemMap — файл от Мозга вне репозитория', () => {
  it('минимальный валидный файл: пропущенные необязательные поля становятся пустыми строками', () => {
    const r = parseEcosystemMap(JSON.stringify(valid));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.map.asOf).toBe('2026-09-11');
    expect(r.map.groups[0]?.rows[0]).toEqual({
      project: 'KARMAN',
      site: 'внутренний',
      port: ':3002',
      note: '',
    });
    expect(r.map.archive).toBe('');
  });

  it('битый JSON — ошибка с текстом, а не исключение', () => {
    const r = parseEcosystemMap('{ not json');
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/JSON/);
  });

  it('дата не ГГГГ-ММ-ДД — ошибка указывает на поле', () => {
    const r = parseEcosystemMap(JSON.stringify({ ...valid, asOf: '11.09.2026' }));
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/^asOf/);
  });

  it('пустой список боксов — ошибка (карта без боксов бессмысленна)', () => {
    const r = parseEcosystemMap(JSON.stringify({ ...valid, groups: [] }));
    expect(r.status).toBe('error');
  });

  it('строка без project — ошибка с путём до строки', () => {
    const bad = { ...valid, groups: [{ title: 'Бокс', rows: [{ site: 'x' }] }] };
    const r = parseEcosystemMap(JSON.stringify(bad));
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.message).toMatch(/groups\.0\.rows\.0\.project/);
  });
});
