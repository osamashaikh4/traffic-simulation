import os
import sys
from pathlib import Path

import pymysql
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from app import create_app  # noqa: E402

TEST_DB = os.environ.get("MYSQL_TEST_DATABASE", "smart_traffic_test")


@pytest.fixture
def app():
    config = db.config_from_env()
    config["MYSQL_DATABASE"] = TEST_DB
    config["TESTING"] = True
    try:
        db.init_db(config)
    except pymysql.MySQLError as exc:
        pytest.skip(f"MySQL not available: {exc}")
    application = create_app(config)
    with application.app_context():
        db.delete_all_records()
        db.reset_rule_config()
        db.close_db()
    yield application


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def row_count(app):
    def count():
        with app.app_context():
            with db.get_db().cursor() as cur:
                cur.execute("SELECT COUNT(*) AS n FROM traffic_records")
                n = cur.fetchone()["n"]
            db.close_db()
            return n
    return count
