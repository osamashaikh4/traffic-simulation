-- Smart Traffic Monitoring prototype - database schema (report section 4.7)

-- Each row is one traffic simulation result.
CREATE TABLE IF NOT EXISTS traffic_records (
    traffic_id         INT AUTO_INCREMENT PRIMARY KEY,
    scenario_label     VARCHAR(50) NULL,
    vehicle_count      INT NOT NULL,
    density_level      VARCHAR(10) NOT NULL,
    green_time_seconds INT NOT NULL,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_vehicle_count CHECK (vehicle_count BETWEEN 0 AND 50),
    CONSTRAINT chk_density_level CHECK (density_level IN ('Low', 'Medium', 'High')),
    CONSTRAINT chk_green_time_range CHECK (green_time_seconds BETWEEN 5 AND 120)
);

-- The active density/green-time rules (a single row, id = 1). Each band has a
-- green-time range, and the time scales with the count inside the band.
-- When the row is missing the defaults in rules.py are used.
CREATE TABLE IF NOT EXISTS rule_config (
    id           TINYINT PRIMARY KEY,
    low_max      INT NOT NULL,
    medium_max   INT NOT NULL,
    low_green_min    INT NOT NULL,
    low_green_max    INT NOT NULL,
    medium_green_min INT NOT NULL,
    medium_green_max INT NOT NULL,
    high_green_min   INT NOT NULL,
    high_green_max   INT NOT NULL,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_rule_single_row CHECK (id = 1),
    CONSTRAINT chk_rule_bands CHECK (low_max >= 0 AND medium_max > low_max AND medium_max < 50)
);
