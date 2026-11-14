"""Smart Traffic Monitoring and Management Web System - Flask backend.

Architecture (report section 4.2): the browser generates a sample vehicle count
and sends it here; the backend validates it, applies the density and green-time
rules, stores the result in MySQL and serves saved records for the history
table and chart.

This is an academic simulation. It does not control any real traffic signal.
"""

import click
import pymysql
from flask import Flask, jsonify, render_template, request

import db
from rules import MAX_COUNT, MIN_COUNT, classify, rules_as_dicts
from validation import ValidationError, parse_scenario_label, parse_vehicle_count

HISTORY_LIMIT = 50


def serialize(record):
    return {
        "traffic_id": record["traffic_id"],
        "scenario_label": record["scenario_label"],
        "vehicle_count": record["vehicle_count"],
        "density_level": record["density_level"],
        "green_time_seconds": record["green_time_seconds"],
        "created_at": record["created_at"].isoformat(sep=" "),
    }


def create_app(config=None):
    app = Flask(__name__)
    app.config.update(db.config_from_env())
    if config:
        app.config.update(config)

    app.teardown_appcontext(db.close_db)

    @app.errorhandler(pymysql.MySQLError)
    def database_error(exc):
        app.logger.exception("Database error")
        return jsonify(error="The database is not available. Check that MySQL is running "
                             "and that you ran 'flask --app app init-db'."), 503

    @app.get("/")
    def dashboard():
        return render_template(
            "index.html", rules=rules_as_dicts(), min_count=MIN_COUNT, max_count=MAX_COUNT
        )

    @app.post("/api/simulations")
    def create_simulation():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(error="Request body must be JSON."), 400
        try:
            vehicle_count = parse_vehicle_count(data.get("vehicle_count"))
            scenario_label = parse_scenario_label(data.get("scenario_label"))
        except ValidationError as exc:
            return jsonify(error=str(exc)), 400

        density_level, green_time = classify(vehicle_count)
        record = db.insert_record(scenario_label, vehicle_count, density_level, green_time)
        return jsonify(record=serialize(record)), 201

    @app.get("/api/simulations")
    def list_simulations():
        records = [serialize(r) for r in db.list_records(HISTORY_LIMIT)]
        totals = db.density_totals()
        return jsonify(
            records=records,
            totals={level: totals.get(level, 0) for level in ("Low", "Medium", "High")},
        )

    @app.delete("/api/simulations")
    def clear_simulations():
        db.delete_all_records()
        return "", 204

    @app.cli.command("init-db")
    def init_db_command():
        """Create the MySQL database and traffic_records table."""
        db.init_db(app.config)
        click.echo(f"Database '{app.config['MYSQL_DATABASE']}' is ready.")

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True)
