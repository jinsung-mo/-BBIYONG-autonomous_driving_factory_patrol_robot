import unittest

from nav_protocol import (
    FREE,
    OCCUPIED,
    UNKNOWN,
    apply_patch,
    classify_cells,
    decode_runs,
    encode_patch,
    encode_runs,
)


class NavProtocolTest(unittest.TestCase):
    def test_classifies_occupancy_probabilities(self):
        self.assertEqual(
            classify_cells([-1, 0, 50, 51, 100]),
            [UNKNOWN, FREE, FREE, OCCUPIED, OCCUPIED],
        )

    def test_rle_round_trip(self):
        cells = [UNKNOWN] * 4 + [FREE] * 3 + [OCCUPIED] * 2
        self.assertEqual(decode_runs(encode_runs(cells)), cells)

    def test_patch_round_trip(self):
        before = [UNKNOWN, UNKNOWN, FREE, FREE, FREE, OCCUPIED]
        after = [UNKNOWN, FREE, FREE, OCCUPIED, OCCUPIED, OCCUPIED]
        self.assertEqual(apply_patch(before, encode_patch(before, after)), after)

    def test_unchanged_map_has_empty_patch(self):
        cells = [UNKNOWN, FREE, OCCUPIED]
        self.assertEqual(encode_patch(cells, cells), [])

if __name__ == "__main__":
    unittest.main()
