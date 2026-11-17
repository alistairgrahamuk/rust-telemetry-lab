# rust-telemetry-lab

Postgres + a Rust generator that bulk-inserts random-walk sensor readings, and a Rust API
that streams them to a React/ECharts front end.

## Run

```sh
cp .env.example .env                        # optional, defaults work
docker compose up -d                        # postgres + api (http://localhost:8080)
docker compose --profile generate up -d     # ...plus the generator (inserts data)
docker compose logs -f generator
docker compose stop generator               # stop inserting, keep postgres up
```

Open http://localhost:8080. Pick up to 8 sensors (any device, any metric) and a range; rows
stream in as NDJSON and the chart fills progressively, one panel per unit with the selected
sensors overlaid. With the generator in live mode (`MODE=live`), new rows arrive over
Server-Sent Events and are appended to the chart.

The generator sits behind the `generate` Compose profile, so it never starts unless you ask.
To make it the default, put `COMPOSE_PROFILES=generate` in `.env`.

Postgres is exposed on the host at `localhost:5433` (user/password/db all `telemetry`):

```sh
PGPASSWORD=telemetry psql -h 127.0.0.1 -p 5433 -U telemetry -d telemetry \
  -c 'SELECT count(*) FROM readings;'
```

Stop with `docker compose down` (keeps data) or `docker compose down -v` (drops data).

## Generator modes

**backfill** (default) writes one reading per sensor every `SAMPLE_INTERVAL_SECS` (5 min) from
`START_DATE` to `END_DATE`, flat out, and exits when the end date is reached. Each device has
three sensors (temperature, humidity, pressure), so 50 devices are 150 sensors and a month is
1.3 M rows; 2024-01-01 to 2026-11-17 (45 M rows) loads in about 2.5 minutes. Series have a random walk, mean reversion and a
daily temperature/humidity cycle so the data looks like real IoT telemetry.

Backfill loads with binary `COPY` and temporarily drops the `readings -> sensors` foreign
key, re-adding and validating it when the load finishes. With the FK in place Postgres
runs a lookup per row, which made loads ~6x slower.

**live** appends batches stamped "now" every `BATCH_INTERVAL_MS` until stopped.

By default every run **truncates `readings` first** (`TRUNCATE_ON_START=true`). Set it to
`false` to keep existing rows; `(sensor_id, recorded_at)` is unique, so overlapping reruns
are skipped rather than duplicated.

```sh
# a specific month
START_DATE=2026-10-01 END_DATE=2026-11-01 docker compose --profile generate up -d
# last 30 days (defaults), 200 devices (600 sensors), 1-minute cadence
DEVICE_COUNT=200 SAMPLE_INTERVAL_SECS=60 docker compose --profile generate up -d
# keep appending live data
MODE=live docker compose --profile generate up -d
```

| Variable               | Default      | Meaning                                              |
|------------------------|--------------|------------------------------------------------------|
| `MODE`                 | backfill     | `backfill` or `live`                                 |
| `DEVICE_COUNT`         | 50           | devices; each has 3 sensors (channels)               |
| `BATCH_SIZE`           | 50000        | rows per COPY (backfill) or INSERT (live)            |
| `TRUNCATE_ON_START`    | true         | clear `readings` before the run                      |
| `START_DATE`           | END_DATE-30d | backfill start, `YYYY-MM-DD` or RFC 3339             |
| `END_DATE`             | now          | backfill end (exclusive); generator exits here       |
| `SAMPLE_INTERVAL_SECS` | 300          | seconds between readings for each sensor             |
| `BATCH_INTERVAL_MS`    | 500          | live mode: pause between batches                     |
| `TOTAL_ROWS`           | 0            | live mode: stop after N rows (0 = forever)           |
| `POSTGRES_HOST_PORT`   | 5433         | host port mapped to Postgres                         |
| `API_HOST_PORT`        | 8080         | host port for the web UI + API                       |

## API

| Endpoint | Returns |
|---|---|
| `GET /api/sensors` | every sensor (device channel) with device, location, metric, unit and `first_ms`/`last_ms` |
| `GET /api/readings/stream?sensor_ids=1,4,7&from=&to=` | NDJSON: a `{"type":"meta","count":N,...}` line, then `[sensor_id, ts_ms, value]` per row, ordered by sensor then time, streamed from a server-side cursor and gzip-compressed when accepted. `from`/`to` are RFC 3339; `to` is exclusive and both are optional. Up to 16 sensors per request. |
| `GET /api/readings/live?sensor_ids=1,4&after=` | SSE `rows` events with batches of `[sensor_id, ts_ms, value]` newer than `after` (polled every second) |

Each sensor in the list is streamed as its own index-ordered cursor, back to back. One
sensor's full history (~300k rows) streams in about 0.2 s; eight sensors (2.4 M rows, 60 MB)
start within 150 ms and finish in about 2 s, compressed with zstd (10.9 MB) or gzip at the
fastest level. Timestamps are whole milliseconds end to end.

### Why the table is written sensor-major

The backfill writes one sensor's entire range, then the next, so a sensor's rows sit on
contiguous heap pages. Written time-major (every sensor per tick) a single sensor's history
spanned every page of the 2.3 GB table, and reading eight sensors meant reading it eight
times; with the sensor-major layout the same query reads ~24 MB per sensor. The generator
also runs `VACUUM ANALYZE` after a load so counts are index-only. Live-mode appends are
time-major but small. If you add bulk loads from elsewhere, `CLUSTER readings USING
readings_pkey` restores the layout.

## Front end (`web/`)

Vite + React + TypeScript + Apache ECharts. A Web Worker fetches and parses the NDJSON
stream byte by byte and posts rows back as transferable typed arrays; series are kept as flat
typed arrays and handed to ECharts without copying; while rows stream, chart refreshes are
paced by how long the last one took. Eight sensors over all time (2.4 M points) load in about
2.3 s and never block the page for more than ~0.3 s. A device × metric picker selects up to 8
sensors;
each keeps a fixed colour while selected. Sensors are grouped into one panel per unit (so
different units never share an axis) with a shared crosshair, legend and zoom, LTTB
downsampling for large ranges, presets anchored to the newest selected reading, a typed custom
range (`YYYY-MM-DD HH:MM`, local time), a live-tail toggle and a table view. Light and dark
follow the OS.

```sh
cd web && npm install
npm run dev          # http://localhost:5173, /api proxied to the Rust API on :8080
```

Run the API locally against the Compose Postgres:

```sh
DATABASE_URL=postgres://telemetry:telemetry@localhost:5433/telemetry STATIC_DIR=web/dist cargo run -p api
```

## Layout

```
Cargo.toml              workspace
crates/generator/       data generator (sqlx + tokio)
crates/api/             axum API: streaming history, SSE live tail, serves web/dist
web/                    React front end (Vite, ECharts)
db/init/001_schema.sql  schema, applied on first postgres start
Dockerfile              multi-stage; `--target runtime --build-arg BIN=<crate>` for a bare
                        binary, `--target api` for the API bundled with the built front end
docker-compose.yml      postgres + api, generator behind the `generate` profile
```

## Schema

- `devices(id, name, location, created_at)`: a physical unit at a location
- `sensors(id, device_id, metric, unit)`: one channel of a device; id = (device-1)*3 + metric index + 1
- `readings(sensor_id, recorded_at, value)`
  - primary key `(sensor_id, recorded_at)`: one reading per sensor per instant, and serves per-sensor range queries
  - heap written sensor-major by the generator (see above); no time-only index

## Local dev without Docker for the Rust side

```sh
docker compose up -d postgres
DATABASE_URL=postgres://telemetry:telemetry@localhost:5433/telemetry cargo run -p generator
```
