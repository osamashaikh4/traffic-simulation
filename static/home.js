// Home page: run simulations and show the latest few results.
// The browser generates the sample count; the Flask backend validates it,
// applies the rules, saves it to MySQL and returns the stored record.

(function () {
  "use strict";

  const { renderRecordRows, getJSON, showError } = window.Traffic;
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

  async function loadRecent() {
    try {
      const body = await getJSON(`/api/simulations?limit=${window.RECENT_LIMIT}`);
      renderRecordRows(el("recent-body"), body.records, "No simulations saved yet.");
    } catch (err) {
      el("recent-body").innerHTML = "";
      showError(err.message);
    }
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
      manualInput.classList.add("is-invalid");
      manualError.textContent = result.error;
      return; // invalid values are never saved (TC10-TC13)
    }
    manualInput.classList.remove("is-invalid");
    runSimulation(result.value);
  });

  manualInput.addEventListener("input", () => manualInput.classList.remove("is-invalid"));

  loadRecent();
})();
