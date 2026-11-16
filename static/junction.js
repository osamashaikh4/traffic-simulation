// Top-down ("god view") junction simulation.
//
// The simulated vehicle count becomes the queue on the west approach
// (eastbound). That approach gets a green time (the rule's recommendation, or
// a fixed plan when comparing); the other roads carry illustrative background
// traffic. Bangladesh drives on the left.
//
// createModel() is pure logic (no DOM) so it can be tested in Node. The queue
// for a run is generated from a seed, and the model advances in fixed time
// steps, so the same run (seed + count + green time) always plays out the
// same way - which makes replays and fixed-vs-smart comparisons fair.
//
// create() builds the view: a canvas plus overlays (label, big signal with
// countdown, vehicles-through counter, hover tooltip) inside a container.

(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // World geometry (world units ~ pixels at zoom 1; 1 unit ~ 0.15 m)
  // ---------------------------------------------------------------------------

  const W = 1100;
  const H = 560;
  const ROAD = { hTop: 238, hBot: 322, hMid: 280, vLeft: 758, vRight: 842, vMid: 800 };
  const SIDEWALK = 12;
  // The part of the world shown: full width, trimming empty ground above and below.
  const VIEW = { x: 0, y: 70, w: W, h: 420 };
  const METRES_PER_UNIT = 0.15;

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
    car: { name: "Car", len: 21, w: 12, v0: 90, colors: ["#f1f3f4", "#202124", "#9aa0a6", "#1a56db", "#b42318", "#f8fafc", "#4b5563", "#0f766e", "#7c2d12"] },
    cng: { name: "CNG auto-rickshaw", len: 16, w: 11, v0: 80, colors: ["#15803d"] },
    bus: { name: "Bus", len: 36, w: 13, v0: 75, colors: ["#b42318", "#1d4ed8", "#c2410c", "#047857"] },
  };

  // Intelligent Driver Model parameters (world units, seconds).
  const IDM = { a: 28, b: 45, T: 1.4, s0: 5 };
  const PHASES = { crossAmber: 3, allRed1: 1.5, amber: 3, allRed2: 1.5 };
  const AMBIENT_RATE = { W: 0.05, S: 0.09, N: 0.09 }; // vehicles per second per lane
  const DT = 1 / 60; // fixed simulation step

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
    const ambient = options.ambient !== false;
    const ambientRand = options.ambientRand || Math.random;
    let queueRand = mulberry32(1);

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
      green: 0, target: 0, cleared: 0, counting: false, lastCrossT: null, lastResult: null,
    };
    let resolveRun = null;
    let nextId = 1;

    function makeVehicle(rand, s, vFactor, simulated) {
      const r = rand();
      const type = r < 0.55 ? "car" : r < 0.88 ? "cng" : "bus";
      const spec = TYPES[type];
      return {
        id: nextId++, type, s, v: vFactor * spec.v0, len: spec.len, w: spec.w,
        v0: spec.v0 * (0.92 + rand() * 0.16),
        color: spec.colors[Math.floor(rand() * spec.colors.length)],
        braking: false, goOnAmber: null, simulated, cleared: false,
      };
    }

    function backOf(lane) {
      let back = Infinity;
      for (const v of lane.vehicles) back = Math.min(back, v.s - v.len);
      return back;
    }

    function waitingEast() {
      let n = 0;
      for (const lane of eastLanes) for (const v of lane.vehicles) if (v.s < lane.stopS) n++;
      return n;
    }

    // A fresh, seeded queue of exactly `count` vehicles, alternating lanes.
    function buildQueue(count) {
      for (const lane of eastLanes) lane.vehicles = lane.vehicles.filter((v) => v.s >= lane.stopS);
      const nextS = eastLanes.map((lane) => Math.min(backOf(lane) - 8, -10));
      for (let k = 0; k < count; k++) {
        const i = k % 2;
        const v = makeVehicle(queueRand, nextS[i], 0.8, true);
        eastLanes[i].vehicles.push(v);
        nextS[i] = v.s - v.len - 10;
      }
    }

    function setPhase(phase) {
      state.phase = phase;
      state.t = 0;
      state.main = phase === "green" ? "green" : phase === "amber" ? "amber" : "red";
      state.cross = phase === "idle" || phase === "arrive" ? "green" : phase === "crossAmber" ? "amber" : "red";
    }

    function startRun(count, green, seed) {
      if (resolveRun) resolveRun({ interrupted: true });
      queueRand = mulberry32(seed === undefined ? Math.floor(Math.random() * 1e9) : seed);
      Object.assign(state, { target: count, green, cleared: 0, counting: false, lastCrossT: null, lastResult: null });
      buildQueue(count);
      setPhase("arrive");
      return new Promise((resolve) => { resolveRun = resolve; });
    }

    function finishRun() {
      const remaining = waitingEast();
      let unusedGreen = 0;
      if (remaining === 0) {
        unusedGreen = state.target === 0 ? state.green
          : state.lastCrossT === null ? 0 : Math.max(0, state.green - state.lastCrossT);
      }
      const result = {
        interrupted: false, target: state.target, green: state.green,
        cleared: state.cleared, remaining, unusedGreen: Math.round(unusedGreen),
      };
      state.lastResult = result;
      state.counting = false;
      setPhase("idle");
      const r = resolveRun;
      resolveRun = null;
      if (r) r(result);
    }

    function advancePhase() {
      const p = state.phase;
      if (p === "arrive") {
        let settled = true;
        for (const lane of eastLanes) for (const v of lane.vehicles) if (v.s < lane.stopS && v.v >= 3) settled = false;
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
        if (!rate || ambientRand() > rate * dt) continue;
        if (backOf(lane) < 16) continue; // lane backed up to the edge
        lane.vehicles.push(makeVehicle(ambientRand, -6, 0.9, false));
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
          if (!v.goOnAmber && dStop < gap) { gap = dStop; leaderV = 0; }
        }

        const a = Math.max(idmAccel(v.v, v.v0, gap, v.v - leaderV), -250);
        const before = v.s;
        v.v = Math.max(0, v.v + a * dt);
        v.s += v.v * dt;
        if (leader) v.s = Math.min(v.s, leader.s - leader.len - 0.5);
        v.braking = a < -6 || v.v < 0.5;
        if (lane.group === "E" && state.counting && before < lane.stopS && v.s >= lane.stopS) {
          state.cleared += 1;
          v.cleared = true;
          state.lastCrossT = state.phase === "green" ? state.t : state.green;
        }
      }
      lane.vehicles = lane.vehicles.filter((v) => v.s - v.len < lane.exitS);
    }

    function step(dt = DT) {
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
        waiting: waitingEast(), cleared: state.cleared,
        target: state.target, green: state.green, t: state.t,
        busy: resolveRun !== null, lastResult: state.lastResult,
      };
    }

    // Arrivals are fast-forwarded so the demo isn't spent watching cars drive in.
    const timeScale = () => (state.phase === "arrive" ? 4 : 1);

    return { lanes, state, step, startRun, info, timeScale };
  }

  // Runs a whole cycle with no drawing and returns the result (same as play).
  function runInstant(count, green, seed) {
    const m = createModel({ ambient: false });
    m.startRun(count, green, seed);
    for (let i = 0; i < 200000 && m.info().busy; i++) m.step(DT);
    return m.state.lastResult;
  }

  // ---------------------------------------------------------------------------
  // City layout (generated once from a fixed seed)
  // ---------------------------------------------------------------------------

  function buildCity() {
    const city = { lamps: [] };
    for (let x = 60; x < W; x += 116) {
      if (x > ROAD.vLeft - 30 && x < ROAD.vRight + 30) continue;
      city.lamps.push({ x, y: ROAD.hTop - 4 }, { x: x + 58, y: ROAD.hBot + 4 });
    }
    for (let y = 40; y < H; y += 116) {
      if (y > ROAD.hTop - 30 && y < ROAD.hBot + 30) continue;
      city.lamps.push({ x: ROAD.vLeft - 4, y }, { x: ROAD.vRight + 4, y: y + 58 });
    }
    return city;
  }

  const CITY = buildCity();

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function line(ctx, x0, y0, x1, y1) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }


  function drawBackground(ctx) {
    ctx.fillStyle = "#f3f3f1";
    ctx.fillRect(0, 0, W, H);

    // Sidewalks
    ctx.fillStyle = "#e1e1dd";
    ctx.fillRect(0, ROAD.hTop - SIDEWALK, W, ROAD.hBot - ROAD.hTop + SIDEWALK * 2);
    ctx.fillRect(ROAD.vLeft - SIDEWALK, 0, ROAD.vRight - ROAD.vLeft + SIDEWALK * 2, H);


    // Asphalt
    ctx.fillStyle = "#454a51";
    ctx.fillRect(0, ROAD.hTop, W, ROAD.hBot - ROAD.hTop);
    ctx.fillRect(ROAD.vLeft, 0, ROAD.vRight - ROAD.vLeft, H);
    // The simulated approach: a faint blue wash so the eye goes there first.
    ctx.fillStyle = "rgba(0,122,255,.18)";
    ctx.fillRect(0, ROAD.hTop, 732, ROAD.hMid - ROAD.hTop - 2);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(ROAD.vLeft - 24, ROAD.hTop - 24, ROAD.vRight - ROAD.vLeft + 48, ROAD.hBot - ROAD.hTop + 48);
    ctx.clip("evenodd");
    ctx.strokeStyle = "rgba(255,255,255,.75)";
    ctx.lineWidth = 2;
    line(ctx, 0, ROAD.hTop + 2, W, ROAD.hTop + 2);
    line(ctx, 0, ROAD.hBot - 2, W, ROAD.hBot - 2);
    line(ctx, ROAD.vLeft + 2, 0, ROAD.vLeft + 2, H);
    line(ctx, ROAD.vRight - 2, 0, ROAD.vRight - 2, H);
    ctx.setLineDash([12, 10]);
    line(ctx, 0, 258, W, 258);
    line(ctx, 0, 302, W, 302);
    line(ctx, 778, 0, 778, H);
    line(ctx, 822, 0, 822, H);
    ctx.setLineDash([]);
    ctx.strokeStyle = "#f2c94c";
    ctx.lineWidth = 1.5;
    line(ctx, 0, ROAD.hMid - 2, W, ROAD.hMid - 2);
    line(ctx, 0, ROAD.hMid + 2, W, ROAD.hMid + 2);
    line(ctx, ROAD.vMid - 2, 0, ROAD.vMid - 2, H);
    line(ctx, ROAD.vMid + 2, 0, ROAD.vMid + 2, H);
    ctx.restore();

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

  function vehiclePose(lane, v) {
    const pos = lane.entry + lane.dir * v.s;
    return lane.axis === "x" ? { x: pos, y: lane.fixed } : { x: lane.fixed, y: pos };
  }

  function drawVehicle(ctx, lane, v) {
    const { x, y } = vehiclePose(lane, v);
    const { len, w } = v;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lane.angle);
    if (v.cleared) ctx.globalAlpha = 0.6; // through the junction: shown faded
    // the vehicle's front is at x = 0 and it extends back to x = -len

    ctx.fillStyle = "rgba(0,0,0,.3)";
    roundRect(ctx, -len + 2, -w / 2 + 2, len, w, 3); ctx.fill();

    ctx.fillStyle = v.color;
    roundRect(ctx, -len, -w / 2, len, w, v.type === "bus" ? 2 : 4); ctx.fill();

    if (v.type === "car") {
      ctx.fillStyle = "rgba(20,30,45,.85)";
      ctx.fillRect(-8, -w / 2 + 1.4, 3.2, w - 2.8);
      ctx.fillRect(-len + 2.8, -w / 2 + 1.8, 2.4, w - 3.6);
      ctx.fillStyle = "rgba(255,255,255,.14)";
      ctx.fillRect(-len + 5.4, -w / 2 + 1.8, len - 13.6, w - 3.6);
    } else if (v.type === "cng") {
      ctx.fillStyle = "#14281d";
      roundRect(ctx, -len + 1.6, -w / 2 + 0.9, len - 5.6, w - 1.8, 3); ctx.fill();
      ctx.fillStyle = "rgba(20,30,45,.85)";
      ctx.fillRect(-4, -w / 2 + 1.6, 2, w - 3.2);
    } else {
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.fillRect(-len + 2, -1.6, len - 6, 3.2);
      ctx.fillStyle = "rgba(20,30,45,.85)";
      ctx.fillRect(-3.8, -w / 2 + 1, 2.8, w - 2);
      ctx.fillStyle = "rgba(255,255,255,.35)";
      for (let k = -len + 5; k < -7; k += 6) ctx.fillRect(k, -w / 2 + 2, 3, 2.4);
    }

    ctx.fillStyle = "#fff6c8";
    ctx.fillRect(-1.3, -w / 2 + 1, 1.3, 2.2);
    ctx.fillRect(-1.3, w / 2 - 3.2, 1.3, 2.2);
    ctx.fillStyle = v.braking ? "#ff2a2a" : "#7f1d1d";
    ctx.fillRect(-len, -w / 2 + 1, 1.5, 2.4);
    ctx.fillRect(-len, w / 2 - 3.4, 1.5, 2.4);
    if (v.braking) {
      ctx.fillStyle = "rgba(255,40,40,.25)";
      ctx.beginPath(); ctx.arc(-len, 0, w * 0.7, Math.PI / 2, Math.PI * 1.5); ctx.fill();
    }
    ctx.restore();
  }

  // Night: headlight beams and tail-light glow, drawn over the dark tint.
  function drawVehicleLights(ctx, lane, v) {
    const { x, y } = vehiclePose(lane, v);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lane.angle);
    const beam = ctx.createLinearGradient(0, 0, 26, 0);
    beam.addColorStop(0, "rgba(255,240,190,.32)");
    beam.addColorStop(1, "rgba(255,240,190,0)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(0, -v.w / 2 + 1);
    ctx.lineTo(26, -v.w / 2 - 4);
    ctx.lineTo(26, v.w / 2 + 4);
    ctx.lineTo(0, v.w / 2 - 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = v.braking ? "rgba(255,40,40,.9)" : "rgba(255,40,40,.5)";
    ctx.beginPath(); ctx.arc(-v.len, -v.w / 2 + 2, v.braking ? 3 : 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(-v.len, v.w / 2 - 2, v.braking ? 3 : 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  const LAMP = { red: "#ff3b30", amber: "#ffb300", green: "#34c759" };

  function drawSignal(ctx, x, y, vertical, state) {
    const len = 40;
    const thick = 16;
    const w = vertical ? thick : len;
    const h = vertical ? len : thick;
    ctx.fillStyle = "rgba(0,0,0,.3)";
    roundRect(ctx, x + 1.5, y + 1.5, w, h, 5); ctx.fill();
    ctx.fillStyle = "#111";
    roundRect(ctx, x, y, w, h, 5); ctx.fill();
    ["red", "amber", "green"].forEach((c, i) => {
      const cx = vertical ? x + thick / 2 : x + 8 + i * 12;
      const cy = vertical ? y + 8 + i * 12 : y + thick / 2;
      const on = state === c;
      if (on) {
        ctx.fillStyle = LAMP[c] + "55";
        ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = on ? LAMP[c] : "#3a3a3a";
      ctx.beginPath(); ctx.arc(cx, cy, 4.6, 0, Math.PI * 2); ctx.fill();
    });
  }

  function pill(ctx, text, x, y, bg, fg, align = "left") {
    ctx.font = "600 13px Inter, system-ui, -apple-system, Segoe UI, sans-serif";
    const w = ctx.measureText(text).width + 16;
    const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    ctx.fillStyle = bg;
    roundRect(ctx, left, y, w, 22, 11); ctx.fill();
    ctx.fillStyle = fg;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(text, left + 8, y + 11.5);
    return w;
  }

  // ---------------------------------------------------------------------------
  // View
  // ---------------------------------------------------------------------------

  const PHASE_TEXT = {
    idle: "Red · cross road moving",
    arrive: "Red · vehicles arriving",
    crossAmber: "Red · cross road amber",
    allRed1: "All red · junction clearing",
    green: "Green · queue moving",
    amber: "Amber · last vehicles",
    allRed2: "All red · junction clearing",
  };

  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function create(container, opts = {}) {
    const model = createModel();
    const box = el("div", "jx-box");
    const canvas = el("canvas", "jx-canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", opts.ariaLabel || "Animated top-down view of the junction");
    const label = el("div", "jx-label");
    // Big signal + countdown (top left) and a vehicles-through counter (top right).
    const signal = el("div", "jx-signal",
      '<div class="jx-lights"><i data-c="red"></i><i data-c="amber"></i><i data-c="green"></i></div>' +
      '<div class="jx-seconds num"></div>');
    signal.dataset.signal = "red";
    signal.setAttribute("role", "status");
    const counter = el("div", "jx-counter",
      '<div class="jx-num num"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" fill="currentColor"/></svg>' +
      '<b class="jx-through">0</b><span class="jx-total"></span><span class="jx-badge"></span></div>' +
      '<div class="jx-bar"><span></span></div>');
    counter.dataset.state = "idle";
    const tip = el("div", "jx-tip");
    tip.hidden = true;
    box.append(canvas, label, signal, counter, tip);
    container.append(box);

    const q = (node, sel) => node.querySelector(sel);
    const ui = {
      seconds: q(signal, ".jx-seconds"),
      through: q(counter, ".jx-through"), total: q(counter, ".jx-total"),
      badge: q(counter, ".jx-badge"), bar: q(counter, ".jx-bar span"),
    };

    const ctx = canvas.getContext("2d");
    const bg = document.createElement("canvas");
    let scale = 1;
    let dpr = 1;
    let speed = 1;
    let scene = "day";
    let last = null;
    let acc = 0;
    let shownResult = null; // result to display when nothing is animating (skip mode)
    let drops = [];

    if (opts.label) label.textContent = opts.label;
    label.hidden = !opts.label;

    // ---- sizing ------------------------------------------------------------
    function fit() {
      const full = container.closest(":fullscreen") !== null;
      const availW = container.clientWidth;
      const availH = full ? container.clientHeight : availW * (VIEW.h / VIEW.w);
      let w = availW;
      let h = w * (VIEW.h / VIEW.w);
      if (h > availH) { h = availH; w = h * (VIEW.w / VIEW.h); }
      w = Math.max(1, Math.floor(w));
      h = Math.max(1, Math.floor(h));
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (box.style.width !== `${w}px`) { box.style.width = `${w}px`; box.style.height = `${h}px`; }
      const newScale = w / VIEW.w;
      if (Math.abs(newScale - scale) < 1e-6 && ratio === dpr && canvas.width === Math.round(w * dpr)) return;
      scale = newScale;
      dpr = ratio;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      bg.width = Math.round(W * scale * dpr);
      bg.height = Math.round(H * scale * dpr);
      const b = bg.getContext("2d");
      b.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
      drawBackground(b);
    }
    new ResizeObserver(fit).observe(container);
    document.addEventListener("fullscreenchange", () => requestAnimationFrame(fit));

    // ---- rendering ------------------------------------------------------------
    function worldTransform() {
      const k = scale * dpr;
      ctx.setTransform(k, 0, 0, k, -VIEW.x * k, -VIEW.y * k);
    }

    function render(realDt) {
      worldTransform();
      ctx.drawImage(bg, 0, 0, W, H);
      for (const lane of model.lanes) for (const v of lane.vehicles) drawVehicle(ctx, lane, v);

      if (scene === "rain") {
        ctx.fillStyle = "rgba(40,55,80,.22)";
        ctx.fillRect(0, 0, W, H);
      }
      if (scene === "night") {
        ctx.fillStyle = "rgba(10,16,36,.5)";
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (const l of CITY.lamps) {
          const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, 30);
          g.addColorStop(0, "rgba(255,206,120,.2)");
          g.addColorStop(1, "rgba(255,206,120,0)");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(l.x, l.y, 30, 0, Math.PI * 2); ctx.fill();
        }
        for (const lane of model.lanes) for (const v of lane.vehicles) drawVehicleLights(ctx, lane, v);
        ctx.restore();
      }

      const { main, cross } = model.state;
      drawSignal(ctx, 690, 218, false, main);   // west approach (simulated)
      drawSignal(ctx, 870, 326, false, main);   // east approach
      drawSignal(ctx, 846, 170, true, cross);   // north approach
      drawSignal(ctx, 738, 350, true, cross);   // south approach

      const info = model.info();
      drawQueueMarkers(info);

      if (scene === "rain") drawRain(realDt);
      updateOverlays(info);
    }

    // Edge marker when the queue runs off the left edge.
    function drawQueueMarkers(info) {
      if (!info.waiting) return;
      let hidden = 0;
      for (const lane of model.lanes) {
        if (lane.group !== "E") continue;
        for (const v of lane.vehicles) if (v.s < lane.stopS && lane.entry + v.s < VIEW.x + 8) hidden++;
      }
      if (hidden > 0) pill(ctx, `\u2190 +${hidden}`, VIEW.x + 8, 212, "rgba(17,24,39,.85)", "#fff");
    }

    function drawRain(realDt) {
      if (drops.length === 0) {
        for (let i = 0; i < 170; i++) drops.push({ x: VIEW.x + Math.random() * VIEW.w, y: VIEW.y + Math.random() * VIEW.h });
      }
      ctx.strokeStyle = "rgba(210,225,245,.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of drops) {
        d.x -= 60 * realDt;
        d.y += 520 * realDt;
        if (d.y > VIEW.y + VIEW.h) { d.y = VIEW.y - 10; d.x = VIEW.x + Math.random() * (VIEW.w + 60); }
        if (d.x < VIEW.x - 10) d.x += VIEW.w + 20;
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - 2, d.y + 13);
      }
      ctx.stroke();
    }

    // ---- overlays -------------------------------------------------------------
    const cache = {};
    function set(node, key, value, prop = "textContent") {
      if (cache[key] === value) return;
      cache[key] = value;
      node[prop] = value;
    }

    function updateOverlays(info) {
      // Signal: lamps follow the simulated road's light; big seconds during green/amber.
      if (cache.signal !== info.main) { cache.signal = info.main; signal.dataset.signal = info.main; }
      const secs = info.remaining !== null && (info.main === "green" || info.main === "amber") ? String(Math.ceil(info.remaining)) : "";
      set(ui.seconds, "seconds", secs);
      set(signal, "aria", `Signal ${info.main}${secs ? `, ${secs} seconds left` : ""}`, "ariaLabel");

      // Counter: vehicles through / vehicles in the queue, and a tick or cross at the end.
      const r = info.busy ? null : (info.lastResult || shownResult);
      const through = r ? r.cleared : info.cleared;
      const total = r ? r.target : info.target;
      const state = info.busy ? "running" : r ? (r.remaining === 0 ? "ok" : "bad") : "idle";
      const blank = state === "idle" && !total;
      set(ui.through, "through", blank ? "\u2013" : String(through));
      set(ui.total, "total", blank ? "" : `/ ${total}`);
      set(ui.badge, "badge", state === "ok" ? "\u2713" : state === "bad" ? `\u2717 ${r.remaining}` : "");
      if (cache.state !== state) { cache.state = state; counter.dataset.state = state; }
      const pct = `${total ? Math.round((through / total) * 1000) / 10 : state === "ok" ? 100 : 0}%`;
      if (cache.bar !== pct) { cache.bar = pct; ui.bar.style.width = pct; }
      void PHASE_TEXT;
    }

    // ---- hover tooltip ------------------------------------------------------------
    function vehicleAt(wx, wy) {
      for (const lane of model.lanes) {
        for (const v of lane.vehicles) {
          const { x, y } = vehiclePose(lane, v);
          const half = v.w / 2 + 2;
          let x0, x1, y0, y1;
          if (lane.axis === "x") {
            [x0, x1] = lane.dir > 0 ? [x - v.len, x] : [x, x + v.len];
            [y0, y1] = [y - half, y + half];
          } else {
            [y0, y1] = lane.dir > 0 ? [y - v.len, y] : [y, y + v.len];
            [x0, x1] = [x - half, x + half];
          }
          if (wx >= x0 - 2 && wx <= x1 + 2 && wy >= y0 && wy <= y1) return { lane, v };
        }
      }
      return null;
    }

    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const hit = vehicleAt(VIEW.x + mx / scale, VIEW.y + my / scale);
      if (!hit) { tip.hidden = true; canvas.style.cursor = ""; return; }
      const { lane, v } = hit;
      const kmh = Math.round(v.v * METRES_PER_UNIT * 3.6);
      const role = v.simulated ? (v.cleared ? "Simulated queue · through" : "Simulated queue") : "Background traffic";
      const state = v.v < 0.5 ? "stopped" : `${kmh} km/h`;
      tip.innerHTML = `<b>${TYPES[v.type].name}</b><span>${role} · ${state}</span>`;
      tip.hidden = false;
      const tx = Math.min(mx + 14, rect.width - tip.offsetWidth - 6);
      const ty = my + 16 + tip.offsetHeight > rect.height ? my - tip.offsetHeight - 10 : my + 16;
      tip.style.transform = `translate(${tx}px, ${ty}px)`;
      canvas.style.cursor = "help";
      void lane;
    });
    canvas.addEventListener("mouseleave", () => { tip.hidden = true; });

    // ---- loop -----------------------------------------------------------------------
    function frame(now) {
      if (!box.isConnected) return;
      fit();
      const real = last === null ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;
      acc += real * speed;
      for (let n = 0; n < 2000; n++) {
        const need = DT / model.timeScale();
        if (acc < need) break;
        model.step(DT);
        acc -= need;
      }
      render(real);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return {
      play(count, green, seed) {
        shownResult = null;
        acc = 0;
        return model.startRun(count, green, seed);
      },
      // Show a result without animating it (used when the animation is skipped).
      showResult(result) {
        model.state.lastResult = null;
        shownResult = result;
      },
      setLabel(text) { label.textContent = text; label.hidden = !text; },
      setSpeed(s) { speed = s; },
      setScene(s) { scene = s; },
      info: () => model.info(),
      element: box,
    };
  }

  const api = { createModel, runInstant, create, W, H, VIEW, DT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Junction = api;
})(typeof window !== "undefined" ? window : globalThis);
