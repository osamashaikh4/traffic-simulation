// Shared helpers for all dashboard pages.
window.Traffic = (function () {
  "use strict";

  // Reads a CSS custom property so charts follow the current light/dark theme.
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Density colours (validated CVD-safe in both themes; always paired with a text label).
  const colors = () => ({ Low: cssVar("--low"), Medium: cssVar("--medium"), High: cssVar("--high") });

  function statusEl(level) {
    const span = document.createElement("span");
    span.className = `status status-${level.toLowerCase()}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    span.append(dot, level);
    return span;
  }

  // Renders records into a <tbody> with the standard six columns.
  function renderRecordRows(tbody, records, emptyMessage) {
    if (records.length === 0) {
      const tr = document.createElement("tr");
      const td = tr.insertCell();
      td.colSpan = 6;
      td.className = "empty";
      td.textContent = emptyMessage;
      tbody.replaceChildren(tr);
      return;
    }
    tbody.replaceChildren(...records.map((r) => {
      const tr = document.createElement("tr");
      const cells = [
        ["id", r.traffic_id],
        ["", r.scenario_label || "—"],
        ["num", r.vehicle_count],
        ["", statusEl(r.density_level)],
        ["num", `${r.green_time_seconds} s`],
        ["time", r.created_at],
      ];
      for (const [cls, value] of cells) {
        const td = tr.insertCell();
        if (cls) td.className = cls;
        if (value instanceof Node) td.appendChild(value); else td.textContent = value;
      }
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
    box.querySelector("span").textContent = message || "";
    box.hidden = !message;
  }

  return { cssVar, colors, statusEl, renderRecordRows, getJSON, showError };
})();
