from fastapi.testclient import TestClient

from mahlwerk.main import create_app


def test_no_web_dir_means_no_mount(client):
    assert client.get("/healthz").json()["status"] == "ok"
    assert client.get("/").status_code == 404


def test_single_page_app_fallback(monkeypatch, tmp_path):
    web = tmp_path / "dist"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<html>Mahlwerk app</html>")
    (web / "assets" / "app.js").write_text("console.log(1)")
    monkeypatch.setenv("MAHLWERK_WEB_DIR", str(web))
    (tmp_path / "secret.txt").write_text("outside")
    client = TestClient(create_app(str(tmp_path / "w.db")))

    assert "Mahlwerk app" in client.get("/").text
    assert "Mahlwerk app" in client.get("/diary/2025-01-01").text
    assert client.get("/assets/app.js").text == "console.log(1)"
    assert "Mahlwerk app" in client.get("/%2e%2e/secret.txt").text  # no escape from the directory

    assert client.get("/healthz").json()["status"] == "ok"
    missing = client.get("/api/v1/nothing")
    assert missing.status_code == 404 and missing.json() == {"detail": "Not Found"}
    assert client.get("/api/v1/me").json()["username"] == "me"
