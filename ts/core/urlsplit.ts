// Python's urllib.parse.urlsplit as far as the guards use it (scheme, host, port, user info). Deliberately not the WHATWG parser:
// the guards judge a URL the way the Python code did.
export interface Split { scheme: string; netloc: string; path: string; query: string; fragment: string;
  hostname: string | null; username: string | null; password: string | null; readonly port: number | null }

/** `.port` raises (like Python's ValueError) for text that is no number in 0..65535. */
export function urlsplit(input: string): Split {
  let url = input.replace(/^[\u0000- ]+/, '').replace(/[\t\r\n]/g, '');
  let scheme = '';
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (m) {
    scheme = m[1]!.toLowerCase();
    url = url.slice(m[0].length);
  }
  let netloc = '';
  if (url.startsWith('//')) {
    const end = url.slice(2).search(/[/?#]/);
    netloc = end === -1 ? url.slice(2) : url.slice(2, 2 + end);
    url = end === -1 ? '' : url.slice(2 + end);
  }
  if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) throw new Error('Invalid IPv6 URL');
  let fragment = '';
  let query = '';
  const hash = url.indexOf('#');
  if (hash !== -1) { fragment = url.slice(hash + 1); url = url.slice(0, hash); }
  const q = url.indexOf('?');
  if (q !== -1) { query = url.slice(q + 1); url = url.slice(0, q); }
  const at = netloc.lastIndexOf('@');
  const userinfo = at === -1 ? null : netloc.slice(0, at);
  const hostport = at === -1 ? netloc : netloc.slice(at + 1);
  let username: string | null = null;
  let password: string | null = null;
  if (userinfo !== null) {
    const c = userinfo.indexOf(':');
    username = c === -1 ? userinfo : userinfo.slice(0, c);
    password = c === -1 ? null : userinfo.slice(c + 1);
  }
  let host: string | null;
  let portText: string | null = null;
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    host = hostport.slice(1, close);
    const rest = hostport.slice(close + 1);
    if (rest.startsWith(':')) portText = rest.slice(1);
  } else {
    const c = hostport.indexOf(':');
    host = c === -1 ? hostport : hostport.slice(0, c);
    if (c !== -1) portText = hostport.slice(c + 1);
  }
  const hostname = host ? host.toLowerCase() : null;
  return {
    scheme, netloc, path: url, query, fragment, hostname, username, password,
    get port() { // computed when asked, like `.port` of Python (the parsing itself does not fail on a bad port)
      if (!portText) return null;
      if (!/^[0-9]+$/.test(portText) || Number(portText) > 65535) throw new Error('Port could not be cast to integer value');
      return Number(portText);
    },
  };
}
