"""Meal templates: a saved set of entries a user logs often, applied to a day and meal with one tap."""

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import current_user
from ..db import Store
from ..deps import get_store
from ..models import Entries, Template, TemplateApply, TemplateIn, TemplatePatch
from ..nutrition import r1, scale
from .diary import emit_entries, entries_out, parse_day, snapshot

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])


def template_out(row: dict) -> Template:
    items = []
    for item in row["items"]:
        kcal = scale(item["per_100"], item["amount"])["kcal"]
        items.append({
            "name": item["name"], "brand": item["brand"], "amount": item["amount"], "unit": item["unit"],
            "kcal": None if kcal is None else r1(kcal),
        })
    return Template(id=row["id"], name=row["name"], kcal=r1(sum(i["kcal"] or 0 for i in items)), items=items)


def _own(store: Store, user_id: int, template_id: int) -> dict:
    row = store.get_template(user_id, template_id)
    if row is None:
        raise HTTPException(404, "unknown template")
    return row


@router.get("/templates", response_model=list[Template])
def list_templates(user: dict = Depends(current_user), store: Store = Depends(get_store)) -> list[Template]:
    return [template_out(row) for row in store.list_templates(user["id"])]


@router.post("/templates", response_model=Template, status_code=201)
def create_template(body: TemplateIn, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> Template:
    """Save a logged meal of this user as a template."""
    parse_day(body.from_.day)
    rows = store.entries_on(user["id"], body.from_.day, body.from_.meal)
    if not rows:
        raise HTTPException(404, "that meal has no entries")
    template_id = store.create_template(user["id"], body.name, [snapshot(r) for r in rows])
    return template_out(store.get_template(user["id"], template_id))


@router.patch("/templates/{template_id}", response_model=Template)
def rename_template(
    template_id: int, body: TemplatePatch, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Template:
    _own(store, user["id"], template_id)
    store.rename_template(user["id"], template_id, body.name)
    return template_out(_own(store, user["id"], template_id))


@router.delete("/templates/{template_id}", status_code=204)
def delete_template(template_id: int, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> None:
    if not store.delete_template(user["id"], template_id):
        raise HTTPException(404, "unknown template")


@router.post("/templates/{template_id}/apply", response_model=Entries, status_code=201)
def apply_template(
    template_id: int, body: TemplateApply, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)
) -> Entries:
    parse_day(body.day)
    row = _own(store, user["id"], template_id)
    ids = store.add_entries(user["id"], body.day, [snapshot(i, body.meal) for i in row["items"]])
    emit_entries(request, store, user, [store.get_entry(user["id"], i) for i in ids])
    return entries_out(store, user["id"], ids)
