import unittest

from bbiyong_base.remote_control_protocol import failsafe_actions, parse_remote_command


class RemoteControlProtocolTest(unittest.TestCase):
    def test_drive_is_clamped_without_releasing_estop(self) -> None:
        actions = parse_remote_command('{"command":"DRIVE","linear":4.0,"angular":-3.0}', 0.2, 0.4)
        self.assertEqual((actions.linear, actions.angular), (0.2, -0.4))
        self.assertIsNone(actions.estop)

    def test_invalid_or_non_finite_drive_is_rejected(self) -> None:
        for payload in (
            '{"command":"DRIVE","linear":"fast","angular":0}',
            '{"command":"DRIVE","linear":1e999,"angular":0}',
            'not-json',
        ):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                parse_remote_command(payload, 0.2, 0.4)

    def test_mode_mapping_and_estop_release_rejection(self) -> None:
        self.assertEqual(
            parse_remote_command('{"command":"SET_MODE","mode":"MANUAL"}', 0.2, 0.4).mode,
            "manual",
        )
        with self.assertRaises(ValueError):
            parse_remote_command('{"command":"ESTOP","active":false}', 0.2, 0.4)

    def test_disconnect_failsafe_is_zero_disabled_and_estopped(self) -> None:
        actions = failsafe_actions()
        self.assertEqual((actions.linear, actions.angular, actions.mode, actions.estop), (0.0, 0.0, "disabled", True))

    def test_safe_map_name_and_finite_goal_are_parsed(self) -> None:
        self.assertEqual(
            parse_remote_command('{"command":"SAVE_MAP","name":"floor_1"}', 0.2, 0.4).map_name,
            "floor_1",
        )
        self.assertEqual(
            parse_remote_command('{"command":"NAVIGATE","x":1,"y":2,"yaw":0.5}', 0.2, 0.4).goal,
            (1.0, 2.0, 0.5),
        )
        with self.assertRaises(ValueError):
            parse_remote_command('{"command":"SAVE_MAP","name":"../bad"}', 0.2, 0.4)


if __name__ == "__main__":
    unittest.main()
