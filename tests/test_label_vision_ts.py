"""The TypeScript server reads a nutrition table with the image model (no OCR there); only runs with MAHLWERK_TS=1."""

import os

import pytest

from test_vision import app, configured, jpeg, model, person  # noqa: F401  (fixtures)

pytestmark = pytest.mark.skipif(os.environ.get("MAHLWERK_TS") != "1", reason="label reading by the image model is TS only")

TABLE = {"basis": "100g", "kcal": 539, "fat": 30.9, "saturated_fat": 10.6, "carbs": 57.5, "sugars": 56.3,
         "fiber": 0, "protein": 6.3, "salt": 0.107}


def scan(client):
    return client.post("/api/v1/label-scans", content=jpeg(), headers={"Content-Type": "image/jpeg"})


def test_the_label_is_read_by_the_model(app, configured, model):
    model.reply = TABLE
    r = scan(person(app))
    assert r.status_code == 200
    body = r.json()
    assert body["basis"] == "100g" and body["warnings"] == [] and body["text"] == ""
    assert body["per_100"]["kcal"] == 539 and body["per_100"]["salt"] == 0.1
    assert "per 100 g" in model.body()["messages"][0]["content"][0]["text"]
    assert model.sent_image()[:2] == b"\xff\xd8"


def test_switched_off_and_not_configured(app, model):
    assert scan(person(app)).status_code == 404 and not model.requests


def test_a_model_answer_without_a_table_is_a_neutral_error(app, configured, model):
    model.reply = "I cannot see a table."
    r = scan(person(app))
    assert r.status_code == 502 and "cannot" not in r.json()["detail"]
