// Label scans (routes/foods.py: label_scan). The Python app reads the nutrition table with an OCR (rapidocr); here the image model of
// the photo recognition reads it (vision.ts, kind `label`), with the same answer shape {per_100, basis, warnings, text} and the same
// rules and brakes as the other photos (signed in the normal way, not the demo account, switched off 404, not configured 409).
import { route, type Route } from '../http.ts';
import { run, sessionUser } from './vision.ts';

export const routes: Route[] = [
  route('POST', '/api/v1/label-scans', async (req) => {
    sessionUser(req);
    return run(req, 'label', 'en');
  }),
];
