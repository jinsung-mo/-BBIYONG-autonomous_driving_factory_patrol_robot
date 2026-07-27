# Orin dashboard

Source for the dashboard served at `https://i15e101.p.ssafy.io/robot/`.

## Navigation data contract

All navigation payloads contain `schema_version: "1.0"`.

- `GET /api/nav/live`: high-rate pose, scan, timestamp, and `map_sequence`.
- `GET /api/nav/map?since=N`: returns `304`, a current RLE snapshot, or a patch
  from sequence `N`.
- `GET /api/nav`: compatibility endpoint for older clients. It reconstructs the
  old map string on demand and is not used by the bundled dashboard.

Snapshot cells use flat RLE pairs `[value, count, ...]`. Patch changes use flat
triples `[start, count, value, ...]`. Values are `-1` unknown, `0` free, and
`100` occupied. Map sequence advances only when geometry or classified cell
content changes.

The live endpoint is deliberately separate from map transfer: adding dashboard
clients no longer multiplies full-grid serialization and bandwidth at 2 Hz.
