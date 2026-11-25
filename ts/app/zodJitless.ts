// Imported FIRST by the app's entry (frontend/src/appMain.ts), before any module that builds zod schemas: zod would probe
// `new Function` for its faster parser, which the app's Content-Security-Policy refuses (a console message on every start).
import { z } from 'zod';

z.config({ jitless: true });
