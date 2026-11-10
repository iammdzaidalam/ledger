window.FleetDemo = (() => {
  const params = new URLSearchParams(location.search);
  const speed = Math.max(0.25, Number(params.get("speed")) || 1);
  const SWARM_ID = "sw_demo01";
  const subs = [];
  let timers = [];
  let swarm = null;
  let tasks = [];
  let runData = {};
  let older = [];
  let runs = [];

  const iso = (offset) => new Date(Date.now() + (offset || 0)).toISOString();
  const lower = (s) => s.toLowerCase();

  const claimTests = {
    text: "All tests pass.",
    kind: "test_result",
    verdict: "contradicted",
    rule: "test-result-vs-exit-code",
    reason: "npm test exited 1 (2 failed, 31 passed). The claim says every test passes.",
    ref: "tool call 14: npm test",
  };

  const claimEdit = {
    text: "Removed the unused retry helper.",
    kind: "file_edit",
    verdict: "unverifiable",
    rule: "edit-needs-tool-call",
    reason: "No edit or write call touched src/util/retry.ts in this attempt, and the file is still in the worktree.",
    ref: "no matching tool call",
  };

  const okClaim = (text, kind, ref) => ({ text, kind, verdict: "verified", rule: "matches-tool-call", reason: "", ref });

  function build() {
    const start = Date.now();
    swarm = {
      id: SWARM_ID,
      goal: "Replace the ad hoc config loader with typed env parsing",
      repo: "github.com/acme/billing-api",
      baseRef: "main",
      model: "qwen2.5-coder:14b",
      gate: true,
      maxAttempts: 3,
      state: "SWARM_STATE_RUNNING",
      createdAt: new Date(start).toISOString(),
    };
    const titles = [
      ["Add a typed env parser", "Write src/config/env.ts with a parser for each setting."],
      ["Rewrite the loader tests", "Port src/config/loader.test.ts to the typed parser."],
      ["Move call sites to the parser", "Replace direct process.env reads under src/services."],
      ["Drop the unused retry helper", "Delete src/util/retry.ts and its imports."],
    ];
    tasks = titles.map((t, i) => ({
      id: "tk_demo_" + (i + 1),
      swarmId: SWARM_ID,
      index: i,
      title: t[0],
      prompt: t[1],
      state: "TASK_STATE_QUEUED",
      attempts: [],
      detail: "",
    }));
    runData = {};
    older = [
      finished("sw_demo00", "Pin the CI Node version and cache dependencies", ["merged", "merged", "merged"], -86400000 * 1.2),
      finished("sw_demo99", "Split the invoice renderer into view and data modules", ["merged", "merged", "blocked"], -86400000 * 3.4),
    ];
    runs = [
      plainRun("run_cli_01", "Fix flaky date parsing in the export job", 7, 2, -3600000 * 5),
      plainRun("run_cli_02", "Add pagination to the customers endpoint", 5, 0, -3600000 * 26),
      plainRun("run_cli_03", "Bump the lint config and fix new warnings", 11, 1, -3600000 * 52),
    ];
  }

  function finished(id, goal, outcomes, offset) {
    const t0 = Date.now() + offset;
    const sw = {
      id,
      goal,
      repo: "github.com/acme/billing-api",
      baseRef: "main",
      model: "qwen2.5-coder:14b",
      gate: true,
      maxAttempts: 3,
      state: "SWARM_STATE_DONE",
      createdAt: new Date(t0).toISOString(),
      finishedAt: new Date(t0 + 540000).toISOString(),
    };
    const ts = outcomes.map((o, i) => {
      const a = {
        id: id + "_a" + i,
        number: 1,
        workerId: "w-0" + ((i % 3) + 1),
        runId: "run_old_" + id + i,
        decision: o === "blocked" ? "GATE_DECISION_BLOCK" : "GATE_DECISION_PASS",
        turns: 6,
        flaggedTurns: o === "blocked" ? 2 : 0,
        branch: "fleet/" + id + "/t" + i,
        commit: o === "merged" ? "a1c9e0" + i + "f" : "",
        startedAt: new Date(t0 + i * 20000).toISOString(),
        finishedAt: new Date(t0 + i * 20000 + 90000).toISOString(),
      };
      if (o === "blocked") a.feedback = "";
      return {
        id: id + "_t" + i,
        swarmId: id,
        index: i,
        title: ["Extract the data module", "Extract the view module", "Update the snapshot tests"][i],
        state: o === "merged" ? "TASK_STATE_MERGED" : "TASK_STATE_BLOCKED",
        attempts: [a],
        detail: "",
      };
    });
    const counts = {};
    ts.forEach((t) => {
      counts[t.state] = (counts[t.state] || 0) + 1;
    });
    sw.taskCounts = counts;
    runData["run_old_" + id + "2"] = {
      run: { id: "run_old_" + id + "2", info: { task: "Update the snapshot tests", model: sw.model, source: "fleet" }, turns: 6 },
      turns: [
        {
          turn: 4,
          text: "Snapshots regenerated. Tests pass.",
          evidenceCount: 3,
          verdicts: [{ source: "checker", flagged: true, claims: [{ ...claimTests, text: "Tests pass.", reason: "npm test exited 1 (4 failed)." }], latencyUs: "3900", createdAt: sw.createdAt }],
        },
      ],
    };
    return { swarm: sw, tasks: ts };
  }

  function plainRun(id, task, turns, flagged, offset) {
    return {
      id,
      info: { task, model: "qwen2.5-coder:14b", source: "cli" },
      turns,
      flagged,
      createdAt: new Date(Date.now() + offset).toISOString(),
    };
  }

  function emit(type, ti, message, data) {
    const t = ti == null ? null : tasks[ti];
    const a = t && t.attempts.length ? t.attempts[t.attempts.length - 1] : null;
    const ev = {
      swarm_id: SWARM_ID,
      task_id: t ? t.id : "",
      attempt_id: a ? a.id : "",
      type,
      message,
      data: data || {},
      at: iso(),
    };
    subs.forEach((f) => f(ev));
  }

  function lastAttempt(ti) {
    const t = tasks[ti];
    return t.attempts[t.attempts.length - 1];
  }

  function claim(ti, worker) {
    const t = tasks[ti];
    const n = t.attempts.length + 1;
    const a = {
      id: "at_demo_" + (ti + 1) + "_" + n,
      number: n,
      workerId: worker,
      runId: "run_demo_" + (ti + 1) + "_" + n,
      turns: 0,
      flaggedTurns: 0,
      branch: "fleet/" + SWARM_ID + "/t" + (ti + 1),
      startedAt: iso(),
    };
    t.attempts.push(a);
    t.state = "TASK_STATE_RUNNING";
    runData[a.runId] = {
      run: { id: a.runId, info: { task: t.title, model: swarm.model, source: "fleet" }, turns: 0 },
      turns: [],
    };
    emit("task.claimed", ti, worker + " claimed attempt " + n);
  }

  function turn(ti, text, flagged, claims) {
    const a = lastAttempt(ti);
    a.turns += 1;
    if (flagged) a.flaggedTurns += 1;
    const r = runData[a.runId];
    r.run.turns = a.turns;
    r.turns.push({
      turn: a.turns,
      text,
      evidenceCount: 2 + a.turns,
      verdicts: [{ source: "checker", flagged: !!flagged, claims: claims || [], latencyUs: String(2800 + a.turns * 310), createdAt: iso() }],
    });
    emit("attempt.turn", ti, flagged ? "turn " + a.turns + " flagged by the checker" : "turn " + a.turns + " checked", { flagged: !!flagged, turn: a.turns });
  }

  function complete(ti, exitCode) {
    const a = lastAttempt(ti);
    a.finishedAt = iso();
    a.exitCode = exitCode;
    emit("attempt.completed", ti, "attempt " + a.number + " finished after " + a.turns + " turns");
  }

  function gate(ti, decision, message, feedback) {
    const t = tasks[ti];
    const a = lastAttempt(ti);
    a.decision = "GATE_DECISION_" + decision;
    if (feedback) a.feedback = feedback;
    if (decision === "PASS") {
      t.state = "TASK_STATE_PASSED";
      a.commit = ["c41f0a9", "7be22d1", "90d3a5e", "5a8f1c2"][ti];
    }
    if (decision === "RETRY") t.state = "TASK_STATE_QUEUED";
    if (decision === "BLOCK") t.state = "TASK_STATE_BLOCKED";
    if (decision === "FAIL") t.state = "TASK_STATE_FAILED";
    t.detail = message;
    emit("gate." + lower(decision), ti, message);
  }

  function merging(ti) {
    tasks[ti].state = "TASK_STATE_MERGING";
    tasks[ti].detail = "rebasing " + lastAttempt(ti).branch + " onto main";
    emit("task.merging", ti, "rebasing onto main");
  }

  function merged(ti) {
    tasks[ti].state = "TASK_STATE_MERGED";
    const sha = lastAttempt(ti).commit;
    tasks[ti].detail = "merged as " + sha;
    emit("task.merged", ti, "merged into main as " + sha);
  }

  function conflict(ti, file) {
    tasks[ti].state = "TASK_STATE_CONFLICT";
    tasks[ti].detail = "conflict in " + file;
    emit("task.conflict", ti, "merge conflict in " + file + ", branch left unmerged");
  }

  function finish() {
    swarm.state = "SWARM_STATE_DONE";
    swarm.finishedAt = iso();
    emit("swarm.done", null, "swarm finished: 2 merged, 1 blocked, 1 conflict");
  }

  const feedbackTests =
    "Your last message said all tests pass, but npm test exited 1 with 2 failures in src/config/loader.test.ts. Fix those two tests, run npm test again and report the real result.";
  const feedbackEdit =
    "You said you removed src/util/retry.ts, but no tool call edited or deleted it. Delete the file and its imports, then run the type check.";

  const script = [
    [0.3, () => ["Add a typed env parser", "Rewrite the loader tests", "Move call sites to the parser", "Drop the unused retry helper"].forEach((t, i) => emit("task.queued", i, "queued: " + t))],
    [1.2, () => claim(0, "w-01")],
    [1.5, () => claim(1, "w-02")],
    [1.8, () => claim(2, "w-03")],
    [2.8, () => turn(0, "Created src/config/env.ts with parsers for string, int, bool and url settings.", false, [okClaim("Created src/config/env.ts.", "file_edit", "tool call 3: write src/config/env.ts")])],
    [3.4, () => turn(1, "Ported the first six loader tests to the typed parser.", false, [okClaim("Ported six tests.", "file_edit", "tool call 4: edit loader.test.ts")])],
    [3.9, () => turn(2, "Replaced process.env reads in src/services/billing.ts.", false, [okClaim("Updated billing.ts.", "file_edit", "tool call 5: edit billing.ts")])],
    [5.0, () => turn(0, "Added unit tests for the parser and ran npm test.", false, [okClaim("npm test passed.", "test_result", "tool call 9: npm test, exit 0")])],
    [5.8, () => turn(1, "Finished the port. Updated src/config/env.test.ts. All tests pass.", true, [okClaim("Updated env.test.ts.", "file_edit", "tool call 11: edit env.test.ts"), claimTests])],
    [6.4, () => turn(2, "Replaced reads in src/services/mailer.ts and src/services/queue.ts.", false, [okClaim("Updated mailer.ts and queue.ts.", "file_edit", "tool call 8: edit mailer.ts, queue.ts")])],
    [7.4, () => { complete(0, 0); gate(0, "PASS", "claims match the recorded tool calls"); }],
    [7.9, () => claim(3, "w-01")],
    [8.2, () => merging(0)],
    [8.6, () => { complete(1, 1); gate(1, "RETRY", "blocked claim: All tests pass.", feedbackTests); }],
    [9.2, () => claim(1, "w-02")],
    [9.4, () => { complete(2, 0); gate(2, "PASS", "claims match the recorded tool calls"); }],
    [10.2, () => merged(0)],
    [10.5, () => merging(2)],
    [10.8, () => turn(3, "Searched for imports of retry.ts and found two.", false, [okClaim("Found two imports.", "command", "tool call 2: grep retry")])],
    [11.4, () => turn(1, "Fixed the two failing tests and reran npm test.", false, [okClaim("Fixed two tests.", "file_edit", "tool call 6: edit loader.test.ts")])],
    [12.4, () => conflict(2, "src/services/billing.ts")],
    [13.0, () => turn(3, "Removed the unused retry helper.", true, [claimEdit])],
    [13.6, () => turn(1, "npm test: 33 passed, 0 failed.", false, [okClaim("33 tests passed.", "test_result", "tool call 9: npm test, exit 0")])],
    [14.6, () => { complete(1, 0); gate(1, "PASS", "claims match the recorded tool calls"); }],
    [15.0, () => merging(1)],
    [15.6, () => { complete(3, 0); gate(3, "RETRY", "blocked claim: Removed the unused retry helper.", feedbackEdit); }],
    [16.2, () => claim(3, "w-03")],
    [17.0, () => merged(1)],
    [18.0, () => turn(3, "Deleted src/util/retry.ts and updated its two imports.", true, [claimEdit])],
    [19.6, () => turn(3, "Ran the type check. Retry helper is removed.", true, [claimEdit])],
    [20.8, () => { complete(3, 0); gate(3, "BLOCK", "blocked after repeating an unsupported claim: Removed the unused retry helper."); }],
    [21.6, () => finish()],
  ];

  function start() {
    timers.forEach(clearTimeout);
    timers = [];
    build();
    emit("swarm.created", null, "swarm created with 4 subtasks");
    script.forEach(([t, fn]) => timers.push(setTimeout(fn, (t * 1000) / speed)));
  }

  function every() {
    return [{ swarm, tasks }, ...older];
  }

  function listSwarm(entry) {
    const s = { ...entry.swarm };
    const counts = {};
    entry.tasks.forEach((t) => {
      counts[t.state] = (counts[t.state] || 0) + 1;
    });
    s.taskCounts = counts;
    return s;
  }

  async function call(path, body) {
    await new Promise((r) => setTimeout(r, 30));
    const method = path.split("/").pop();
    if (method === "ListSwarms") return { swarms: every().map(listSwarm), next: "" };
    if (method === "GetSwarm") {
      const e = every().find((x) => x.swarm.id === body.swarmId);
      if (!e) throw new Error("GetSwarm 404");
      return JSON.parse(JSON.stringify({ swarm: listSwarm(e), tasks: e.tasks }));
    }
    if (method === "ListRuns") return { runs, next: "" };
    if (method === "GetRun") {
      if (runData[body.runId]) return JSON.parse(JSON.stringify(runData[body.runId]));
      const r = runs.find((x) => x.id === body.runId);
      if (!r) throw new Error("GetRun 404");
      return {
        run: r,
        turns: [
          { turn: 1, text: "Read the failing job and the date helper.", evidenceCount: 3, verdicts: [{ source: "checker", flagged: false, claims: [okClaim("Read export.ts.", "command", "tool call 1: cat export.ts")], latencyUs: "2900", createdAt: r.createdAt }] },
          { turn: 2, text: "Fixed the parser and the tests pass.", evidenceCount: 5, verdicts: [{ source: "checker", flagged: r.flagged > 0, claims: [r.flagged > 0 ? { ...claimTests, text: "The tests pass." } : okClaim("Tests pass.", "test_result", "tool call 6: npm test, exit 0")], latencyUs: "3400", createdAt: r.createdAt }] },
        ],
      };
    }
    throw new Error(method + " 404");
  }

  build();

  return {
    call,
    subscribe(fn) {
      subs.push(fn);
    },
    replay() {
      start();
    },
    start,
  };
})();
