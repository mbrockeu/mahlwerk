"""Who may change what is shared: members of the household (and admins) change everything; a guest only what they made.

`household` is on the user dict (see auth.py). The owner of a food, recipe or group is the user id in `created_by`; None means the
household owns it. Guests can read everything shared and create their own foods, recipes and groups."""

from fastapi import HTTPException

HOUSEHOLD_ONLY = "this belongs to the household: only members of the household may change it"
NOT_YOURS = "this was made by somebody else: guests may change only what they made themselves"


def is_household(user: dict) -> bool:
    return bool(user.get("household", True))


def can_edit(user: dict, owner: int | None) -> bool:
    return is_household(user) or (owner is not None and owner == user["id"])


def need_edit(user: dict, owner: int | None) -> None:
    """403 unless the user may change something owned by `owner`."""
    if not can_edit(user, owner):
        raise HTTPException(403, NOT_YOURS if owner is not None else HOUSEHOLD_ONLY)


def need_household(user: dict, what: str = "this") -> None:
    if not is_household(user):
        raise HTTPException(403, f"{what} is for members of the household only")
