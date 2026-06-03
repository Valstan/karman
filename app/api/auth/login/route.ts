import { NextResponse } from 'next/server';
import { or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { authUser } from '@/lib/db/schema';
import { verifyDjangoPassword } from '@/lib/auth/password';
import { setSessionCookie } from '@/lib/auth/session';
import { loginSchema } from '@/lib/validation/auth';

// pbkdf2 (Django-хеши) требует Node runtime.
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ message: 'Введите логин и пароль' }, { status: 400 });
  }

  const { username, password } = parsed.data;

  const rows = await db
    .select()
    .from(authUser)
    .where(
      or(
        sql`lower(${authUser.username}) = lower(${username})`,
        sql`lower(${authUser.email}) = lower(${username})`,
      ),
    )
    .orderBy(authUser.id)
    .limit(1);

  const user = rows[0];
  if (!user || !user.isActive || !verifyDjangoPassword(password, user.password)) {
    return NextResponse.json({ message: 'Неверный логин или пароль' }, { status: 401 });
  }

  await setSessionCookie(user.id);
  return NextResponse.json({
    user: { id: user.id, username: user.username, isSuperuser: user.isSuperuser },
  });
}
