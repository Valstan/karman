import { requireSecretsUser } from '@/lib/auth/current-user';
import {
  readPresence,
  readRoomDayCounts,
  readRoomSenders,
  readRoomStats,
} from '@/lib/hotline/service';
import { formatDateTime } from '@/lib/format';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Витрина «Телефон» (мандат 04.10, срок 16.10): только чтение, только
 * суперпользователь (`requireSecretsUser` — как /secrets: 404 чужим).
 * Комнаты (каденс + last_ts), участники (presence: кто на проводе),
 * дежурный виден как «смотрящий жив» (спека v2-c).
 *
 * Только чтение намеренно: писать в ленту — дело клиентов relay, а не кнопки
 * в браузере. Отдельный GET на каждую загрузку (`force-dynamic`) — данные
 * живые, статический пререндер соврал бы про «кто на проводе».
 */
export const dynamic = 'force-dynamic';

const LINE_STATE_RU = { on_line: 'на проводе', offline: 'оффлайн' } as const;

export default async function HotlinePage() {
  await requireSecretsUser();
  // Один «сейчас» на весь рендер; сравнение в map — через детерминированный
  // `new Date(строка)` (чистая функция от входа), purity-гейт такое пропускает.
  const now = new Date();
  const [presence, stats, dayCounts, senders] = await Promise.all([
    readPresence(),
    readRoomStats(),
    readRoomDayCounts(),
    readRoomSenders(),
  ]);

  const dayByRoom = new Map(dayCounts.map((d) => [d.room, d.dayCount]));
  const sendersByRoom = new Map<string, { sender: string; lastTs: string | null }[]>();
  for (const s of senders) {
    const list = sendersByRoom.get(s.room) ?? [];
    list.push({ sender: s.sender, lastTs: s.lastTs });
    sendersByRoom.set(s.room, list);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Телефон</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Живая сводка relay: кто на проводе, что в комнатах. Только чтение —
          писать в ленту умеют клиенты relay.
        </p>
      </div>

      <section aria-label="Участники">
        <h2 className="mb-2 text-lg font-medium">На проводе</h2>
        {presence.length === 0 ? (
          <Alert>
            <AlertTitle>Тихо</AlertTitle>
            <AlertDescription>Ни одной метки присутствия — все спят.</AlertDescription>
          </Alert>
        ) : (
          <ul className="flex flex-col gap-2">
            {presence.map((p) => {
              const alive = new Date(p.aliveUntil) > now;
              return (
                <li
                  key={p.label}
                  className="flex flex-wrap items-baseline gap-x-3 rounded-md border bg-card px-3 py-2"
                >
                  <span className="font-mono font-medium">{p.label}</span>
                  <span className="text-sm">
                    {LINE_STATE_RU[p.lineState as keyof typeof LINE_STATE_RU] ?? p.lineState}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {alive ? 'жив' : 'молчит'} до {formatDateTime(p.aliveUntil)}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    тик {formatDateTime(p.updatedAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Комнаты">
        <h2 className="mb-2 text-lg font-medium">Комнаты</h2>
        {stats.length === 0 ? (
          <Alert>
            <AlertTitle>Лента пуста</AlertTitle>
            <AlertDescription>В relay пока ни одного сообщения.</AlertDescription>
          </Alert>
        ) : (
          <ul className="flex flex-col gap-2">
            {stats.map((r) => (
              <li key={r.room} className="rounded-md border bg-card px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono font-medium">{r.room}</span>
                  <span className="text-sm text-muted-foreground">
                    {r.total} сообщений, {dayByRoom.get(r.room) ?? 0} за 24ч
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    last_ts {r.lastTs ? formatDateTime(r.lastTs) : '—'}
                  </span>
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  участники:{' '}
                  {(sendersByRoom.get(r.room) ?? [])
                    .map((s) => `${s.sender} (${s.lastTs ? formatDateTime(s.lastTs) : '—'})`)
                    .join(', ') || '—'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
