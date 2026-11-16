# Smart Traffic Monitoring and Management Web System (Bangladesh)

TM471 graduation project prototype. A web page that generates a **simulated**
vehicle count (0–50), classifies it as Low / Medium / High, recommends a
green-light duration (15 / 30 / 45 seconds), stores each result in MySQL and
shows a history table and charts.

> This is an academic simulation. It does not use cameras, sensors or GPS and
> it does **not** control any real traffic light.

## Rules (`rules.py`, editable on Home)

| Vehicle count | Density | Recommended green time |
|---|---|---|
| 0–10  | Low    | 15 seconds |
| 11–25 | Medium | 30 seconds |
| 26–50 | High   | 45 seconds |

These are the defaults (in `rules.py`). They can be changed from the **Edit**
button on the Home page's Rules panel; the active rules are stored in the
`rule_config` table and apply to the next simulation (saved results keep the
values they were given). Limits: bands stay contiguous over 0–50 with at least
one count each, green times 5–120 s. **Reset to defaults** restores the table
above. The values are illustrative, not engineering standards.

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

flask --app app init-db      # creates or updates the database tables (safe to re-run)
flask --app app run --port 8000   # open http://127.0.0.1:8000
```

On macOS, port 5000 is used by AirPlay Receiver (you get "Access denied"), so use another port such as 8000.

The table definition is in `schema.sql` if you prefer to create it by hand.

## Using the dashboard

A sidebar links the pages. Everything (font and chart library) is served
from `static/vendor/`, so it works offline.

**Home** - the live junction.
1. Click **Simulate traffic** (or press **S**). The browser generates a random
   whole number from 0 to 50 and sends it to Flask, which validates it, applies
   the rules, saves the record and returns it. Type an exact value and press
   **Run** to test a specific count; type a **Label** to tag the run.
2. The big numbers show vehicles, density and recommended green time.
3. The junction (top-down, left-hand traffic as in Bangladesh) plays the run:
   the vehicles queue on the highlighted west road, its light turns green for
   the recommended time, and they drive through. A big signal shows the light
   and the seconds left; the counter shows vehicles through, ending in a tick
   (all through) or a cross with the number still waiting. Hover a vehicle to
   see its type and speed. Other roads carry background traffic.
4. Toolbar: **speed** 1x-8x or skip (instant result), **scene** day / night /
   rain (visual only), **Compare**, **Auto** (back-to-back random runs),
   and **full screen** (or press **F**) for presenting.
5. **Compare** plays the same queue twice: once with the rule's green time
   (Smart) and once with a fixed green time you choose (Fixed, default 30 s),
   then shows vehicles through, vehicles left waiting and unused green for each.
6. Each run is generated from its record number, so **replaying** a run (click
   a bar in *Last 20 runs*, *Replay* in Recent results or on Reports) shows
   exactly the same vehicles and result. Replays are not saved again.
7. **Rules** shows the active bands (Edit to change them); **Recent results**
   shows the latest 3 runs.

The animation assumes roughly one vehicle every 2 seconds per lane once
moving; it is an illustration, not a calibrated traffic model.

**Reports** - every saved run, newest first, with Low / Medium / High
filters, 20 rows per page by default (10, 20, 50 or 100 selectable),
**Export CSV** (downloads the records matching the current filter; opens in
Excel) and a button to clear all records.

**Analytics** (set `SHOW_ANALYTICS=0` to hide it) - summary figures (total runs, average count, average green
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
schema.sql       traffic_records and rule_config tables
templates/       base.html (sidebar layout), home, reports, analytics, _icons.html
static/          style.css, page JavaScript, junction.js (junction animation),
                 vendor/ (Inter font, Chart.js 4)
tests/           Automated tests for report chapter 5
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET    | `/` | Home page |
| GET    | `/reports?density=High&page=2&per_page=50` | Reports page (all parameters optional) |
| GET    | `/reports/export.csv?density=High` | CSV download of all matching records |
| GET    | `/analytics` | Analytics page |
| POST   | `/api/simulations` | Body `{"vehicle_count": 40, "scenario_label": "optional"}` → 201 with saved record, or 400 with `error` |
| GET    | `/api/simulations/<id>` | One saved run (used for replays) |
| GET    | `/api/simulations?limit=3` | Latest records (newest first, default 50) and totals per density |
| GET    | `/api/analytics` | Summary figures, density totals, latest 50 runs and count distribution |
| DELETE | `/api/simulations` | Clear all records |
| GET    | `/api/rules` | Active rule settings and bands |
| PUT    | `/api/rules` | Body `{"low_max": 10, "medium_max": 25, "low_green": 15, "medium_green": 30, "high_green": 45}` → saves, or 400 with `error` |
| DELETE | `/api/rules` | Reset rules to the defaults |

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
