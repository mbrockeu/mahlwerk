// The app build answers the API in the page itself: its entry (src/appMain.ts) sets `window.mahlwerkLocal`, a fetch-like function over
// the app host (ts/app). Everything that talks to the API asks here which way to go; in a normal browser nothing is set and the
// plain `fetch` is used, as before. No imports: the server bundle must not grow.

type LocalInit = { method?: string; headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal };
export type LocalFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: Blob | string | null }) => Promise<Response>;

export const localApi = (): LocalFetch | undefined => (globalThis as { mahlwerkLocal?: LocalFetch }).mahlwerkLocal;

/** `fetch`, or the app host when there is one. The local answer cannot be cancelled, but an aborted call rejects like fetch does. */
export function apiFetch(url: string, init: LocalInit): Promise<Response> {
  const local = localApi();
  if (!local) return fetch(url, init);
  const { signal, body, ...rest } = init;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
  const answer = local(url, { ...rest, body: body as Blob | string | null | undefined });
  if (!signal) return answer;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

const pictures = new Map<string, Promise<string | null>>();

/** Svelte action for a recipe picture in the app: the bytes come from the app host and are shown as an object URL; a missing picture
 * fires `error` on the image, like a failed load (the components then show the initial). Does nothing in a normal browser. */
export function localImage(node: HTMLImageElement, url: string) {
  const local = localApi();
  if (!local) return {};
  let current = url;
  const load = (u: string) => {
    let p = pictures.get(u);
    if (!p) {
      p = local(u).then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null)).catch(() => null);
      pictures.set(u, p);
    }
    void p.then((src) => {
      if (u !== current) return;
      if (src) node.src = src;
      else { pictures.delete(u); node.dispatchEvent(new Event('error')); }
    });
  };
  load(url);
  return { update(u: string) { current = u; load(u); } };
}

/** A download of an API address in the app (the data export): fetched from the app host, saved under the name the answer gives. */
export async function localDownload(url: string): Promise<void> {
  const r = await apiFetch(url, { method: 'GET', headers: { 'X-Mahlwerk-Request': '1' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const name = /filename="?([^";]+)"?/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'mahlwerk-export.zip';
  const href = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
