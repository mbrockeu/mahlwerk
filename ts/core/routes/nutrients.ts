// The directory of additional nutrients (routes/nutrients.py): key, group, unit and EU reference intake; names are the client's business.
import { route, type Route } from '../http.ts';
import { NUTRIENTS } from '../nutrients.ts';

export const routes: Route[] = [
  route('GET', '/api/v1/nutrients', async () => NUTRIENTS.map((n) => ({ key: n.key, group: n.group, unit: n.unit, nrv: n.nrv }))),
];
