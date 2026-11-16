"""Smart Traffic Monitoring and Management Web System - Flask backend.

Architecture (report section 4.2): the browser generates a sample vehicle count
and sends it here; the backend validates it, applies the density and green-time
rules, stores the result in MySQL and serves saved records for the Reports and
Analytics pages.

This is an academic simulation. It does not control any real traffic signal.
"""

import csv
import io
import math
import os
from datetime import date

import click
import pymysql
from flask import Flask, Response, abort, jsonify, render_template, request

import db
from rules import GREEN_MAX, GREEN_MIN, MAX_COUNT, MIN_COUNT, classify, rules_as_dicts
from validation import (ValidationError, parse_rule_config, parse_scenario_label,
                        parse_vehicle_count)

DENSITY_LEVELS = ("Low", "Medium", "High")
RECENT_LIMIT = 3          # results shown on the home page
HOME_CHART_RUNS = 20      # runs shown on the dashboard chart
DASHBOARD_RECENT = 8      # results listed on the dashboard
PAGE_SIZES = (10, 20, 50, 100)
DEFAULT_PAGE_SIZE = 20
ANALYTICS_RUNS = 50       # runs shown on the "count per run" chart
# Histogram buckets line up with the 10/11 and 25/26 rule boundaries.
DISTRIBUTION_BUCKETS = [(0, 5), (6, 10), (11, 15), (16, 20), (21, 25),
                        (26, 30), (31, 35), (36, 40), (41, 45), (46, 50)]


def csv_safe(value):
    """Stop spreadsheet apps treating user text such as '=SUM(...)' as a formula."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def serialize(record):
    return {
        "traffic_id": record["traffic_id"],
        "scenario_label": record["scenario_label"],
        "vehicle_count": record["vehicle_count"],
        "density_level": record["density_level"],
        "green_time_seconds": record["green_time_seconds"],
        "created_at": record["created_at"].isoformat(sep=" "),
    }


def density_totals():
    totals = db.density_totals()
    return {level: totals.get(level, 0) for level in DENSITY_LEVELS}


def create_app(config=None):
    app = Flask(__name__)
    app.config.update(db.config_from_env())
    # The Analytics page is shown by default. Set SHOW_ANALYTICS=0 to hide it.
    app.config["SHOW_ANALYTICS"] = os.environ.get("SHOW_ANALYTICS", "1") == "1"
    if config:
        app.config.update(config)

    app.teardown_appcontext(db.close_db)

    @app.context_processor
    def nav_settings():
        return {"show_analytics": app.config["SHOW_ANALYTICS"]}

    def require_analytics():
        if not app.config["SHOW_ANALYTICS"]:
            abort(404)

    @app.errorhandler(pymysql.MySQLError)
    def database_error(exc):
        app.logger.exception("Database error")
        message = ("The database is not available. Check that MySQL is running "
                   "and that you ran 'flask --app app init-db'.")
        if request.path.startswith("/api/"):
            return jsonify(error=message), 503
        return render_template("error.html", message=message), 503

    # --- Pages ---------------------------------------------------------------

    @app.get("/")
    def home():
        return render_template(
            "home.html", rules=rules_as_dicts(db.get_rules()), rule_config=db.get_rule_config(),
            min_count=MIN_COUNT, max_count=MAX_COUNT, green_min=GREEN_MIN, green_max=GREEN_MAX,
            recent_limit=RECENT_LIMIT, chart_runs=HOME_CHART_RUNS,
        )

    @app.get("/dashboard")
    def dashboard():
        return render_template("dashboard.html", rules=rules_as_dicts(db.get_rules()),
                               recent_limit=DASHBOARD_RECENT, chart_runs=HOME_CHART_RUNS)

    @app.get("/about")
    def about():
        return render_template("about.html", rules=rules_as_dicts(db.get_rules()),
                               min_count=MIN_COUNT, max_count=MAX_COUNT)

    def density_filter():
        density = request.args.get("density") or None
        if density is not None and density not in DENSITY_LEVELS:
            abort(400)
        return density

    @app.get("/reports")
    def reports():
        density = density_filter()
        per_page = request.args.get("per_page", DEFAULT_PAGE_SIZE, type=int)
        if per_page not in PAGE_SIZES:
            per_page = DEFAULT_PAGE_SIZE
        total = db.count_records(density)
        pages = max(1, math.ceil(total / per_page))
        page = min(max(request.args.get("page", 1, type=int), 1), pages)
        records = db.list_records(per_page, (page - 1) * per_page, density)
        return render_template(
            "reports.html", records=[serialize(r) for r in records], totals=density_totals(),
            density=density, page=page, pages=pages, total=total,
            per_page=per_page, page_sizes=PAGE_SIZES,
            # omit per_page from links while it is the default, to keep URLs short
            per_page_arg=None if per_page == DEFAULT_PAGE_SIZE else per_page,
            first=(page - 1) * per_page + 1 if total else 0,
            last=(page - 1) * per_page + len(records),
        )

    @app.get("/reports/export.csv")
    def export_reports():
        density = density_filter()
        records = db.list_records(db.count_records(density), 0, density)
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(["ID", "Scenario", "Vehicle count", "Density", "Green time (s)", "Saved at"])
        for r in map(serialize, records):
            writer.writerow([r["traffic_id"], csv_safe(r["scenario_label"] or ""), r["vehicle_count"],
                             r["density_level"], r["green_time_seconds"], r["created_at"]])
        name = f"traffic-reports-{date.today().isoformat()}{'-' + density.lower() if density else ''}.csv"
        # UTF-8 byte-order mark so Excel reads the file as UTF-8.
        return Response("\ufeff" + out.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.get("/analytics")
    def analytics():
        require_analytics()
        return render_template("analytics.html", rules=rules_as_dicts(db.get_rules()),
                               analytics_runs=ANALYTICS_RUNS)

    # --- API -----------------------------------------------------------------

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

        density_level, green_time = classify(vehicle_count, db.get_rules())
        record = db.insert_record(scenario_label, vehicle_count, density_level, green_time)
        return jsonify(record=serialize(record)), 201

    @app.get("/api/simulations")
    def list_simulations():
        limit = min(max(request.args.get("limit", 50, type=int), 1), 500)
        records = [serialize(r) for r in db.list_records(limit)]
        return jsonify(records=records, totals=density_totals())

    @app.get("/api/simulations/<int:traffic_id>")
    def get_simulation(traffic_id):
        record = db.get_record(traffic_id)
        if record is None:
            return jsonify(error=f"Run #{traffic_id} was not found."), 404
        return jsonify(record=serialize(record))

    @app.delete("/api/simulations")
    def clear_simulations():
        db.delete_all_records()
        return "", 204

    @app.get("/api/analytics")
    def analytics_data():
        require_analytics()
        rules = db.get_rules()
        stats = db.summary()
        frequencies = db.count_frequencies()
        recent = [serialize(r) for r in reversed(db.list_records(ANALYTICS_RUNS))]
        distribution = [
            {
                "label": f"{low}–{high}",
                "density": classify(high, rules)[0],
                "runs": sum(frequencies.get(n, 0) for n in range(low, high + 1)),
            }
            for low, high in DISTRIBUTION_BUCKETS
        ]
        return jsonify(
            summary={
                "total_runs": stats["total_runs"],
                "avg_count": round(float(stats["avg_count"]), 1) if stats["total_runs"] else None,
                "min_count": stats["min_count"],
                "max_count": stats["max_count"],
                "avg_green": round(float(stats["avg_green"]), 1) if stats["total_runs"] else None,
            },
            totals=density_totals(),
            recent=recent,
            distribution=distribution,
        )

    def rules_payload():
        config = db.get_rule_config()
        return {"config": config, "rules": rules_as_dicts(db.get_rules())}

    @app.get("/api/rules")
    def get_rules():
        return jsonify(rules_payload())

    @app.put("/api/rules")
    def update_rules():
        try:
            config = parse_rule_config(request.get_json(silent=True))
        except ValidationError as exc:
            return jsonify(error=str(exc)), 400
        db.save_rule_config(config)
        return jsonify(rules_payload())

    @app.delete("/api/rules")
    def reset_rules():
        db.reset_rule_config()
        return jsonify(rules_payload())

    @app.cli.command("init-db")
    def init_db_command():
        """Create the MySQL database and traffic_records table."""
        db.init_db(app.config)
        click.echo(f"Database '{app.config['MYSQL_DATABASE']}' is ready.")

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True)
