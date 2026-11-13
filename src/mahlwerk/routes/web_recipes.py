"""Recipes from web pages: preview and take over (see webrecipes.py for what is read, what is kept and how the fetch is guarded).

For signed-in people only (an access token is refused). Switched off: 404. Every network problem on the way is the same
502 with the same text; a bad address is 422; the brake is 429.
"""

import logging
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import webrecipes
from ..auth import session_user
from ..db import Store
from ..deps import get_store
from ..models import Food
from .foods import build_food

log = logging.getLogger("mahlwerk.webrecipes")


def need_web_recipes(request: Request) -> None:
    if not request.app.state.features.web_recipes:
        raise HTTPException(404, "the connector for recipes from web pages is switched off (admin area)")


router = APIRouter(prefix="/api/v1/web-recipes", dependencies=[Depends(session_user), Depends(need_web_recipes)])

BLOCKED = {
    "no_name": "the recipe needs a name",
    "no_energy": "the page gives no energy value (kcal) for this recipe, so it is not taken over (it would count as 0 kcal)",
    "too_high": "the energy value per portion is not plausible (more than 5000 kcal): check the portions or whether the values are for the whole recipe",
    "whole_needs_portions": "the number of portions is needed to divide the values of the whole recipe",
}


class PreviewIn(BaseModel):
    url: str = Field(min_length=1, max_length=2000, description="the address of the recipe page (http or https, a public website)")
    whole: bool = Field(False, description="the values on the page are for the whole recipe: they are divided by the portions")
    portions: float | None = Field(None, gt=0, le=webrecipes.MAX_PORTIONS, description="the person's own number of portions (else the page's)")
    name: str | None = Field(None, max_length=400, description="the person's own name (else the page's)")


class AdoptIn(PreviewIn):
    refresh: bool = Field(False, description="fetch the page again even if it was fetched a few minutes ago")
    group_id: int | None = Field(None, description="put the recipe into this group")


class WebPreview(BaseModel):
    url: str = Field(description="the normalised address (tracking parameters and fragment removed)")
    host: str = Field(description="the provider as shown: the host without www.")
    name: str
    portions: float | None
    page_portions: float | None = Field(description="what the page says; `portions` is the person's number when given")
    per_portion: dict[str, float | None] = Field(description="kcal, fat, saturated_fat, carbs, sugars, fiber, protein, salt per portion")
    extra: dict[str, float] = Field(description="further values per portion (sodium in mg)")
    complete: bool = Field(description="kcal, fat, carbs and protein are all present")
    whole: bool
    serving_size: str
    ingredients: list[str] = Field(description="the ingredient lines of the page, for the person to look at; never stored")
    warnings: list[str] = Field(description="no_portions, portions_range, energy_mismatch, maybe_whole, maybe_per_100, rounded_off")
    blocked: str | None = Field(description="why it cannot be taken over: no_name, no_energy, too_high, whole_needs_portions")
    food_id: int | None = Field(description="the food it already is on this server, if it was taken over before")


def _load(request: Request, user: dict, url: str, refresh: bool) -> tuple[str, "webrecipes.Parsed", str]:
    """(address as given, what the page said, address of the page that answered). From the cache or from one fetch."""
    try:
        address, _, _ = webrecipes.check_address(url)
    except webrecipes.LinkRejected:
        raise HTTPException(422, "this is not a web address that can be fetched (an http or https address of a public website, standard port)") from None
    # a name that is the server's own (or listed by the admin) is refused like an internal target: same text, nothing contacted
    if webrecipes.is_blocked(urlsplit(address).hostname or "", request.app.state.web_fetcher.blocked()):
        raise HTTPException(502, webrecipes.NEUTRAL)
    key = address  # with the scheme: what http answers must never be shown for https
    cache: webrecipes.Cache = request.app.state.web_cache
    if refresh:
        cache.drop(key)
    elif (hit := cache.get(key)) is not None:
        parsed, final = hit
        if parsed is None:
            raise HTTPException(422, "no recipe data found on this page")
        return address, parsed, final
    brake: webrecipes.Brake = request.app.state.web_brake
    if not brake.slot():  # first the slot: a fetch that could not even start is not counted against the person
        raise HTTPException(429, "the server is fetching other pages right now, try again in a moment", headers={"Retry-After": "5"})
    try:
        wait = brake.allow(user["id"])
        if wait:
            raise HTTPException(429, "too many pages fetched lately, try again in a few minutes", headers={"Retry-After": str(wait)})
        page = request.app.state.web_fetcher.fetch(address)
    except webrecipes.FetchFailed as exc:
        log.info("web recipe fetch failed: %s", exc.kind)
        if exc.kind == "not_html":
            raise HTTPException(422, "the address is not a web page (HTML)") from None
        if exc.kind == "too_large":
            raise HTTPException(422, "the page is too large") from None
        raise HTTPException(502, webrecipes.NEUTRAL) from None
    finally:
        brake.release()
    try:
        parsed = webrecipes.parse_page(page.text)
    except (ValueError, OverflowError, RecursionError, LookupError, UnicodeError):  # whatever a page does to the reader: no recipe, no 500
        parsed = None
    cache.put(key, parsed, page.url)
    if parsed is None:
        raise HTTPException(422, "no recipe data found on this page")
    return address, parsed, page.url


def _preview(store: Store, address: str, final: str, parsed: "webrecipes.Parsed", body: PreviewIn) -> WebPreview:
    item = webrecipes.interpret(parsed, whole=body.whole, portions=body.portions, name=body.name)
    known = store.get_food_by_external_id(webrecipes.external_id(address))
    return WebPreview(
        url=address, host=webrecipes.host_label(final), name=item.name, portions=item.portions, page_portions=parsed.portions,
        per_portion=item.per_portion, extra=item.extra, complete=item.complete, whole=body.whole, serving_size=parsed.serving_size,
        ingredients=parsed.ingredients, warnings=item.warnings, blocked=item.blocked, food_id=known["id"] if known else None,
    )


@router.post("/preview", response_model=WebPreview)
def preview(body: PreviewIn, request: Request, store: Store = Depends(get_store), user: dict = Depends(session_user)) -> WebPreview:
    """Fetch the page (once per few minutes and address) and show what would be taken over. Saves nothing. A POST, because it makes the server open a connection."""
    address, parsed, final = _load(request, user, body.url, False)
    return _preview(store, address, final, parsed, body)


def _save(request: Request, store: Store, user: dict, address: str, final: str, parsed: "webrecipes.Parsed", body: PreviewIn, group_id: int | None,
          force: bool = False) -> Food:
    item = webrecipes.interpret(parsed, whole=body.whole, portions=body.portions, name=body.name)
    if item.blocked:
        raise HTTPException(422, BLOCKED[item.blocked])
    if group_id is not None and store.get_group(group_id) is None:
        raise HTTPException(404, "unknown group")
    data = {**webrecipes.food_data(item, address, final), "whole": body.whole}
    external = webrecipes.external_id(address)
    known = store.get_food_by_external_id(external)
    if known is not None and address.startswith("http://") and str((known["data"] or {}).get("url", "")).startswith("https://"):
        # http and https of one page are ONE recipe, but an http address must not quietly replace one taken over through https
        raise HTTPException(422, "this page was taken over with its https address: use that address")
    if known is not None:
        fetched_at = store.update_food(known["id"], webrecipes.SOURCE, data)
        food_id, row = known["id"], {**known, "source": webrecipes.SOURCE, "data": data, "fetched_at": fetched_at}
    else:
        food_id, fetched_at = store.put_external_food(external, webrecipes.SOURCE, data)
        row = {"id": food_id, "code": None, "source": webrecipes.SOURCE, "data": data, "fetched_at": fetched_at, "external_id": external}
    if group_id is not None:
        store.add_to_group(group_id, [food_id])
    _picture(request, store, food_id, webrecipes.image_address(parsed.image, final), user, force)
    return build_food(store.get_food(food_id) or row)


def _picture(request: Request, store: Store, food_id: int, url: str | None, user: dict, force: bool) -> None:
    """When the admin switched pictures on for web recipes, fetch the picture the page named, with the same guarded fetch as the page. It
    counts as a fetch of the brake (per person and for the server) and takes a slot. A picture that is stored already for the same address
    is not fetched again unless `force` (an explicit reload). Best effort: never makes taking the recipe over fail; a picture somebody set
    or took away is left alone. Nothing is remembered about the address while the switch is off."""
    if not url or not request.app.state.features.web_images:
        return
    brake: webrecipes.Brake = request.app.state.web_brake
    if not brake.slot():
        return
    try:
        request.app.state.images.fetch_provider(request.app.state.web_fetcher, food_id, url, webrecipes.SOURCE, force=force,
                                                permit=lambda: brake.allow(user["id"]) == 0)
    finally:
        brake.release()


@router.post("", response_model=Food)
def adopt(body: AdoptIn, request: Request, store: Store = Depends(get_store), user: dict = Depends(session_user)) -> Food:
    """Take the recipe over as a food (source `web`, external id `web:<host><path>`). The address is the identity: doing it again
    (also with other tracking parameters) updates the same food. The values of one portion are stored as 100 g of the food, so
    100 g = 1 portion when logging; the food belongs to the household."""
    address, parsed, final = _load(request, user, body.url, body.refresh)
    return _save(request, store, user, address, final, parsed, body, body.group_id, body.refresh)


@router.post("/{food_id}/reload", response_model=Food)
def reload(food_id: int, request: Request, store: Store = Depends(get_store), user: dict = Depends(session_user)) -> Food:
    """Fetch the page of a taken-over recipe again. The values are renewed; the name and the number of portions the person
    set stay (and "values for the whole recipe", if that was said)."""
    row = store.get_food(food_id)
    if row is None or not row["found"] or row["source"] != webrecipes.SOURCE:
        raise HTTPException(404, "unknown web recipe")
    data = row["data"]
    address = webrecipes.safe_link(data.get("url"))
    if address is None:
        raise HTTPException(422, "this recipe has no usable address")
    address, parsed, final = _load(request, user, address, True)
    body = PreviewIn(url=address, whole=bool(data.get("whole")), portions=data.get("portions"), name=data.get("name"))
    return _save(request, store, user, address, final, parsed, body, None, True)
