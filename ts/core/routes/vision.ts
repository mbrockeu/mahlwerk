// Photo recognition: what a photo of a meal or of a recipe shows, asked of the image model the operator configured (routes/vision.py;
// vision.ts for the call).
//
// Only for people signed in the normal way (an access token is refused) and never for the demo account. Switched off: 404; not
// configured: 409. The photo is shrunk and made a clean JPEG first (no EXIF, no GPS position), sent to the model, and forgotten: nothing
// is stored, neither the photo nor the answer, and no log line holds anything of either. The result is a SUGGESTION made of checked
// fields: amounts and nutrition values are estimates the person reviews before anything is booked.
// Brakes: a number of photos per person and hour (MAHLWERK_VISION_PER_HOUR, default 30) and MAHLWERK_VISION_PARALLEL runs (default two)
// at the same time on the whole server; beyond them 429 with `Retry-After`.
import { z } from 'zod';
import { featureOn } from '../features.ts';
import { HttpError, parse, queryObject, route, type Req, type Route } from '../http.ts';
import { dimensions, MAX_PIXELS } from '../imagesize.ts';
import { forModel, ImageRejected, type ImageRunner } from '../imageproc.ts';
import * as vision from '../vision.ts';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BUSY_WAIT = 10;
const STATUS: Record<string, number> = { too_large: 413, too_many_pixels: 413, busy: 429, unavailable: 501, format: 422, broken: 422 };
const FAILURE: Record<string, number> = { timeout: 504, unavailable: 502, unusable: 502, busy: 429 };

/** The dependency of the router: a caller who signed in the normal way (an access token is refused). */
export const sessionUser = (req: Req) => { if (req.user!.via_token) throw new HttpError(403, 'not available with an access token'); };

const query = z.object({ lang: z.enum(['de', 'en']).default('en') });

export async function run(req: Req, kind: 'meal' | 'recipe' | 'label', lang: string) {
  const { ctx } = req;
  const user = req.user!;
  if (!(await featureOn(ctx, 'vision.enabled'))) throw new HttpError(404, 'photo recognition is switched off (admin area)');
  const settings = vision.settingsFromEnv(ctx.env);
  if (settings === null) throw new HttpError(409, 'photo recognition is not configured (MAHLWERK_VISION_URL and MAHLWERK_VISION_MODEL)');
  const image = req.body instanceof Uint8Array ? req.body : new Uint8Array();
  if (!image.length) throw new HttpError(422, 'empty body');
  if (image.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'image too large');
  const size = dimensions(image); // from the header: a small file can claim a huge picture
  if (size === null) throw new HttpError(422, 'the image must be a JPEG, PNG or WebP file');
  if (size[0] * size[1] > MAX_PIXELS) throw new HttpError(413, `image has too many pixels (at most ${Math.floor(MAX_PIXELS / 1_000_000)} megapixels)`);
  const brake = vision.brakeOf(ctx);
  if (!brake.slot()) throw new HttpError(429, 'photo recognition is busy, try again in a moment', { 'Retry-After': String(BUSY_WAIT) });
  try {
    const wait = brake.allow(user.id, vision.perHourFromEnv(ctx.env));
    if (wait) throw new HttpError(429, 'too many photos lately, try again later', { 'Retry-After': String(wait) });
    try {
      const runner = ctx.services.imageRunner as ImageRunner;
      const jpeg = await forModel(runner, image);
      try {
        return await vision.describe(ctx, settings, kind, lang, jpeg);
      } catch (e) {
        const second = vision.fallbackFromEnv(ctx.env);
        if (!(e instanceof vision.VisionError) || second === null || !vision.FALLBACK_ON.includes(e.kind)) throw e;
        console.warn(`image model failed (${e.kind}), asking the fallback`);
        return await vision.describe(ctx, second, kind, lang, jpeg);
      }
    } catch (e) {
      if (e instanceof ImageRejected) throw new HttpError(STATUS[e.kind] ?? 422, e.message, e.kind === 'busy' ? { 'Retry-After': '5' } : undefined);
      if (e instanceof vision.VisionError) {
        if (e.kind === 'busy') { // the model is busy: the person did nothing wrong, the photo does not count
          brake.refund(user.id);
          throw new HttpError(429, e.message, { 'Retry-After': String(e.retryAfter ?? BUSY_WAIT) });
        }
        throw new HttpError(FAILURE[e.kind]!, e.message);
      }
      throw e;
    }
  } finally {
    brake.release();
  }
}

export const routes: Route[] = [
  route('GET', '/api/v1/vision/status', async (req) => {
    sessionUser(req);
    const enabled = await featureOn(req.ctx, 'vision.enabled');
    const configured = vision.settingsFromEnv(req.ctx.env) !== null;
    return { enabled, configured, ready: enabled && configured, per_hour: vision.perHourFromEnv(req.ctx.env) };
  }),

  // Recognise the parts of a meal in a photo. Send the image as the request body (JPEG, PNG or WebP).
  route('POST', '/api/v1/vision/meal', async (req) => {
    sessionUser(req);
    return run(req, 'meal', parse(query, queryObject(req.query), 'query').lang);
  }),

  // Read name, portions and ingredient lines of a recipe in a photo (the method is not taken over). Send the image as the request body.
  route('POST', '/api/v1/vision/recipe', async (req) => {
    sessionUser(req);
    return run(req, 'recipe', parse(query, queryObject(req.query), 'query').lang);
  }),
];
