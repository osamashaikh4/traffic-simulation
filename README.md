# Smart Traffic Monitoring and Management Web System (Bangladesh)

TM471 graduation project prototype. A web page that generates a **simulated**
vehicle count (0–50), classifies it as Low / Medium / High, recommends a
green-light duration (15 / 30 / 45 seconds), stores each result in MySQL and
shows a history table and charts.

> This is an academic simulation. It does not use cameras, sensors or GPS and
> it does **not** control any real traffic light.

## Rules (`rules.py`)

| Vehicle count | Density | Recommended green time |
|---|---|---|
| 0–10  | Low    | 15 seconds |
| 11–25 | Medium | 30 seconds |
| 26–50 | High   | 45 seconds |

All thresholds and durations are kept in `rules.py` so they can be changed in
one place (NFR4). The values are illustrative, not engineering standards.

## Requirements

- Python 3.10+
- MySQL 8 running locally
- A modern desktop browser (Chrome or Edge)

## Setup

```bash
cd smart-traffic
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Database connection (defaults shown - change if your MySQL has a password)
export MYSQL_HOST=localhost MYSQL_PORT=3306 MYSQL_USER=root MYSQL_PASSWORD= MYSQL_DATABASE=smart_traffic

flask --app app init-db      # creates the database and the traffic_records table
flask --app app run --port 8000   # open http://127.0.0.1:8000
```

On macOS, port 5000 is used by AirPlay Receiver (you get "Access denied"), so use another port such as 8000.

The table definition is in `schema.sql` if you prefer to create it by hand.

## Using the dashboard

A sidebar links the three pages.

**Home** - run simulations.
1. Optionally type a scenario label (e.g. "Test Run 1").
2. Click **Simulate Traffic**: the browser generates a random whole number
   from 0 to 50 and sends it to Flask.
3. Flask validates the value, applies the rules, saves the record and returns it.
4. The three result cards show count, density and green time, with a sentence
   explaining which rule was applied. The matching rule row is highlighted.
5. **Recent results** shows the latest 3 saved runs.

**Reports** - every saved run, newest first, 25 per page, with Low / Medium /
High filters and a button to clear all records.

**Analytics** (hidden for now - start the app with `SHOW_ANALYTICS=1` to show it) - summary figures (total runs, average count, average green
time, count range) and three charts: vehicle count per run (latest 50, with
the rule boundaries marked), runs by density, and the vehicle-count
distribution.

For boundary testing, open **Manual test value** and enter an exact number
(e.g. 10, 11, 25, 26). Blank, negative, over-50, decimal and non-numeric
values show a validation message and are never saved. Decimals are rejected,
not rounded (documented rule for TC13).

## Project structure

```
app.py           Flask app: pages, JSON API, init-db command
rules.py         Density and green-time rules (single source of truth)
validation.py    Input validation for vehicle counts and scenario labels
db.py            MySQL access (PyMySQL)
schema.sql       traffic_records table
templates/       base.html (sidebar layout), home, reports, analytics (Bootstrap 5)
static/          Page JavaScript (Chart.js 4 on Analytics) and CSS
tests/           Automated tests for report chapter 5
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET    | `/` | Home page |
| GET    | `/reports?density=High&page=2` | Reports page (both parameters optional) |
| GET    | `/analytics` | Analytics page |
| POST   | `/api/simulations` | Body `{"vehicle_count": 40, "scenario_label": "optional"}` → 201 with saved record, or 400 with `error` |
| GET    | `/api/simulations?limit=3` | Latest records (newest first, default 50) and totals per density |
| GET    | `/api/analytics` | Summary figures, density totals, latest 50 runs and count distribution |
| DELETE | `/api/simulations` | Clear all records |

## Tests

```bash
pytest -v
```

The tests use a separate `smart_traffic_test` database (override with
`MYSQL_TEST_DATABASE`) and cover:

- **TC01–TC09** (section 5.2): every functional case, both for the rule
  function and through the full API + database.
- **TC10–TC13** (section 5.3): blank, negative, over-50 and decimal inputs are
  rejected with a message and no record is saved.
- **Section 5.4**: one simulation creates exactly one record; the saved record
  matches the dashboard result and has a timestamp; history is newest first;
  chart totals update after new simulations.

Record the actual results of these runs in the report's test tables before
submission (Appendix D).
