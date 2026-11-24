// All routes, one file per group (like src/mahlwerk/routes/). A group exports `routes: Route[]`; add it here.
import type { Route } from '../http.ts';
import { routes as health } from './health.ts';

export const ROUTES: Route[] = [...health];
