// Home page: run simulations, animate them on the junction view, auto mode,
// edit the rules, and show the latest results.
// The browser generates the sample count; the Flask backend validates it,
// applies the rules, saves it to MySQL and returns the stored record.

(function () {
  "use strict";

  const { renderRecordRows, getJSON, showError, colors, cssVar, boundaryLines, statusEl } = window.Traffic;
  const RANGE = window.COUNT_RANGE;
  const rules = () => window.TRAFFIC_RULES; // replaced when the rules are edited

  const el = (id) => document.getElementById(id);
  const simulateBtn = el("simulate-btn");
  const manualForm = el("manual-form");
  const manualInput = el("manual-count");
  const manualError = el("manual-error");
  const labelInput = el("scenario-label");
  const speedSelect = el("speed");
  const autoBtn = el("auto-btn");

  const junction = window.Junction.create(el("junction"), {
    phase: el("hud-phase"),
    phaseDot: el("hud-phase-dot"),
    countdown: el("hud-countdown"),
    waiting: el("hud-waiting"),
    cleared: el("hud-cleared"),
  });

  let busy = false;        // a request or an animated signal cycle is in progress
  let autoRunning = false;
  let autoRuns = 0;

  // ---- Simulation ----------------------------------------------------------

  // Whole number from RANGE.min to RANGE.max inclusive (FR2).
  function generateVehicleCount() {
    return Math.floor(Math.random() * (RANGE.max - RANGE.min + 1)) + RANGE.min;
  }

  // Mirrors the server rules (validation.py) so obviously invalid values are
  // caught before sending. The server is still the authority.
  function validateManual(raw) {
    const text = raw.trim();
    if (text === "") return { error: "Please enter a vehicle count." };
    if (!/^[+-]?\d+$/.test(text)) {
      return isNaN(Number(text))
        ? { error: "Vehicle count must be a number." }
        : { error: "Vehicle count must be a whole number (decimals are not allowed)." };
    }
    const value = parseInt(text, 10);
    if (value < RANGE.min || value > RANGE.max) {
      return { error: `Vehicle count must be between ${RANGE.min} and ${RANGE.max}.` };
    }
    return { value };
  }

  const speed = () => Number(speedSelect.value);

  // Saves one simulation, shows it, then plays its signal cycle on the junction.
  // Resolves with the saved record, or null if the request failed.
  async function runSimulation(vehicleCount) {
    showError("");
    setBusy(true);
    try {
      const body = await getJSON("/api/simulations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_count: vehicleCount, scenario_label: labelInput.value }),
      });
      const rec = body.record;
      showResult(rec);
      loadRecent();
      if (speed() > 0) await junction.play(rec.vehicle_count, rec.green_time_seconds);
      return rec;
    } catch (err) {
      showError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function showResult(rec) {
    const rule = rules().find((r) => r.density === rec.density_level);
    el("result-count").textContent = rec.vehicle_count;

    el("result-density").textContent = rec.density_level;
    el("result-density-wrap").className = `metric-value density-${rec.density_level.toLowerCase()}`;
    el("result-range").textContent = `Range ${rule.min}–${rule.max} vehicles`;

    el("result-green").innerHTML = `${rec.green_time_seconds}<span class="unit"> s</span>`;

    el("result-explanation").innerHTML =
      `Vehicle count <strong>${rec.vehicle_count}</strong> is within ` +
      `<strong>${rule.min}–${rule.max}</strong>, so the density is ` +
      `<strong>${rec.density_level}</strong> and the recommended green time is ` +
      `<strong>${rec.green_time_seconds} seconds</strong>. Saved as record #${rec.traffic_id}.`;

    highlightRule(rec.density_level);

    const metrics = el("result-metrics");
    metrics.classList.remove("flash");
    void metrics.offsetWidth; // restart animation
    metrics.classList.add("flash");

    // Illustrative only: the signal head turns green to show a recommendation exists.
    document.querySelectorAll(".signal .lamp").forEach((l) => l.classList.remove("on"));
    document.querySelector(".signal .lamp.green").classList.add("on");
  }

  let lastDensity = null;
  function highlightRule(level) {
    lastDensity = level;
    document.querySelectorAll("#rules-table tbody tr").forEach((tr) => {
      tr.classList.toggle("active-rule", tr.dataset.density === level);
    });
  }

  function setBusy(value) {
    busy = value;
    const locked = busy || autoRunning;
    simulateBtn.disabled = locked;
    manualForm.querySelector("button").disabled = locked;
  }

  // While an animation is playing, choosing "Skip animation" fast-forwards it.
  speedSelect.addEventListener("change", () => junction.setSpeed(speed() || 32));
  junction.setSpeed(speed() || 32);

  // ---- Auto mode -------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function autoLoop() {
    while (autoRunning) {
      if (busy) { await sleep(200); continue; }
      const rec = await runSimulation(generateVehicleCount());
      if (!rec) { stopAuto(); break; } // stop on errors (e.g. database down)
      autoRuns += 1;
      el("auto-count").textContent = autoRuns;
      await sleep(speed() > 0 ? 700 : 1200); // short pause so each result can be read
    }
  }

  function startAuto() {
    autoRunning = true;
    autoRuns = 0;
    el("auto-count").textContent = "";
    autoBtn.setAttribute("aria-pressed", "true");
    setBusy(busy);
    autoLoop();
  }

  function stopAuto() {
    autoRunning = false;
    autoBtn.setAttribute("aria-pressed", "false");
    setBusy(busy);
  }

  autoBtn.addEventListener("click", () => (autoRunning ? stopAuto() : startAuto()));

  // ---- Recent results + chart --------------------------------------------------

  // One request feeds both the "Recent results" table and the chart.
  async function loadRecent() {
    try {
      const body = await getJSON(`/api/simulations?limit=${Math.max(window.RECENT_LIMIT, window.CHART_RUNS)}`);
      renderRecordRows(el("recent-body"), body.records.slice(0, window.RECENT_LIMIT), "No simulations saved yet.");
      renderChart(body.records.slice(0, window.CHART_RUNS).reverse()); // oldest on the left
    } catch (err) {
      el("recent-body").replaceChildren();
      showError(err.message);
    }
  }

  let chart = null;

  function renderChart(runs) {
    const empty = runs.length === 0;
    el("runs-chart-box").hidden = empty;
    el("runs-chart-empty").hidden = !empty;
    if (empty) return;

    const palette = colors();
    const ink = cssVar("--text-3");
    const grid = cssVar("--border");
    const latest = runs.length - 1;
    const data = {
      labels: runs.map((r) => `#${r.traffic_id}`),
      datasets: [{
        label: "Vehicle count",
        data: runs.map((r) => r.vehicle_count),
        backgroundColor: runs.map((r) => palette[r.density_level]),
        // Outline the newest run so the latest simulation is easy to spot.
        borderColor: runs.map((_, i) => (i === latest ? cssVar("--text") : "transparent")),
        borderWidth: runs.map((_, i) => (i === latest ? 2 : 0)),
        borderRadius: { topLeft: 4, topRight: 4 },
        borderSkipped: "bottom",
        maxBarThickness: 40,
        categoryPercentage: 0.9,
        barPercentage: 0.9,
      }],
    };

    if (chart) {
      chart.$runs = runs;
      chart.data = data;
      chart.update();
      return;
    }
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 13;
    Chart.defaults.color = ink;
    chart = new Chart(el("runs-chart"), {
      type: "bar",
      data,
      options: {
        maintainAspectRatio: false,
        layout: { padding: { right: 100, top: 6 } },
        scales: {
          x: { grid: { display: false }, border: { color: grid }, ticks: { color: ink, maxRotation: 0, autoSkip: true } },
          y: { min: 0, max: 50, grid: { color: grid }, border: { display: false }, ticks: { stepSize: 10, color: ink } },
        },
        plugins: {
          legend: { display: false },
          boundaryLines: { color: ink, ink },
          tooltip: {
            callbacks: {
              title: (items) => {
                const r = chart.$runs[items[0].dataIndex];
                return `Run #${r.traffic_id}${r.scenario_label ? " · " + r.scenario_label : ""}`;
              },
              label: (ctx) => {
                const r = chart.$runs[ctx.dataIndex];
                return `${r.vehicle_count} vehicles · ${r.density_level} · ${r.green_time_seconds} s green`;
              },
            },
          },
        },
      },
      plugins: [boundaryLines],
    });
    chart.$runs = runs;
  }

  // ---- Rules editor ---------------------------------------------------------------

  const rulesForm = el("rules-form");
  const rulesView = el("rules-view");
  const rulesEditBtn = el("rules-edit-btn");
  const rulesError = el("rules-error");
  const field = (name) => rulesForm.elements[name];
  const RULE_FIELDS = ["low_max", "medium_max", "low_green", "medium_green", "high_green"];
  let savedConfig = null;

  function fillForm(config) {
    RULE_FIELDS.forEach((k) => { field(k).value = config[k]; });
    updateRanges();
  }

  // Keep the "From" column in step with the limits being typed.
  function updateRanges() {
    const low = parseInt(field("low_max").value, 10);
    const med = parseInt(field("medium_max").value, 10);
    el("rule-medium-min").textContent = Number.isFinite(low) ? low + 1 : "–";
    el("rule-high-min").textContent = Number.isFinite(med) ? med + 1 : "–";
  }

  function setEditing(on) {
    rulesForm.hidden = !on;
    rulesView.hidden = on;
    rulesEditBtn.hidden = on;
    rulesError.textContent = "";
    RULE_FIELDS.forEach((k) => field(k).classList.remove("invalid"));
    if (on) field("low_max").focus();
  }

  function renderRulesTable(list) {
    el("rules-table").tBodies[0].replaceChildren(...list.map((r) => {
      const tr = document.createElement("tr");
      tr.dataset.density = r.density;
      const range = tr.insertCell(); range.className = "num"; range.textContent = `${r.min}–${r.max}`;
      tr.insertCell().appendChild(statusEl(r.density));
      const green = tr.insertCell(); green.className = "num"; green.textContent = `${r.green_time} s`;
      return tr;
    }));
    if (lastDensity) highlightRule(lastDensity);
  }

  function applyRules(payload) {
    window.TRAFFIC_RULES = payload.rules;
    savedConfig = payload.config;
    renderRulesTable(payload.rules);
    if (chart) chart.update(); // redraw the boundary lines
  }

  async function saveRules(method, body) {
    rulesError.textContent = "";
    try {
      const payload = await getJSON("/api/rules", {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      applyRules(payload);
      setEditing(false);
      const panel = rulesView.closest(".panel");
      panel.classList.remove("saved-flash");
      void panel.offsetWidth;
      panel.classList.add("saved-flash");
    } catch (err) {
      rulesError.textContent = err.message;
      // Point at the field the message is about, when we can tell.
      const msg = err.message.toLowerCase();
      const guess = msg.includes("low upper") ? "low_max" : msg.includes("medium upper") ? "medium_max"
        : msg.includes("low green") ? "low_green" : msg.includes("medium green") ? "medium_green"
        : msg.includes("high green") ? "high_green" : null;
      RULE_FIELDS.forEach((k) => field(k).classList.toggle("invalid", k === guess));
    }
  }

  rulesEditBtn.addEventListener("click", async () => {
    try {
      const payload = await getJSON("/api/rules");
      savedConfig = payload.config;
      fillForm(savedConfig);
    } catch (err) {
      showError(err.message);
      return;
    }
    setEditing(true);
  });
  el("rules-cancel").addEventListener("click", () => setEditing(false));
  el("rules-reset").addEventListener("click", () => {
    if (confirm("Reset the rules to the defaults (0–10 Low 15 s, 11–25 Medium 30 s, 26–50 High 45 s)?")) {
      saveRules("DELETE");
    }
  });
  rulesForm.addEventListener("input", (e) => { e.target.classList.remove("invalid"); updateRanges(); });
  rulesForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = {};
    RULE_FIELDS.forEach((k) => { body[k] = field(k).value; });
    saveRules("PUT", body);
  });
  rulesForm.addEventListener("keydown", (e) => { if (e.key === "Escape") setEditing(false); });

  // ---- Manual value + keyboard -------------------------------------------------------

  simulateBtn.addEventListener("click", () => runSimulation(generateVehicleCount()));

  manualForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy || autoRunning) return;
    const result = validateManual(manualInput.value);
    if (result.error) {
      manualInput.classList.add("invalid");
      manualInput.setAttribute("aria-invalid", "true");
      manualError.textContent = result.error;
      return; // invalid values are never saved (TC10-TC13)
    }
    clearManualError();
    runSimulation(result.value);
  });

  function clearManualError() {
    manualInput.classList.remove("invalid");
    manualInput.removeAttribute("aria-invalid");
    manualError.textContent = "";
  }
  manualInput.addEventListener("input", clearManualError);

  // Keyboard shortcut: S runs a random simulation (ignored while typing).
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "s" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    if (simulateBtn.disabled) return;
    e.preventDefault();
    simulateBtn.click();
  });

  loadRecent();
})();
