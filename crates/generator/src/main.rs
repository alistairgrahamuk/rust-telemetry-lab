//! Generates realistic IoT sensor readings and bulk-inserts them into Postgres.
//!
//! Each *device* has three *sensors* (temperature, humidity, pressure); every reading is one
//! value for one sensor, so a device produces three rows per tick.
//!
//! Two modes, chosen by `MODE`:
//!   backfill (default) - one reading per sensor every SAMPLE_INTERVAL_SECS from START_DATE
//!                        to END_DATE, written flat out; exits when END_DATE is reached.
//!   live               - keeps appending batches stamped "now" until stopped.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, Timelike, Utc};
use rand::{rngs::StdRng, Rng, SeedableRng};
use sqlx::postgres::{PgPoolCopyExt, PgPoolOptions};
use sqlx::PgPool;
use std::f32::consts::TAU;
use std::time::Duration;
use tracing::info;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Backfill,
    Live,
}

struct Config {
    database_url: String,
    mode: Mode,
    device_count: i16,
    batch_size: usize,
    truncate_on_start: bool,
    // backfill
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    sample_interval: ChronoDuration,
    // live
    batch_interval: Duration,
    total_rows: u64,
}

impl Config {
    fn from_env() -> Result<Self> {
        let mode = match std::env::var("MODE").unwrap_or_else(|_| "backfill".into()).to_lowercase().as_str() {
            "backfill" => Mode::Backfill,
            "live" => Mode::Live,
            other => bail!("MODE must be 'backfill' or 'live', got {other:?}"),
        };

        let end = match std::env::var("END_DATE") {
            Ok(v) => parse_date(&v).context("END_DATE")?,
            Err(_) => Utc::now(),
        };
        let start = match std::env::var("START_DATE") {
            Ok(v) => parse_date(&v).context("START_DATE")?,
            Err(_) => end - ChronoDuration::days(30),
        };
        if mode == Mode::Backfill && start >= end {
            bail!("START_DATE ({start}) must be before END_DATE ({end})");
        }

        Ok(Self {
            database_url: std::env::var("DATABASE_URL").context("DATABASE_URL is required")?,
            mode,
            device_count: env_or("DEVICE_COUNT", env_or("SENSOR_COUNT", 50)),
            batch_size: env_or("BATCH_SIZE", 50_000),
            truncate_on_start: env_or("TRUNCATE_ON_START", true),
            start,
            end,
            sample_interval: ChronoDuration::seconds(env_or("SAMPLE_INTERVAL_SECS", 300)),
            batch_interval: Duration::from_millis(env_or("BATCH_INTERVAL_MS", 500)),
            total_rows: env_or("TOTAL_ROWS", 0),
        })
    }
}

/// Accepts `YYYY-MM-DD` (midnight UTC) or a full RFC 3339 timestamp.
fn parse_date(s: &str) -> Result<DateTime<Utc>> {
    if let Ok(d) = NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d") {
        return Ok(d.and_hms_opt(0, 0, 0).unwrap().and_utc());
    }
    DateTime::parse_from_rfc3339(s.trim())
        .map(|d| d.with_timezone(&Utc))
        .with_context(|| format!("expected YYYY-MM-DD or RFC 3339, got {s:?}"))
}

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Metrics every device exposes, in sensor-id order. Sensor id = (device-1)*3 + index + 1.
const METRICS: [(&str, &str); 3] = [("temperature", "°C"), ("humidity", "%"), ("pressure", "hPa")];
const METRICS_PER_DEVICE: usize = METRICS.len();

fn sensor_id(device: i16, metric_idx: usize) -> i16 {
    (device - 1) * METRICS_PER_DEVICE as i16 + metric_idx as i16 + 1
}

/// Per-device state so each series drifts smoothly instead of being white noise.
struct DeviceState {
    id: i16,
    baseline: [f32; 3],
    temperature: f32,
    humidity: f32,
    pressure: f32,
}

struct Reading {
    sensor_id: i16,
    at: DateTime<Utc>,
    value: f32,
}

impl DeviceState {
    fn new(id: i16, rng: &mut impl Rng) -> Self {
        let baseline = [rng.gen_range(15.0..25.0), rng.gen_range(35.0..65.0), rng.gen_range(995.0..1025.0)];
        Self { id, baseline, temperature: baseline[0], humidity: baseline[1], pressure: baseline[2] }
    }

    /// Random walk with a weak pull back to baseline, plus a daily temperature/humidity cycle
    /// (warmest ~15:00 UTC, driest at the same time) so a month of data has visible structure.
    /// Pushes one reading per metric.
    fn sample(&mut self, rng: &mut impl Rng, at: DateTime<Utc>, out: &mut Vec<Reading>) {
        const REVERT: f32 = 0.01;
        self.temperature = (self.temperature + REVERT * (self.baseline[0] - self.temperature) + rng.gen_range(-0.3..0.3)).clamp(-20.0, 60.0);
        self.humidity = (self.humidity + REVERT * (self.baseline[1] - self.humidity) + rng.gen_range(-0.8..0.8)).clamp(0.0, 100.0);
        self.pressure = (self.pressure + REVERT * (self.baseline[2] - self.pressure) + rng.gen_range(-0.2..0.2)).clamp(950.0, 1060.0);

        let day_frac = at.num_seconds_from_midnight() as f32 / 86_400.0;
        let diurnal = (TAU * (day_frac - 0.375)).sin(); // peaks at 15:00, trough at 03:00

        let values = [
            self.temperature + 4.0 * diurnal,
            (self.humidity - 8.0 * diurnal).clamp(0.0, 100.0),
            self.pressure,
        ];
        for (i, value) in values.into_iter().enumerate() {
            out.push(Reading { sensor_id: sensor_id(self.id, i), at, value });
        }
    }
}

async fn ensure_devices_and_sensors(pool: &PgPool, count: i16) -> Result<()> {
    let ids: Vec<i16> = (1..=count).collect();
    let names: Vec<String> = ids.iter().map(|i| format!("sensor-{i:03}")).collect();
    let locations: Vec<String> =
        ids.iter().map(|i| format!("building-{}/floor-{}", (i - 1) / 20 + 1, (i - 1) % 20 / 5 + 1)).collect();

    sqlx::query(
        "INSERT INTO devices (id, name, location)
         SELECT * FROM UNNEST($1::smallint[], $2::text[], $3::text[])
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(&ids)
    .bind(&names)
    .bind(&locations)
    .execute(pool)
    .await
    .context("seeding devices")?;

    let mut s_ids = Vec::with_capacity(ids.len() * METRICS_PER_DEVICE);
    let mut s_dev = Vec::with_capacity(s_ids.capacity());
    let mut s_metric = Vec::with_capacity(s_ids.capacity());
    let mut s_unit = Vec::with_capacity(s_ids.capacity());
    for &d in &ids {
        for (m, (metric, unit)) in METRICS.iter().enumerate() {
            s_ids.push(sensor_id(d, m));
            s_dev.push(d);
            s_metric.push(*metric);
            s_unit.push(*unit);
        }
    }
    sqlx::query(
        "INSERT INTO sensors (id, device_id, metric, unit)
         SELECT * FROM UNNEST($1::smallint[], $2::smallint[], $3::text[], $4::text[])
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(&s_ids)
    .bind(&s_dev)
    .bind(&s_metric)
    .bind(&s_unit)
    .execute(pool)
    .await
    .context("seeding sensors")?;
    Ok(())
}

/// INSERT ... ON CONFLICT DO NOTHING via UNNEST. Slower than COPY, but tolerates duplicate
/// timestamps, which live mode can produce when batches overlap.
async fn flush_insert(pool: &PgPool, buf: &mut Vec<Reading>) -> Result<u64> {
    if buf.is_empty() {
        return Ok(0);
    }
    let n = buf.len();
    let (mut ids, mut ts, mut vals) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
    for r in buf.drain(..) {
        ids.push(r.sensor_id);
        ts.push(r.at);
        vals.push(r.value);
    }

    let result = sqlx::query(
        "INSERT INTO readings (sensor_id, recorded_at, value)
         SELECT * FROM UNNEST($1::smallint[], $2::timestamptz[], $3::real[])
         ON CONFLICT (sensor_id, recorded_at) DO NOTHING",
    )
    .bind(&ids)
    .bind(&ts)
    .bind(&vals)
    .execute(pool)
    .await
    .context("inserting readings batch")?;
    Ok(result.rows_affected())
}

/// Postgres binary COPY protocol: https://www.postgresql.org/docs/current/sql-copy.html#id-1.9.3.55.9.4
/// Microseconds between the Unix epoch and the Postgres epoch (2000-01-01 00:00:00 UTC).
const PG_EPOCH_OFFSET_US: i64 = 946_684_800_000_000;
const COPY_SIGNATURE: &[u8] = b"PGCOPY\n\xff\r\n\0";

fn encode_copy_binary(buf: &[Reading]) -> Vec<u8> {
    // header 19 bytes + 2 trailer + per row: 2 (field count) + 3 * 4 (lengths) + 2 + 8 + 4
    let mut out = Vec::with_capacity(21 + buf.len() * 28);
    out.extend_from_slice(COPY_SIGNATURE);
    out.extend_from_slice(&0i32.to_be_bytes()); // flags
    out.extend_from_slice(&0i32.to_be_bytes()); // header extension length
    for r in buf {
        out.extend_from_slice(&3i16.to_be_bytes());
        out.extend_from_slice(&2i32.to_be_bytes());
        out.extend_from_slice(&r.sensor_id.to_be_bytes());
        out.extend_from_slice(&8i32.to_be_bytes());
        out.extend_from_slice(&(r.at.timestamp_micros() - PG_EPOCH_OFFSET_US).to_be_bytes());
        out.extend_from_slice(&4i32.to_be_bytes());
        out.extend_from_slice(&r.value.to_be_bytes());
    }
    out.extend_from_slice(&(-1i16).to_be_bytes());
    out
}

/// COPY ... FROM STDIN (FORMAT binary). Roughly 10x faster than INSERT, but a duplicate
/// (sensor_id, recorded_at) aborts the whole batch, so backfill relies on TRUNCATE_ON_START
/// or a non-overlapping range.
async fn flush_copy(pool: &PgPool, buf: &mut Vec<Reading>) -> Result<u64> {
    if buf.is_empty() {
        return Ok(0);
    }
    let bytes = encode_copy_binary(buf);
    buf.clear();
    let mut copy = pool
        .copy_in_raw("COPY readings (sensor_id, recorded_at, value) FROM STDIN (FORMAT binary)")
        .await
        .context("starting COPY")?;
    copy.send(bytes).await.context("sending COPY data")?;
    copy.finish().await.context("finishing COPY")
}

const FK_NAME: &str = "readings_sensor_id_fkey";

/// The FK to `sensors` fires a lookup trigger for every row, which makes COPY ~6x slower
/// (measured: 10.3s vs 1.7s per 446k rows). Drop it for the load, re-add (and validate) after.
async fn drop_sensor_fk(pool: &PgPool) -> Result<()> {
    sqlx::query(&format!("ALTER TABLE readings DROP CONSTRAINT IF EXISTS {FK_NAME}"))
        .execute(pool)
        .await
        .context("dropping sensor FK")?;
    Ok(())
}

async fn restore_sensor_fk(pool: &PgPool) -> Result<()> {
    let t = std::time::Instant::now();
    sqlx::query(&format!(
        "ALTER TABLE readings ADD CONSTRAINT {FK_NAME} FOREIGN KEY (sensor_id) REFERENCES sensors(id)"
    ))
    .execute(pool)
    .await
    .context("re-adding sensor FK")?;
    info!(elapsed_ms = t.elapsed().as_millis(), "sensor FK restored and validated");
    Ok(())
}

async fn run_backfill(cfg: &Config, pool: &PgPool, devices: &mut [DeviceState], rng: &mut StdRng) -> Result<()> {
    drop_sensor_fk(pool).await?;
    let result = backfill_rows(cfg, pool, devices, rng).await;
    // Always try to put the constraint back, even if the load failed part-way.
    let restored = restore_sensor_fk(pool).await;
    result.and(restored)
}

async fn backfill_rows(cfg: &Config, pool: &PgPool, devices: &mut [DeviceState], rng: &mut StdRng) -> Result<()> {
    let steps = (cfg.end - cfg.start).num_seconds() / cfg.sample_interval.num_seconds();
    let expected = steps as u64 * devices.len() as u64 * METRICS_PER_DEVICE as u64;
    info!(start = %cfg.start, end = %cfg.end, interval_secs = cfg.sample_interval.num_seconds(), expected_rows = expected, "backfill starting");

    let started = std::time::Instant::now();
    let mut buf: Vec<Reading> = Vec::with_capacity(cfg.batch_size + devices.len() * METRICS_PER_DEVICE);
    let mut inserted: u64 = 0;
    let mut t = cfg.start;
    let mut last_log = std::time::Instant::now();

    while t < cfg.end {
        for d in devices.iter_mut() {
            d.sample(rng, t, &mut buf);
        }
        if buf.len() >= cfg.batch_size {
            inserted += flush_copy(pool, &mut buf).await?;
            if last_log.elapsed() >= Duration::from_secs(2) {
                let pct = inserted as f64 * 100.0 / expected.max(1) as f64;
                info!(inserted, pct = format!("{pct:.1}%"), cursor = %t, "backfill progress");
                last_log = std::time::Instant::now();
            }
        }
        t += cfg.sample_interval;
    }
    inserted += flush_copy(pool, &mut buf).await?;

    let secs = started.elapsed().as_secs_f64().max(0.001);
    info!(inserted, rows_per_sec = (inserted as f64 / secs) as u64, elapsed_secs = format!("{secs:.1}"), "backfill complete: END_DATE reached");
    Ok(())
}

async fn run_live(cfg: &Config, pool: &PgPool, devices: &mut [DeviceState], rng: &mut StdRng) -> Result<()> {
    info!(batch = cfg.batch_size, interval_ms = cfg.batch_interval.as_millis(), total = cfg.total_rows, "live mode starting");
    let mut buf: Vec<Reading> = Vec::with_capacity(cfg.batch_size);
    let mut inserted: u64 = 0;
    let mut ticker = tokio::time::interval(cfg.batch_interval.max(Duration::from_millis(1)));
    let started = std::time::Instant::now();

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!(inserted, "shutting down");
                return Ok(());
            }
            _ = ticker.tick() => {
                // Truncate to whole milliseconds: the API/front end track "last seen" at ms
                // precision, so sub-ms timestamps would be re-sent by the live tail.
                let now = DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
                let ticks = cfg.batch_size / (devices.len() * METRICS_PER_DEVICE);
                for i in 0..ticks.max(1) {
                    // Spread the batch across the interval so timestamps aren't all identical.
                    let at = now - ChronoDuration::milliseconds((ticks - i) as i64);
                    for d in devices.iter_mut() {
                        d.sample(rng, at, &mut buf);
                    }
                }
                inserted += flush_insert(pool, &mut buf).await?;
                let secs = started.elapsed().as_secs_f64().max(0.001);
                info!(inserted, rows_per_sec = (inserted as f64 / secs) as u64, "batch written");
                if cfg.total_rows > 0 && inserted >= cfg.total_rows {
                    info!(inserted, "reached TOTAL_ROWS, exiting");
                    return Ok(());
                }
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let cfg = Config::from_env()?;
    info!(mode = ?cfg.mode, devices = cfg.device_count, sensors = cfg.device_count as usize * METRICS_PER_DEVICE, truncate = cfg.truncate_on_start, "starting generator");

    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(30))
        .connect(&cfg.database_url)
        .await
        .context("connecting to postgres")?;

    if cfg.truncate_on_start {
        sqlx::query("TRUNCATE readings RESTART IDENTITY").execute(&pool).await.context("truncating readings")?;
        info!("cleared existing readings");
    }
    ensure_devices_and_sensors(&pool, cfg.device_count).await?;

    let mut rng = StdRng::from_entropy();
    let mut devices: Vec<DeviceState> = (1..=cfg.device_count).map(|id| DeviceState::new(id, &mut rng)).collect();

    match cfg.mode {
        Mode::Backfill => run_backfill(&cfg, &pool, &mut devices, &mut rng).await?,
        Mode::Live => run_live(&cfg, &pool, &mut devices, &mut rng).await?,
    }

    pool.close().await;
    Ok(())
}
