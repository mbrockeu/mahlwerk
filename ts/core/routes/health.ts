import { route } from '../http.ts';
import { VERSION } from '../version.ts';

export const routes = [
  route('GET', '/healthz', async () => ({ status: 'ok', version: VERSION }), { auth: false }),
];
