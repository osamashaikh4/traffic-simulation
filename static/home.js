// Home page: run simulations and play them on the junction, compare with a
// fixed signal plan, replay earlier runs, auto mode, rules editor, and the
// latest results. The browser generates the sample count; the Flask backend
// validates it, applies the rules, saves it to MySQL and returns the record.

(function () {
  "use strict";

  const { renderRecordRows, getJSON, showError, colors, cssVar, boundaryLines, statusEl } = window.Traffic;
  const RANGE = window.COUNT_RANGE;
  const GREEN = window.GREEN_RANGE;
  const rules = () => window.TRAFFIC_RULES; // replaced when the rules are edited

  const el = (id) => document.getElementById(id);
  const simulateBtn = el("simulate-btn");
  const manualForm = el("manual-form");
  const manualInput = el("manual-count");
  const manualError = el("manual-error");
  const labelInput = el("scenario-label");
  const autoBtn = el("auto-btn");
  const compareBtn = el("compare-btn");
  const fixedInput = el("fixed-green");
  const stagePanel = el("stage-panel");

  // Small per-browser preferences (speed, scene, compare).
  const prefs = (() => { try { return JSON.parse(localStorage.getItem("sim-prefs")) || {}; } catch (e) { return {}; } })();
  const savePrefs = () => { try { localStorage.setItem("sim-prefs", JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  let speed = prefs.speed ?? 2;
  let scene = prefs.scene || "day";
  let compare = !!prefs.compare;
  let busy = false;
  let autoRunning = false;
  let autoRuns = 0;

  // ---- Junction views ----------------------------------------------------------

  const smart = window.Junction.create(el("stage-smart"));
  let fixed = null;
  const views = () => (compare && fixed ? [smart, fixed] : [smart]);

  function ensureFixedView() {
    if (!fixed) fixed = window.Junction.create(el("stage-fixed"));
    fixed.setSpeed(speed || 32);
    fixed.setScene(scene);
  }

  function fixedGreen() {
    const n = parseInt(fixedInput.value, 10);
    const value = Number.isFinite(n) ? Math.min(GREEN.max, Math.max(GREEN.min, n)) : 30;
    fixedInput.value = value;
    return value;
  }

  function setLabels(smartGreen) {
    if (!compare) { smart.setLabel(""); return; }
    smart.setLabel(smartGreen ? `SMART · ${smartGreen} s` : "SMART");
    smart.element.querySelector(".jx-label").classList.add("smart");
    fixed.setLabel(`FIXED · ${fixedGreen()} s`);
  }

  // ---- Running a simulation ---------------------------------------------------------

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

  // Saves one simulation and plays it. Resolves with the record, or null on error.
  async function runSimulation(vehicleCount) {
    showError("");
    setBusy(true);
    try {
      const body = await getJSON("/api/simulations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_count: vehicleCount, scenario_label: labelInput.value }),
      });
      loadRecent();
      await playRecord(body.record, false);
      return body.record;
    } catch (err) {
      showError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Plays a saved record on the junction (and the fixed plan when comparing).
  // The run's id is the seed, so a replay shows exactly the same vehicles.
  async function playRecord(rec, isReplay) {
    showResult(rec, isReplay);
    el("verdict").hidden = true;
    const count = rec.vehicle_count;
    const seed = rec.traffic_id;
    if (compare) ensureFixedView();
    setLabels(rec.green_time_seconds);

    let smartRes;
    let fixedRes;
    if (speed > 0) {
      const runs = [smart.play(count, rec.green_time_seconds, seed)];
      if (compare) runs.push(fixed.play(count, fixedGreen(), seed));
      [smartRes, fixedRes] = await Promise.all(runs);
    } else {
      smartRes = window.Junction.runInstant(count, rec.green_time_seconds, seed);
      smart.showResult(smartRes);
      if (compare) {
        fixedRes = window.Junction.runInstant(count, fixedGreen(), seed);
        fixed.showResult(fixedRes);
      }
    }
    if (compare && smartRes && fixedRes && !smartRes.interrupted && !fixedRes.interrupted) {
      renderVerdict(fixedRes, smartRes);
    }
  }

  async function replay(id) {
    if (busy || autoRunning) return;
    showError("");
    setBusy(true);
    try {
      const body = await getJSON(`/api/simulations/${id}`);
      stagePanel.scrollIntoView({ behavior: "smooth", block: "start" });
      await playRecord(body.record, true);
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function showResult(rec, isReplay) {
    el("result-count").textContent = rec.vehicle_count;
    el("result-density").textContent = rec.density_level;
    el("result-density-wrap").className = `r-value density-${rec.density_level.toLowerCase()}`;
    el("result-green").innerHTML = `${rec.green_time_seconds}<span class="unit"> s</span>`;
    el("replay-tag").hidden = !isReplay;
    el("replay-text").textContent = isReplay ? `#${rec.traffic_id}` : "";
    highlightRule(rec.density_level);

    const strip = el("result-metrics");
    strip.classList.remove("flash");
    void strip.offsetWidth; // restart animation
    strip.classList.add("flash");
  }

  function renderVerdict(f, s) {
    const side = (title, r) => {
      const ok = r.remaining === 0;
      const sub = r.target === 0 ? "no vehicles" : ok ? (r.unusedGreen > 0 ? `${r.unusedGreen} s green unused` : "green fully used") : `${r.remaining} still waiting`;
      return `<span class="v-title">${title} · ${r.green} s</span>` +
        `<span class="v-big ${ok ? "v-ok" : "v-bad"}">${ok ? "✓" : "✗"} ${r.cleared}<small>/ ${r.target}</small></span>` +
        `<span class="v-sub">${sub}</span>`;
    };
    el("v-fixed").innerHTML = side("Fixed", f);
    el("v-smart").innerHTML = side("Smart", s);

    const mid = el("v-mid");
    let text = "Same result";
    let cls = "";
    if (s.cleared !== f.cleared) {
      const d = s.cleared - f.cleared;
      text = `${d > 0 ? "+" : "−"}${Math.abs(d)} vehicle${Math.abs(d) === 1 ? "" : "s"}`;
      cls = d > 0 ? "win" : "lose";
    } else if (s.remaining === 0 && s.green !== f.green) {
      const d = f.green - s.green;
      text = d > 0 ? `${d} s less waiting` : `${-d} s longer green`;
      cls = d > 0 ? "win" : "lose";
    }
    mid.textContent = text;
    mid.className = `v-mid ${cls}`;
    el("verdict").hidden = false;
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
    compareBtn.disabled = busy;
    document.querySelectorAll(".replay-btn").forEach((b) => { b.disabled = locked; });
  }

  // ---- Toolbar: speed, scene, compare, auto, full screen ---------------------------------

  function selectSeg(groupId, attr, value) {
    el(groupId).querySelectorAll("button").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset[attr] === String(value)));
    });
  }

  function applySpeed(value) {
    speed = value;
    prefs.speed = value; savePrefs();
    selectSeg("speed-seg", "speed", value);
    views().forEach((v) => v.setSpeed(value || 32)); // "skip" fast-forwards anything playing
  }
  el("speed-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (b) applySpeed(Number(b.dataset.speed));
  });

  function applyScene(value) {
    scene = value;
    prefs.scene = value; savePrefs();
    selectSeg("scene-seg", "scene", value);
    views().forEach((v) => v.setScene(value));
  }
  el("scene-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (b) applyScene(b.dataset.scene);
  });

  function applyCompare(on) {
    compare = on;
    prefs.compare = on; savePrefs();
    compareBtn.setAttribute("aria-pressed", String(on));
    el("fixed-wrap").hidden = !on;
    el("stage-fixed").hidden = !on;
    el("verdict").hidden = true;
    if (on) ensureFixedView();
    setLabels(null);
  }
  compareBtn.addEventListener("click", () => applyCompare(!compare));
  fixedInput.addEventListener("change", () => { fixedGreen(); if (compare) setLabels(null); });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function autoLoop() {
    while (autoRunning) {
      if (busy) { await sleep(200); continue; }
      const rec = await runSimulation(generateVehicleCount());
      if (!rec) { stopAuto(); break; } // stop on errors (e.g. database down)
      autoRuns += 1;
      el("auto-count").textContent = autoRuns;
      await sleep(speed > 0 ? 900 : 1300); // a beat to see the result
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

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stagePanel.requestFullscreen) stagePanel.requestFullscreen();
  }
  el("fullscreen-btn").addEventListener("click", toggleFullscreen);

  // ---- Recent results + chart ------------------------------------------------------------

  // One request feeds both the "Recent results" table and the chart.
  async function loadRecent() {
    try {
      const body = await getJSON(`/api/simulations?limit=${Math.max(window.RECENT_LIMIT, window.CHART_RUNS)}`);
      const tbody = el("recent-body");
      const recent = body.records.slice(0, window.RECENT_LIMIT);
      renderRecordRows(tbody, recent, "No simulations saved yet.");
      if (recent.length) {
        [...tbody.rows].forEach((tr, i) => {
          const td = tr.insertCell();
          td.className = "row-action";
          const b = document.createElement("button");
          b.type = "button";
          b.className = "replay-btn";
          b.title = `Replay run #${recent[i].traffic_id}`;
          b.innerHTML = '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M10 9v6l5-3z" fill="currentColor"/></svg> Replay';
          b.disabled = busy || autoRunning;
          b.addEventListener("click", () => replay(recent[i].traffic_id));
          td.appendChild(b);
        });
      } else {
        tbody.rows[0].cells[0].colSpan = 7;
      }
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
        onClick: (_e, items) => { if (items.length) replay(chart.$runs[items[0].index].traffic_id); },
        onHover: (e, items) => { e.native.target.style.cursor = items.length ? "pointer" : ""; },
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
              footer: () => "Click to replay",
            },
          },
        },
      },
      plugins: [boundaryLines],
    });
    chart.$runs = runs;
  }

  // ---- Rules editor ----------------------------------------------------------------------

  const rulesForm = el("rules-form");
  const rulesView = el("rules-view");
  const rulesEditBtn = el("rules-edit-btn");
  const rulesError = el("rules-error");
  const field = (name) => rulesForm.elements[name];
  const RULE_FIELDS = ["low_max", "medium_max", "low_green", "medium_green", "high_green"];

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

  async function saveRules(method, body) {
    rulesError.textContent = "";
    try {
      const payload = await getJSON("/api/rules", {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      window.TRAFFIC_RULES = payload.rules;
      renderRulesTable(payload.rules);
      if (chart) chart.update(); // redraw the boundary lines
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
      fillForm((await getJSON("/api/rules")).config);
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

  // ---- Manual value + keyboard ---------------------------------------------------------------

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

  // Keyboard: S simulates, F toggles full screen (ignored while typing).
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    const key = e.key.toLowerCase();
    if (key === "s" && !simulateBtn.disabled) { e.preventDefault(); simulateBtn.click(); }
    if (key === "f") { e.preventDefault(); toggleFullscreen(); }
  });

  // ---- Start ---------------------------------------------------------------------------------------

  applySpeed(speed);
  applyScene(scene);
  applyCompare(compare);
  loadRecent();

  const replayId = new URLSearchParams(location.search).get("replay");
  if (replayId && /^\d+$/.test(replayId)) {
    history.replaceState(null, "", location.pathname);
    replay(Number(replayId));
  }
})();
