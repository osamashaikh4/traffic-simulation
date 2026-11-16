// Analytics page: KPI tiles and three charts from /api/analytics.

(function () {
  "use strict";

  const { COLORS, getJSON, showError } = window.Traffic;
  const RULES = window.TRAFFIC_RULES;
  const INK = "#5f6368";
  const GRID = "#eceff1";
  const el = (id) => document.getElementById(id);

  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = INK;

  const recessiveScales = (extraY = {}) => ({
    x: { grid: { display: false }, border: { color: GRID } },
    y: { beginAtZero: true, grid: { color: GRID }, border: { display: false },
         ticks: { precision: 0 }, ...extraY },
  });

  // Draws dashed horizontal lines at the Low/Medium upper limits (10 and 25 by default).
  const boundaryLines = {
    id: "boundaryLines",
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#9aa0a6";
      ctx.fillStyle = INK;
      ctx.font = "11px " + Chart.defaults.font.family;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      RULES.slice(0, -1).forEach((r) => {
        const y = scales.y.getPixelForValue(r.max + 0.5);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, y);
        ctx.lineTo(chartArea.right, y);
        ctx.stroke();
        // Label sits in the right-hand padding, clear of the data points.
        ctx.fillText(`${r.density} ≤ ${r.max}`, chartArea.right + 8, y);
      });
      ctx.restore();
    },
  };

  // Writes each bar's value above it (selective direct labels).
  const barValueLabels = {
    id: "barValueLabels",
    afterDatasetsDraw(chart, _args, opts) {
      const { ctx } = chart;
      const data = chart.data.datasets[0].data;
      const total = data.reduce((a, b) => a + b, 0);
      ctx.save();
      ctx.fillStyle = "#202124";
      ctx.font = "600 12px " + Chart.defaults.font.family;
      ctx.textAlign = "center";
      chart.getDatasetMeta(0).data.forEach((bar, i) => {
        if (!data[i] && !opts.showZero) return;
        const text = opts.percent && total ? `${data[i]} (${Math.round((data[i] / total) * 100)}%)` : `${data[i]}`;
        ctx.fillText(text, bar.x, bar.y - 6);
      });
      ctx.restore();
    },
  };

  function renderKpis(s) {
    el("kpi-runs").textContent = s.total_runs;
    el("kpi-avg").textContent = s.avg_count;
    el("kpi-green").textContent = `${s.avg_green} s`;
    el("kpi-range").textContent = `${s.min_count}–${s.max_count}`;
  }

  function renderRunsChart(recent) {
    const colors = recent.map((r) => COLORS[r.density_level]);
    new Chart(el("runs-chart"), {
      type: "line",
      data: {
        labels: recent.map((r) => `#${r.traffic_id}`),
        datasets: [{
          label: "Vehicle count",
          data: recent.map((r) => r.vehicle_count),
          borderColor: "#80868b",
          borderWidth: 2,
          pointBackgroundColor: colors,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          tension: 0,
        }],
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { right: 84 } },
        interaction: { mode: "index", intersect: false },
        scales: recessiveScales({ min: 0, max: 50, title: { display: true, text: "Vehicles" } }),
        plugins: {
          legend: { display: false },
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

  function renderDensityChart(totals) {
    const levels = RULES.map((r) => r.density);
    new Chart(el("density-chart"), {
      type: "bar",
      data: {
        labels: levels,
        datasets: [{
          label: "Runs",
          data: levels.map((l) => totals[l]),
          backgroundColor: levels.map((l) => COLORS[l]),
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: "bottom",
          maxBarThickness: 64,
        }],
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        scales: recessiveScales(),
        plugins: {
          legend: { display: false },
          barValueLabels: { percent: true, showZero: true },
          tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} runs` } },
        },
      },
      plugins: [barValueLabels],
    });
  }

  function renderDistributionChart(buckets) {
    new Chart(el("distribution-chart"), {
      type: "bar",
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [{
          label: "Runs",
          data: buckets.map((b) => b.runs),
          backgroundColor: buckets.map((b) => COLORS[b.density]),
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: "bottom",
          categoryPercentage: 0.92,
          barPercentage: 0.96,
        }],
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        scales: recessiveScales({ title: { display: true, text: "Runs" } }),
        plugins: {
          legend: { display: false },
          barValueLabels: { percent: false, showZero: false },
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

  async function load() {
    try {
      const data = await getJSON("/api/analytics");
      if (!data.summary.total_runs) {
        el("empty-state").classList.remove("d-none");
        return;
      }
      el("analytics").classList.remove("d-none");
      renderKpis(data.summary);
      renderRunsChart(data.recent);
      renderDensityChart(data.totals);
      renderDistributionChart(data.distribution);
    } catch (err) {
      showError(err.message);
    }
  }

  load();
})();
