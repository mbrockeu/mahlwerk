// Entry of the app build (`npm run build:app` -> web/dist-app): the same interface, but the API is answered in the page by the app
// host (ts/app, the core of the server) with the data on the device, reached over the native bridge of the iOS app
// (`window.webkit.messageHandlers.mahlwerkNative`, see ts/PORTING.md "App-Host"). Sets `window.mahlwerkLocal`, then starts the app.
import schemaSql from '../../ts/core/schema.sql?raw';
import { hostRequest, localFetch, openLocal } from '../../ts/app/localHost.ts';

type Handler = { postMessage(msg: unknown): Promise<unknown> };
const native = (window as { webkit?: { messageHandlers?: { mahlwerkNative?: Handler } } }).webkit?.messageHandlers?.mahlwerkNative;

try {
  if (!native) throw new Error('the native bridge (mahlwerkNative) is missing');
  const { dispatch } = await openLocal({ bridge: (msg) => native.postMessage(msg), schemaSql });
  (window as { mahlwerkLocal?: unknown }).mahlwerkLocal = localFetch(dispatch);
  // for the native side: Health sync, history, summary/today, the widget's water button (ts/PORTING.md "App-Host")
  (window as { mahlwerkHost?: unknown }).mahlwerkHost = { request: hostRequest(dispatch) };
  document.getElementById('boot')?.remove(); // the loading note of index.html (app build): the interface takes over
  await import('./main');
} catch (e) {
  // no interface without the data: say why instead of a blank page (the database may have another schema version)
  const box = document.getElementById('app')!;
  box.textContent = `Mahlwerk cannot start: ${e instanceof Error ? e.message : String(e)}`;
  box.setAttribute('role', 'alert');
  console.error(e);
}
