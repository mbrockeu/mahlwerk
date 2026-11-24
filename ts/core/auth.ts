// Who is calling (auth.py). For now only `single` mode; proxy, local, oidc and access tokens follow in package 2c.
import { HttpError, type Req, type User } from './http.ts';
import { getOrCreateUser } from './store/users.ts';

export async function identify(req: Req): Promise<User> {
  const mode = (req.ctx.env.MAHLWERK_AUTH ?? 'single').trim().toLowerCase();
  if (mode === 'single') {
    const name = req.ctx.env.MAHLWERK_SINGLE_USER ?? 'me';
    const row = await getOrCreateUser(req.ctx, name, name);
    return { ...row, is_admin: true, via_token: false, household: true };
  }
  throw new HttpError(501, `auth mode ${mode} not ported yet`);
}
