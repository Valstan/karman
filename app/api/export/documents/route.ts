import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listDocuments } from '@/lib/services/documents';
import { buildCsv, csvDate } from '@/lib/csv';
import { todayStr } from '@/lib/dates';
import { csvResponse } from '../csv-response';

export const runtime = 'nodejs';

function scansSummary(d: { hasFront: boolean; hasBack: boolean; hasAdditional: boolean }): string {
  return [d.hasFront && 'лицевая', d.hasBack && 'оборот', d.hasAdditional && 'доп.']
    .filter(Boolean)
    .join(', ');
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const documents = await listDocuments(user);
  const headers = [
    'Название',
    'Категория',
    'Тип',
    'Номер',
    'Дата выдачи',
    'Действует до',
    'Кем выдан',
    'Активен',
    'Сканы',
  ];
  const rows = documents.map((d) => [
    d.title,
    d.categoryName ?? '',
    d.documentType,
    d.documentNumber,
    csvDate(d.issueDate),
    csvDate(d.expiryDate),
    d.issuingAuthority ?? '',
    d.isActive ? 'да' : 'нет',
    scansSummary(d),
  ]);

  return csvResponse(`documents-${todayStr()}.csv`, buildCsv(headers, rows));
}
