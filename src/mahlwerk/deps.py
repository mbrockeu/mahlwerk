from fastapi import Request

from .catalog import Catalog
from .db import Store


def get_store(request: Request) -> Store:
    return request.app.state.store


def get_catalog(request: Request) -> Catalog:
    return request.app.state.catalog
