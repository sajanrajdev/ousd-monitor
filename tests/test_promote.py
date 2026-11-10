"""scripts/promote.mjs, against a stand-in for the Vercel API on localhost."""

import json
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

REPO = Path(__file__).resolve().parent.parent
NODE = shutil.which("node") or "node"
TOKEN = "vercel-secret-token-444"
ENV = {"VERCEL_TOKEN": TOKEN, "VERCEL_ORG_ID": "team_org555", "VERCEL_PROJECT_ID": "prj_project666"}
PREVIEW = "https://ousd-monitor-abc123.vercel.app"


class FakeVercel:
    """Answers the three calls the script makes, from `state`, and records each request."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.preview = {
            "id": "dpl_preview",
            "name": "ousd-monitor",
            "projectId": ENV["VERCEL_PROJECT_ID"],
            "target": None,
            "readyState": "READY",
        }
        self.made = {"id": "dpl_prod", "target": "production", "readyState": "INITIALIZING"}
        self.final = {
            "readyState": "READY",
            "target": "production",
            "url": "ousd-monitor-prod789.vercel.app",
        }
        self.refuse_post = False
        self.url = ""

    def handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, status: int, body: dict) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _record(self, body=None) -> str:
                parsed = urlparse(self.path)
                fake.requests.append(
                    {
                        "method": self.command,
                        "path": parsed.path,
                        "query": parse_qs(parsed.query),
                        "auth": self.headers.get("Authorization"),
                        "body": body,
                    }
                )
                return parsed.path

            def do_GET(self):
                path = self._record()
                if path == "/v13/deployments/ousd-monitor-abc123.vercel.app":
                    self._reply(200, fake.preview)
                elif path == "/v13/deployments/dpl_prod":
                    self._reply(200, fake.final)
                else:
                    self._reply(404, {"error": {"message": "Not found"}})

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                self._record(json.loads(self.rfile.read(length) or b"{}"))
                if fake.refuse_post:
                    self._reply(403, {"error": {"message": "Not allowed"}})
                else:
                    self._reply(200, fake.made)

        return Handler


@pytest.fixture
def vercel():
    fake = FakeVercel()
    server = ThreadingHTTPServer(("127.0.0.1", 0), fake.handler())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield fake
    server.shutdown()


def promote(vercel: FakeVercel, *args: str, **extra: str) -> subprocess.CompletedProcess:
    env = {"PATH": "/usr/bin:/bin", "VERCEL_API_URL": vercel.url, **ENV, **extra}
    env = {key: value for key, value in env.items() if value != "<unset>"}
    return subprocess.run(
        [NODE, str(REPO / "scripts" / "promote.mjs"), *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )


def test_promotes_a_ready_preview_and_prints_the_production_url(vercel):
    result = promote(vercel, PREVIEW)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "https://ousd-monitor-prod789.vercel.app"
    post = next(r for r in vercel.requests if r["method"] == "POST")
    assert post["body"] == {
        "name": "ousd-monitor",
        "deploymentId": "dpl_preview",
        "project": ENV["VERCEL_PROJECT_ID"],
        "target": "production",
    }
    assert all(r["auth"] == f"Bearer {TOKEN}" for r in vercel.requests)
    assert all(r["query"]["teamId"] == [ENV["VERCEL_ORG_ID"]] for r in vercel.requests)
    assert TOKEN not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ({"projectId": "prj_other"}, "is not a deployment of this project"),
        ({"target": "production"}, "is already a production deployment"),
        ({"readyState": "BUILDING"}, "is BUILDING, not READY"),
    ],
)
def test_refuses_a_preview_it_should_not_promote(vercel, change, reason):
    vercel.preview.update(change)
    result = promote(vercel, PREVIEW)
    assert result.returncode == 1
    assert reason in result.stderr
    assert not [r for r in vercel.requests if r["method"] == "POST"]


def test_a_refused_call_names_the_status_and_reason(vercel):
    vercel.refuse_post = True
    result = promote(vercel, PREVIEW)
    assert result.returncode == 1
    assert "403 Not allowed" in result.stderr
    assert TOKEN not in result.stdout + result.stderr


def test_a_production_deployment_that_errors_fails(vercel):
    vercel.final = {"readyState": "ERROR", "target": "production", "url": "x.vercel.app"}
    result = promote(vercel, PREVIEW)
    assert result.returncode == 1
    assert "ended ERROR" in result.stderr


def test_a_ready_deployment_that_is_not_production_fails(vercel):
    vercel.final = {"readyState": "READY", "target": None, "url": "x.vercel.app"}
    result = promote(vercel, PREVIEW)
    assert result.returncode == 1
    assert "not production" in result.stderr


@pytest.mark.parametrize("missing", sorted(ENV))
def test_a_missing_variable_refuses_before_calling(vercel, missing):
    result = promote(vercel, PREVIEW, **{missing: "<unset>"})
    assert result.returncode == 1
    assert "must all be set" in result.stderr
    assert vercel.requests == []


def test_a_bare_host_works_like_a_url(vercel):
    assert promote(vercel, "ousd-monitor-abc123.vercel.app").returncode == 0
