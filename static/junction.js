// Top-down ("god view") junction simulation.
//
// The simulated vehicle count becomes the queue on the west approach
// (eastbound). That approach gets the recommended green time; the other
// roads carry illustrative background traffic. Bangladesh drives on the left.
//
// The model (createModel) has no DOM code so it can be tested in Node.
// The view (Junction.create) draws the model on a <canvas> and drives it.

(function (root) {
  "use strict";

  const W = 1100;
  const H = 560;
  const ROAD = { hTop: 238, hBot: 322, hMid: 280, vLeft: 758, vRight: 842, vMid: 800 };
  const SIDEWALK = 12;

  // Approach geometry. s = distance travelled from the entry point.
  const GEOM = {
    E: { axis: "x", dir: 1, entry: -60, stop: 730, exit: W + 60, angle: 0, signal: "main" },
    W: { axis: "x", dir: -1, entry: W + 60, stop: 870, exit: -60, angle: Math.PI, signal: "main" },
    S: { axis: "y", dir: 1, entry: -60, stop: 210, exit: H + 60, angle: Math.PI / 2, signal: "cross" },
    N: { axis: "y", dir: -1, entry: H + 60, stop: 350, exit: -60, angle: -Math.PI / 2, signal: "cross" },
  };
  // Left-hand traffic: eastbound uses the north half, southbound the east half, etc.
  const LANES = [
    ["E1", "E", 248], ["E2", "E", 268],
    ["W1", "W", 292], ["W2", "W", 312],
    ["S1", "S", 812], ["S2", "S", 832],
    ["N1", "N", 788], ["N2", "N", 768],
  ];

  const TYPES = {
    car: { len: 21, w: 12, v0: 90, colors: ["#f1f3f4", "#202124", "#9aa0a6", "#1a56db", "#b42318", "#f8fafc", "#4b5563", "#0f766e", "#7c2d12"] },
    cng: { len: 16, w: 11, v0: 80, colors: ["#15803d"] },
    bus: { len: 36, w: 13, v0: 75, colors: ["#b42318", "#1d4ed8", "#c2410c", "#047857"] },
  };

  // Intelligent Driver Model parameters (pixels, seconds). 1 px ~ 0.15 m.
  const IDM = { a: 28, b: 45, T: 1.4, s0: 5 };

  const PHASES = {
    crossAmber: 3,
    allRed1: 1.5,
    amber: 3,
    allRed2: 1.5,
  };
  const AMBIENT_RATE = { W: 0.12, S: 0.15, N: 0.15 }; // vehicles per second per lane

  function idmAccel(v, v0, gap, dv) {
    const free = 1 - Math.pow(v / v0, 4);
    if (gap === Infinity) return IDM.a * free;
    const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
    const g = Math.max(gap, 0.1);
    return IDM.a * (free - (sStar / g) * (sStar / g));
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------

  function createModel(options = {}) {
    const rand = options.rand || Math.random;
    const ambient = options.ambient !== false;

    const lanes = LANES.map(([id, group, fixed]) => {
      const g = GEOM[group];
      return {
        id, group, fixed, ...g,
        stopS: (g.stop - g.entry) * g.dir,
        exitS: (g.exit - g.entry) * g.dir,
        vehicles: [],
      };
    });
    const eastLanes = lanes.filter((l) => l.group === "E");

    const state = {
      phase: "idle", t: 0, main: "red", cross: "green",
      green: 0, target: 0, cleared: 0, counting: false, run: 0,
    };
    let resolveRun = null;
    let nextId = 1;

    function randomType() {
      const r = rand();
      return r < 0.55 ? "car" : r < 0.88 ? "cng" : "bus";
    }

    function makeVehicle(s, v) {
      const type = randomType();
      const spec = TYPES[type];
      return {
        id: nextId++, type, s, v: v * spec.v0, len: spec.len, w: spec.w, v0: spec.v0 * (0.92 + rand() * 0.16),
        color: spec.colors[Math.floor(rand() * spec.colors.length)], braking: false, goOnAmber: null,
      };
    }

    function backOf(lane) {
      let back = Infinity;
      for (const v of lane.vehicles) back = Math.min(back, v.s - v.len);
      return back;
    }

    function waitingEast() {
      const list = [];
      for (const lane of eastLanes) for (const v of lane.vehicles) if (v.s < lane.stopS) list.push([lane, v]);
      return list;
    }

    // Make the eastbound queue hold exactly `count` vehicles.
    function setQueue(count) {
      const waiting = waitingEast().sort((a, b) => a[1].s - b[1].s); // back of queue first
      if (waiting.length > count) {
        for (const [lane, v] of waiting.slice(0, waiting.length - count)) {
          lane.vehicles.splice(lane.vehicles.indexOf(v), 1);
        }
        return;
      }
      const perLane = new Map(eastLanes.map((l) => [l, 0]));
      for (const [lane] of waiting) perLane.set(lane, perLane.get(lane) + 1);
      for (let k = waiting.length; k < count; k++) {
        const lane = [...perLane.entries()].sort((a, b) => a[1] - b[1] || (rand() - 0.5))[0][0];
        perLane.set(lane, perLane.get(lane) + 1);
        const s = Math.min(backOf(lane) - 8, -10);
        lane.vehicles.push(makeVehicle(s, 0.8));
      }
    }

    function setPhase(phase) {
      state.phase = phase;
      state.t = 0;
      state.main = phase === "green" ? "green" : phase === "amber" ? "amber" : "red";
      state.cross = phase === "idle" || phase === "arrive" ? "green" : phase === "crossAmber" ? "amber" : "red";
    }

    function startRun(count, green) {
      if (resolveRun) resolveRun({ interrupted: true });
      state.target = count;
      state.green = green;
      state.cleared = 0;
      state.counting = false;
      state.run += 1;
      setQueue(count);
      setPhase("arrive");
      return new Promise((resolve) => { resolveRun = resolve; });
    }

    function finishRun() {
      const result = { interrupted: false, cleared: state.cleared, remaining: waitingEast().length };
      state.counting = false;
      setPhase("idle");
      const r = resolveRun;
      resolveRun = null;
      if (r) r(result);
    }

    function advancePhase() {
      const p = state.phase;
      if (p === "arrive") {
        const settled = waitingEast().every(([, v]) => v.v < 3);
        if ((state.t >= 1 && settled) || state.t >= 30) setPhase("crossAmber");
      } else if (p === "crossAmber" && state.t >= PHASES.crossAmber) {
        setPhase("allRed1");
      } else if (p === "allRed1" && state.t >= PHASES.allRed1) {
        state.counting = true;
        setPhase("green");
      } else if (p === "green" && state.t >= state.green) {
        setPhase("amber");
      } else if (p === "amber" && state.t >= PHASES.amber) {
        setPhase("allRed2");
      } else if (p === "allRed2" && state.t >= PHASES.allRed2) {
        finishRun();
      }
    }

    function spawnAmbient(dt) {
      if (!ambient) return;
      for (const lane of lanes) {
        const rate = AMBIENT_RATE[lane.group];
        if (!rate || rand() > rate * dt) continue;
        if (backOf(lane) < 16) continue; // lane backed up to the edge
        lane.vehicles.push(makeVehicle(-6, 0.9));
      }
    }

    function stepLane(lane, dt) {
      const sig = state[lane.signal];
      lane.vehicles.sort((a, b) => b.s - a.s); // front first
      for (let i = 0; i < lane.vehicles.length; i++) {
        const v = lane.vehicles[i];
        const leader = i > 0 ? lane.vehicles[i - 1] : null;
        let gap = Infinity;
        let leaderV = 0;
        if (leader) { gap = leader.s - leader.len - v.s; leaderV = leader.v; }

        if (sig === "green") v.goOnAmber = null;
        if (sig !== "green" && v.s <= lane.stopS) {
          const dStop = lane.stopS - v.s;
          if (v.goOnAmber === null && sig === "amber") {
            // Commit once: go only if stopping comfortably is impossible.
            v.goOnAmber = dStop < (v.v * v.v) / (2 * IDM.b) + 2;
          }
          const mustStop = sig === "red" ? !v.goOnAmber : !v.goOnAmber;
          if (mustStop && dStop < gap) { gap = dStop; leaderV = 0; }
        }

        const a = Math.max(idmAccel(v.v, v.v0, gap, v.v - leaderV), -250);
        const before = v.s;
        v.v = Math.max(0, v.v + a * dt);
        v.s += v.v * dt;
        if (leader) v.s = Math.min(v.s, leader.s - leader.len - 0.5);
        v.braking = a < -6 || v.v < 0.5;
        if (lane.group === "E" && state.counting && before < lane.stopS && v.s >= lane.stopS) {
          state.cleared += 1;
        }
      }
      lane.vehicles = lane.vehicles.filter((v) => v.s - v.len < lane.exitS);
    }

    function step(dt) {
      state.t += dt;
      advancePhase();
      spawnAmbient(dt);
      for (const lane of lanes) stepLane(lane, dt);
    }

    function info() {
      const remaining =
        state.phase === "green" ? state.green - state.t :
        state.phase === "amber" ? PHASES.amber - state.t :
        state.phase === "crossAmber" ? PHASES.crossAmber - state.t :
        state.phase === "allRed1" ? PHASES.allRed1 - state.t :
        state.phase === "allRed2" ? PHASES.allRed2 - state.t : null;
      return {
        phase: state.phase, main: state.main, cross: state.cross,
        remaining: remaining === null ? null : Math.max(0, remaining),
        waiting: waitingEast().length, cleared: state.cleared,
        target: state.target, green: state.green, busy: resolveRun !== null,
      };
    }

    // Arrivals are fast-forwarded so the demo isn't spent watching cars drive in.
    const timeScale = () => (state.phase === "arrive" ? 4 : 1);

    return { lanes, state, step, startRun, info, timeScale };
  }

  // ---------------------------------------------------------------------------
  // View
  // ---------------------------------------------------------------------------

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function drawBackground(ctx) {
    const rand = mulberry32(7);
    ctx.fillStyle = "#d8dccd";
    ctx.fillRect(0, 0, W, H);

    // City blocks with buildings, rooftop tanks and trees.
    const blocks = [
      [0, 0, ROAD.vLeft - SIDEWALK, ROAD.hTop - SIDEWALK],
      [ROAD.vRight + SIDEWALK, 0, W, ROAD.hTop - SIDEWALK],
      [0, ROAD.hBot + SIDEWALK, ROAD.vLeft - SIDEWALK, H],
      [ROAD.vRight + SIDEWALK, ROAD.hBot + SIDEWALK, W, H],
    ];
    const roofs = ["#cbbfa8", "#b9a68c", "#a3adb8", "#d6cdbd", "#9fa79a", "#c7b199", "#bfb6aa", "#aab4bf"];
    for (const [x0, y0, x1, y1] of blocks) {
      for (let y = y0 + 10; y < y1 - 30; y += 78) {
        for (let x = x0 + 10; x < x1 - 30; x += 96) {
          const bw = Math.min(84, x1 - 10 - x);
          const bh = Math.min(66, y1 - 10 - y);
          if (bw < 30 || bh < 30) continue;
          if (rand() < 0.18) {
            // small park
            ctx.fillStyle = "#b8cfa0";
            roundRect(ctx, x, y, bw, bh, 6); ctx.fill();
            for (let k = 0; k < 4; k++) drawTree(ctx, x + 12 + rand() * (bw - 24), y + 12 + rand() * (bh - 24), 7 + rand() * 4);
            continue;
          }
          const roof = roofs[Math.floor(rand() * roofs.length)];
          ctx.fillStyle = "rgba(0,0,0,.18)";
          ctx.fillRect(x + 4, y + 4, bw, bh);
          ctx.fillStyle = roof;
          ctx.fillRect(x, y, bw, bh);
          ctx.strokeStyle = "rgba(0,0,0,.18)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, bw - 2, bh - 2);
          // rooftop water tank and AC units
          ctx.fillStyle = "#3b4252";
          ctx.beginPath(); ctx.arc(x + bw - 14, y + 14, 6, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#e5e7eb";
          for (let k = 0; k < 2; k++) ctx.fillRect(x + 8 + k * 12, y + bh - 14, 8, 6);
        }
      }
    }

    // Sidewalks
    ctx.fillStyle = "#c3c6cb";
    ctx.fillRect(0, ROAD.hTop - SIDEWALK, W, ROAD.hBot - ROAD.hTop + SIDEWALK * 2);
    ctx.fillRect(ROAD.vLeft - SIDEWALK, 0, ROAD.vRight - ROAD.vLeft + SIDEWALK * 2, H);

    // Street trees along the sidewalks
    for (let x = 30; x < W; x += 58) {
      if (x > ROAD.vLeft - 40 && x < ROAD.vRight + 40) continue;
      drawTree(ctx, x, ROAD.hTop - SIDEWALK - 6, 8);
      drawTree(ctx, x + 22, ROAD.hBot + SIDEWALK + 6, 8);
    }
    for (let y = 26; y < H; y += 58) {
      if (y > ROAD.hTop - 40 && y < ROAD.hBot + 40) continue;
      drawTree(ctx, ROAD.vLeft - SIDEWALK - 6, y, 8);
      drawTree(ctx, ROAD.vRight + SIDEWALK + 6, y + 22, 8);
    }

    // Asphalt
    ctx.fillStyle = "#3f444a";
    ctx.fillRect(0, ROAD.hTop, W, ROAD.hBot - ROAD.hTop);
    ctx.fillRect(ROAD.vLeft, 0, ROAD.vRight - ROAD.vLeft, H);

    const outside = (fn) => {
      // run fn for the four road arms, skipping the junction box
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(ROAD.vLeft - 24, ROAD.hTop - 24, ROAD.vRight - ROAD.vLeft + 48, ROAD.hBot - ROAD.hTop + 48);
      ctx.clip("evenodd");
      fn();
      ctx.restore();
    };

    outside(() => {
      // Edge lines
      ctx.strokeStyle = "rgba(255,255,255,.75)";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      line(ctx, 0, ROAD.hTop + 2, W, ROAD.hTop + 2);
      line(ctx, 0, ROAD.hBot - 2, W, ROAD.hBot - 2);
      line(ctx, ROAD.vLeft + 2, 0, ROAD.vLeft + 2, H);
      line(ctx, ROAD.vRight - 2, 0, ROAD.vRight - 2, H);
      // Lane dividers (dashed)
      ctx.setLineDash([12, 10]);
      line(ctx, 0, 258, W, 258);
      line(ctx, 0, 302, W, 302);
      line(ctx, 778, 0, 778, H);
      line(ctx, 822, 0, 822, H);
      // Centre lines (double yellow)
      ctx.setLineDash([]);
      ctx.strokeStyle = "#f2c94c";
      ctx.lineWidth = 1.5;
      line(ctx, 0, ROAD.hMid - 2, W, ROAD.hMid - 2);
      line(ctx, 0, ROAD.hMid + 2, W, ROAD.hMid + 2);
      line(ctx, ROAD.vMid - 2, 0, ROAD.vMid - 2, H);
      line(ctx, ROAD.vMid + 2, 0, ROAD.vMid + 2, H);
    });

    // Stop lines
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    line(ctx, 732, ROAD.hTop + 2, 732, ROAD.hMid - 3);
    line(ctx, 868, ROAD.hMid + 3, 868, ROAD.hBot - 2);
    line(ctx, ROAD.vMid + 3, 212, ROAD.vRight - 2, 212);
    line(ctx, ROAD.vLeft + 2, 348, ROAD.vMid - 3, 348);

    // Zebra crossings
    ctx.fillStyle = "rgba(255,255,255,.85)";
    for (let y = ROAD.hTop + 3; y < ROAD.hBot - 3; y += 8) {
      ctx.fillRect(737, y, 15, 4);
      ctx.fillRect(848, y, 15, 4);
    }
    for (let x = ROAD.vLeft + 3; x < ROAD.vRight - 3; x += 8) {
      ctx.fillRect(x, 216, 4, 15);
      ctx.fillRect(x, 329, 4, 15);
    }
  }

  function line(ctx, x0, y0, x1, y1) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }

  function drawTree(ctx, x, y, r) {
    ctx.fillStyle = "rgba(0,0,0,.15)";
    ctx.beginPath(); ctx.arc(x + 3, y + 3, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#4d7c3a";
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#6a9a4f";
    ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.55, 0, Math.PI * 2); ctx.fill();
  }

  function drawVehicle(ctx, lane, v) {
    const pos = lane.entry + lane.dir * v.s;
    const x = lane.axis === "x" ? pos : lane.fixed;
    const y = lane.axis === "x" ? lane.fixed : pos;
    const { len, w } = v;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lane.angle);
    // the vehicle's front is at x = 0 and it extends back to x = -len

    ctx.fillStyle = "rgba(0,0,0,.3)";
    roundRect(ctx, -len + 2, -w / 2 + 2, len, w, 3); ctx.fill();

    ctx.fillStyle = v.color;
    roundRect(ctx, -len, -w / 2, len, w, v.type === "bus" ? 2 : 3.5); ctx.fill();

    if (v.type === "car") {
      ctx.fillStyle = "rgba(20,30,45,.85)";
      ctx.fillRect(-7, -w / 2 + 1.2, 2.8, w - 2.4);     // windscreen
      ctx.fillRect(-len + 2.5, -w / 2 + 1.5, 2, w - 3); // rear window
      ctx.fillStyle = "rgba(255,255,255,.14)";
      ctx.fillRect(-len + 4.5, -w / 2 + 1.5, len - 11.5, w - 3); // roof sheen
    } else if (v.type === "cng") {
      ctx.fillStyle = "#14281d";
      roundRect(ctx, -len + 1.5, -w / 2 + 0.8, len - 5, w - 1.6, 3); ctx.fill(); // canopy
      ctx.fillStyle = "rgba(20,30,45,.85)";
      ctx.fillRect(-3.6, -w / 2 + 1.5, 1.8, w - 3);
    } else {
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.fillRect(-len + 2, -1.5, len - 6, 3);          // roof stripe
      ctx.fillStyle = "rgba(20,30,45,.85)";
      ctx.fillRect(-3.5, -w / 2 + 1, 2.5, w - 2);        // windscreen
      ctx.fillStyle = "rgba(255,255,255,.35)";
      for (let k = -len + 5; k < -7; k += 6) ctx.fillRect(k, -w / 2 + 2, 3, 2.2);
    }

    // head- and tail-lights
    ctx.fillStyle = "#fff6c8";
    ctx.fillRect(-1.2, -w / 2 + 1, 1.2, 2);
    ctx.fillRect(-1.2, w / 2 - 3, 1.2, 2);
    ctx.fillStyle = v.braking ? "#ff2a2a" : "#7f1d1d";
    ctx.fillRect(-len, -w / 2 + 1, 1.4, 2.2);
    ctx.fillRect(-len, w / 2 - 3.2, 1.4, 2.2);
    if (v.braking) {
      ctx.fillStyle = "rgba(255,40,40,.25)";
      ctx.beginPath(); ctx.arc(-len, 0, w * 0.7, Math.PI / 2, Math.PI * 1.5); ctx.fill();
    }
    ctx.restore();
  }

  const LAMP = { red: "#ff3b30", amber: "#ffb300", green: "#34c759" };

  function drawSignal(ctx, x, y, vertical, state) {
    const len = 26;
    const thick = 10;
    ctx.fillStyle = "rgba(0,0,0,.3)";
    roundRect(ctx, x + 1.5, y + 1.5, vertical ? thick : len, vertical ? len : thick, 4); ctx.fill();
    ctx.fillStyle = "#111";
    roundRect(ctx, x, y, vertical ? thick : len, vertical ? len : thick, 4); ctx.fill();
    ["red", "amber", "green"].forEach((c, i) => {
      const cx = vertical ? x + thick / 2 : x + 5 + i * 8;
      const cy = vertical ? y + 5 + i * 8 : y + thick / 2;
      const on = state === c;
      if (on) {
        ctx.fillStyle = LAMP[c] + "55";
        ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = on ? LAMP[c] : "#3a3a3a";
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    });
  }

  function pill(ctx, text, x, y, bg, fg) {
    ctx.font = "600 12px system-ui, -apple-system, Segoe UI, sans-serif";
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = bg;
    roundRect(ctx, x, y, w, 20, 10); ctx.fill();
    ctx.fillStyle = fg;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 7, y + 10.5);
    return w;
  }

  function create(canvas, hud) {
    const model = createModel();
    const ctx = canvas.getContext("2d");
    const background = document.createElement("canvas");
    let dpr = 0;
    let speed = 1;
    let last = null;

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (ratio === dpr) return;
      dpr = ratio;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      background.width = W * dpr;
      background.height = H * dpr;
      const bctx = background.getContext("2d");
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBackground(bctx);
    }

    function render() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(background, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const lane of model.lanes) for (const v of lane.vehicles) drawVehicle(ctx, lane, v);

      const { main, cross } = model.state;
      drawSignal(ctx, 704, 227, false, main);   // west approach (simulated)
      drawSignal(ctx, 870, 323, false, main);   // east approach
      drawSignal(ctx, 843, 184, true, cross);   // north approach
      drawSignal(ctx, 747, 350, true, cross);   // south approach

      const info = model.info();
      pill(ctx, "Simulated approach →", 12, 210, "rgba(17,24,39,.85)", "#fff");
      if (info.remaining !== null && (info.main === "green" || info.main === "amber")) {
        const bg = info.main === "green" ? "#1e7d4b" : "#b7791f";
        pill(ctx, `${Math.ceil(info.remaining)} s`, 662, 202, bg, "#fff");
      }
      updateHud(info);
    }

    const hudCache = {};
    function setText(key, text) {
      if (!hud[key] || hudCache[key] === text) return;
      hudCache[key] = text;
      hud[key].textContent = text;
    }

    const PHASE_TEXT = {
      idle: "Red · cross road moving",
      arrive: "Red · vehicles arriving",
      crossAmber: "Red · cross road amber",
      allRed1: "All red · junction clearing",
      green: "Green · queue moving",
      amber: "Amber · last vehicles",
      allRed2: "All red · junction clearing",
    };

    function updateHud(info) {
      setText("phase", PHASE_TEXT[info.phase]);
      if (hud.phaseDot && hud.phaseDot.dataset.signal !== info.main) hud.phaseDot.dataset.signal = info.main;
      setText("countdown", info.remaining === null ? "–" : `${Math.ceil(info.remaining)} s`);
      setText("waiting", String(info.waiting));
      setText("cleared", info.phase === "idle" && !info.target ? "–" : `${info.cleared} of ${info.target}`);
    }

    function frame(now) {
      resize();
      if (last !== null) {
        const real = Math.min((now - last) / 1000, 0.1);
        let sim = real * speed * model.timeScale();
        while (sim > 0) {
          const dt = Math.min(sim, 1 / 30);
          model.step(dt);
          sim -= dt;
        }
      }
      last = now;
      render();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return {
      play: (count, green) => model.startRun(count, green),
      setSpeed: (s) => { speed = s; },
      info: () => model.info(),
    };
  }

  const api = { createModel, create, W, H };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Junction = api;
})(typeof window !== "undefined" ? window : globalThis);
