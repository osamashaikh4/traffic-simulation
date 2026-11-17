"""MySQL access for traffic_records and rule_config."""

import os
from pathlib import Path

import pymysql
from flask import current_app, g

from rules import DEFAULT_CONFIG, build_rules

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def _connect(config, with_db=True):
    kwargs = dict(
        host=config["MYSQL_HOST"],
        port=config["MYSQL_PORT"],
        user=config["MYSQL_USER"],
        password=config["MYSQL_PASSWORD"],
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True,
        charset="utf8mb4",
    )
    if with_db:
        kwargs["database"] = config["MYSQL_DATABASE"]
    return pymysql.connect(**kwargs)


def get_db():
    if "db" not in g:
        g.db = _connect(current_app.config)
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(config):
    """Create the database (if missing) and the traffic_records table."""
    name = config["MYSQL_DATABASE"]
    if not name.replace("_", "").isalnum():
        raise ValueError("MYSQL_DATABASE may only contain letters, numbers and underscores.")
    conn = _connect(config, with_db=False)
    try:
        with conn.cursor() as cur:
            cur.execute(f"CREATE DATABASE IF NOT EXISTS `{name}` CHARACTER SET utf8mb4")
            cur.execute(f"USE `{name}`")
            for statement in SCHEMA_PATH.read_text().split(";"):
                if statement.strip():
                    cur.execute(statement)
            _migrate(cur, name)
    finally:
        conn.close()


def _migrate(cur, name):
    """Upgrade databases created before green times became configurable:
    the old CHECK only allowed 15, 30 or 45 seconds."""
    cur.execute(
        "SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS "
        "WHERE CONSTRAINT_SCHEMA = %s AND TABLE_NAME = 'traffic_records' "
        "AND CONSTRAINT_NAME = 'chk_green_time'",
        (name,),
    )
    if cur.fetchone()["n"]:
        cur.execute(
            "ALTER TABLE traffic_records DROP CHECK chk_green_time, "
            "ADD CONSTRAINT chk_green_time_range CHECK (green_time_seconds BETWEEN 5 AND 120)"
        )

    # Green times became ranges: low_green -> low_green_min + low_green_max, etc.
    cur.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'rule_config'",
        (name,),
    )
    columns = {row["COLUMN_NAME"] for row in cur.fetchall()}
    for level in ("low", "medium", "high"):
        if f"{level}_green" in columns and f"{level}_green_min" not in columns:
            cur.execute(
                f"ALTER TABLE rule_config RENAME COLUMN {level}_green TO {level}_green_min, "
                f"ADD COLUMN {level}_green_max INT NULL AFTER {level}_green_min"
            )
            cur.execute(f"UPDATE rule_config SET {level}_green_max = {level}_green_min")
            cur.execute(f"ALTER TABLE rule_config MODIFY {level}_green_max INT NOT NULL")


# --- Rule settings ----------------------------------------------------------

RULE_FIELDS = ("low_max", "medium_max", "low_green_min", "low_green_max",
               "medium_green_min", "medium_green_max", "high_green_min", "high_green_max")


def get_rule_config():
    """The saved rule settings, or the defaults when none have been saved."""
    with get_db().cursor() as cur:
        cur.execute(f"SELECT {', '.join(RULE_FIELDS)} FROM rule_config WHERE id = 1")
        row = cur.fetchone()
    return dict(row) if row else dict(DEFAULT_CONFIG)


def get_rules():
    return build_rules(get_rule_config())


def save_rule_config(config):
    values = [config[f] for f in RULE_FIELDS]
    updates = ", ".join(f"{f} = new.{f}" for f in RULE_FIELDS)
    with get_db().cursor() as cur:
        cur.execute(
            f"INSERT INTO rule_config (id, {', '.join(RULE_FIELDS)}) "
            f"VALUES (1, {', '.join(['%s'] * len(RULE_FIELDS))}) "
            f"AS new ON DUPLICATE KEY UPDATE {updates}",
            values,
        )


def reset_rule_config():
    with get_db().cursor() as cur:
        cur.execute("DELETE FROM rule_config")


# --- Traffic records ----------------------------------------------------------

def insert_record(scenario_label, vehicle_count, density_level, green_time_seconds):
    with get_db().cursor() as cur:
        cur.execute(
            "INSERT INTO traffic_records "
            "(scenario_label, vehicle_count, density_level, green_time_seconds) "
            "VALUES (%s, %s, %s, %s)",
            (scenario_label, vehicle_count, density_level, green_time_seconds),
        )
        record_id = cur.lastrowid
        cur.execute("SELECT * FROM traffic_records WHERE traffic_id = %s", (record_id,))
        return cur.fetchone()


def get_record(traffic_id):
    with get_db().cursor() as cur:
        cur.execute("SELECT * FROM traffic_records WHERE traffic_id = %s", (traffic_id,))
        return cur.fetchone()


def list_records(limit=50, offset=0, density=None):
    """Newest first, optionally filtered by density level."""
    where, params = ("WHERE density_level = %s", [density]) if density else ("", [])
    with get_db().cursor() as cur:
        cur.execute(
            f"SELECT * FROM traffic_records {where} "
            "ORDER BY created_at DESC, traffic_id DESC LIMIT %s OFFSET %s",
            (*params, limit, offset),
        )
        return cur.fetchall()


def count_records(density=None):
    where, params = ("WHERE density_level = %s", [density]) if density else ("", [])
    with get_db().cursor() as cur:
        cur.execute(f"SELECT COUNT(*) AS n FROM traffic_records {where}", params)
        return cur.fetchone()["n"]


def summary():
    with get_db().cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) AS total_runs, AVG(vehicle_count) AS avg_count, "
            "MIN(vehicle_count) AS min_count, MAX(vehicle_count) AS max_count, "
            "AVG(green_time_seconds) AS avg_green FROM traffic_records"
        )
        return cur.fetchone()


def count_frequencies():
    """{vehicle_count: number of runs} across all saved records."""
    with get_db().cursor() as cur:
        cur.execute(
            "SELECT vehicle_count, COUNT(*) AS total FROM traffic_records GROUP BY vehicle_count"
        )
        return {row["vehicle_count"]: row["total"] for row in cur.fetchall()}


def density_totals():
    with get_db().cursor() as cur:
        cur.execute(
            "SELECT density_level, COUNT(*) AS total FROM traffic_records GROUP BY density_level"
        )
        return {row["density_level"]: row["total"] for row in cur.fetchall()}


def delete_all_records():
    with get_db().cursor() as cur:
        cur.execute("DELETE FROM traffic_records")


def config_from_env():
    return {
        "MYSQL_HOST": os.environ.get("MYSQL_HOST", "localhost"),
        "MYSQL_PORT": int(os.environ.get("MYSQL_PORT", "3306")),
        "MYSQL_USER": os.environ.get("MYSQL_USER", "root"),
        "MYSQL_PASSWORD": os.environ.get("MYSQL_PASSWORD", ""),
        "MYSQL_DATABASE": os.environ.get("MYSQL_DATABASE", "smart_traffic"),
    }
