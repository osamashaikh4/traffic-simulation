// Analytics page: KPI tiles and three charts from /api/analytics.

(function () {
  "use strict";

  const { cssVar, colors, getJSON, showError, boundaryLines } = window.Traffic;
  const RULES = window.TRAFFIC_RULES;
  const el = (id) => document.getElementById(id);
  let charts = [];
  let data = null;

  function theme() {
    return {
      ink: cssVar("--text-3"),
      text: cssVar("--text"),
      grid: cssVar("--border"),
      line: cssVar("--text-3"),
      surface: cssVar("--panel"),
      colors: colors(),
    };
  }

  function scales(t, extraY = {}) {
    return {
      x: { grid: { display: false }, border: { color: t.grid }, ticks: { color: t.ink } },
      y: {
        beginAtZero: true, grid: { color: t.grid }, border: { display: false },
        ticks: { precision: 0, color: t.ink }, ...extraY,
        title: extraY.title ? { ...extraY.title, color: t.ink } : undefined,
      },
    };
  }


  // Value (and optional share) above each bar - selective direct labels.
  const barValueLabels = {
    id: "barValueLabels",
    afterDatasetsDraw(chart, _args, opts) {
      const { ctx } = chart;
      const values = chart.data.datasets[0].data;
      const total = values.reduce((a, b) => a + b, 0);
      ctx.save();
      ctx.fillStyle = opts.color;
      ctx.font = "600 14px " + Chart.defaults.font.family;
      ctx.textAlign = "center";
      chart.getDatasetMeta(0).data.forEach((bar, i) => {
        if (!values[i] && !opts.showZero) return;
        const text = opts.percent && total ? `${values[i]} (${Math.round((values[i] / total) * 100)}%)` : `${values[i]}`;
        ctx.fillText(text, bar.x, bar.y - 6);
      });
      ctx.restore();
    },
  };

  function renderKpis(s) {
    el("kpi-runs").textContent = s.total_runs;
    el("kpi-avg").textContent = s.avg_count;
    el("kpi-green").innerHTML = `${s.avg_green}<span class="unit"> s</span>`;
    el("kpi-range").textContent = `${s.min_count}–${s.max_count}`;
  }

  function runsChart(t, recent) {
    const pointColors = recent.map((r) => t.colors[r.density_level]);
    return new Chart(el("runs-chart"), {
      type: "line",
      data: {
        labels: recent.map((r) => `#${r.traffic_id}`),
        datasets: [{
          label: "Vehicle count",
          data: recent.map((r) => r.vehicle_count),
          borderColor: t.line,
          borderWidth: 2,
          pointBackgroundColor: pointColors,
          pointBorderColor: t.surface,
          pointBorderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 8,
          tension: 0,
          clip: false, // keep points at 0 and 50 fully visible
        }],
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { right: 100, top: 8 } },
        interaction: { mode: "index", intersect: false },
        scales: scales(t, { min: 0, max: 50, title: { display: true, text: "Vehicles" } }),
        plugins: {
          legend: { display: false },
          boundaryLines: { color: t.ink, ink: t.ink },
          tooltip: {
            callbacks: {
              title: (items) => {
                const r = recent[items[0].dataIndex];
                return `Run #${r.traffic_id}${r.scenario_label ? " · " + r.scenario_label : ""}`;
              },
              label: (ctx) => {
                const r = recent[ctx.dataIndex];
                return `${r.vehicle_count} vehicles · ${r.density_level} · ${r.green_time_seconds} s green`;
              },
              footer: (items) => recent[items[0].dataIndex].created_at,
            },
          },
        },
      },
      plugins: [boundaryLines],
    });
  }

  function densityChart(t, totals) {
    const levels = RULES.map((r) => r.density);
    return new Chart(el("density-chart"), {
      type: "bar",
      data: {
        labels: levels,
        datasets: [{
          label: "Runs",
          data: levels.map((l) => totals[l]),
          backgroundColor: levels.map((l) => t.colors[l]),
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: "bottom",
          maxBarThickness: 64,
        }],
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        scales: scales(t),
        plugins: {
          legend: { display: false },
          barValueLabels: { percent: true, showZero: true, color: t.text },
          tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} runs` } },
        },
      },
      plugins: [barValueLabels],
    });
  }

  function distributionChart(t, buckets) {
    return new Chart(el("distribution-chart"), {
      type: "bar",
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [{
          label: "Runs",
          data: buckets.map((b) => b.runs),
          backgroundColor: buckets.map((b) => t.colors[b.density]),
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: "bottom",
          categoryPercentage: 0.92,
          barPercentage: 0.96,
        }],
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        scales: scales(t, { title: { display: true, text: "Runs" } }),
        plugins: {
          legend: { display: false },
          barValueLabels: { percent: false, showZero: false, color: t.text },
          tooltip: {
            callbacks: {
              title: (items) => `${items[0].label} vehicles`,
              label: (ctx) => `${ctx.parsed.y} runs · ${buckets[ctx.dataIndex].density}`,
            },
          },
        },
      },
      plugins: [barValueLabels],
    });
  }

  function drawCharts() {
    charts.forEach((c) => c.destroy());
    const t = theme();
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = t.ink;
    Chart.defaults.font.size = 13;
    charts = [runsChart(t, data.recent), densityChart(t, data.totals), distributionChart(t, data.distribution)];
  }

  async function load() {
    try {
      data = await getJSON("/api/analytics");
      if (!data.summary.total_runs) {
        el("empty-state").hidden = false;
        return;
      }
      el("analytics").hidden = false;
      renderKpis(data.summary);
      drawCharts();
    } catch (err) {
      showError(err.message);
    }
  }


  load();
})();
