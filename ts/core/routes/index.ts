// All routes, one file per group (like src/mahlwerk/routes/). A group exports `routes: Route[]`; add it here.
import type { Route } from '../http.ts';
import { routes as catalog } from './catalog.ts';
import { routes as diary } from './diary.ts';
import { routes as foods } from './foods.ts';
import { routes as health } from './health.ts';
import { routes as webhooks } from './webhooks.ts';

export const ROUTES: Route[] = [...health, ...catalog, ...diary, ...foods, ...webhooks];
