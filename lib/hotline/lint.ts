/**
 * Серверный deny-линт Телефона: секретам в ленте не место.
 *
 * Зеркало клиентского `send_deny` из общего `hotline.sh` (Ф0): те же классы —
 * приватные ключи, токены GitHub/OpenAI/AWS/Google, `secret|token|password…=…`.
 * Плюс НАШИ классы, которых у Ф0 нет: голые токены vault (`skm_…`, `skb_…`) —
 * их в ленте не ловит ничто, кроме этого списка (gitleaks против форматов
 * комнат тоже слеп — см. #262 и находку S4 аудита #057).
 *
 * Правило #262 (позитивный контроль): детектор, не виденный на настоящем
 * артефакте, считается отсутствующим — каждый шаблон в `HOTLINE_DENY_PATTERNS`
 * обязан иметь позитивный пример в `lint.test.ts`.
 */

/** Каждый шаблон — с комментарием, ЧТО ловит: голый регекс без подписи протухает. */
export const HOTLINE_DENY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'private-key', re: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { name: 'github-token', re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}/ },
  { name: 'openai-key', re: /sk-(live|test)-[A-Za-z0-9]{10,}/ },
  { name: 'aws-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'slack-token', re: /xox[bpas]-[A-Za-z0-9-]+/ },
  { name: 'google-oauth', re: /ya29\.[A-Za-z0-9_-]+/ },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{20,}/ },
  // `secret=…` / `token: …` / `password=…` — как в Ф0 (досл. класс send_deny).
  {
    name: 'secret-assignment',
    re: /(secret|token|password|passwd|pwd)\s*[:=]\s*\S{6,}/i,
  },
  // Наши классы: голые токены комнат и времянок vault (Ф0 их не знает).
  { name: 'vault-room-token', re: /\bskm_[A-Za-z0-9]+\b/ },
  { name: 'vault-claim-token', re: /\bskb_[A-Za-z0-9]+\b/ },
];

/**
 * Имя первого сработавшего шаблона либо null. Проверяется ДО записи;
 * согласованию («grant id=21 готов, забирай accept'ом») здесь зелёный.
 */
export function hotlineLint(text: string): string | null {
  for (const { name, re } of HOTLINE_DENY_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}
