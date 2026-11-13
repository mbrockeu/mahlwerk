// The public demo (built with VITE_DEMO=1, see scripts/build-site.sh): the real interface on the in-memory mock,
// no server. In a normal build VITE_DEMO is undefined, so this is false and the demo code is not reached.
export const DEMO = !!import.meta.env.VITE_DEMO;
/** A barcode the mock knows (Haferflocken); mirrors gtin('400100000010') in mock.ts. */
export const DEMO_SAMPLE_CODE = '4001000000102';
