import json
from pathlib import Path
import tempfile
import time
import unittest

from bbiyong_bringup.scouting_session import (
    atomic_write_json,
    read_ready_session,
    route_matches_session,
)


class ScoutingSessionTest(unittest.TestCase):
    def test_ready_session_is_fresh_and_route_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.json"
            atomic_write_json(path, {
                "sessionId": "session-a",
                "mapFile": "/maps/a.yaml",
                "ready": True,
                "updatedAt": time.time(),
            })
            session = read_ready_session(path)
        self.assertEqual(session["sessionId"], "session-a")
        self.assertTrue(route_matches_session(
            {"scoutingSessionId": "session-a"}, session
        ))
        self.assertFalse(route_matches_session(
            {"scoutingSessionId": "old"}, session
        ))

    def test_stale_or_stopped_session_is_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.json"
            for ready, updated_at in ((False, time.time()), (True, time.time() - 10)):
                atomic_write_json(path, {
                    "sessionId": "session-a",
                    "mapFile": "/maps/a.yaml",
                    "ready": ready,
                    "updatedAt": updated_at,
                })
                self.assertIsNone(read_ready_session(path))


if __name__ == "__main__":
    unittest.main()
