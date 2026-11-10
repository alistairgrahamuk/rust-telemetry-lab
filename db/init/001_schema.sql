-- Runs once, on first start of the postgres container (empty data volume).

CREATE TABLE IF NOT EXISTS sensors (
    id         SMALLINT PRIMARY KEY,
    name       TEXT        NOT NULL,
    location   TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS readings (
    id          BIGSERIAL   PRIMARY KEY,
    sensor_id   SMALLINT    NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    temperature REAL        NOT NULL,
    humidity    REAL        NOT NULL,
    pressure    REAL        NOT NULL,
    -- Named explicitly: the generator drops this during a backfill (per-row FK checks make
    -- COPY ~6x slower) and re-adds it, validated, when the load completes.
    CONSTRAINT readings_sensor_id_fkey FOREIGN KEY (sensor_id) REFERENCES sensors(id)
);

-- One reading per sensor per timestamp; also serves "sensor X between t1 and t2" queries.
CREATE UNIQUE INDEX IF NOT EXISTS readings_sensor_time_idx ON readings (sensor_id, recorded_at);
-- Cheap time-range index that stays tiny even at hundreds of millions of rows.
CREATE INDEX IF NOT EXISTS readings_time_brin_idx ON readings USING BRIN (recorded_at);
