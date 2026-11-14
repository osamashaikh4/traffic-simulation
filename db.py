"""MySQL access for traffic_records."""

import os
from pathlib import Path

import pymysql
from flask import current_app, g

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
            cur.execute(SCHEMA_PATH.read_text())
    finally:
        conn.close()


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


def list_records(limit=50):
    """Newest first."""
    with get_db().cursor() as cur:
        cur.execute(
            "SELECT * FROM traffic_records ORDER BY created_at DESC, traffic_id DESC LIMIT %s",
            (limit,),
        )
        return cur.fetchall()


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
