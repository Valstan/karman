import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { getCurrentUser } from '@/lib/auth/current-user';
import { circleFilePath } from '@/lib/services/circle';
import { contentTypeForPath, fileExists, absolutePathFor } from '@/lib/storage/media';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ fileId: string }> };

/**
 * Отдаёт файл документа, доступный через круг (или свой). Отдельный роут от
 * `/api/documents/[id]/files/[fileId]`: тот проверяет ВЛАДЕНИЕ и чужой файл не
 * отдаст никогда — это его работа, и добавлять туда «а ещё по кругу можно»
 * значило бы смешать два разных вопроса в одной проверке.
 *
 * Нужен для выгрузки ZIP и «Поделиться картинкой»: браузер забирает файлы
 * людей круга сам, поэтому сервер не собирает архив в памяти.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: 'Требуется авторизация' }, { status: 401 });

  const { fileId: raw } = await ctx.params;
  const fileId = Number(raw);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return NextResponse.json({ message: 'Некорректный запрос' }, { status: 400 });
  }

  const found = await circleFilePath(user, fileId);
  // «Нет доступа» и «нет файла» отвечают ОДИНАКОВО: иначе разница между 403 и
  // 404 сама по себе сообщает, что файл с таким id существует.
  if (!found || !(await fileExists(found.path))) {
    return NextResponse.json({ message: 'Файл не найден' }, { status: 404 });
  }

  // `readFile` уже отдаёт Buffer (подтип Uint8Array). Обёртка `new Uint8Array(buffer)`
  // копировала файл ВТОРЫМ разом: на файле в 10 МБ это две копии в памяти сервера
  // (аудит #057, D6). Тело отдаём самим Buffer — копия одна.
  const buffer = await readFile(absolutePathFor(found.path));
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': contentTypeForPath(found.path),
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  });
}
