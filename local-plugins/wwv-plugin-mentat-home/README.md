# @worldwideview/wwv-plugin-mentat-home

Renders entities from a running [Mentat](https://github.com/giannisanni/mentat) home-security instance on the WorldWideView 3D globe.

> Mentat is *not* a WWV data-engine seeder. This plugin opens its own WebSocket to Mentat's `/api/bridge/wwv/*` surface, translates frames into `GeoEntity[]`, and pushes them via `ctx.onDataUpdate()`. The bridge contract lives in `mentat/backend/api/bridge.py` — that file is the protocol's source of truth.

## What you'll see

| Mentat entity   | Rendering                                                      |
|-----------------|----------------------------------------------------------------|
| `camera`        | amber camera glyph billboard                                   |
| `vehicle`       | blue vehicle glyph billboard                                   |
| `alert_active`  | red alert glyph billboard (large)                              |
| `alert_resolved`| muted alert glyph billboard (small)                            |
| `person_known`  | green point with white outline                                 |
| `person_unknown`| red point with white outline                                   |
| `event`         | purple point                                                   |
| `sensor`        | amber point                                                    |
| `zone`          | slate point (polygon rendering arrives with v2)                |

Zone polygons, alert pulse animations, and selection HUDs land in subsequent versions.

## Configuration

The plugin discovers its bridge through a single URL: a manifest endpoint that publishes the snapshot + stream URLs and a home-anchor lat/lon.

| Setting                                                          | Default                                                    | Effect                                                                 |
|------------------------------------------------------------------|------------------------------------------------------------|------------------------------------------------------------------------|
| `NEXT_PUBLIC_WWV_PLUGIN_MENTAT_HOME_MANIFEST_URL` (build-time)   | `http://localhost:8080/api/bridge/wwv/manifest`            | Where the plugin reads its discovery doc. Point this at your shell's Caddy origin in production. |

Inside the plugin the env var is read as `ctx.env.MENTAT_HOME_MANIFEST_URL` (WWV strips the `NEXT_PUBLIC_WWV_PLUGIN_` prefix).

## Lifecycle

```
initialize(ctx)
   ├── GET   manifestUrl                 → BridgeManifest
   ├── GET   manifest.snapshotUrl        → initial entities (Map<id, GeoEntity>)
   ├── push  ctx.onDataUpdate(snapshot)
   └── WS    manifest.streamUrl          → live frames

frames                                   (source of truth: mentat/backend/api/bridge.py)
   { type:"hello",  schemaVersion, serverTime, pluginId }   // first frame
   { type:"entity", entity }                                 // upsert
   { type:"delete", id }                                     // remove
   { type:"ping" }                                           // keepalive (~25s)

destroy()
   ├── close WS
   ├── clear timers
   └── drop entity map
```

Reconnection uses exponential backoff capped at 30s. If we've been disconnected for >60s the plugin re-fetches the snapshot before resuming the stream so state can't drift past that gap.

## Development

Workspace pulls this in automatically via `local-plugins/*` in `pnpm-workspace.yaml`. From the WWV root:

```sh
pnpm install            # one time, picks up this plugin
pnpm run dev:all        # starts WWV + data engine + plugin watcher
```

Then start Mentat's stack (`docker compose up -d` + `uvicorn`) and the shell (`caddy run`) so the bridge has something to serve. Toggle the **Mentat Home Security** layer in WWV's left sidebar.
