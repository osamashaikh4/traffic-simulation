// Shared helpers for all dashboard pages.
window.Traffic = (function () {
  "use strict";

  // Validated with the dataviz palette checker (CVD-safe; amber always ships with a text label).
  const COLORS = { Low: "#3a9f6c", Medium: "#d4a017", High: "#9b1c1c" };

  function densityBadge(level) {
    const badge = document.createElement("span");
    badge.className = `badge density-${level.toLowerCase()}`;
    badge.textContent = level;
    return badge;
  }

  // Renders records into a <tbody> with the standard six columns.
  function renderRecordRows(tbody, records, emptyMessage) {
    if (records.length === 0) {
      tbody.innerHTML = "";
      const tr = tbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = 6;
      td.className = "text-muted";
      td.textContent = emptyMessage;
      return;
    }
    tbody.replaceChildren(...records.map((r) => {
      const tr = document.createElement("tr");
      [r.traffic_id, r.scenario_label || "—", r.vehicle_count, densityBadge(r.density_level),
       `${r.green_time_seconds} s`, r.created_at].forEach((value) => {
        const td = tr.insertCell();
        if (value instanceof Node) td.appendChild(value); else td.textContent = value;
      });
      return tr;
    }));
  }

  async function getJSON(url, options) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    return body;
  }

  function showError(message) {
    const box = document.getElementById("request-error");
    if (!box) return;
    box.textContent = message;
    box.classList.toggle("d-none", !message);
  }

  return { COLORS, densityBadge, renderRecordRows, getJSON, showError };
})();
