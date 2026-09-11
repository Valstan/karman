import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Воркер — plain ESM без типов; тест держит его контракт (мандат brain 2026-09-09).
// @ts-expect-error — .js без декларации, намеренно: файл едет в панель Cloudflare как есть.
import worker from './karman-tg.js';

const SECRET = 'relay-secret-for-tests';
const TOKEN = '123456:ABC-def_ghi';
const BASE = 'https://karman-tg.example.workers.dev';

type Call = { url: string; init: RequestInit };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

function call(path: string, opts: { method?: string; secret?: string | null; env?: Record<string, string> } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.secret !== null) {
    headers.set('x-relay-secret', opts.secret ?? SECRET);
  }
  const method = opts.method ?? 'POST';
  const req = new Request(BASE + path, { method, headers, body: method === 'POST' ? '{}' : undefined });
  return worker.fetch(req, opts.env ?? { RELAY_SECRET: SECRET });
}

describe('karman-tg relay', () => {
  it('пропускает разрешённый метод с верным секретом и не отдаёт наружу заголовки звонящего', async () => {
    const res = await call(`/bot${TOKEN}/sendMessage`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const h = calls[0]?.init.headers as Record<string, string>;
    expect(Object.keys(h)).toEqual(['content-type']);
  });

  it('сохраняет query getUpdates', async () => {
    const res = await call(`/bot${TOKEN}/getUpdates?timeout=25&offset=7`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=25&offset=7`);
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('без заголовка — 403, до Telegram не ходит (#114: гейт проверяется подсадным)', async () => {
    const res = await call(`/bot${TOKEN}/sendMessage`, { secret: null });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('неверный секрет — 403', async () => {
    const res = await call(`/bot${TOKEN}/sendMessage`, { secret: 'wrong' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('RELAY_SECRET не задан — реле закрыто (503), а не прозрачно', async () => {
    const res = await call(`/bot${TOKEN}/sendMessage`, { env: {} });
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('метод вне allowlist — 404', async () => {
    const res = await call(`/bot${TOKEN}/deleteWebhook`);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('путь не вида /bot<token>/<метод> — 404', async () => {
    for (const p of ['/', '/getMe', `/bot${TOKEN}/`, `/bot${TOKEN}/sendMessage/extra`, `/file/bot${TOKEN}/x`]) {
      const res = await call(p);
      expect(res.status, p).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it('HTTP-метод кроме GET/POST — 405', async () => {
    const res = await call(`/bot${TOKEN}/sendMessage`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(calls).toHaveLength(0);
  });
});
