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
  // The part of the world shown: a close-up centred on the junction (like the design mockup).
  const VIEW = { x: 652, y: 170, w: 296, h: 220 };
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
    car: { name: "Car", len: 22, w: 13, v0: 90, colors: ["#2f7bf6", "#2f7bf6", "#f2c230", "#e0453a", "#eef1f5", "#eef1f5", "#b9c2cf", "#2b313c"] },
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

  // Decoration: grass texture, trees in the four corners, lamp posts (night).
  function buildCity() {
    const rand = mulberry32(11);
    const city = { trees: [], speckles: [], lamps: [], grit: [] };
    const corners = [
      [VIEW.x - 40, VIEW.y - 40, ROAD.vLeft - SIDEWALK, ROAD.hTop - SIDEWALK],
      [ROAD.vRight + SIDEWALK, VIEW.y - 40, VIEW.x + VIEW.w + 40, ROAD.hTop - SIDEWALK],
      [VIEW.x - 40, ROAD.hBot + SIDEWALK, ROAD.vLeft - SIDEWALK, VIEW.y + VIEW.h + 40],
      [ROAD.vRight + SIDEWALK, ROAD.hBot + SIDEWALK, VIEW.x + VIEW.w + 40, VIEW.y + VIEW.h + 40],
    ];
    for (const [x0, y0, x1, y1] of corners) {
      for (let i = 0; i < 260; i++) {
        city.speckles.push({ x: x0 + rand() * (x1 - x0), y: y0 + rand() * (y1 - y0), r: 1 + rand() * 2.2, light: rand() < 0.5 });
      }
      // Trees, kept away from the kerb so they never cover the road.
      let placed = 0;
      for (let tries = 0; tries < 400 && placed < 9; tries++) {
        const r = 11 + rand() * 9;
        const x = x0 + r + rand() * Math.max(1, x1 - x0 - 2 * r);
        const y = y0 + r + rand() * Math.max(1, y1 - y0 - 2 * r);
        const nearRoadX = Math.min(Math.abs(x - (ROAD.vLeft - SIDEWALK)), Math.abs(x - (ROAD.vRight + SIDEWALK)));
        const nearRoadY = Math.min(Math.abs(y - (ROAD.hTop - SIDEWALK)), Math.abs(y - (ROAD.hBot + SIDEWALK)));
        if (nearRoadX < r + 14 || nearRoadY < r + 14) continue;
        if (city.trees.some((t) => Math.hypot(t.x - x, t.y - y) < (t.r + r) * 0.85)) continue;
        city.trees.push({ x, y, r, seed: rand() });
        placed++;
      }
    }
    for (let i = 0; i < 900; i++) {
      city.grit.push({ x: rand() * W, y: rand() * H, a: 0.03 + rand() * 0.05 });
    }
    for (let x = 60; x < W; x += 116) {
      if (x > ROAD.vLeft - 30 && x < ROAD.vRight + 30) continue;
      city.lamps.push({ x, y: ROAD.hTop - 6 }, { x: x + 58, y: ROAD.hBot + 6 });
    }
    for (let y = 40; y < H; y += 116) {
      if (y > ROAD.hTop - 30 && y < ROAD.hBot + 30) continue;
      city.lamps.push({ x: ROAD.vLeft - 6, y }, { x: ROAD.vRight + 6, y: y + 58 });
    }
    city.trees.sort((a, b) => a.y - b.y);
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

  function drawTree(ctx, t) {
    const { x, y, r } = t;
    ctx.fillStyle = "rgba(0,0,0,.28)";
    ctx.beginPath(); ctx.ellipse(x + r * 0.35, y + r * 0.4, r * 1.05, r * 0.95, 0, 0, Math.PI * 2); ctx.fill();
    const blobs = 5;
    for (let i = 0; i < blobs; i++) {
      const ang = (i / blobs) * Math.PI * 2 + t.seed * 6;
      const bx = x + Math.cos(ang) * r * 0.45;
      const by = y + Math.sin(ang) * r * 0.45;
      const br = r * (0.55 + ((t.seed * 97 + i * 13) % 10) / 40);
      const g = ctx.createRadialGradient(bx - br * 0.4, by - br * 0.4, br * 0.1, bx, by, br);
      g.addColorStop(0, "#6fae48");
      g.addColorStop(0.5, "#357a2b");
      g.addColorStop(1, "#1b4a1a");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
    }
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.05, x, y, r * 0.7);
    g.addColorStop(0, "rgba(150,210,105,.75)");
    g.addColorStop(1, "rgba(79,143,56,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, Math.PI * 2); ctx.fill();
  }

  function drawBackground(ctx) {
    // Grass
    const grass = ctx.createLinearGradient(0, 0, W, H);
    grass.addColorStop(0, "#5c9a3f");
    grass.addColorStop(1, "#4d8a35");
    ctx.fillStyle = grass;
    ctx.fillRect(0, 0, W, H);
    for (const s of CITY.speckles) {
      ctx.fillStyle = s.light ? "rgba(140,200,95,.35)" : "rgba(30,70,25,.3)";
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }

    // Sidewalks (with rounded inner corners) and kerb lines
    const sw = SIDEWALK;
    ctx.fillStyle = "#b9bec6";
    ctx.fillRect(0, ROAD.hTop - sw, W, ROAD.hBot - ROAD.hTop + sw * 2);
    ctx.fillRect(ROAD.vLeft - sw, 0, ROAD.vRight - ROAD.vLeft + sw * 2, H);
    ctx.strokeStyle = "rgba(0,0,0,.08)";
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 14) {
      if (x > ROAD.vLeft - sw && x < ROAD.vRight + sw) continue;
      line(ctx, x, ROAD.hTop - sw, x, ROAD.hTop);
      line(ctx, x, ROAD.hBot, x, ROAD.hBot + sw);
    }
    for (let y = 0; y < H; y += 14) {
      if (y > ROAD.hTop - sw && y < ROAD.hBot + sw) continue;
      line(ctx, ROAD.vLeft - sw, y, ROAD.vLeft, y);
      line(ctx, ROAD.vRight, y, ROAD.vRight + sw, y);
    }

    // Asphalt
    ctx.fillStyle = "#3b4049";
    ctx.fillRect(0, ROAD.hTop, W, ROAD.hBot - ROAD.hTop);
    ctx.fillRect(ROAD.vLeft, 0, ROAD.vRight - ROAD.vLeft, H);
    for (const g of CITY.grit) {
      const onRoad = (g.y > ROAD.hTop && g.y < ROAD.hBot) || (g.x > ROAD.vLeft && g.x < ROAD.vRight);
      if (!onRoad) continue;
      ctx.fillStyle = `rgba(255,255,255,${g.a})`;
      ctx.fillRect(g.x, g.y, 1.4, 1.4);
    }
    // Kerb edges
    ctx.strokeStyle = "#8d939c";
    ctx.lineWidth = 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(ROAD.vLeft - sw, ROAD.hTop - sw, ROAD.vRight - ROAD.vLeft + sw * 2, ROAD.hBot - ROAD.hTop + sw * 2);
    ctx.clip("evenodd");
    line(ctx, 0, ROAD.hTop, W, ROAD.hTop);
    line(ctx, 0, ROAD.hBot, W, ROAD.hBot);
    line(ctx, ROAD.vLeft, 0, ROAD.vLeft, H);
    line(ctx, ROAD.vRight, 0, ROAD.vRight, H);
    ctx.restore();


    // Lane markings (outside the junction box)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(ROAD.vLeft - 26, ROAD.hTop - 26, ROAD.vRight - ROAD.vLeft + 52, ROAD.hBot - ROAD.hTop + 52);
    ctx.clip("evenodd");
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 12]);
    line(ctx, 0, 258, W, 258);
    line(ctx, 0, 302, W, 302);
    line(ctx, 778, 0, 778, H);
    line(ctx, 822, 0, 822, H);
    ctx.setLineDash([]);
    ctx.lineWidth = 1.6;
    line(ctx, 0, ROAD.hMid - 2, W, ROAD.hMid - 2);
    line(ctx, 0, ROAD.hMid + 2, W, ROAD.hMid + 2);
    line(ctx, ROAD.vMid - 2, 0, ROAD.vMid - 2, H);
    line(ctx, ROAD.vMid + 2, 0, ROAD.vMid + 2, H);
    ctx.restore();

    // Stop lines
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    line(ctx, 732, ROAD.hTop + 1, 732, ROAD.hMid - 3);
    line(ctx, 868, ROAD.hMid + 3, 868, ROAD.hBot - 1);
    line(ctx, ROAD.vMid + 3, 212, ROAD.vRight - 1, 212);
    line(ctx, ROAD.vLeft + 1, 348, ROAD.vMid - 3, 348);

    // Zebra crossings on all four sides
    ctx.fillStyle = "rgba(255,255,255,.92)";
    for (let y = ROAD.hTop + 4; y < ROAD.hBot - 4; y += 9) {
      ctx.fillRect(737, y, 16, 5);
      ctx.fillRect(847, y, 16, 5);
    }
    for (let x = ROAD.vLeft + 4; x < ROAD.vRight - 4; x += 9) {
      ctx.fillRect(x, 216, 5, 16);
      ctx.fillRect(x, 328, 5, 16);
    }

    for (const t of CITY.trees) drawTree(ctx, t);
  }

  function vehiclePose(lane, v) {
    const pos = lane.entry + lane.dir * v.s;
    return lane.axis === "x" ? { x: pos, y: lane.fixed } : { x: lane.fixed, y: pos };
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(c + amt * 255)));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function drawVehicle(ctx, lane, v) {
    const { x, y } = vehiclePose(lane, v);
    const { len, w } = v;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lane.angle);
    if (v.cleared) ctx.globalAlpha = 0.75; // through the junction: shown slightly faded
    // the vehicle's front is at x = 0 and it extends back to x = -len

    // soft shadow
    ctx.fillStyle = "rgba(0,0,0,.35)";
    roundRect(ctx, -len + 1.5, -w / 2 + 2.2, len + 1, w + 0.6, 5); ctx.fill();

    // body with a gloss gradient across its width
    const body = ctx.createLinearGradient(0, -w / 2, 0, w / 2);
    body.addColorStop(0, shade(v.color, -0.12));
    body.addColorStop(0.35, shade(v.color, 0.1));
    body.addColorStop(0.65, v.color);
    body.addColorStop(1, shade(v.color, -0.18));
    ctx.fillStyle = body;
    roundRect(ctx, -len, -w / 2, len, w, v.type === "bus" ? 3 : v.type === "car" ? w * 0.42 : 5); ctx.fill();

    const glass = "rgba(18,28,44,.92)";
    if (v.type === "car") {
      // tinted windscreen
      const ws = ctx.createLinearGradient(-10.5, 0, -5.5, 0);
      ws.addColorStop(0, "#1a2638");
      ws.addColorStop(1, "#58779b");
      ctx.fillStyle = ws;
      ctx.beginPath();
      ctx.moveTo(-5.4, -w / 2 + 1.8); ctx.lineTo(-10.4, -w / 2 + 2.4); ctx.lineTo(-10.4, w / 2 - 2.4); ctx.lineTo(-5.4, w / 2 - 1.8);
      ctx.closePath(); ctx.fill();
      // side windows
      ctx.fillStyle = "rgba(20,30,46,.85)";
      ctx.fillRect(-16.4, -w / 2 + 1.3, 6, 1.1);
      ctx.fillRect(-16.4, w / 2 - 2.4, 6, 1.1);
      // roof with a highlight
      const roof = ctx.createLinearGradient(0, -w / 2 + 2.6, 0, w / 2 - 2.6);
      roof.addColorStop(0, shade(v.color, 0.22));
      roof.addColorStop(1, shade(v.color, 0.02));
      ctx.fillStyle = roof;
      roundRect(ctx, -16.4, -w / 2 + 2.6, 6, w - 5.2, 2.2); ctx.fill();
      // rear window
      ctx.fillStyle = "#1c2a3d";
      ctx.beginPath();
      ctx.moveTo(-16.4, -w / 2 + 2.6); ctx.lineTo(-19.2, -w / 2 + 3.2); ctx.lineTo(-19.2, w / 2 - 3.2); ctx.lineTo(-16.4, w / 2 - 2.6);
      ctx.closePath(); ctx.fill();
      // bonnet shine
      ctx.fillStyle = "rgba(255,255,255,.18)";
      roundRect(ctx, -4.6, -w / 2 + 2.4, 3.2, w - 4.8, 1.5); ctx.fill();
      // mirrors
      ctx.fillStyle = shade(v.color, -0.22);
      ctx.fillRect(-8.2, -w / 2 - 1.3, 2.2, 1.5);
      ctx.fillRect(-8.2, w / 2 - 0.2, 2.2, 1.5);
    } else if (v.type === "cng") {
      ctx.fillStyle = "#13261b";
      roundRect(ctx, -len + 1.6, -w / 2 + 0.9, len - 5.6, w - 1.8, 4); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.12)";
      roundRect(ctx, -len + 3, -w / 2 + 2, len - 9, 2, 1); ctx.fill();
      ctx.fillStyle = glass;
      ctx.fillRect(-4, -w / 2 + 1.6, 2, w - 3.2);
    } else {
      ctx.fillStyle = "rgba(255,255,255,.88)";
      roundRect(ctx, -len + 3, -w / 2 + 2.2, len - 8, w - 4.4, 2); ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,.12)";
      for (let k = -len + 7; k < -8; k += 7) ctx.fillRect(k, -w / 2 + 2.2, 1, w - 4.4);
      ctx.fillStyle = glass;
      ctx.fillRect(-4.2, -w / 2 + 1, 3, w - 2);
    }

    ctx.fillStyle = "#fff8d6";
    ctx.fillRect(-1.3, -w / 2 + 1.2, 1.3, 2.4);
    ctx.fillRect(-1.3, w / 2 - 3.6, 1.3, 2.4);
    ctx.fillStyle = v.braking ? "#ff2a2a" : "#8a1d1d";
    ctx.fillRect(-len, -w / 2 + 1.2, 1.6, 2.6);
    ctx.fillRect(-len, w / 2 - 3.8, 1.6, 2.6);
    if (v.braking) {
      ctx.fillStyle = "rgba(255,40,40,.28)";
      ctx.beginPath(); ctx.arc(-len, 0, w * 0.75, Math.PI / 2, Math.PI * 1.5); ctx.fill();
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

  const LAMP = { red: "#ff3b30", amber: "#ffb300", green: "#2bd14f" };

  // A signal head on a pole at a corner: three lamps, the lit one glowing.
  function drawSignal(ctx, x, y, state) {
    const w = 11;
    const h = 29;
    ctx.fillStyle = "rgba(0,0,0,.35)";
    roundRect(ctx, x + 2.5, y + 3, w, h, 4); ctx.fill();
    ctx.fillStyle = "#11151c";
    roundRect(ctx, x, y, w, h, 4); ctx.fill();
    ctx.strokeStyle = "#2a313d";
    ctx.lineWidth = 0.8;
    roundRect(ctx, x + 0.4, y + 0.4, w - 0.8, h - 0.8, 4); ctx.stroke();
    ["red", "amber", "green"].forEach((c, i) => {
      const cx = x + w / 2;
      const cy = y + 5.5 + i * 9;
      const on = state === c;
      if (on) {
        const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, 10);
        g.addColorStop(0, LAMP[c] + "cc");
        g.addColorStop(1, LAMP[c] + "00");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = on ? LAMP[c] : "#2b313b";
      ctx.beginPath(); ctx.arc(cx, cy, 3.3, 0, Math.PI * 2); ctx.fill();
      if (on) {
        ctx.fillStyle = "rgba(255,255,255,.55)";
        ctx.beginPath(); ctx.arc(cx - 1, cy - 1, 1, 0, Math.PI * 2); ctx.fill();
      }
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
    // Live bar under the map: signal + countdown, vehicles through, vehicles waiting.
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
    const waiting = el("div", "jx-wait", '<b class="num">0</b><span>waiting</span>');
    const live = el("div", "jx-live");
    live.append(signal, counter, waiting);
    const tip = el("div", "jx-tip");
    tip.hidden = true;
    box.append(canvas, label, tip);
    container.append(box, live);

    const q = (node, sel) => node.querySelector(sel);
    const ui = {
      seconds: q(signal, ".jx-seconds"),
      through: q(counter, ".jx-through"), total: q(counter, ".jx-total"),
      badge: q(counter, ".jx-badge"), bar: q(counter, ".jx-bar span"),
      waiting: q(waiting, "b"),
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
      const availH = full ? container.clientHeight - live.offsetHeight : availW * (VIEW.h / VIEW.w);
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
      drawSignal(ctx, 740, 192, main);    // NW corner: west approach (simulated)
      drawSignal(ctx, 849, 339, main);    // SE corner: east approach
      drawSignal(ctx, 849, 192, cross);   // NE corner: north approach
      drawSignal(ctx, 740, 339, cross);   // SW corner: south approach

      const info = model.info();

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
      set(ui.waiting, "waiting", String(r ? r.remaining : info.waiting));
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
