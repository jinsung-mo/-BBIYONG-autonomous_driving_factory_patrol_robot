"""Versioned, dependency-free map encoding used by the dashboard bridge."""

SCHEMA_VERSION = "1.0"
UNKNOWN = -1
FREE = 0
OCCUPIED = 100


def classify_cells(values):
    """Reduce OccupancyGrid probabilities to the three dashboard states."""
    return [
        UNKNOWN if value < 0 else FREE if value <= 50 else OCCUPIED
        for value in values
    ]


def encode_runs(values):
    """Encode values as flat [value, count, ...] RLE."""
    if not values:
        return []
    encoded = []
    value = values[0]
    count = 1
    for current in values[1:]:
        if current == value:
            count += 1
        else:
            encoded.extend((value, count))
            value, count = current, 1
    encoded.extend((value, count))
    return encoded


def decode_runs(encoded):
    values = []
    if len(encoded) % 2:
        raise ValueError("RLE payload must contain value/count pairs")
    for value, count in zip(encoded[::2], encoded[1::2]):
        if count < 1:
            raise ValueError("RLE run length must be positive")
        values.extend([value] * count)
    return values


def encode_patch(previous, current):
    """Encode changed contiguous cells as flat [start, count, value, ...]."""
    if len(previous) != len(current):
        raise ValueError("patch inputs must have the same length")
    patch = []
    index = 0
    while index < len(current):
        if current[index] == previous[index]:
            index += 1
            continue
        start = index
        value = current[index]
        index += 1
        while (
            index < len(current)
            and current[index] != previous[index]
            and current[index] == value
        ):
            index += 1
        patch.extend((start, index - start, value))
    return patch


def apply_patch(values, patch):
    if len(patch) % 3:
        raise ValueError("patch payload must contain start/count/value triples")
    result = list(values)
    for start, count, value in zip(patch[::3], patch[1::3], patch[2::3]):
        if start < 0 or count < 1 or start + count > len(result):
            raise ValueError("patch run is outside the map")
        result[start:start + count] = [value] * count
    return result
