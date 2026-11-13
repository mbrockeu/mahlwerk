// Barcode scanning: the browser's BarcodeDetector when it reads EAN/UPC, otherwise the bundled
// zxing-wasm ponyfill from public/vendor. A code counts only when two consecutive frames agree.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const BASE = import.meta.env.BASE_URL;

interface Detector { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> }
export type Engine = 'native' | 'wasm';

export function validGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop() as number;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** UPC-A is EAN-13 with a leading zero. */
export const normalizeCode = (code: string) => (code.length === 12 ? `0${code}` : code);

function loadPonyfill(): Promise<any> {
  const w = window as any;
  if (w.BarcodeDetectionAPI) return Promise.resolve(w.BarcodeDetectionAPI);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${BASE}vendor/barcode-detector-ponyfill.js`;
    script.onload = () => resolve(w.BarcodeDetectionAPI);
    script.onerror = () => reject(new Error('detector'));
    document.head.append(script);
  });
}

let detectorPromise: Promise<{ detector: Detector; engine: Engine }> | null = null;

function makeDetector() {
  detectorPromise ??= (async () => {
    const forced = new URLSearchParams(location.search).get('engine');
    const w = window as any;
    if (forced !== 'wasm' && 'BarcodeDetector' in window) {
      try {
        const supported: string[] = await w.BarcodeDetector.getSupportedFormats();
        if (supported.includes('ean_13')) {
          return { engine: 'native' as Engine, detector: new w.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) }) };
        }
      } catch { /* fall through to the bundled detector */ }
    }
    const api = await loadPonyfill();
    // load the .wasm from our own server instead of a CDN
    api.prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? `${BASE}vendor/${path}` : prefix + path) },
      fireImmediately: true,
    });
    return { engine: 'wasm' as Engine, detector: new api.BarcodeDetector({ formats: FORMATS }) as Detector };
  })();
  detectorPromise.catch(() => { detectorPromise = null; });
  return detectorPromise;
}

export interface Scanner {
  start(): Promise<void>;
  /** Look for the next code (after a result was handled). */
  resume(delay?: number): void;
  stop(): void;
  hasTorch: boolean;
  hasZoom: boolean;
  setTorch(on: boolean): Promise<void>;
  setZoom(on: boolean): Promise<void>;
}

export function createScanner(video: HTMLVideoElement, onCode: (code: string, engine: Engine) => void): Scanner {
  let detector: Detector | null = null;
  let engine: Engine = 'wasm';
  let track: MediaStreamTrack | null = null;
  let scanning = false;
  let loopId = 0;
  let lastSeen: string | null = null;

  async function tick(id: number) {
    if (!scanning || id !== loopId) return;
    if (video.readyState >= 2 && detector) {
      try {
        const found = (await detector.detect(video)).map((c) => c.rawValue).find(validGtin);
        if (scanning && id === loopId && found && found === lastSeen) {
          scanning = false;
          onCode(normalizeCode(found), engine);
          return;
        }
        lastSeen = found || null;
      } catch { /* a single failed frame is not worth reporting */ }
    }
    setTimeout(() => tick(id), 60);
  }

  const scanner: Scanner = {
    hasTorch: false,
    hasZoom: false,
    async start() {
      const made = await makeDetector();
      detector = made.detector;
      engine = made.engine;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      video.srcObject = stream;
      await video.play();
      track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities ? track.getCapabilities() : {}) as any;
      scanner.hasZoom = !!(caps.zoom && caps.zoom.max >= 2);
      scanner.hasTorch = !!caps.torch;
      scanner.resume(0);
    },
    resume(delay = 0) {
      if (!track) return;
      lastSeen = null;
      scanning = true;
      loopId += 1;
      const id = loopId;
      setTimeout(() => tick(id), delay);
    },
    stop() {
      scanning = false;
      loopId += 1;
      track?.stop();
      track = null;
      video.srcObject = null;
    },
    async setTorch(on) { await track?.applyConstraints({ advanced: [{ torch: on } as any] }); },
    async setZoom(on) { await track?.applyConstraints({ advanced: [{ zoom: on ? 2 : 1 } as any] }); },
  };
  return scanner;
}
