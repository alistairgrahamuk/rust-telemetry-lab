//! Streaming read API for sensor readings, plus static hosting of the React front end.
//!
//!   GET /api/sensors                       sensors with their first/last reading
//!   GET /api/readings/stream?sensor_id=&from=&to=
//!                                          NDJSON: one `{"type":"meta",...}` line, then
//!                                          `[ts_ms, temperature, humidity, pressure]` per row
//!   GET /api/readings/live?sensor_id=&after=
//!                                          SSE: batches of new rows as they are inserted

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
use tower_http::{compression::CompressionLayer, services::ServeDir, trace::TraceLayer};
use tracing::{error, info};

type Row = (DateTime<Utc>, f32, f32, f32);

/// Flush NDJSON to the client once this many bytes are buffered (~1.5k rows).
const CHUNK_BYTES: usize = 64 * 1024;
const LIVE_POLL: Duration = Duration::from_secs(1);
const LIVE_BATCH_LIMIT: i64 = 10_000;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
}

#[derive(Serialize)]
struct Sensor {
    id: i16,
    name: String,
    location: String,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
}

async fn sensors(State(st): State<AppState>) -> Result<Json<Vec<Sensor>>, ApiError> {
    let rows: Vec<(i16, String, String, Option<DateTime<Utc>>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT s.id, s.name, s.location,
                (SELECT min(recorded_at) FROM readings r WHERE r.sensor_id = s.id),
                (SELECT max(recorded_at) FROM readings r WHERE r.sensor_id = s.id)
         FROM sensors s ORDER BY s.id",
    )
    .fetch_all(&st.pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(id, name, location, first, last)| Sensor {
                id,
                name,
                location,
                first_ms: first.map(|t| t.timestamp_millis()),
                last_ms: last.map(|t| t.timestamp_millis()),
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
struct RangeQuery {
    sensor_id: i16,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
}

fn write_row(buf: &mut Vec<u8>, (ts, t, h, p): Row) {
    // Compact positional arrays keep 192k rows/month-range around 7 MB uncompressed.
    let _ = writeln!(buf, "[{},{:.2},{:.2},{:.2}]", ts.timestamp_millis(), t, h, p);
}

async fn stream_readings(State(st): State<AppState>, Query(q): Query<RangeQuery>) -> Result<Response, ApiError> {
    // chrono's MIN/MAX overflow Postgres' timestamptz range; use epoch..9999-12-31.
    let from = q.from.unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
    let to = q.to.unwrap_or_else(|| DateTime::from_timestamp(253_402_300_799, 0).unwrap());

    // Cheap index-only count so the client can show progress.
    let (count,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM readings WHERE sensor_id = $1 AND recorded_at >= $2 AND recorded_at < $3")
            .bind(q.sensor_id)
            .bind(from)
            .bind(to)
            .fetch_one(&st.pool)
            .await?;

    let pool = st.pool.clone();
    let body = async_stream::stream! {
        let mut buf = Vec::with_capacity(CHUNK_BYTES + 64);
        let _ = writeln!(buf, r#"{{"type":"meta","sensor_id":{},"count":{},"from_ms":{},"to_ms":{}}}"#,
            q.sensor_id, count, from.timestamp_millis(), to.timestamp_millis());

        let mut rows = sqlx::query_as::<_, Row>(
            "SELECT recorded_at, temperature, humidity, pressure FROM readings
             WHERE sensor_id = $1 AND recorded_at >= $2 AND recorded_at < $3
             ORDER BY recorded_at",
        )
        .bind(q.sensor_id)
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
        if !buf.is_empty() {
            yield Ok(Bytes::from(buf));
        }
    };

    Ok((
        [(header::CONTENT_TYPE, "application/x-ndjson"), (header::CACHE_CONTROL, "no-store")],
        Body::from_stream(body),
    )
        .into_response())
}

#[derive(Deserialize)]
struct LiveQuery {
    sensor_id: i16,
    /// Only rows strictly after this instant are sent; defaults to now.
    after: Option<DateTime<Utc>>,
}

async fn live_readings(
    State(st): State<AppState>,
    Query(q): Query<LiveQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let pool = st.pool.clone();
    let mut after = q.after.unwrap_or_else(Utc::now);

    let stream = async_stream::stream! {
        loop {
            tokio::time::sleep(LIVE_POLL).await;
            let rows: Result<Vec<Row>, _> = sqlx::query_as(
                "SELECT recorded_at, temperature, humidity, pressure FROM readings
                 WHERE sensor_id = $1 AND recorded_at > $2
                 ORDER BY recorded_at LIMIT $3",
            )
            .bind(q.sensor_id)
            .bind(after)
            .bind(LIVE_BATCH_LIMIT)
            .fetch_all(&pool)
            .await;

            match rows {
                Ok(rows) if rows.is_empty() => continue,
                Ok(rows) => {
                    after = rows.last().unwrap().0;
                    let mut buf = Vec::with_capacity(rows.len() * 40);
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

    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

struct ApiError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error!(error = %self.0, "request failed");
        (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()).into_response()
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
        .layer(CompressionLayer::new()) // skips text/event-stream by default
        .layer(TraceLayer::new_for_http())
        .with_state(AppState { pool });

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!(%addr, static_dir = %static_dir.display(), "api listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
