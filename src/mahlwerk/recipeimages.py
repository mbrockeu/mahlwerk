"""Pictures of recipes: link a processed picture to a food, take it away, fetch a provider's picture once.

Three kinds of picture, one rule of precedence:
  * `own`: a photo a person set (camera or file). It always wins: a reload from Cookidoo or from the web page never replaces it.
  * `cookidoo` / `web`: fetched from the provider when the admin switched "store recipe pictures" on for that connector (default
    off), when a recipe is taken over, when a person asks for "Reload", and for Cookidoo by the catch-up run. A picture that is stored
    already for the SAME address is not fetched again unless the person explicitly reloads; every fetch counts against a brake. Never
    loaded by the browser: the browser only ever asks this server (the content security policy allows nothing else).
  * `none`: a person took the provider's picture away; a reload does not bring it back (only "restore" does).
  * `failed`: the last try to fetch the picture failed; the catch-up leaves such a recipe alone for 7 days.

The provider's address is controlled by the provider (Cookidoo's answer, a web page), so it is fetched with the same hardened
fetcher as web pages (public addresses only, pinned connection, redirects checked, own hosts blocked, time and size limits,
JPEG/PNG/WebP only) and then decoded in a limited child process (imageproc.py). A picture that fails for any reason is simply not
there: taking over a recipe never fails because of its picture.
"""

import logging

from . import imageproc, webrecipes
from .db import Store
from .imageproc import ImageRejected
from .imagestore import ImageStore, StoreError

log = logging.getLogger("mahlwerk.images")

ORIGINS = ("own", "cookidoo", "web")
FAILED_SKIP_SECONDS = 7 * 86400


class RecipeImages:
    def __init__(self, store: Store, files: ImageStore):
        self.store, self.files = store, files

    # ---- linking ----

    def attach(self, food_id: int, data: bytes, origin: str, url: str | None = None) -> str | None:
        """Process `data` and make it the picture of the food. Raises ImageRejected, StoreFull or LookupError (unknown food).
        A provider's picture is dropped (None) when, meanwhile, somebody set an own photo or took the picture away."""
        processed = imageproc.process(data)  # outside the lock: this takes a moment
        with self.files.lock:
            if origin != "own" and not self.wants(food_id):  # checked again under the lock: an own photo set during the fetch wins
                return None
            self.files.put(processed)
            before = self.store.set_food_image(food_id, processed.hash, origin, url)
            if before is False:  # the food is gone: nothing refers to the new files then
                if self.store.image_refs(processed.hash) == 0:
                    self.files.delete(processed.hash)
                raise LookupError(food_id)
            self._release(before, keep=processed.hash)
            self._maybe_sweep()
        return processed.hash

    def remove(self, food_id: int, mark: bool = False) -> bool:
        """Take the picture away. `mark`: say that a person did it to a provider's picture (a reload does not bring it back)."""
        with self.files.lock:
            row = self.store.get_food(food_id)
            if row is None:
                return False
            marker = "none" if mark and row.get("image_origin") in ("cookidoo", "web") else None
            before = self.store.clear_food_image(food_id, marker)
            self._release(before)
            self._maybe_sweep()
        return True

    def restore(self, food_id: int) -> bool:
        """Lift the "taken away" marker of a provider's picture (the caller then reloads the recipe, which fetches it). False when there is none."""
        with self.files.lock:
            row = self.store.get_food(food_id)
            if row is None or row.get("image_origin") != "none":
                return False
            self.store.clear_food_image(food_id, None)
        return True

    def release_food(self, digest: str | None) -> None:
        """After a food was deleted: its picture goes too when nothing else uses it."""
        with self.files.lock:
            self._release(digest)

    def _release(self, digest: str | None, keep: str | None = None) -> None:
        if digest and digest != keep and self.store.image_refs(digest) == 0:
            self.files.delete(digest)

    def sweep(self) -> int:
        """Files nothing refers to (bounded; only old ones): at start-up, after a mass deletion and, at most once a day, on a write."""
        with self.files.lock:
            return self.files.sweep(self.store.image_hashes())

    def _maybe_sweep(self) -> None:
        if self.files.sweep_due():
            self.sweep()

    # ---- the provider's picture ----

    def wants(self, food_id: int) -> bool:
        """A provider's picture may be stored for this food: nobody set an own one or took it away."""
        row = self.store.get_food(food_id)
        return row is not None and row.get("image_origin") not in ("own", "none")

    def fetch_provider(self, fetcher: webrecipes.Fetcher, food_id: int, url: str | None, origin: str, *, force: bool = False,
                       permit=None) -> bool:
        """Fetch the provider's picture at `url` and store it for the food. True when there is a picture now. Never raises.

        Not fetched again (True, no connection) when a picture of the same address is stored and `force` (an explicit reload) is not set.
        `permit` is asked before any connection (a brake, per person and for the server): False means "not now", nothing is marked."""
        if not url:
            return False
        row = self.store.get_food(food_id)
        if row is None or row.get("image_origin") in ("own", "none"):
            return False
        try:
            address = webrecipes.check_address(url)[0]
        except webrecipes.LinkRejected:
            return False
        if not force and row.get("image_hash") and row.get("image_url") == address:
            return True
        if permit is not None and not permit():
            return bool(row.get("image_hash"))
        try:
            page = fetcher.fetch_image(address)
            return self.attach(food_id, page.data, origin, address) is not None
        except webrecipes.FetchFailed as exc:
            log.info("recipe picture not fetched: %s", exc.kind)
        except ImageRejected as exc:
            log.info("recipe picture refused: %s", exc.kind)
        except StoreError as exc:
            log.warning("recipe pictures: %s", exc)
        except LookupError:
            return False
        except Exception as exc:  # noqa: BLE001 - a picture must never break taking a recipe over
            log.warning("recipe picture failed (%s)", type(exc).__name__)
        if not row.get("image_hash"):  # remember the failure (the catch-up skips such a recipe for a week); a picture it has stays
            self.store.clear_food_image(food_id, "failed")
        return bool(row.get("image_hash"))
