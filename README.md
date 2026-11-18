# rust-telemetry-lab

Postgres + a Rust generator that writes random-walk IoT sensor readings, and a Rust API that
streams them to a React/ECharts front end.

The project is meant to be run locally and intermittently. The generator remembers nothing
between runs; it reads the newest row in the table and carries on from there, so you can shut
everything down for days, start it again, and the gap is filled before the chart opens.

## Install

You need Docker with Compose. Everything else (Rust, Node, Postgres) runs in containers.

```sh
git clone <this repo> && cd rust-telemetry-lab
cp .env.example .env            # optional; the defaults work as they are
docker compose up -d            # postgres (localhost:5433) + api/web (http://localhost:8080)
```

### 1. Load history once: pick a date range

Run a `backfill` for the span you want to look at. It writes one reading per sensor every
5 minutes across the range, flat out, then exits. Dates are `YYYY-MM-DD` (midnight UTC) or
RFC 3339; `END_DATE` is exclusive.

```sh
MODE=backfill START_DATE=2026-01-01 END_DATE=2026-11-18 docker compose --profile generate up -d
docker compose logs -f generator     # Ctrl-C to stop watching; the load keeps going
```

A backfill **replaces** whatever is in `readings` (`TRUNCATE_ON_START` defaults to true in
this mode). 50 devices × 3 sensors at a 5-minute cadence is about 1.3 M rows per month; 2024-01-01
to 2026-11-17 (45 M rows) loads in roughly 2.5 minutes. The container exits 0 when done.

### 2. Every time after that: catch up and keep up

```sh
docker compose --profile generate up -d
```

With no `MODE` set the generator runs in **catchup** mode, the default:

1. finds the newest stored reading for every sensor;
2. continues each sensor's random walk from its last value, so there is no jump at the join;
3. fills from that reading to now, on the same 5-minute grid;
4. then writes one reading per sensor every 5 minutes until stopped.

If the machine sleeps or the container is stopped, the next start fills whatever fell due
in the meantime. Nothing is truncated in this mode. If you run step 2 on an empty table it
loads the last 30 days first (or `START_DATE`..now, if set), so for a quick start you can skip
step 1 entirely.

To have the generator come up with a plain `docker compose up -d`, put `COMPOSE_PROFILES=generate`
in `.env`.

### Stopping

```sh
docker compose stop generator   # stop writing, keep postgres + api up
docker compose down             # stop everything, keep the data
docker compose down -v          # stop everything and drop the data
```

### Checking the data

```sh
PGPASSWORD=telemetry psql -h 127.0.0.1 -p 5433 -U telemetry -d telemetry \
  -c 'SELECT count(*), min(recorded_at), max(recorded_at) FROM readings;'
```

## Using the UI

Open http://localhost:8080. The page is a **dashboard of chart widgets**:

- **Add widget** puts a new card in the first free space. Each widget has its own sensor
  picker (any device, any metric, one sensor or up to 8), a title you can type, and a remove
  button. Drag a widget by its header; resize it from the bottom-right corner.
- **The dashboard owns the time range.** Presets (24h to All) and the live-tail toggle apply
  to every widget. Hover, crosshair and zoom within a widget are independent of the others.
- Inside a widget, sensors are grouped into one panel per unit so different units never share
  an axis. Small widgets drop the zoom slider; the mouse wheel still zooms.
- The layout, every widget's sensors and the chosen range are saved in the browser
  (`localStorage`), so a reload brings the same dashboard back.

Rows stream in as NDJSON and the charts fill progressively. Each sensor is fetched once for
the current range no matter how many widgets show it. With live tail on, each new 5-minute
tick from the generator arrives over Server-Sent Events and is appended to every widget that
shows that sensor; the green dot means the stream is connected, and it reconnects on its own if
the API restarts.

## Generator modes and settings

| `MODE`     | What it does                                                                                           | Exits?            |
|------------|--------------------------------------------------------------------------------------------------------|-------------------|
| `catchup`  | Default. Fill from the newest stored reading to now, then one reading per sensor per `SAMPLE_INTERVAL_SECS`. Empty table: loads `START_DATE`..now first. | No (Ctrl-C / `docker stop`) |
| `backfill` | Load `START_DATE`..`END_DATE` with binary `COPY`, truncating first by default.                          | Yes, when done    |
| `live`     | Load test: appends `BATCH_SIZE` rows stamped "now" every `BATCH_INTERVAL_MS`.                          | No, unless `TOTAL_ROWS` |

Each device has three sensors (temperature, humidity, pressure). Series have a random walk,
mean reversion and a daily temperature/humidity cycle so the data looks like real telemetry.

| Variable               | Default                   | Meaning                                                          |
|------------------------|---------------------------|------------------------------------------------------------------|
| `MODE`                 | catchup                   | `catchup`, `backfill` or `live`                                  |
| `DEVICE_COUNT`         | 50                        | devices; each has 3 sensors                                      |
| `SAMPLE_INTERVAL_SECS` | 300                       | seconds between readings for each sensor (the tick grid)         |
| `START_DATE`           | 30 days before `END_DATE` | backfill start; catchup uses it only when the table is empty     |
| `END_DATE`             | now                       | backfill end (exclusive); ignored by catchup                     |
| `TRUNCATE_ON_START`    | true for backfill, else false | clear `readings` before the run                              |
| `BATCH_SIZE`           | 50000                     | rows per COPY / INSERT                                           |
| `BATCH_INTERVAL_MS`    | 500                       | live mode: pause between batches                                 |
| `TOTAL_ROWS`           | 0                         | live mode: stop after N rows (0 = forever)                       |
| `POSTGRES_HOST_PORT`   | 5433                      | host port mapped to Postgres                                     |
| `API_HOST_PORT`        | 8080                      | host port for the web UI + API                                   |

Examples:

```sh
# full history then keep up, in one go (fresh database)
START_DATE=2024-01-01 docker compose --profile generate up -d
# replace everything with one specific month, then stop
MODE=backfill START_DATE=2026-10-01 END_DATE=2026-11-01 docker compose --profile generate up -d
# 200 devices (600 sensors) at a 1-minute cadence
DEVICE_COUNT=200 SAMPLE_INTERVAL_SECS=60 docker compose --profile generate up -d
```

Keep `SAMPLE_INTERVAL_SECS` the same between runs; catchup continues the grid from the newest
stored reading, so changing it shifts the grid from that point on. Raising `DEVICE_COUNT` later
adds devices that have no history before the moment they were added.

### How the two write paths differ

**Backfill** loads with binary `COPY` and temporarily drops the `readings -> sensors` foreign
key, re-adding and validating it when the load finishes, then runs `VACUUM ANALYZE`. With the FK
in place Postgres runs a lookup per row, which made loads ~6x slower. A duplicate
`(sensor_id, recorded_at)` aborts a COPY batch, which is why this mode truncates first.

**Catchup** uses `INSERT ... ON CONFLICT DO NOTHING` with the FK in place: slower per row
(~20k rows/s unoptimised, a day's gap is 43k rows) but it tolerates overlap and never
revalidates the whole table. The initial load on an empty table takes the backfill path.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/sensors` | every sensor (device channel) with device, location, metric, unit and `first_ms`/`last_ms` |
| `GET /api/readings/stream?sensor_ids=1,4,7&from=&to=` | NDJSON: a `{"type":"meta","count":N,...}` line, then `[sensor_id, ts_ms, value]` per row, ordered by sensor then time, streamed from a server-side cursor and gzip/zstd-compressed when accepted. `from`/`to` are RFC 3339; `to` is exclusive and both are optional. Up to 16 sensors per request. |
| `GET /api/readings/live?sensor_ids=1,4&after=` | SSE `rows` events with batches of `[sensor_id, ts_ms, value]` newer than `after` (polled every second). Up to 512 sensors, so one subscription covers a whole dashboard. |

Each sensor in the list is streamed as its own index-ordered cursor, back to back. One
sensor's full history (~300k rows) streams in about 0.2 s; eight sensors (2.4 M rows, 60 MB)
start within 150 ms and finish in about 2 s, compressed with zstd (10.9 MB) or gzip at the
fastest level. Timestamps are whole milliseconds end to end.

### Why the table is written sensor-major

The backfill writes one sensor's entire range, then the next, so a sensor's rows sit on
contiguous heap pages. Written time-major (every sensor per tick) a single sensor's history
spanned every page of the 2.3 GB table, and reading eight sensors meant reading it eight
times; with the sensor-major layout the same query reads ~24 MB per sensor. Catchup's gap
fill is also written sensor-major; the 5-minute ticks that follow are time-major but tiny.
If you add bulk loads from elsewhere, `CLUSTER readings USING readings_pkey` restores the
layout.

## Front end (`web/`)

Vite + React + TypeScript + Apache ECharts + react-grid-layout.

- `App.tsx` is the dashboard shell: range controls, status line and the grid. `dashboard.ts`
  holds the config shape and its `localStorage` persistence. `Widget.tsx` is one card with its
  `SensorPicker.tsx`; `Chart.tsx` is the per-unit panel chart inside it.
- `useSeriesStore.ts` fetches the union of all widgets' sensors for the dashboard range:
  one stream per 16 sensors, only the missing sensors when a widget's selection changes, and a
  single live-tail subscription. Series are flat typed arrays (`series.ts`) mutated in place;
  a cheap version counter drives re-renders.
- A Web Worker (`stream.worker.ts`, parser in `rowParser.ts`) fetches and parses the NDJSON
  stream byte by byte and posts rows back as transferable typed arrays; while rows stream, chart refreshes are paced by
  how long the last one took. Eight sensors over all time (2.4 M points) load in about 2.3 s
  and never block the page for more than ~0.3 s.
- Presets anchor to the newest reading across the dashboard's sensors, so they always show
  data. Light and dark follow the OS.

```sh
cd web && npm install
npm run dev          # http://localhost:5173, /api proxied to the Rust API on :8080
```

## Tests

```sh
cargo test --workspace        # generator: date parsing, COPY encoding, tick grid, walk resume; api: id parsing
cd web && npm test            # vitest: NDJSON row parser (incl. mid-row flush), span formatting, widget placement, series
```

Formatting is pinned by `rustfmt.toml` (`cargo fmt --all -- --check`); clippy runs clean with `--all-targets`.

## Developing without Docker for the Rust side

```sh
docker compose up -d postgres
export DATABASE_URL=postgres://telemetry:telemetry@localhost:5433/telemetry
cargo run -p generator                                  # catchup mode
MODE=backfill START_DATE=2026-10-01 cargo run -p generator
STATIC_DIR=web/dist cargo run -p api                    # API + built front end on :8080
```

## Layout

```
Cargo.toml              workspace
crates/generator/       data generator (sqlx + tokio): catchup / backfill / live
crates/api/             axum API: streaming history, SSE live tail, serves web/dist
web/                    React dashboard front end (Vite, ECharts, react-grid-layout)
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
