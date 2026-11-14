-- Smart Traffic Monitoring prototype - database schema (report section 4.7)
-- One table: each row is one traffic simulation result.

CREATE TABLE IF NOT EXISTS traffic_records (
    traffic_id         INT AUTO_INCREMENT PRIMARY KEY,
    scenario_label     VARCHAR(50) NULL,
    vehicle_count      INT NOT NULL,
    density_level      VARCHAR(10) NOT NULL,
    green_time_seconds INT NOT NULL,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_vehicle_count CHECK (vehicle_count BETWEEN 0 AND 50),
    CONSTRAINT chk_density_level CHECK (density_level IN ('Low', 'Medium', 'High')),
    CONSTRAINT chk_green_time CHECK (green_time_seconds IN (15, 30, 45))
);
