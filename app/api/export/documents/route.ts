import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listDocuments } from '@/lib/services/documents';
import { buildCsv, csvDate } from '@/lib/csv';
import { todayStr } from '@/lib/dates';
import { csvResponse } from '../csv-response';

export const runtime = 'nodejs';

// Файлов на документе стало произвольное число (раньше было три именованных
// слота, и колонка перечисляла их словами). В CSV уезжает количество: имена
// файлов сюда не помещаются, а «есть/нет» теряет то, ради чего меняли модель.
function filesSummary(d: { fileCount: number }): string {
  return d.fileCount === 0 ? '' : String(d.fileCount);
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
    'Файлов',
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
    filesSummary(d),
  ]);

  return csvResponse(`documents-${todayStr()}.csv`, buildCsv(headers, rows));
}
