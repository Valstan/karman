import { requireUser } from '@/lib/auth/current-user';
import { getOwnProfile } from '@/lib/services/profile';
import { ProfileForm } from '@/components/app/profile-form';

export default async function ProfilePage() {
  const user = await requireUser();
  const profile = await getOwnProfile(user);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Мои данные</h1>
        <p className="text-sm text-muted-foreground">
          То, что постоянно спрашивают: реквизиты, прописка, работа. Видите их только вы —
          пока сами не откроете их родне в Круге.
        </p>
      </div>
      <ProfileForm profile={profile} />
    </div>
  );
}
