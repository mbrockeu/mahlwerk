// admin_models.py: WebhookIn, WebhookPatch (requests); Webhook, WebhookCreated, Delivery are plain objects of store/webhooks.ts.
import { z } from 'zod';
import { pyBool, pyStr } from './common.ts';

export const EVENTS = ['entry.created', 'entry.updated', 'entry.deleted', 'weight.recorded', 'water.changed',
  'fasting.started', 'fasting.ended', 'goal.changed', 'badge.earned', 'activity.recorded', 'workout.created'] as const;

// StringConstraints(strip_whitespace=True, min_length=1, max_length=80): stripped first, then measured
const name = () => z.string().transform((s) => s.trim()).pipe(pyStr(1, 80));
const events = () => z.array(z.enum(EVENTS)).min(1);

export const webhookIn = z.object({ name: name(), url: pyStr(0, 500), events: events(), enabled: pyBool().default(true) });
export const webhookPatch = z.object({
  name: name().nullish(), url: pyStr(0, 500).nullish(), events: events().nullish(), enabled: pyBool().nullish(),
});
