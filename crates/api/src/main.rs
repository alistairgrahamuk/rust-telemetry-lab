//! Streaming read API for sensor readings, plus static hosting of the React front end.
//!
//!   GET /api/sensors                         every sensor (device channel) with first/last reading
//!   GET /api/readings/stream?sensor_ids=1,4&from=&to=
//!                                            NDJSON: one `{"type":"meta",...}` line, then
//!                                            `[sensor_id, ts_ms, value]` per row, ordered by
//!                                            sensor then time (index order, no sort)
//!   GET /api/readings/live?sensor_ids=1,4&after=
//!                                            SSE: batches of `[sensor_id, ts_ms, value]` as rows arrive

use anyhow::{Context, Result};
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::get,
    Json, Router,
};
use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::{convert::Infallible, io::Write, net::SocketAddr, path::PathBuf, time::Duration};
use tower_http::{
    compression::{CompressionLayer, CompressionLevel},
    services::ServeDir,
    trace::TraceLayer,
};
use tracing::{error, info};

type Row = (i16, DateTime<Utc>, f32);

/// Flush NDJSON to the client once this many bytes are buffered (~2.5k rows).
const CHUNK_BYTES: usize = 64 * 1024;
const LIVE_POLL: Duration = Duration::from_secs(1);
const LIVE_BATCH_LIMIT: i64 = 50_000;
const MAX_SENSORS_PER_REQUEST: usize = 16;
/// The live poll is one indexed query however many sensors it covers, so it takes a whole dashboard.
const MAX_LIVE_SENSORS: usize = 512;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
}

#[derive(Serialize)]
struct Sensor {
    id: i16,
    device_id: i16,
    device: String,
    location: String,
    metric: String,
    unit: String,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
}

async fn sensors(State(st): State<AppState>) -> Result<Json<Vec<Sensor>>, ApiError> {
    type SensorRow = (
        i16,
        i16,
        String,
        String,
        String,
        String,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
    );
    let rows: Vec<SensorRow> = sqlx::query_as(
        "SELECT s.id, d.id, d.name, d.location, s.metric, s.unit,
                (SELECT min(recorded_at) FROM readings r WHERE r.sensor_id = s.id),
                (SELECT max(recorded_at) FROM readings r WHERE r.sensor_id = s.id)
         FROM sensors s JOIN devices d ON d.id = s.device_id
         ORDER BY d.id, s.id",
    )
    .fetch_all(&st.pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(id, device_id, device, location, metric, unit, first, last)| Sensor {
                id,
                device_id,
                device,
                location,
                metric,
                unit,
                first_ms: first.map(|t| t.timestamp_millis()),
                last_ms: last.map(|t| t.timestamp_millis()),
            })
            .collect(),
    ))
}

/// Comma-separated sensor ids, validated and de-duplicated.
fn parse_ids(raw: &str, max: usize) -> Result<Vec<i16>, ApiError> {
    let mut ids: Vec<i16> = raw
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            s.trim()
                .parse::<i16>()
                .map_err(|_| ApiError::bad_request(format!("invalid sensor id {s:?}")))
        })
        .collect::<Result<_, _>>()?;
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Err(ApiError::bad_request("sensor_ids is required".into()));
    }
    if ids.len() > max {
        return Err(ApiError::bad_request(format!("at most {max} sensors per request")));
    }
    Ok(ids)
}

#[derive(Deserialize)]
struct RangeQuery {
    sensor_ids: String,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
}

fn write_row(buf: &mut Vec<u8>, (sid, ts, v): Row) {
    let _ = writeln!(buf, "[{sid},{},{v:.2}]", ts.timestamp_millis());
}

async fn stream_readings(State(st): State<AppState>, Query(q): Query<RangeQuery>) -> Result<Response, ApiError> {
    let ids = parse_ids(&q.sensor_ids, MAX_SENSORS_PER_REQUEST)?;
    // chrono's MIN/MAX overflow Postgres' timestamptz range; use epoch..9999-12-31.
    let from = q.from.unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
    let to =
        q.to.unwrap_or_else(|| DateTime::from_timestamp(253_402_300_799, 0).unwrap());

    // Cheap index-only counts so the client can show progress. One query per sensor: with
    // several ids in an ANY(...) the planner prefers a parallel seq scan + sort over the
    // 45M-row table, which costs seconds before the first row; per-sensor queries always
    // walk the (sensor_id, recorded_at) primary key.
    let mut count: i64 = 0;
    for &id in &ids {
        let (c,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM readings WHERE sensor_id = $1 AND recorded_at >= $2 AND recorded_at < $3",
        )
        .bind(id)
        .bind(from)
        .bind(to)
        .fetch_one(&st.pool)
        .await?;
        count += c;
    }

    let pool = st.pool.clone();
    let body = async_stream::stream! {
        let mut buf = Vec::with_capacity(CHUNK_BYTES + 64);
        let _ = writeln!(buf, r#"{{"type":"meta","sensor_ids":{:?},"count":{},"from_ms":{},"to_ms":{}}}"#,
            ids, count, from.timestamp_millis(), to.timestamp_millis());

        // One index-ordered cursor per sensor, streamed back to back: rows start flowing within
        // milliseconds instead of after a whole-table sort (see the note on counts above).
        for id in ids {
            let mut rows = sqlx::query_as::<_, Row>(
                "SELECT sensor_id, recorded_at, value FROM readings
                 WHERE sensor_id = $1 AND recorded_at >= $2 AND recorded_at < $3
                 ORDER BY recorded_at",
            )
            .bind(id)
            .bind(from)
            .bind(to)
            .fetch(&pool);

            while let Some(row) = rows.next().await {
                match row {
                    Ok(r) => {
                        write_row(&mut buf, r);
                        if buf.len() >= CHUNK_BYTES {
                            yield Ok::<Bytes, sqlx::Error>(Bytes::from(std::mem::take(&mut buf)));
                        }
                    }
                    Err(e) => {
                        error!(error = %e, "readings stream aborted");
                        yield Err(e);
                        return;
                    }
                }
            }
        }
        if !buf.is_empty() {
            yield Ok(Bytes::from(buf));
        }
    };

    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(body),
    )
        .into_response())
}

#[derive(Deserialize)]
struct LiveQuery {
    sensor_ids: String,
    /// Only rows strictly after this instant are sent; defaults to now.
    after: Option<DateTime<Utc>>,
}

async fn live_readings(
    State(st): State<AppState>,
    Query(q): Query<LiveQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let ids = parse_ids(&q.sensor_ids, MAX_LIVE_SENSORS)?;
    let pool = st.pool.clone();
    let mut after = q.after.unwrap_or_else(Utc::now);

    let stream = async_stream::stream! {
        loop {
            tokio::time::sleep(LIVE_POLL).await;
            let rows: Result<Vec<Row>, _> = sqlx::query_as(
                "SELECT sensor_id, recorded_at, value FROM readings
                 WHERE sensor_id = ANY($1) AND recorded_at > $2
                 ORDER BY recorded_at, sensor_id LIMIT $3",
            )
            .bind(&ids)
            .bind(after)
            .bind(LIVE_BATCH_LIMIT)
            .fetch_all(&pool)
            .await;

            match rows {
                Ok(rows) if rows.is_empty() => continue,
                Ok(rows) => {
                    after = rows.last().unwrap().1;
                    let mut buf = Vec::with_capacity(rows.len() * 24);
                    buf.push(b'[');
                    for (i, r) in rows.into_iter().enumerate() {
                        if i > 0 { buf.push(b','); }
                        write_row(&mut buf, r);
                        buf.pop(); // drop the newline writeln! added
                    }
                    buf.push(b']');
                    yield Ok(Event::default().event("rows").data(String::from_utf8_lossy(&buf)));
                }
                Err(e) => {
                    error!(error = %e, "live poll failed");
                    yield Ok(Event::default().event("error").data(e.to_string()));
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

#[derive(Debug)]
struct ApiError(StatusCode, anyhow::Error);

impl ApiError {
    fn bad_request(msg: String) -> Self {
        Self(StatusCode::BAD_REQUEST, anyhow::anyhow!(msg))
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, e.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if self.0.is_server_error() {
            error!(error = %self.1, "request failed");
        }
        (self.0, self.1.to_string()).into_response()
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let static_dir = PathBuf::from(std::env::var("STATIC_DIR").unwrap_or_else(|_| "web/dist".into()));

    let pool = PgPoolOptions::new()
        .max_connections(16)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&database_url)
        .await
        .context("connecting to postgres")?;

    let index = static_dir.join("index.html");
    let app = Router::new()
        .route("/api/sensors", get(sensors))
        .route("/api/readings/stream", get(stream_readings))
        .route("/api/readings/live", get(live_readings))
        .route("/api/health", get(|| async { "ok" }))
        // SPA: unknown paths fall back to index.html so client-side routes work.
        .fallback_service(ServeDir::new(&static_dir).fallback(tower_http::services::ServeFile::new(index)))
        // Fastest level, zstd preferred (every current browser accepts it), gzip as fallback.
        // Measured on a 60 MB / 2.4 M-row stream: plain 1.9 s, zstd 1.95 s (10.9 MB), gzip
        // level 1 1.96 s (15.4 MB); the default gzip level took 4.6 s and was the bottleneck
        // for the browser. Skips text/event-stream by default.
        .layer(
            CompressionLayer::new()
                .zstd(true)
                .gzip(true)
                .quality(CompressionLevel::Fastest),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(AppState { pool });

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!(%addr, static_dir = %static_dir.display(), "api listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ids_sorts_dedups_and_trims() {
        assert_eq!(parse_ids("4, 1,1,,3", 16).unwrap(), vec![1, 3, 4]);
    }

    #[test]
    fn parse_ids_rejects_bad_input() {
        assert!(parse_ids("", 16).is_err());
        assert!(parse_ids(" , ", 16).is_err());
        assert!(parse_ids("1,abc", 16).is_err());
        assert!(parse_ids("99999", 16).is_err()); // does not fit i16
        let too_many = (1..=MAX_SENSORS_PER_REQUEST as i16 + 1)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert!(parse_ids(&too_many, MAX_SENSORS_PER_REQUEST).is_err());
        assert!(parse_ids(&too_many, MAX_LIVE_SENSORS).is_ok()); // the live cap is wider
        let just_enough = (1..=MAX_SENSORS_PER_REQUEST as i16)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(
            parse_ids(&just_enough, MAX_SENSORS_PER_REQUEST).unwrap().len(),
            MAX_SENSORS_PER_REQUEST
        );
    }
}
