(() => {
  "use strict";

  const demo = new URLSearchParams(location.search).get("demo") === "1" && window.FleetDemo ? window.FleetDemo : null;
  const SW = "/ledger.v1.SwarmService/";
  const VF = "/ledger.v1.VerifyService/";
  const NS = "http://www.w3.org/2000/svg";
  const FEED_CAP = 120;
  const STORE_CAP = 400;

  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };

  const S = {
    mode: "swarms",
    swarms: [],
    swarmNext: "",
    runs: [],
    runNext: "",
    sel: null,
    detail: null,
    run: null,
    events: [],
    held: [],
    paused: false,
    scope: "swarm",
    filter: "",
    open: new Set(),
    seen: new Set(),
    claims: new Map(),
    flight: new Map(),
    lastByTask: new Map(),
    pane: "list",
  };

  async function rpc(path, body) {
    if (demo) return demo.call(path, body || {});
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error(path.split("/").pop() + " " + r.status);
    return r.json();
  }

  const en = (v) => String(v || "").replace(/^(TASK_STATE|SWARM_STATE|GATE_DECISION)_/, "").toLowerCase();
  const ts = (iso) => (iso ? Date.parse(iso) : NaN);

  function ago(iso) {
    const t = ts(iso);
    if (isNaN(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return Math.round(s) + "s ago";
    if (s < 5400) return Math.round(s / 60) + "m ago";
    if (s < 129600) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function clock(iso) {
    const t = ts(iso);
    if (isNaN(t)) return "";
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function span(msec) {
    const s = Math.max(0, Math.round(msec / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  const CAT = {
    merged: "merged",
    blocked: "blocked",
    failed: "blocked",
    conflict: "conflict",
    running: "running",
    merging: "running",
    passed: "running",
    queued: "queued",
    cancelled: "queued",
  };

  function tally(items, key) {
    const c = { merged: 0, blocked: 0, conflict: 0, running: 0, queued: 0 };
    for (const it of items) {
      const cat = CAT[en(key(it))];
      if (cat) c[cat] += 1;
    }
    return c;
  }

  function tallyMap(map) {
    const c = { merged: 0, blocked: 0, conflict: 0, running: 0, queued: 0 };
    for (const k of Object.keys(map || {})) {
      const cat = CAT[en(k)];
      if (cat) c[cat] += Number(map[k]) || 0;
    }
    return c;
  }

  function tone(word) {
    switch (word) {
      case "pass":
      case "merged":
      case "verified":
      case "done":
        return "ok";
      case "block":
      case "blocked":
      case "fail":
      case "failed":
      case "contradicted":
        return "bad";
      case "retry":
      case "conflict":
      case "unverifiable":
      case "unsupported":
      case "cancelled":
        return "warn";
      case "running":
      case "merging":
      case "passed":
        return "run";
      default:
        return "";
    }
  }

  function keepFocus(fn) {
    const a = document.activeElement;
    const key = a && a.dataset ? a.dataset.key : null;
    fn();
    if (key) {
      const n = document.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (n && n !== document.activeElement) n.focus({ preventScroll: true });
    }
  }

  const FONT = {
    0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  };

  function dotNumber(n, digits) {
    const text = String(Math.min(n, Math.pow(10, digits) - 1)).padStart(digits, "0");
    const pitch = 4;
    const w = digits * 5 * pitch + (digits - 1) * pitch;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + 7 * pitch);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    let lead = true;
    [...text].forEach((ch, di) => {
      if (ch !== "0" || di === digits - 1) lead = false;
      const glyph = FONT[ch];
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          const on = glyph[r][c] === "1" && !(lead && ch === "0");
          const dot = document.createElementNS(NS, "circle");
          dot.setAttribute("cx", String(di * (5 * pitch + pitch) + c * pitch + pitch / 2));
          dot.setAttribute("cy", String(r * pitch + pitch / 2));
          dot.setAttribute("r", "1.25");
          dot.setAttribute("fill", "currentColor");
          dot.setAttribute("opacity", on ? "1" : "0.14");
          svg.append(dot);
        }
      }
    });
    return svg;
  }

  function setPane(p) {
    S.pane = p;
    $("#app").dataset.pane = p;
    const mid = matchMedia("(min-width: 760px) and (max-width: 1199px)").matches;
    const shown = mid && p === "list" ? "detail" : p;
    document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pane === shown)));
  }

  function setConn(state, label) {
    const c = $("#conn");
    c.dataset.s = state;
    c.lastChild.textContent = label || state;
  }

  function matches(text) {
    return !S.filter || text.toLowerCase().includes(S.filter);
  }

  function renderList() {
    keepFocus(() => {
      const box = $("#list");
      box.replaceChildren();
      const swarms = S.mode === "swarms";
      $("#m-swarms").setAttribute("aria-pressed", String(swarms));
      $("#m-runs").setAttribute("aria-pressed", String(!swarms));
      if (swarms) {
        const rows = S.swarms.filter((s) => matches(s.goal + " " + s.id + " " + (s.model || "") + " " + en(s.state)));
        if (!rows.length) box.append(el("p", "empty", S.swarms.length ? "No swarm matches the filter." : "No swarms yet."));
        for (const s of rows) {
          const b = el("button", "item");
          b.type = "button";
          b.dataset.key = "s:" + s.id;
          b.setAttribute("aria-current", String(S.sel && S.sel.kind === "swarm" && S.sel.id === s.id));
          const t = el("div", "t");
          const st = en(s.state);
          t.append(el("i", "dot " + (st === "running" ? "run" : st === "done" ? "ok" : "warn")), el("span", "", s.goal || s.id));
          const c = tallyMap(s.taskCounts);
          const line = el("div", "s");
          if (st === "running") line.append(el("span", "", "running"));
          if (c.merged) line.append(el("span", "", c.merged + " merged"));
          if (c.blocked) line.append(el("span", "", c.blocked + " blocked"));
          if (c.conflict) line.append(el("span", "", c.conflict + " conflict"));
          if (st === "running" && c.running + c.queued) line.append(el("span", "", c.running + c.queued + " open"));
          line.append(el("span", "", ago(s.createdAt)));
          b.append(t, line);
          b.onclick = () => go("swarm", s.id);
          box.append(b);
        }
        if (S.swarmNext) box.append(moreButton());
      } else {
        const rows = S.runs.filter((r) => matches(((r.info && r.info.task) || "") + " " + r.id));
        if (!rows.length) box.append(el("p", "empty", S.runs.length ? "No run matches the filter." : "No runs yet. Start the CLI with --server."));
        for (const r of rows) {
          const b = el("button", "item");
          b.type = "button";
          b.dataset.key = "r:" + r.id;
          b.setAttribute("aria-current", String(S.sel && S.sel.kind === "run" && S.sel.id === r.id));
          const t = el("div", "t");
          t.append(el("i", "dot " + (r.flagged ? "bad" : "ok")), el("span", "", (r.info && r.info.task) || r.id));
          const line = el("div", "s");
          line.append(el("span", "", (r.turns || 0) + " turns"), el("span", "", r.flagged ? r.flagged + " flagged" : "clean"), el("span", "", ago(r.createdAt)));
          b.append(t, line);
          b.onclick = () => go("run", r.id);
          box.append(b);
        }
        if (S.runNext) box.append(moreButton());
      }
    });
  }

  function moreButton() {
    const b = el("button", "btn more", "Load more");
    b.type = "button";
    b.onclick = () => loadList(true);
    return b;
  }

  async function loadList(more) {
    try {
      if (S.mode === "swarms") {
        const d = await rpc(SW + "ListSwarms", { limit: 50, before: more ? S.swarmNext : "" });
        S.swarms = more ? S.swarms.concat(d.swarms || []) : d.swarms || [];
        S.swarmNext = d.next || "";
      } else {
        const d = await rpc(VF + "ListRuns", { limit: 50, before: more ? S.runNext : "" });
        S.runs = more ? S.runs.concat(d.runs || []) : d.runs || [];
        S.runNext = d.next || "";
      }
      renderList();
    } catch (e) {
      if (!S.swarms.length && !S.runs.length) $("#list").replaceChildren(el("p", "empty", "Could not load the list: " + e.message));
    }
  }

  async function loadBoth() {
    const keep = S.mode;
    for (const m of ["runs", "swarms"]) {
      S.mode = m;
      await loadList(false);
    }
    S.mode = keep;
    renderList();
  }

  function go(kind, id) {
    history.pushState(null, "", "#/" + kind + "/" + encodeURIComponent(id));
    openItem(kind, id, true);
  }

  function openItem(kind, id, pane) {
    S.sel = { kind, id };
    S.mode = kind === "run" ? "runs" : "swarms";
    S.detail = null;
    S.run = null;
    renderList();
    renderDetail();
    renderFeed();
    if (pane) setPane("detail");
    if (kind === "swarm") loadDetail();
    else loadRun();
  }

  let detailTimer = 0;
  let listTimer = 0;

  function scheduleDetail() {
    if (detailTimer) return;
    detailTimer = setTimeout(() => {
      detailTimer = 0;
      if (S.sel && S.sel.kind === "swarm") loadDetail();
    }, 250);
  }

  function scheduleList() {
    if (listTimer) return;
    listTimer = setTimeout(() => {
      listTimer = 0;
      loadList(false);
    }, 600);
  }

  async function loadDetail() {
    if (!S.sel || S.sel.kind !== "swarm") return;
    const id = S.sel.id;
    try {
      const d = await rpc(SW + "GetSwarm", { swarmId: id });
      if (!S.sel || S.sel.id !== id) return;
      d.tasks = (d.tasks || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const t of d.tasks) {
        const trouble =
          ["blocked", "failed", "conflict"].includes(en(t.state)) ||
          (t.attempts || []).some((a) => ["retry", "block", "fail"].includes(en(a.decision)));
        if (trouble && !S.seen.has(t.id)) {
          S.seen.add(t.id);
          S.open.add(t.id);
        }
      }
      S.detail = d;
      renderDetail();
      renderFeedLabels();
    } catch (e) {
      if (!S.detail) $("#main").replaceChildren(el("p", "empty", "Could not load the swarm: " + e.message));
    }
  }

  async function loadRun() {
    if (!S.sel || S.sel.kind !== "run") return;
    const id = S.sel.id;
    try {
      const d = await rpc(VF + "GetRun", { runId: id });
      if (!S.sel || S.sel.id !== id) return;
      S.run = d;
      renderDetail();
    } catch (e) {
      $("#main").replaceChildren(el("p", "empty", "Could not load the run: " + e.message));
    }
  }

  function renderDetail() {
    keepFocus(() => {
      const box = $("#main");
      if (!S.sel) {
        box.replaceChildren(el("p", "empty", S.swarms.length || S.runs.length ? "Select a swarm or a run from the list." : "Nothing to show yet."));
        return;
      }
      if (S.sel.kind === "swarm") {
        if (!S.detail) box.replaceChildren(el("p", "empty", "Loading swarm."));
        else box.replaceChildren(...swarmNodes(S.detail));
      } else if (!S.run) box.replaceChildren(el("p", "empty", "Loading run."));
      else box.replaceChildren(...runNodes(S.run));
    });
  }

  function countCell(cls, n, label) {
    const c = el("div", "count " + cls + (n ? " on" : ""));
    c.append(dotNumber(n, 2), el("span", "", label));
    c.setAttribute("role", "group");
    c.setAttribute("aria-label", n + " " + label);
    return c;
  }

  function swarmNodes(d) {
    const sw = d.swarm;
    const tasks = d.tasks;
    const out = [];
    const st = en(sw.state);
    const c = tally(tasks, (t) => t.state);

    const eyebrow = el("p", "eyebrow");
    eyebrow.append(el("span", "", sw.id), el("span", "chip " + (st === "running" ? "run" : st === "done" ? "ok" : "warn"), st));
    out.push(eyebrow);
    out.push(el("h1", "", sw.goal));

    const facts = el("dl", "facts");
    const fact = (k, v, node) => {
      const row = el("div");
      row.append(el("dt", "", k));
      const dd = el("dd");
      if (node) dd.append(node);
      else dd.textContent = v;
      row.append(dd);
      facts.append(row);
    };
    fact("Gate", sw.gate ? "on" : "off");
    if (sw.repo) fact("Repo", sw.repo + (sw.baseRef ? "@" + sw.baseRef : ""));
    if (sw.model) fact("Model", sw.model);
    const startMs = ts(sw.createdAt);
    const endMs = ts(sw.finishedAt);
    const elapsed = el("span", "");
    elapsed.dataset.elapsed = String(startMs);
    if (!isNaN(endMs)) elapsed.dataset.end = String(endMs);
    elapsed.textContent = span((isNaN(endMs) ? Date.now() : endMs) - startMs);
    fact("Elapsed", "", elapsed);
    if (sw.maxAttempts) fact("Attempts", "up to " + sw.maxAttempts + " per subtask");
    out.push(facts);

    const readout = el("div", "readout");
    readout.append(countCell("run", c.running + c.queued, "in progress"), countCell("ok", c.merged, "merged"), countCell("bad", c.blocked, "blocked"), countCell("warn", c.conflict, "conflict"));
    out.push(readout);

    if (st !== "running") {
      const parts = [];
      if (c.merged) parts.push(c.merged + " merged");
      if (c.blocked) parts.push(c.blocked + " blocked");
      if (c.conflict) parts.push(c.conflict + " conflict");
      if (c.running + c.queued) parts.push(c.running + c.queued + " not finished");
      out.push(el("p", "ended", (st === "cancelled" ? "Cancelled. " : "Finished. ") + (parts.length ? parts.join(", ") : "No subtasks ran") + "."));
    }

    const lanes = el("ol", "lanes");
    lanes.setAttribute("aria-label", "Subtasks");
    for (const t of tasks) lanes.append(laneNode(sw, t));
    out.push(lanes);
    return out;
  }

  const STAGES = ["Queued", "Running", "Gate", "Merge", "Merged"];

  function stageStates(state) {
    switch (en(state)) {
      case "queued":
        return ["active", "", "", "", ""];
      case "running":
        return ["done", "active", "", "", ""];
      case "passed":
      case "merging":
        return ["done", "done", "done", "active", ""];
      case "merged":
        return ["done", "done", "done", "done", "done"];
      case "conflict":
        return ["done", "done", "done", "fail", ""];
      case "blocked":
      case "failed":
        return ["done", "done", "fail", "", ""];
      default:
        return ["done", "", "", "", ""];
    }
  }

  function stageLabels(state) {
    const labels = STAGES.slice();
    const s = en(state);
    if (s === "blocked") labels[2] = "Blocked";
    if (s === "failed") labels[2] = "Failed";
    if (s === "conflict") labels[3] = "Conflict";
    if (s === "passed") labels[3] = "To merge";
    return labels;
  }

  function laneNode(sw, t) {
    const state = en(t.state);
    const li = el("li", "lane");
    li.dataset.cat = CAT[state] || "queued";
    const top = el("div", "lane-top");
    top.append(el("span", "idx", "T" + ((t.index || 0) + 1)), el("h3", "", t.title || t.id), el("span", "chip", state));
    li.append(top);

    const track = el("ol", "track");
    track.setAttribute("aria-label", "Progress: " + state);
    const states = stageStates(t.state);
    const labels = stageLabels(t.state);
    labels.forEach((l, i) => {
      const s = el("li", "stage" + (states[i] ? " " + states[i] : ""), l);
      track.append(s);
    });
    li.append(track);

    const attempts = t.attempts || [];
    const cur = attempts[attempts.length - 1];
    const meta = el("div", "lane-meta");
    const max = sw.maxAttempts || Math.max(3, attempts.length);
    const pips = el("span", "pips");
    for (let i = 0; i < max; i++) {
      const a = attempts[i];
      let cls = "";
      if (a) {
        const dec = en(a.decision);
        cls = dec === "pass" ? "ok" : dec === "retry" ? "warn" : dec === "block" || dec === "fail" ? "bad" : "run";
      }
      pips.append(el("i", "pip " + cls));
    }
    pips.setAttribute("role", "img");
    pips.setAttribute("aria-label", "Attempt " + attempts.length + " of " + max);
    meta.append(pips, el("span", "", attempts.length ? "attempt " + attempts.length + " of " + max : "no attempt yet"));
    if (cur && cur.workerId) meta.append(el("span", "", "worker " + cur.workerId));
    if (cur && cur.branch) meta.append(el("span", "", cur.branch));
    li.append(meta);

    const ev = S.lastByTask.get(t.id);
    const last = el("p", "last");
    if (ev) {
      last.append(el("b", "", ev.type), document.createTextNode(eventMessage(ev)));
      if (ev.at) last.append(el("span", "", "  " + clock(ev.at)));
    } else if (t.detail) last.append(document.createTextNode(t.detail));
    else last.append(document.createTextNode("no events yet"));
    li.append(last);

    if (state === "merged") {
      const p = el("p", "outcome ok");
      p.append(document.createTextNode("Merged into " + (sw.baseRef || "the base branch")));
      if (cur && cur.commit) {
        p.append(document.createTextNode(" as "), el("code", "", cur.commit.slice(0, 9)));
      }
      p.append(document.createTextNode("."));
      li.append(p);
    } else if (state === "conflict") {
      li.append(el("p", "outcome warn", "Merge conflict. The branch passed the gate but was not merged." + (t.detail ? " " + t.detail + "." : "")));
    } else if (state === "blocked" || state === "failed") {
      li.append(el("p", "outcome bad", (state === "blocked" ? "Blocked by the gate." : "Failed the gate.") + " The branch was not merged."));
    }

    if (attempts.length) {
      const open = S.open.has(t.id);
      const b = el("button", "toggle", (open ? "Hide attempts" : "Show attempts") + " (" + attempts.length + ")");
      b.type = "button";
      b.dataset.key = "t:" + t.id;
      b.setAttribute("aria-expanded", String(open));
      b.onclick = () => {
        if (S.open.has(t.id)) S.open.delete(t.id);
        else S.open.add(t.id);
        renderDetail();
      };
      li.append(b);
      if (open) {
        const wrap = el("div", "attempts");
        attempts.forEach((a) => wrap.append(attemptNode(a)));
        li.append(wrap);
      }
    }
    return li;
  }

  function attemptNode(a) {
    const art = el("article", "attempt");
    const dec = en(a.decision);
    const head = el("div", "attempt-head");
    head.append(el("h4", "", "Attempt " + a.number));
    const label = dec || (a.finishedAt ? "awaiting gate" : "running");
    head.append(el("span", "chip " + (tone(dec) || (a.finishedAt ? "" : "run")), label));
    const bits = [];
    if (a.workerId) bits.push(a.workerId);
    bits.push((a.turns || 0) + " turns" + (a.flaggedTurns ? ", " + a.flaggedTurns + " flagged" : ""));
    const st = ts(a.startedAt);
    if (!isNaN(st)) bits.push(span((isNaN(ts(a.finishedAt)) ? Date.now() : ts(a.finishedAt)) - st));
    if (a.finishedAt && a.exitCode !== undefined) bits.push("exit " + a.exitCode);
    head.append(el("span", "meta", bits.join(" · ")));
    if (a.runId) {
      const l = el("button", "link", "Open run");
      l.type = "button";
      l.onclick = () => go("run", a.runId);
      head.append(l);
    }
    art.append(head);

    const box = el("div", "claims");
    art.append(box);
    fillClaims(a, box);

    if (a.feedback) {
      const f = el("div", "feedback");
      f.append(el("b", "", "Sent back to the worker"), el("p", "", a.feedback));
      art.append(f);
    }
    return art;
  }

  function extractClaims(data) {
    const list = [];
    let verified = 0;
    for (const t of data.turns || []) {
      for (const v of t.verdicts || []) {
        for (const c of v.claims || []) {
          if (!c.verdict) continue;
          if (c.verdict === "verified") verified += 1;
          else list.push({ turn: t.turn, source: v.source, c });
        }
      }
    }
    return { list, verified };
  }

  function claimsFor(a) {
    const key = [a.turns, a.flaggedTurns, a.decision].join("|");
    const hit = S.claims.get(a.runId);
    if (hit && hit.key === key) return Promise.resolve(hit);
    const fk = a.runId + key;
    if (S.flight.has(fk)) return S.flight.get(fk);
    const p = rpc(VF + "GetRun", { runId: a.runId })
      .then((d) => {
        const entry = { key, ...extractClaims(d) };
        S.claims.set(a.runId, entry);
        return entry;
      })
      .finally(() => S.flight.delete(fk));
    S.flight.set(fk, p);
    return p;
  }

  function fillClaims(a, box) {
    const need = a.runId && ((a.flaggedTurns || 0) > 0 || ["retry", "block", "fail"].includes(en(a.decision)));
    if (!need) return;
    const hit = S.claims.get(a.runId);
    const paint = (entry) => {
      box.replaceChildren();
      if (!entry.list.length) box.append(el("p", "muted", "The checker flagged this attempt but no claim detail is stored."));
      for (const x of entry.list) box.append(claimNode(x.c, x.turn, x.source));
      if (entry.verified) box.append(el("p", "muted", entry.verified + " other " + (entry.verified === 1 ? "claim" : "claims") + " matched the recorded tool calls."));
    };
    if (hit) paint(hit);
    else box.append(el("p", "muted", "Loading evidence."));
    claimsFor(a)
      .then(paint)
      .catch(() => {
        if (!hit) {
          box.replaceChildren(el("p", "muted", "Evidence is unavailable for this run."));
        }
      });
  }

  function claimNode(c, turn, source) {
    const tn = tone(c.verdict) || "";
    const dl = el("dl", "claim " + tn);
    const row = (k, node) => {
      dl.append(el("dt", "", k));
      const dd = el("dd");
      dd.append(node);
      dl.append(dd);
    };
    const said = el("span", "said", "“" + (c.text || "").slice(0, 240) + "”");
    row("Claimed", said);
    const verdict = el("span");
    verdict.append(el("span", "chip", c.verdict));
    if (c.kind) verdict.append(el("span", "chip", c.kind));
    const where = [];
    if (turn !== undefined) where.push("turn " + turn);
    if (source && source !== "checker") where.push(source);
    if (where.length) verdict.append(el("span", "muted mono", where.join(" · ")));
    row("Verdict", verdict);
    if (c.reason) row("Evidence", el("span", "why", c.reason));
    if (c.ref) row("Source", el("span", "mono", c.ref));
    if (c.rule) row("Rule", el("span", "mono", c.rule));
    return dl;
  }

  function runNodes(d) {
    const run = d.run;
    const out = [];
    const eyebrow = el("p", "eyebrow");
    eyebrow.append(el("span", "", run.id));
    out.push(eyebrow, el("h1", "", (run.info && run.info.task) || run.id));
    const facts = el("dl", "facts");
    const add = (k, v) => {
      if (!v) return;
      const row = el("div");
      row.append(el("dt", "", k), el("dd", "", v));
      facts.append(row);
    };
    add("Model", run.info && run.info.model);
    add("Source", run.info && run.info.source);
    add("Turns", String(run.turns || (d.turns || []).length));
    add("Started", run.createdAt ? ago(run.createdAt) : "");
    out.push(facts);
    if (!(d.turns || []).length) out.push(el("p", "empty", "This run has no turns yet."));
    for (const t of d.turns || []) {
      const verdicts = t.verdicts || [];
      const checker = verdicts.find((v) => v.source === "checker");
      const card = el("article", "turn" + (checker && checker.flagged ? " flagged" : ""));
      const h = el("h3", "", "Turn " + t.turn);
      h.append(el("span", "", (t.evidenceCount || 0) + " tool calls"));
      for (const v of verdicts) if (v.source !== "checker") h.append(el("span", "chip " + (v.flagged ? "bad" : "ok"), v.source + (v.flagged ? " flagged" : " clear")));
      card.append(h, el("div", "text", t.text));
      for (const v of verdicts) for (const c of v.claims || []) if (c.verdict) card.append(claimNode(c, undefined, v.source));
      out.push(card);
    }
    return out;
  }

  function eventData(ev) {
    if (ev.data && typeof ev.data === "object") return ev.data;
    if (typeof ev.data === "string" && ev.data) {
      try {
        return JSON.parse(ev.data);
      } catch (e) {
        return {};
      }
    }
    return {};
  }

  function eventMessage(ev) {
    if (ev.message) return ev.message;
    const d = ev.data || {};
    if (ev.type === "attempt.turn") return "turn " + (d.turn !== undefined ? d.turn : "") + (d.flagged ? " flagged" : " checked");
    return "";
  }

  function evTone(ev) {
    switch (ev.type) {
      case "gate.pass":
      case "task.merged":
      case "swarm.done":
        return "ok";
      case "gate.block":
      case "gate.fail":
      case "task.heartbeat_lost":
        return "bad";
      case "gate.retry":
      case "task.conflict":
      case "swarm.cancelled":
        return "warn";
      case "attempt.turn":
        return ev.data && ev.data.flagged ? "bad" : "";
      case "task.claimed":
      case "task.merging":
      case "attempt.completed":
        return "run";
      default:
        return "";
    }
  }

  function taskLabel(ev) {
    if (!ev.task_id) return "";
    if (S.detail && S.detail.swarm.id === ev.swarm_id) {
      const t = S.detail.tasks.find((x) => x.id === ev.task_id);
      if (t) return "T" + ((t.index || 0) + 1);
    }
    return ev.task_id.slice(-4);
  }

  function swarmLabel(ev) {
    const s = S.swarms.find((x) => x.id === ev.swarm_id);
    return s ? s.goal.slice(0, 28) : ev.swarm_id;
  }

  function inScope(ev) {
    if (S.scope === "all") return true;
    return !!S.sel && S.sel.kind === "swarm" && ev.swarm_id === S.sel.id;
  }

  function feedItem(ev) {
    const li = el("li", "ev");
    li.append(el("time", "", clock(ev.at)));
    const body = el("div");
    const head = el("div");
    const chip = el("span", "chip " + evTone(ev));
    chip.append(el("i", "dot " + evTone(ev)), document.createTextNode(ev.type));
    head.append(chip);
    const who = [taskLabel(ev)];
    if (S.scope === "all") who.push(swarmLabel(ev));
    const w = who.filter(Boolean).join(" · ");
    if (w) head.append(el("span", "who", w));
    body.append(head);
    const msg = eventMessage(ev);
    if (msg) body.append(el("p", "", msg));
    li.append(body);
    li._ev = ev;
    return li;
  }

  function renderFeed() {
    const ul = $("#feed");
    ul.setAttribute("aria-busy", "true");
    ul.replaceChildren();
    let n = 0;
    for (const ev of S.events) {
      if (!inScope(ev)) continue;
      ul.append(feedItem(ev));
      if (++n >= FEED_CAP) break;
    }
    if (!n) {
      const li = el("li", "empty", S.scope === "all" ? "No events yet." : S.sel && S.sel.kind === "swarm" ? "No events for this swarm yet." : "Open a swarm to see its events.");
      ul.append(li);
    }
    ul.setAttribute("aria-busy", "false");
    renderPause();
  }

  function renderFeedLabels() {
    $("#feed")
      .querySelectorAll(".ev")
      .forEach((li) => {
        const who = $(".who", li);
        if (who && li._ev) who.textContent = [taskLabel(li._ev), S.scope === "all" ? swarmLabel(li._ev) : ""].filter(Boolean).join(" · ");
      });
  }

  function renderPause() {
    const b = $("#pause");
    b.setAttribute("aria-pressed", String(S.paused));
    b.textContent = S.paused ? "Resume" + (S.held.length ? " (" + S.held.length + " held)" : "") : "Pause";
  }

  function pushFeed(ev) {
    S.events.unshift(ev);
    if (S.events.length > STORE_CAP) S.events.length = STORE_CAP;
    if (!inScope(ev)) return;
    const ul = $("#feed");
    const empty = $(".empty", ul);
    if (empty) empty.remove();
    ul.prepend(feedItem(ev));
    while (ul.children.length > FEED_CAP) ul.lastChild.remove();
  }

  function setPaused(v) {
    S.paused = v;
    if (!v) {
      const held = S.held;
      S.held = [];
      held.forEach(pushFeed);
    }
    renderPause();
  }

  function onEvent(raw) {
    const ev = { ...raw, data: eventData(raw) };
    if (ev.task_id) S.lastByTask.set(ev.task_id, ev);
    if (S.paused) {
      S.held.unshift(ev);
      if (S.held.length > STORE_CAP) S.held.length = STORE_CAP;
      renderPause();
    } else {
      pushFeed(ev);
    }
    if (S.sel && S.sel.kind === "swarm" && ev.swarm_id === S.sel.id) scheduleDetail();
    scheduleList();
  }

  let fails = 0;
  let wasDown = false;
  let pollTimer = 0;
  let source = null;

  function resync() {
    loadList(false);
    if (S.sel && S.sel.kind === "swarm") loadDetail();
    else if (S.sel) loadRun();
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(resync, 5000);
  }

  function stopPoll() {
    clearInterval(pollTimer);
    pollTimer = 0;
  }

  function connect() {
    if (demo) {
      demo.subscribe(onEvent);
      setConn("live", "live");
      return;
    }
    if (!window.EventSource) {
      setConn("polling", "polling");
      startPoll();
      return;
    }
    source = new EventSource("/events");
    source.onopen = () => {
      fails = 0;
      stopPoll();
      setConn("live");
      if (wasDown) resync();
      wasDown = false;
    };
    source.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch (e) {
        return;
      }
    };
    source.onerror = () => {
      source.close();
      wasDown = true;
      fails += 1;
      if (fails >= 2) {
        setConn("polling", "polling");
        startPoll();
      } else setConn("reconnecting");
      setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, fails - 1)));
    };
  }

  let prev = null;

  function parseProm(text) {
    const rows = [];
    for (const line of text.split("\n")) {
      if (!line || line[0] === "#") continue;
      const m = /^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)/.exec(line);
      if (m) rows.push({ n: m[1], l: m[2] || "", v: parseFloat(m[3]) });
    }
    return rows;
  }

  function p99(rows) {
    const byLe = new Map();
    for (const r of rows) {
      if (r.n !== "ledger_check_duration_seconds_bucket") continue;
      const le = /le="([^"]+)"/.exec(r.l);
      if (!le) continue;
      const k = le[1] === "+Inf" ? Infinity : parseFloat(le[1]);
      byLe.set(k, (byLe.get(k) || 0) + r.v);
    }
    const keys = [...byLe.keys()].sort((a, b) => a - b);
    if (!keys.length) return null;
    const total = byLe.get(keys[keys.length - 1]);
    if (!total) return null;
    for (const k of keys) if (byLe.get(k) >= total * 0.99) return k === Infinity ? keys[keys.length - 2] : k;
    return null;
  }

  async function pollMetrics() {
    if (demo) return;
    try {
      const r = await fetch("/metrics", { headers: { Accept: "text/plain" } });
      if (!r.ok) throw new Error("metrics");
      const rows = parseProm(await r.text());
      const box = $("#stats");
      const count = rows.filter((x) => x.n === "ledger_check_duration_seconds_count").reduce((a, x) => a + x.v, 0);
      const now = Date.now();
      let rate = null;
      if (prev && now > prev.t && count >= prev.count) rate = ((count - prev.count) / (now - prev.t)) * 1000;
      prev = { t: now, count };
      const q = rows.filter((x) => x.n === "ledger_queue_jobs");
      const waiting = q.filter((x) => /state="(pending|queued|available|ready)"/.test(x.l));
      const depth = (waiting.length ? waiting : q).reduce((a, x) => a + x.v, 0);
      const lat = p99(rows);
      const parts = [];
      if (rows.some((x) => x.n === "ledger_check_duration_seconds_count")) parts.push(["checks/s", rate === null ? "--" : rate.toFixed(rate < 10 ? 1 : 0)]);
      if (lat !== null) parts.push(["p99 check", lat < 1 ? Math.round(lat * 1000) + " ms" : lat.toFixed(1) + " s"]);
      if (q.length) parts.push(["queue", String(depth)]);
      box.replaceChildren();
      for (const [k, v] of parts) {
        const s = el("span", "", k + " ");
        s.append(el("b", "", v));
        box.append(s);
      }
      box.hidden = !parts.length;
    } catch (e) {
      $("#stats").hidden = true;
    }
  }

  function tickElapsed() {
    document.querySelectorAll("[data-elapsed]").forEach((n) => {
      if (n.dataset.end) return;
      n.textContent = span(Date.now() - Number(n.dataset.elapsed));
    });
  }

  function typing(t) {
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }

  function items() {
    return [...document.querySelectorAll("#list .item")];
  }

  function bind() {
    $("#m-swarms").onclick = () => {
      S.mode = "swarms";
      renderList();
    };
    $("#m-runs").onclick = () => {
      S.mode = "runs";
      renderList();
    };
    $("#filter").addEventListener("input", (e) => {
      S.filter = e.target.value.trim().toLowerCase();
      renderList();
    });
    $("#scope-swarm").onclick = () => setScope("swarm");
    $("#scope-all").onclick = () => setScope("all");
    $("#pause").onclick = () => setPaused(!S.paused);
    document.querySelectorAll("#tabs button").forEach((b) => {
      b.onclick = () => setPane(b.dataset.pane);
    });
    matchMedia("(min-width: 760px) and (max-width: 1199px)").addEventListener("change", () => setPane(S.pane));
    window.addEventListener("popstate", fromHash);
    $("#replay").onclick = () => {
      S.events = [];
      S.held = [];
      S.lastByTask.clear();
      S.claims.clear();
      S.open.clear();
      S.seen.clear();
      demo.replay();
      renderFeed();
      setTimeout(async () => {
        await loadBoth();
        go("swarm", "sw_demo01");
      }, 60);
    };
    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typing(e.target)) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        setPane("list");
        $("#filter").focus();
      } else if (e.key === "p") {
        setPaused(!S.paused);
      } else if (e.key === "j" || e.key === "k") {
        const list = items();
        if (!list.length) return;
        let i = list.indexOf(document.activeElement);
        if (i < 0) i = list.findIndex((n) => n.getAttribute("aria-current") === "true");
        i = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + (e.key === "j" ? 1 : -1)));
        setPane("list");
        list[i].focus();
        list[i].scrollIntoView({ block: "nearest" });
      }
    });
  }

  function setScope(v) {
    S.scope = v;
    $("#scope-swarm").setAttribute("aria-pressed", String(v === "swarm"));
    $("#scope-all").setAttribute("aria-pressed", String(v === "all"));
    renderFeed();
  }

  function fromHash() {
    const m = /^#\/(swarm|run)\/(.+)$/.exec(location.hash);
    if (m) openItem(m[1], decodeURIComponent(m[2]), true);
  }

  async function init() {
    bind();
    if (demo) {
      $("#demo-tag").hidden = false;
      $("#replay").hidden = false;
      document.title = "Ledger Fleet (demo)";
    }
    renderDetail();
    renderFeed();
    connect();
    if (demo) demo.start();
    await loadBoth();
    const m = /^#\/(swarm|run)\/(.+)$/.exec(location.hash);
    if (m) openItem(m[1], decodeURIComponent(m[2]), false);
    else if (S.swarms.length) openItem("swarm", S.swarms[0].id, false);
    else if (S.runs.length) openItem("run", S.runs[0].id, false);
    setInterval(tickElapsed, 1000);
    setInterval(renderList, 30000);
    pollMetrics();
    setInterval(pollMetrics, 5000);
  }

  init();
})();
