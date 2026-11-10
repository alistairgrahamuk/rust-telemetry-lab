# rust-telemetry-lab

Postgres + a Rust generator that bulk-inserts random-walk sensor readings. A streaming
API/front end will be added later as a second crate using the same Dockerfile.

## Run

```sh
cp .env.example .env                        # optional, defaults work
docker compose up -d                        # postgres only
docker compose --profile generate up -d     # postgres + generator (inserts data)
docker compose logs -f generator
docker compose stop generator               # stop inserting, keep postgres up
```

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

## Layout

```
Cargo.toml              workspace
crates/generator/       data generator (sqlx + tokio)
db/init/001_schema.sql  schema, applied on first postgres start
Dockerfile              multi-stage; `--build-arg BIN=<crate>` builds any workspace binary
docker-compose.yml      postgres + generator (api service stubbed in comments)
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
