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

Open http://localhost:8080. Pick a sensor and a range; rows stream in as NDJSON and the three
panels fill progressively. With the generator in live mode (`MODE=live`), new rows arrive over
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
`START_DATE` to `END_DATE`, flat out, and exits when the end date is reached. A month of 50
sensors is 432,000 rows and takes a few seconds. Series have a random walk, mean reversion and a
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
# last 30 days (defaults), 200 sensors, 1-minute cadence
SENSOR_COUNT=200 SAMPLE_INTERVAL_SECS=60 docker compose --profile generate up -d
# keep appending live data
MODE=live docker compose --profile generate up -d
```

| Variable               | Default      | Meaning                                              |
|------------------------|--------------|------------------------------------------------------|
| `MODE`                 | backfill     | `backfill` or `live`                                 |
| `SENSOR_COUNT`         | 50           | distinct sensors                                     |
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
| `GET /api/sensors` | sensors with `first_ms`/`last_ms` of their readings |
| `GET /api/readings/stream?sensor_id=&from=&to=` | NDJSON: a `{"type":"meta","count":N,...}` line, then `[ts_ms, temp, hum, pressure]` per row, streamed from a server-side cursor and gzip-compressed when accepted. `from`/`to` are RFC 3339; `to` is exclusive and both are optional. |
| `GET /api/readings/live?sensor_id=&after=` | SSE `rows` events with batches of rows newer than `after` (polled every second) |

A sensor's full history (~300k rows, 11 MB) streams in about 0.7 s uncompressed or 1.5 s as
2.8 MB gzip. Timestamps are whole milliseconds end to end.

## Front end (`web/`)

Vite + React + TypeScript + Apache ECharts. Three stacked single-series panels with a shared
crosshair and zoom, LTTB downsampling for large ranges, presets anchored to the sensor's last
reading, a custom range, a live-tail toggle and a table view. Light and dark follow the OS.

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

- `sensors(id, name, location, created_at)`
- `readings(id, sensor_id, recorded_at, temperature, humidity, pressure)`
  - unique btree on `(sensor_id, recorded_at)`: one reading per sensor per instant, and serves per-sensor range queries
  - BRIN on `recorded_at` for cheap whole-table time slices

## Local dev without Docker for the Rust side

```sh
docker compose up -d postgres
DATABASE_URL=postgres://telemetry:telemetry@localhost:5433/telemetry cargo run -p generator
```
