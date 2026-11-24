// All routes, one file per group (like src/mahlwerk/routes/). A group exports `routes: Route[]`; add it here.
import type { Route } from '../http.ts';
import { routes as activity } from './activity.ts';
import { routes as badges } from './badges.ts';
import { routes as body } from './body.ts';
import { routes as diary } from './diary.ts';
import { routes as exportRoutes } from './export.ts';
import { routes as fasting } from './fasting.ts';
import { routes as foods } from './foods.ts';
import { routes as health } from './health.ts';
import { routes as insights } from './insights.ts';
import { routes as nutrients } from './nutrients.ts';
import { routes as summary } from './summary.ts';
import { routes as water } from './water.ts';

export const ROUTES: Route[] = [
  ...health, ...diary, ...foods,
  ...insights, ...badges, ...water, ...fasting, ...nutrients, ...summary, ...activity, ...exportRoutes, ...body,
];
