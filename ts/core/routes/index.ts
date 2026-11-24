// All routes, one file per group (like src/mahlwerk/routes/). A group exports `routes: Route[]`; add it here.
// The first route that matches wins: a fixed path must stand before a `{param}` path that would swallow it.
import type { Route } from '../http.ts';
import { routes as activity } from './activity.ts';
import { routes as admin } from './admin.ts';
import { routes as auth } from './auth.ts';
import { routes as badges } from './badges.ts';
import { routes as body } from './body.ts';
import { routes as catalog } from './catalog.ts';
import { routes as combos } from './combos.ts';
import { routes as cookidoo } from './cookidoo.ts';
import { routes as demoView } from './demoView.ts';
import { routes as diary } from './diary.ts';
import { routes as exportRoutes } from './export.ts';
import { routes as fasting } from './fasting.ts';
import { routes as foods } from './foods.ts';
import { routes as health } from './health.ts';
import { routes as images } from './images.ts';
import { routes as insights } from './insights.ts';
import { routes as labelScans } from './labelScans.ts';
import { routes as nutrients } from './nutrients.ts';
import { routes as oidc } from './oidc.ts';
import { routes as profile } from './profile.ts';
import { routes as recipeGroups } from './recipeGroups.ts';
import { routes as recipes } from './recipes.ts';
import { routes as suggestions } from './suggestions.ts';
import { routes as summary } from './summary.ts';
import { routes as templates } from './templates.ts';
import { routes as tokens } from './tokens.ts';
import { routes as vision } from './vision.ts';
import { routes as water } from './water.ts';
import { routes as webhooks } from './webhooks.ts';
import { routes as webRecipes } from './webRecipes.ts';

export const ROUTES: Route[] = [
  ...health, ...auth, ...oidc, ...demoView, ...profile, ...tokens, ...admin,
  ...catalog, ...diary, ...combos, ...foods, ...templates, ...suggestions, ...recipes, ...recipeGroups,
  ...insights, ...badges, ...water, ...fasting, ...nutrients, ...summary, ...activity, ...exportRoutes, ...body,
  ...images, ...labelScans, ...vision, ...webhooks, ...webRecipes, ...cookidoo,
];
