// All routes, one file per group (like src/mahlwerk/routes/). A group exports `routes: Route[]`; add it here.
// The first route that matches wins: a fixed path must stand before a `{param}` path that would swallow it.
import type { Route } from '../http.ts';
import { routes as combos } from './combos.ts';
import { routes as diary } from './diary.ts';
import { routes as foods } from './foods.ts';
import { routes as health } from './health.ts';
import { routes as recipeGroups } from './recipeGroups.ts';
import { routes as recipes } from './recipes.ts';
import { routes as suggestions } from './suggestions.ts';
import { routes as templates } from './templates.ts';

export const ROUTES: Route[] = [...health, ...diary, ...combos, ...foods, ...templates, ...suggestions, ...recipes, ...recipeGroups];
