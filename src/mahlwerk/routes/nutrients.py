"""The directory of additional nutrients (see nutrients.py)."""

from fastapi import APIRouter, Depends

from .. import nutrients
from ..auth import current_user
from ..models import NutrientInfo

router = APIRouter(prefix="/api/v1", dependencies=[Depends(current_user)])


@router.get("/nutrients", response_model=list[NutrientInfo])
def list_nutrients() -> list[dict]:
    """Key, group, unit and EU reference intake of every additional nutrient; names are the client's business."""
    return nutrients.directory()
