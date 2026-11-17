-- Runs once, on first start of the postgres container (empty data volume).
--
-- A *device* is a physical unit at a location. Each device exposes several *sensors*
-- (channels), one per metric, and every reading is a single value for one sensor.

CREATE TABLE IF NOT EXISTS devices (
    id         SMALLINT PRIMARY KEY,
    name       TEXT        NOT NULL,
    location   TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensors (
    id        SMALLINT PRIMARY KEY,
    device_id SMALLINT NOT NULL REFERENCES devices(id),
    metric    TEXT     NOT NULL,   -- temperature | humidity | pressure
    unit      TEXT     NOT NULL,   -- °C | % | hPa
    UNIQUE (device_id, metric)
);

CREATE TABLE IF NOT EXISTS readings (
    sensor_id   SMALLINT    NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    value       REAL        NOT NULL,
    -- One reading per sensor per instant; the index also serves per-sensor range scans.
    PRIMARY KEY (sensor_id, recorded_at),
    -- Named explicitly: the generator drops this during a backfill (per-row FK checks make
    -- COPY ~6x slower) and re-adds it, validated, when the load completes.
    CONSTRAINT readings_sensor_id_fkey FOREIGN KEY (sensor_id) REFERENCES sensors(id)
);

-- The generator writes backfills sensor-major (one sensor's whole range, then the next), so
-- each sensor's history is physically contiguous and a per-sensor range query reads only its
-- own pages. A BRIN index on recorded_at would be useless with that layout, so there is none.
