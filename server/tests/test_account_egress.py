"""Regression checks using temporary auth files and mocked Tencent responses."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
from server import config, security
from server.routers import accounts
from server.services import tencent


class AccountEgressTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.auth_dir = self.root / "auths"
        self.auth_dir.mkdir()
        self.config_file = self.root / "config.json"
        self.config_file.write_text(json.dumps({
            "proxies": {"route-hk": "socks5h://127.0.0.1:17890"}
        }))
        self.payload = {
            "account": {"uid": "example", "nickname": "Example"},
            "auth": {"accessToken": "test-access-token", "realm": "global"},
            "proxy": "route-hk",
        }
        self.account_file = self.auth_dir / "workbuddy-example.json"
        self.account_file.write_text(json.dumps(self.payload))
        for name, value in [("AUTH_DIR", self.auth_dir),
                            ("UPSTREAM_CONFIG", self.config_file),
                            ("DEFAULT_ACCOUNT_PROXY", "")]:
            patch = mock.patch.object(config, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        for name in ["global_http_proxy", "effective_http_proxy"]:
            patch = mock.patch.object(config, name, return_value="http://fallback.invalid:1")
            patch.start()
            self.addCleanup(patch.stop)
        app = FastAPI()
        app.include_router(accounts.router)
        app.dependency_overrides[security.current_user] = lambda: {"username": "test", "role": "admin"}
        app.dependency_overrides[security.require_admin] = lambda: {"username": "test", "role": "admin"}
        self.client = TestClient(app)

    def test_relogin_without_override_uses_bound_route(self):
        with mock.patch.object(accounts.tencent, "start_login", new_callable=mock.AsyncMock) as start:
            start.return_value = {"state": "", "authUrl": ""}
            response = self.client.post("/api/auth/start", json={"uid": "example", "realm": "cn"})
        self.assertEqual(response.status_code, 200, response.text)
        start.assert_awaited_once_with("global", "route-hk")
        self.assertEqual(response.json()["target"]["proxy"], "route-hk")

    def test_explicit_direct_overrides_existing_route(self):
        with mock.patch.object(accounts.tencent, "start_login", new_callable=mock.AsyncMock) as start:
            start.return_value = {"state": "", "authUrl": ""}
            response = self.client.post("/api/auth/start", json={"uid": "example", "proxy": "__direct__"})
        self.assertEqual(response.status_code, 200, response.text)
        start.assert_awaited_once_with("global", "__direct__")
        self.assertEqual(config.account_proxy({"proxy": "__direct__"}), "")

    def test_missing_bound_route_fails_before_network(self):
        self.config_file.write_text("{}")
        with mock.patch.object(accounts.tencent, "start_login", new_callable=mock.AsyncMock) as start:
            response = self.client.post("/api/auth/start", json={"uid": "example"})
        self.assertEqual(response.status_code, 400)
        start.assert_not_awaited()

    def test_selected_routes_survive_poll_write_and_renewal(self):
        for route in ["route-hk", "__direct__"]:
            with self.subTest(route=route):
                seen = []
                def reply(request):
                    seen.append(request.url.path)
                    data = {"accessToken": "test-access-token", "expiresIn": 3600} if request.url.path.endswith("/token") else {"uid": "example"}
                    return httpx.Response(200, json={"code": 0, "data": data})
                state = "test-account-egress-" + route
                tencent._state_cache[state] = (time.time(), "global", route)
                client = httpx.AsyncClient(transport=httpx.MockTransport(reply))
                with mock.patch.object(config, "http_client", return_value=client) as make_client:
                    result = asyncio.run(tencent.poll_login(state, "global"))
                expected = "" if route == "__direct__" else "socks5h://127.0.0.1:17890"
                make_client.assert_called_once_with(config.TENCENT_TIMEOUT, connect=5, proxy=expected)
                self.assertEqual(len(seen), 2)
                self.assertEqual(result["proxy"], route)
                tencent.write_auth_file(result)
                tencent.update_auth_tokens(self.account_file.name, {"access_token": "test-renewed-token"})
                self.assertEqual(json.loads(self.account_file.read_text())["proxy"], route)
                tencent.drop_state(state)


if __name__ == "__main__":
    unittest.main(verbosity=2)
