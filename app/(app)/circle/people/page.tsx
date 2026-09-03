import Link from 'next/link';
import { ArrowLeft, FileText } from 'lucide-react';
import { requireUser } from '@/lib/auth/current-user';
import { listVisibleDocuments, listVisiblePeople } from '@/lib/services/circle';
import { PROFILE_FIELDS, formatProfileValue } from '@/lib/profile/fields';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Данные круга: карточки и документы всех, кто открыл доступ, плюс свои.
 * Список людей считается сервисом по согласиям — сюда он не приходит
 * параметром, поэтому «показать чужое» здесь невозможно в принципе.
 *
 * Экран для ЧТЕНИЯ. Забрать данные себе — соседний экран `/circle/export`,
 * там выбор галочками и форматы.
 */
export default async function CirclePeoplePage() {
  const user = await requireUser();
  const [people, documents] = await Promise.all([
    listVisiblePeople(user),
    listVisibleDocuments(user),
  ]);

  const docsByPerson = new Map<number, typeof documents>();
  for (const doc of documents) {
    const list = docsByPerson.get(doc.ownerUserId) ?? [];
    list.push(doc);
    docsByPerson.set(doc.ownerUserId, list);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/circle"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> К кругам
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Данные круга</h1>
          <p className="text-sm text-muted-foreground">
            {people.length} человек. Здесь только те, кто согласился участвовать, — и вы.
          </p>
        </div>
        {/* Экран выгрузки появляется вехой 4 — ссылку добавим вместе с ним,
            чтобы здесь не висел мёртвый переход. */}
      </div>

      {people.map((person) => {
        const filled = PROFILE_FIELDS.filter(
          (field) => formatProfileValue(field.kind, person.profile[field.key]) !== '',
        );
        const personDocs = docsByPerson.get(person.userId) ?? [];
        return (
          <Card key={person.userId}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {person.name}
                <span className="text-xs font-normal text-muted-foreground">
                  {person.username}
                </span>
                {person.userId === user.id && <Badge variant="outline">это вы</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {filled.length === 0 ? (
                <p className="text-sm text-muted-foreground">Карточка пока не заполнена.</p>
              ) : (
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {filled.map((field) => (
                    <div key={field.key}>
                      <dt className="text-xs text-muted-foreground">{field.label}</dt>
                      <dd className="font-medium break-words">
                        {formatProfileValue(field.kind, person.profile[field.key])}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              {personDocs.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Документы</p>
                  <ul className="flex flex-col gap-2">
                    {personDocs.map((doc) => (
                      <li key={doc.id} className="rounded-md border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{doc.title}</span>
                          {doc.documentType !== '' && (
                            <Badge variant="secondary">{doc.documentType}</Badge>
                          )}
                          {doc.files.length > 0 && (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <FileText className="h-3 w-3" /> {doc.files.length}
                            </span>
                          )}
                        </div>
                        {doc.fields.length > 0 && (
                          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {doc.fields
                              .filter((f) => f.value.trim() !== '')
                              .map((f) => (
                                <div key={`${doc.id}-${f.name}`}>
                                  <dt className="text-xs text-muted-foreground">{f.name}</dt>
                                  <dd className="text-sm break-words">{f.value}</dd>
                                </div>
                              ))}
                          </dl>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
