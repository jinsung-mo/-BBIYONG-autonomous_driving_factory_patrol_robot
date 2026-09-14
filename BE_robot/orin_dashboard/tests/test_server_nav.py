import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen

import server


class NavEndpointTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        server.NAV_LIVE_FILE = os.path.join(self.temp.name, "live.json")
        server.NAV_MAP_FILE = os.path.join(self.temp.name, "map.json")
        server.NAV_MAP_UPDATE_FILE = os.path.join(self.temp.name, "update.json")
        self.live = {
            "schema_version": "1.0",
            "t": 1,
            "map_sequence": 2,
            "pose": None,
            "scan": None,
        }
        self.snapshot = {
            "schema_version": "1.0",
            "kind": "snapshot",
            "sequence": 2,
            "w": 3,
            "h": 1,
            "res": 0.05,
            "ox": 0,
            "oy": 0,
            "encoding": "rle-v1",
            "cells": [-1, 1, 0, 1, 100, 1],
        }
        self.update = {
            "schema_version": "1.0",
            "kind": "patch",
            "base_sequence": 1,
            "sequence": 2,
            "encoding": "runs-v1",
            "changes": [1, 1, 0],
        }
        for path, value in (
            (server.NAV_LIVE_FILE, self.live),
            (server.NAV_MAP_FILE, self.snapshot),
            (server.NAV_MAP_UPDATE_FILE, self.update),
        ):
            with open(path, "w", encoding="utf-8") as file:
                json.dump(value, file)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.temp.cleanup()

    def get_json(self, path):
        with urlopen(self.base + path) as response:
            return response.status, json.load(response)

    def test_live_is_separate_from_map(self):
        status, payload = self.get_json("/api/nav/live")
        self.assertEqual(status, 200)
        self.assertNotIn("map", payload)
        self.assertEqual(payload["map_sequence"], 2)

    def test_map_returns_patch_for_previous_sequence(self):
        status, payload = self.get_json("/api/nav/map?since=1")
        self.assertEqual(status, 200)
        self.assertEqual(payload["kind"], "patch")

    def test_map_returns_not_modified_for_current_sequence(self):
        with self.assertRaises(HTTPError) as result:
            urlopen(self.base + "/api/nav/map?since=2")
        self.assertEqual(result.exception.code, 304)

    def test_legacy_endpoint_reconstructs_old_shape(self):
        status, payload = self.get_json("/api/nav")
        self.assertEqual(status, 200)
        self.assertEqual(payload["map"]["data"], ". #")
        self.assertEqual(payload["map"]["seq"], 2)


if __name__ == "__main__":
    unittest.main()
