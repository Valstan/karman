/**
 * IP клиента для журналов, аудита и счётчиков перебора.
 *
 * ## Почему нельзя брать первый элемент `X-Forwarded-For`
 *
 * `X-Forwarded-For` — **дополняемый** заголовок: прокси дописывает адрес в конец того,
 * что прислал клиент. Референс и боевой конфиг nginx оба используют
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`, то есть
 * `X-Forwarded-For: 9.9.9.9` от клиента доезжает до приложения как
 * `9.9.9.9, <настоящий адрес>`. Первый элемент (`split(',')[0]`) — это ровно то, что
 * подставил клиент, поэтому `loginGuardKey(username, ip)` менялся целиком на каждый
 * запрос, счётчик неудач обнулялся, и блокировка перебора (10 попыток / 15 минут) не
 * срабатывала никогда. Тот же приём обнулял все остальные IP-бакеты (`/api/secrets*`).
 *
 * Проверено на боевом боксе (`nginx -T`): `X-Forwarded-For $proxy_add_x_forwarded_for`,
 * `X-Real-IP $remote_addr`. Аудит #057, находка R1 — подтверждена замером, а не чтением.
 *
 * ## Что доверенно
 *
 * `X-Real-IP` nginx **перезаписывает** значением `$remote_addr`, клиент его подменить не
 * может. Именно поэтому в проекте он и есть — а до этого использования не находилось
 * ни в одном из девяти роутов, которые дублировали неправильный `split(',')[0]`.
 *
 * ## Формат
 *
 * Возвращается только то, что похоже на IP: колонка `auth_audit.ip` — `varchar(64)`, а
 * `logAuthAudit` не обрезает вход (аудит #057, D4). Не-IP-хвост в заголовке раньше ронял
 * INSERT анонимным запросом — поэтому фильтр здесь, а не в вызывающем коде.
 */

const IP_SHAPE = /^[0-9a-fA-F:.]{2,45}$/;

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return IP_SHAPE.test(trimmed) ? trimmed : null;
}

export function clientIp(req: Request): string | null {
  // 1. Доверенный заголовок: nginx перезаписывает его из $remote_addr.
  const real = normalize(req.headers.get('x-real-ip'));
  if (real) return real;

  // 2. Последний элемент XFF — тот, который дописал прокси, а не клиент.
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',');
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const candidate = normalize(parts[i]);
      if (candidate) return candidate;
    }
  }

  return null;
}