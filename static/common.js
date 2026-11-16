// Shared helpers for all dashboard pages.
window.Traffic = (function () {
  "use strict";

  // Reads a CSS custom property so charts use the same colours as the page.
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Density colours (validated colour-blind safe; always paired with a text label).
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

  // Chart.js plugin: dashed horizontal lines at the Low/Medium upper limits,
  // labelled in the chart's right padding. Reads the page's window.TRAFFIC_RULES.
  const boundaryLines = {
    id: "boundaryLines",
    afterDatasetsDraw(chart, _args, opts) {
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = opts.color;
      ctx.fillStyle = opts.ink;
      ctx.font = "13px " + Chart.defaults.font.family;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      window.TRAFFIC_RULES.slice(0, -1).forEach((r) => {
        const y = scales.y.getPixelForValue(r.max + 0.5);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, y);
        ctx.lineTo(chartArea.right, y);
        ctx.stroke();
        ctx.fillText(`${r.density} ≤ ${r.max}`, chartArea.right + 8, y);
      });
      ctx.restore();
    },
  };

  return { cssVar, colors, statusEl, renderRecordRows, getJSON, showError, boundaryLines };
})();
