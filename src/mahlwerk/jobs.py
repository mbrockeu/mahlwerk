"""Background work inside the service: the catalogue refresh started from the admin area (one at a time)."""

import logging
import threading
import time

import httpx

from . import __version__
from .catalog import OFF_URL, import_off

log = logging.getLogger("mahlwerk.jobs")
MAX_ERROR = 300


class CatalogRefresh:
    """Runs `import_off` in a thread. The import builds a new file and swaps it in atomically, so searches keep
    working while it runs and a failed import leaves the old catalogue alone. Failures end up in the state."""

    def __init__(self, catalog, features, contact: str = "no-contact-configured", source: str = OFF_URL):
        self.catalog = catalog
        self.features = features
        self.contact = contact
        self.source = source
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state: dict = {
            "state": "idle", "started_at": None, "finished_at": None, "progress": None,
            "countries": [], "result": None, "error": None,
        }

    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def start(self) -> bool:
        """Start a refresh; False when one is already running."""
        with self._lock:
            if self._state["state"] == "running":
                return False
            self._state = {
                "state": "running", "started_at": int(time.time()), "finished_at": None, "progress": None,
                "countries": list(self.features.countries), "result": None, "error": None,
            }
            countries = list(self._state["countries"])
            self._thread = threading.Thread(target=self._run, args=(countries,), name="mahlwerk-catalog", daemon=True)
            self._thread.start()
        return True

    def wait(self, timeout: float = 30.0) -> None:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def _progress(self, text: str) -> None:
        with self._lock:
            self._state["progress"] = text

    def _run(self, countries: list[str]) -> None:
        http = None
        try:
            if self.source.startswith(("http://", "https://")):
                http = httpx.Client(
                    timeout=httpx.Timeout(30, read=120), follow_redirects=True,
                    headers={"User-Agent": f"Mahlwerk/{__version__} ({self.contact})"},
                )
            stats = import_off(self.catalog.path, countries, self.source, http=http, progress=self._progress)
            result = {
                "rows_read": stats.read, "products": stats.kept, "seconds": round(stats.seconds, 1),
                "truncated": stats.truncated,
            }
            update = {"state": "done", "result": result, "error": None}
        except Exception as exc:  # the import reports its own problems; anything else must not crash the service
            log.warning("catalogue refresh failed: %s", type(exc).__name__)
            update = {"state": "error", "error": (str(exc) or type(exc).__name__)[:MAX_ERROR]}
        finally:
            if http is not None:
                http.close()
        with self._lock:
            self._state.update(update, finished_at=int(time.time()))
