// All routes, one file per group (like src/mahlwerk/routes/). A group exports `routes: Route[]`; add it here.
import type { Route } from '../http.ts';
import { routes as admin } from './admin.ts';
import { routes as auth } from './auth.ts';
import { routes as demoView } from './demoView.ts';
import { routes as diary } from './diary.ts';
import { routes as foods } from './foods.ts';
import { routes as health } from './health.ts';
import { routes as oidc } from './oidc.ts';
import { routes as profile } from './profile.ts';
import { routes as tokens } from './tokens.ts';

export const ROUTES: Route[] = [...health, ...auth, ...oidc, ...demoView, ...profile, ...diary, ...foods, ...tokens, ...admin];
