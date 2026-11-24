// Label scans (routes/foods.py: label_scan). The OCR (rapidocr) is not part of the TypeScript server: it behaves like the Python app
// without the optional package, which answers 501 for every sign-in (the route is there so that 401 still comes first without one).
import { HttpError, route, type Route } from '../http.ts';

export const routes: Route[] = [
  route('POST', '/api/v1/label-scans', async () => {
    throw new HttpError(501, 'label reading is not installed (pip install mahlwerk[label])');
  }),
];
