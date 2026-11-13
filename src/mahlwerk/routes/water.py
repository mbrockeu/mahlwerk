"""Water drunk per day (one total per day)."""

from fastapi import APIRouter, Depends, Request

from ..auth import current_user
from ..db import MAX_WATER_ML, Store
from ..deps import get_store
from ..models import WaterAdd, WaterDay, WaterSet
from ..webhooks import emit
from .diary import parse_day

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])


def _out(store: Store, uid: int, ml: int) -> WaterDay:
    return WaterDay(ml=ml, goal_ml=(store.get_goal(uid) or {}).get("water_ml", 2000))


def _changed(request: Request, user: dict, day: str, water: WaterDay) -> WaterDay:
    emit(request, user, "water.changed", {"day": day, "ml": water.ml, "goal_ml": water.goal_ml})
    return water


@router.post("/water/{day}", response_model=WaterDay)
def add_water(day: str, body: WaterAdd, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> WaterDay:
    """Add or take back some ml; the total is kept between 0 and 10000 ml."""
    parse_day(day)
    return _changed(request, user, day, _out(store, user["id"], store.add_water(user["id"], day, body.add_ml)))


@router.put("/water/{day}", response_model=WaterDay)
def put_water(day: str, body: WaterSet, request: Request, user: dict = Depends(current_user), store: Store = Depends(get_store)) -> WaterDay:
    parse_day(day)
    return _changed(request, user, day, _out(store, user["id"], store.put_water(user["id"], day, min(body.ml, MAX_WATER_ML))))
