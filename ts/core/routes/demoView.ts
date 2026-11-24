// Switching an admin to the built-in demo account and back (routes/demo_view.py, see demoAccount.ts). Both endpoints work with the REAL
// identity (`realUser`): a session or proxy/single sign-in, never an access token. The CSRF header is required like for every write.
// Only an admin may switch, and only to the demo account: there is no way to name another user here.
import { clearDemoCookie, cookieKey, realUser, setDemoCookie } from '../auth.ts';
import { today } from '../dates.ts';
import * as demoAccount from '../demoAccount.ts';
import { featureOn } from '../features.ts';
import { HttpError, outOf, route, type Route } from '../http.ts';

export const routes: Route[] = [
  // Switch this browser to the demo account (12 hours at most). The sample data is topped up to today first.
  route('POST', '/api/v1/me/demo-view/enter', async (req) => {
    const user = await realUser(req);
    const { ctx } = req;
    if (!user.is_admin) throw new HttpError(403, 'admin only');
    if (!(await featureOn(ctx, 'demo_account.enabled'))) throw new HttpError(404, 'the demo account is switched off');
    try {
      await demoAccount.provision(ctx.db, today()); // makes it when only the environment switched it on, and fills it up to today
    } catch (e) {
      if (e instanceof demoAccount.DemoAccountError) throw new HttpError(409, e.message);
      throw e;
    }
    outOf(req).headers[demoAccount.VIEW_HEADER] = 'demo';
    setDemoCookie(req, await demoAccount.seal(await cookieKey(ctx, demoAccount.KEY_NAME), user.id, user.session_hash, ctx.now()));
    return { can_switch: false, viewing: true, real_username: user.username, real_display_name: user.display_name };
  }, { auth: false }),

  // Back to the own account. Always works for a signed-in caller, whatever the state of the demo account.
  route('POST', '/api/v1/me/demo-view/leave', async (req) => {
    await realUser(req);
    outOf(req).headers[demoAccount.VIEW_HEADER] = 'own';
    clearDemoCookie(req);
    return undefined;
  }, { auth: false, status: 204 }),
];
