// Smart Traffic dashboard - client-side logic.
// The browser generates the sample count; the Flask backend validates it,
// applies the rules, saves it to MySQL and returns the stored record.

(function () {
  "use strict";

  const RULES = window.TRAFFIC_RULES;
  const RANGE = window.COUNT_RANGE;
  const CHART_POINTS = 20;
  const COLORS = { Low: "#1e8e3e", Medium: "#b06000", High: "#c5221f" };

  const el = (id) => document.getElementById(id);
  const simulateBtn = el("simulate-btn");
  const manualForm = el("manual-form");
  const manualInput = el("manual-count");
  const manualError = el("manual-error");
  const requestError = el("request-error");
  const labelInput = el("scenario-label");

  let countChart, densityChart;

  // --- Simulation -----------------------------------------------------------

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
    hideRequestError();
    setBusy(true);
    try {
      const res = await fetch("/api/simulations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_count: vehicleCount, scenario_label: labelInput.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
      showResult(body.record);
      await loadHistory();
    } catch (err) {
      showRequestError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // --- Rendering ------------------------------------------------------------

  function showResult(rec) {
    const rule = RULES.find((r) => r.density === rec.density_level);
    el("result-count").textContent = rec.vehicle_count;

    const density = el("result-density");
    density.textContent = rec.density_level;
    density.className = `display-5 fw-semibold text-density-${rec.density_level.toLowerCase()}`;
    el("result-range").textContent = `Range ${rule.min}–${rule.max} vehicles`;

    el("result-green").textContent = `${rec.green_time_seconds} s`;

    el("result-explanation").innerHTML =
      `Vehicle count <strong>${rec.vehicle_count}</strong> is within ` +
      `<strong>${rule.min}–${rule.max}</strong>, so the density is ` +
      `<strong>${rec.density_level}</strong> and the recommended green time is ` +
      `<strong>${rec.green_time_seconds} seconds</strong>. Saved as record #${rec.traffic_id}.`;

    document.querySelectorAll("#rules-table tbody tr").forEach((tr) => {
      tr.classList.toggle("active-rule", tr.dataset.density === rec.density_level);
    });

    document.querySelectorAll(".result-card").forEach((card) => {
      card.classList.remove("flash");
      void card.offsetWidth; // restart animation
      card.classList.add("flash");
    });

    // Illustrative only: the signal head turns green to show a recommendation exists.
    document.querySelectorAll(".signal .lamp").forEach((l) => l.classList.remove("on"));
    document.querySelector(".signal .lamp.green").classList.add("on");
  }

  function renderHistory(records) {
    const tbody = el("history-body");
    if (records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted">No simulations saved yet.</td></tr>';
      return;
    }
    tbody.replaceChildren(...records.map((r) => {
      const tr = document.createElement("tr");
      const cells = [
        r.traffic_id,
        r.scenario_label || "—",
        r.vehicle_count,
        null,
        `${r.green_time_seconds} s`,
        r.created_at,
      ];
      cells.forEach((value, i) => {
        const td = document.createElement("td");
        if (i === 3) {
          const badge = document.createElement("span");
          badge.className = `badge density-${r.density_level.toLowerCase()}`;
          badge.textContent = r.density_level;
          td.appendChild(badge);
        } else {
          td.textContent = value;
        }
        tr.appendChild(td);
      });
      return tr;
    }));
  }

  function renderCharts(records, totals) {
    const recent = records.slice(0, CHART_POINTS).reverse(); // oldest -> newest
    const labels = recent.map((r) => `#${r.traffic_id}`);
    const counts = recent.map((r) => r.vehicle_count);
    const pointColors = recent.map((r) => COLORS[r.density_level]);

    if (!countChart) {
      countChart = new Chart(el("count-chart"), {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: "Vehicle count",
            data: counts,
            borderColor: "#6c757d",
            pointBackgroundColor: pointColors,
            pointBorderColor: pointColors,
            pointRadius: 5,
            tension: 0,
          }],
        },
        options: {
          maintainAspectRatio: false,
          scales: { y: { min: RANGE.min, max: RANGE.max, title: { display: true, text: "Vehicles" } } },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                afterLabel: (ctx) => {
                  const r = recent[ctx.dataIndex];
                  return `${r.density_level} · ${r.green_time_seconds} s green`;
                },
              },
            },
          },
        },
      });
    } else {
      countChart.data.labels = labels;
      countChart.data.datasets[0].data = counts;
      countChart.data.datasets[0].pointBackgroundColor = pointColors;
      countChart.data.datasets[0].pointBorderColor = pointColors;
      countChart.update();
    }

    const levels = ["Low", "Medium", "High"];
    const values = levels.map((l) => totals[l]);
    if (!densityChart) {
      densityChart = new Chart(el("density-chart"), {
        type: "bar",
        data: {
          labels: levels,
          datasets: [{ label: "Runs", data: values, backgroundColor: levels.map((l) => COLORS[l]) }],
        },
        options: {
          maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
          plugins: { legend: { display: false } },
        },
      });
    } else {
      densityChart.data.datasets[0].data = values;
      densityChart.update();
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch("/api/simulations");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not load history (${res.status}).`);
      renderHistory(body.records);
      renderCharts(body.records, body.totals);
    } catch (err) {
      el("history-body").innerHTML = "";
      showRequestError(err.message);
    }
  }

  // --- UI helpers -----------------------------------------------------------

  function setBusy(busy) {
    simulateBtn.disabled = busy;
    manualForm.querySelector("button").disabled = busy;
  }

  function showRequestError(msg) {
    requestError.textContent = msg;
    requestError.classList.remove("d-none");
  }

  function hideRequestError() {
    requestError.classList.add("d-none");
  }

  // --- Events ---------------------------------------------------------------

  simulateBtn.addEventListener("click", () => runSimulation(generateVehicleCount()));

  manualForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const result = validateManual(manualInput.value);
    if (result.error) {
      manualInput.classList.add("is-invalid");
      manualError.textContent = result.error;
      return; // invalid values are never saved (TC10-TC13)
    }
    manualInput.classList.remove("is-invalid");
    runSimulation(result.value);
  });

  manualInput.addEventListener("input", () => manualInput.classList.remove("is-invalid"));

  el("clear-btn").addEventListener("click", async () => {
    if (!confirm("Delete all saved simulation records?")) return;
    hideRequestError();
    const res = await fetch("/api/simulations", { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showRequestError(body.error || "Could not clear history.");
      return;
    }
    await loadHistory();
  });

  loadHistory();
})();
