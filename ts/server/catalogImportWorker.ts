// The worker thread of the catalogue refresh: runs the import and reports progress, the result or the error to the main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { importOff } from './catalogImport.ts';

const { dest, countries, source } = workerData as { dest: string; countries: string[]; source: string };
try {
  const stats = await importOff(dest, countries, source, (text) => parentPort!.postMessage({ progress: text }));
  parentPort!.postMessage({ done: stats });
} catch (e) {
  parentPort!.postMessage({ error: (e as Error).message || (e as Error).name });
}
