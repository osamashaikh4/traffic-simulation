// Dashboard: totals, the "Last N runs" chart and the latest results.
// Clicking a bar or "Replay" plays that run again on the Simulation page.

(function () {
  "use strict";

  const { renderRecordRows, getJSON, showError, colors, cssVar, boundaryLines } = window.Traffic;
  const el = (id) => document.getElementById(id);
  const replayUrl = (id) => `/?replay=${id}`;

  function renderTiles(totals) {
    el("tile-total").textContent = totals.Low + totals.Medium + totals.High;
    el("tile-low").textContent = totals.Low;
    el("tile-medium").textContent = totals.Medium;
    el("tile-high").textContent = totals.High;
  }

  function renderRecent(records) {
    const tbody = el("recent-body");
    renderRecordRows(tbody, records, "No simulations saved yet.");
    if (!records.length) { tbody.rows[0].cells[0].colSpan = 7; return; }
    [...tbody.rows].forEach((tr, i) => {
      const td = tr.insertCell();
      td.className = "row-action";
      const a = document.createElement("a");
      a.className = "replay-link";
      a.href = replayUrl(records[i].traffic_id);
      a.title = `Replay run #${records[i].traffic_id}`;
      a.innerHTML = '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M10 9v6l5-3z" fill="currentColor"/></svg> Replay';
      td.appendChild(a);
    });
  }

  function renderChart(runs) {
    const empty = runs.length === 0;
    el("runs-chart-box").hidden = empty;
    el("runs-chart-empty").hidden = !empty;
    if (empty) return;

    const palette = colors();
    const ink = cssVar("--text-3");
    const grid = cssVar("--border");
    const latest = runs.length - 1;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 13;
    Chart.defaults.color = ink;
    new Chart(el("runs-chart"), {
      type: "bar",
      data: {
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
          maxBarThickness: 44,
          categoryPercentage: 0.9,
          barPercentage: 0.9,
        }],
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { right: 100, top: 6 } },
        onClick: (_e, items) => { if (items.length) location.href = replayUrl(runs[items[0].index].traffic_id); },
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
                const r = runs[items[0].dataIndex];
                return `Run #${r.traffic_id}${r.scenario_label ? " · " + r.scenario_label : ""}`;
              },
              label: (ctx) => {
                const r = runs[ctx.dataIndex];
                return `${r.vehicle_count} vehicles · ${r.density_level} · ${r.green_time_seconds} s green`;
              },
              footer: () => "Click to replay",
            },
          },
        },
      },
      plugins: [boundaryLines],
    });
  }

  async function load() {
    try {
      const limit = Math.max(window.RECENT_LIMIT, window.CHART_RUNS);
      const body = await getJSON(`/api/simulations?limit=${limit}`);
      renderTiles(body.totals);
      renderRecent(body.records.slice(0, window.RECENT_LIMIT));
      renderChart(body.records.slice(0, window.CHART_RUNS).reverse()); // oldest on the left
    } catch (err) {
      el("recent-body").replaceChildren();
      showError(err.message);
    }
  }

  load();
})();
