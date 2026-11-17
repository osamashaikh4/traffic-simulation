// Simulation page: run simulations and play them on the junction, compare
// with a fixed signal plan, replay earlier runs, auto mode and rules editor. The browser generates the sample count; the Flask backend
// validates it, applies the rules, saves it to MySQL and returns the record.

(function () {
  "use strict";

  const { getJSON, showError } = window.Traffic;
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

  // ---- System status pill -------------------------------------------------------
  const statusPill = el("status-pill");
  let offline = false;
  function setStatus() {
    const state = offline ? "offline" : busy ? "running" : "ready";
    statusPill.dataset.state = state;
    el("status-text").textContent = state === "offline" ? "Database Offline" : state === "running" ? "Simulating" : "System Ready";
  }
  async function checkStatus() {
    try { await getJSON("/api/rules"); offline = false; } catch (e) { offline = true; }
    setStatus();
  }

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
      offline = false;
      await playRecord(body.record, false);
      return body.record;
    } catch (err) {
      showError(err.message);
      if (/database/i.test(err.message)) offline = true;
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
    const rule = rules().find((r) => r.density === rec.density_level);
    el("result-count").textContent = rec.vehicle_count;
    el("result-density").textContent = rec.density_level;
    el("result-density-wrap").className = `density-pill density-${rec.density_level.toLowerCase()}`;
    el("result-range").textContent = rule ? `(${rule.min} – ${rule.max} vehicles)` : "";
    el("result-green").textContent = `${rec.green_time_seconds} Seconds`;
    const scaled = rule && rule.green_min !== rule.green_max
      ? ` (scaled within ${rule.green_min}–${rule.green_max} s for ${rule.min}–${rule.max} vehicles)` : "";
    el("result-explanation").textContent =
      `${rec.vehicle_count} vehicles fall within the ${rec.density_level} density category, ` +
      `so the system recommends ${rec.green_time_seconds} seconds${scaled}.`;
    el("replay-tag").hidden = !isReplay;
    el("replay-text").textContent = isReplay ? `#${rec.traffic_id}` : "";
    highlightRule(rec.density_level);

    document.querySelectorAll(".stat-card").forEach((card) => {
      card.classList.remove("flash");
      void card.offsetWidth; // restart animation
      card.classList.add("flash");
    });
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
    document.querySelectorAll("#rules-view .rule-item").forEach((item) => {
      item.classList.toggle("active-rule", item.dataset.density === level);
    });
  }

  function setBusy(value) {
    busy = value;
    const locked = busy || autoRunning;
    simulateBtn.disabled = locked;
    manualForm.querySelector("button").disabled = locked;
    compareBtn.disabled = busy;
    setStatus();
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

  // ---- Rules editor ----------------------------------------------------------------------

  const rulesForm = el("rules-form");
  const rulesView = el("rules-view");
  const rulesEditBtn = el("rules-edit-btn");
  const rulesError = el("rules-error");
  const field = (name) => rulesForm.elements[name];
  const RULE_FIELDS = ["low_max", "medium_max", "low_green_min", "low_green_max",
    "medium_green_min", "medium_green_max", "high_green_min", "high_green_max"];

  // Same formula as rules.green_for(): linear inside the band, rounded half up.
  function greenFor(count, low, high, gMin, gMax) {
    if (high === low || gMin === gMax) return gMin;
    return Math.floor(gMin + ((count - low) / (high - low)) * (gMax - gMin) + 0.5);
  }

  function fillForm(config) {
    RULE_FIELDS.forEach((k) => { field(k).value = config[k]; });
    updateRanges();
  }

  // Keep the "From" column and the preview in step with what is being typed.
  function updateRanges() {
    const num = (k) => parseInt(field(k).value, 10);
    const low = num("low_max");
    const med = num("medium_max");
    el("rule-medium-min").textContent = Number.isFinite(low) ? low + 1 : "–";
    el("rule-high-min").textContent = Number.isFinite(med) ? med + 1 : "–";
    const bands = { low: [0, low], medium: [low + 1, med], high: [med + 1, window.COUNT_MAX] };
    for (const [name, [from, to]] of Object.entries(bands)) {
      const cell = rulesForm.querySelector(`[data-preview="${name}"]`);
      const gMin = num(`${name}_green_min`);
      const gMax = num(`${name}_green_max`);
      if (![from, to, gMin, gMax].every(Number.isFinite) || to < from || gMax < gMin) { cell.textContent = "–"; continue; }
      const mid = Math.round((from + to) / 2);
      const points = [...new Set([from, mid, to])];
      cell.textContent = points.map((n) => `${n}\u2192${greenFor(n, from, to, gMin, gMax)}`).join(" · ") + " s";
    }
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
    const art = el("rules-view").querySelector(".rules-art");
    el("rules-view").replaceChildren(...list.map((r) => {
      const item = document.createElement("div");
      item.className = "rule-item";
      item.dataset.density = r.density;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = `var(--${r.density.toLowerCase()})`;
      const text = document.createElement("div");
      text.innerHTML = `<b>${r.density} Density</b><span>(${r.min}–${r.max} vehicles)</span><br><span>→ ${r.green_label} seconds</span>`;
      item.append(dot, text);
      return item;
    }), art);
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
      setEditing(false);
      const panel = rulesView.closest(".panel");
      panel.classList.remove("saved-flash");
      void panel.offsetWidth;
      panel.classList.add("saved-flash");
    } catch (err) {
      rulesError.textContent = err.message;
      // Point at the field the message is about, when we can tell.
      const msg = err.message.toLowerCase();
      const level = msg.startsWith("low") ? "low" : msg.startsWith("medium") ? "medium" : msg.startsWith("high") ? "high" : null;
      const guess = msg.includes("upper limit") ? `${level}_max`
        : level && msg.includes("maximum green") ? `${level}_green_max`
        : level && msg.includes("minimum green") ? `${level}_green_min` : null;
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
    if (confirm("Reset the rules to the defaults (0–10 Low 15 s, 11–25 Medium 30 s, 26–50 High 45 s, fixed)?")) {
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
  checkStatus();

  const replayId = new URLSearchParams(location.search).get("replay");
  if (replayId && /^\d+$/.test(replayId)) {
    history.replaceState(null, "", location.pathname);
    replay(Number(replayId));
  }
})();
