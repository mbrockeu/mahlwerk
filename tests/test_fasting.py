import time

URL = "/api/v1/fasting"
HOUR = 3600


def now() -> int:
    return int(time.time())


def start(client, hours_ago=0.0, **body):
    return client.post(f"{URL}/start", json={"started_at": now() - int(hours_ago * HOUR), **body})


def test_nothing_running_at_first(client):
    assert client.get(URL).json() == {"current": None, "last": None, "recent": []}


def test_start_stop_and_history(client):
    r = start(client, 3, target_hours=12)
    assert r.status_code == 201
    fast = r.json()
    assert fast["ended_at"] is None and fast["duration_seconds"] is None
    assert fast["target_hours"] == 12 and 3 * HOUR <= fast["elapsed_seconds"] < 3 * HOUR + 5
    assert fast["target_reached"] is False
    state = client.get(URL).json()
    assert state["current"]["id"] == fast["id"] and state["last"] is None

    stopped = client.post(f"{URL}/stop", json={})
    assert stopped.status_code == 200
    done = stopped.json()
    assert done["id"] == fast["id"] and done["ended_at"] is not None
    assert done["duration_seconds"] == done["elapsed_seconds"] >= 3 * HOUR
    state = client.get(URL).json()
    assert state["current"] is None and state["last"]["id"] == fast["id"] and len(state["recent"]) == 1


def test_start_without_body_uses_now_and_the_setting(client):
    client.patch("/api/v1/me/settings", json={"fasting": {"target_hours": 18}})
    fast = client.post(f"{URL}/start").json()
    assert fast["target_hours"] == 18 and fast["elapsed_seconds"] < 5


def test_a_second_start_is_a_conflict_and_stop_needs_a_running_fast(client):
    assert client.post(f"{URL}/stop", json={}).status_code == 409
    assert start(client, 1).status_code == 201
    assert start(client, 2).status_code == 409
    client.post(f"{URL}/stop", json={})
    assert start(client, 0).status_code == 201  # possible again after stopping


def test_start_time_limits(client):
    assert start(client, -1).status_code == 422  # in the future
    assert start(client, 49).status_code == 422  # more than 48 h back
    assert start(client, 47.5).status_code == 201


def test_stop_time_limits(client):
    fast = start(client, 10).json()
    assert client.post(f"{URL}/stop", json={"ended_at": fast["started_at"] - 1}).status_code == 422
    assert client.post(f"{URL}/stop", json={"ended_at": now() + HOUR}).status_code == 422
    r = client.post(f"{URL}/stop", json={"ended_at": fast["started_at"] + 4 * HOUR})
    assert r.status_code == 200 and r.json()["duration_seconds"] == 4 * HOUR


def test_target_reached(client):
    start(client, 15.9, target_hours=16)
    assert client.get(URL).json()["current"]["target_reached"] is False
    fast = client.get(URL).json()["current"]
    base = now()  # one clock reading, so a second ticking over between the calls cannot change the duration
    client.patch(f"{URL}/{fast['id']}", json={"started_at": base - 17 * HOUR})
    assert client.get(URL).json()["current"]["target_reached"] is True
    done = client.post(f"{URL}/stop", json={"ended_at": base - 2 * HOUR}).json()  # 15 h of 16
    assert done["target_reached"] is False and done["duration_seconds"] == 15 * HOUR


def test_target_hours_are_limited(client):
    assert start(client, 1, target_hours=7).status_code == 422
    assert start(client, 1, target_hours=73).status_code == 422
    assert start(client, 1, target_hours=72).status_code == 201


def test_patch_corrects_times_and_target(client):
    fast = start(client, 5).json()
    r = client.patch(f"{URL}/{fast['id']}", json={"started_at": now() - 9 * HOUR, "target_hours": 20})
    assert r.status_code == 200 and r.json()["target_hours"] == 20 and r.json()["elapsed_seconds"] >= 9 * HOUR
    assert client.patch(f"{URL}/{fast['id']}", json={}).status_code == 422
    assert client.patch(f"{URL}/{fast['id']}", json={"started_at": now() + HOUR}).status_code == 422
    assert client.patch(f"{URL}/{fast['id']}", json={"ended_at": now() - 10 * HOUR}).status_code == 422  # before the start
    done = client.patch(f"{URL}/{fast['id']}", json={"ended_at": now() - HOUR}).json()  # finishes the open fast
    assert done["duration_seconds"] is not None and client.get(URL).json()["current"] is None
    later = client.patch(f"{URL}/{fast['id']}", json={"started_at": now() - 30 * HOUR}).json()  # no 48 h limit here
    assert later["duration_seconds"] >= 29 * HOUR - 5


def test_delete(client):
    fast = start(client, 2).json()
    assert client.delete(f"{URL}/{fast['id']}").status_code == 204
    assert client.get(URL).json()["current"] is None
    assert client.delete(f"{URL}/{fast['id']}").status_code == 404
    assert start(client, 1).status_code == 201


def test_recent_keeps_the_latest_14_finished_fasts_newest_first(client):
    ids = []
    for i in range(16):
        fast = start(client, 40 - i * 2).json()  # every fast stops before the next one starts
        client.post(f"{URL}/stop", json={"ended_at": fast["started_at"] + HOUR})
        ids.append(fast["id"])
    state = client.get(URL).json()
    assert [f["id"] for f in state["recent"]] == ids[::-1][:14]
    assert state["last"]["id"] == ids[-1]


def test_other_users_fasts_are_not_visible_and_not_changeable(duo):
    ann, ben = duo
    fast = start(ann, 3).json()
    assert ben.get(URL).json()["current"] is None
    assert ben.patch(f"{URL}/{fast['id']}", json={"target_hours": 20}).status_code == 404
    assert ben.delete(f"{URL}/{fast['id']}").status_code == 404
    assert start(ben, 1).status_code == 201  # each has their own open fast
    assert ann.get(URL).json()["current"]["id"] == fast["id"]
    assert ann.get(f"{URL}").json()["current"]["target_hours"] == 16


def test_settings_default_patch_and_validation(client):
    assert client.get("/api/v1/me").json()["settings"]["fasting"] == {"enabled": False, "target_hours": 16}
    r = client.patch("/api/v1/me/settings", json={"fasting": {"enabled": True}})
    assert r.json()["fasting"] == {"enabled": True, "target_hours": 16}
    r = client.patch("/api/v1/me/settings", json={"fasting": {"target_hours": 18.5}})
    assert r.json()["fasting"] == {"enabled": True, "target_hours": 18.5}  # only the given field changes
    assert client.get("/api/v1/me").json()["settings"]["fasting"]["enabled"] is True
    assert client.patch("/api/v1/me/settings", json={"fasting": {"target_hours": 7}}).status_code == 422
    assert client.patch("/api/v1/me/settings", json={"fasting": {"target_hours": 73}}).status_code == 422
    assert client.patch("/api/v1/me/settings", json={"playful": False}).json()["fasting"]["enabled"] is True
