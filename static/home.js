// Home page: run simulations and show the latest few results.
// The browser generates the sample count; the Flask backend validates it,
// applies the rules, saves it to MySQL and returns the stored record.

(function () {
  "use strict";

  const { renderRecordRows, getJSON, showError, colors, cssVar, boundaryLines } = window.Traffic;
  const RULES = window.TRAFFIC_RULES;
  const RANGE = window.COUNT_RANGE;

  const el = (id) => document.getElementById(id);
  const simulateBtn = el("simulate-btn");
  const manualForm = el("manual-form");
  const manualInput = el("manual-count");
  const manualError = el("manual-error");
  const labelInput = el("scenario-label");

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

  async function runSimulation(vehicleCount) {
    showError("");
    setBusy(true);
    try {
      const body = await getJSON("/api/simulations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_count: vehicleCount, scenario_label: labelInput.value }),
      });
      showResult(body.record);
      await loadRecent();
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function showResult(rec) {
    const rule = RULES.find((r) => r.density === rec.density_level);
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

    document.querySelectorAll("#rules-table tbody tr").forEach((tr) => {
      tr.classList.toggle("active-rule", tr.dataset.density === rec.density_level);
    });

    const metrics = el("result-metrics");
    metrics.classList.remove("flash");
    void metrics.offsetWidth; // restart animation
    metrics.classList.add("flash");

    // Illustrative only: the signal head turns green to show a recommendation exists.
    document.querySelectorAll(".signal .lamp").forEach((l) => l.classList.remove("on"));
    document.querySelector(".signal .lamp.green").classList.add("on");
  }

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

  function setBusy(busy) {
    simulateBtn.disabled = busy;
    manualForm.querySelector("button").disabled = busy;
  }

  simulateBtn.addEventListener("click", () => runSimulation(generateVehicleCount()));

  manualForm.addEventListener("submit", (e) => {
    e.preventDefault();
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
