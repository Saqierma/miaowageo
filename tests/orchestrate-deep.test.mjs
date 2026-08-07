import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { runDeepAudit, RobotsDisallowedError, DEEP_TIMEOUT_MS } from "../src/orchestrate-deep.mjs";
import { LighthouseBusyError, LIGHTHOUSE_TIMEOUT_MS } from "../src/lighthouse-runner.mjs";
import { PSI_TIMEOUT_MS } from "../src/psi.mjs";
import { psiChecks } from "../src/checks/psi-map.mjs";

const fxPsi = (n) => JSON.parse(readFileSync(new URL(`../fixtures/psi/${n}.json`, import.meta.url), "utf8"));
const fxLh = (n) => JSON.parse(readFileSync(new URL(`../fixtures/lighthouse/${n}.json`, import.meta.url), "utf8"));

const okPsi = async (url) => ({ raw: fxPsi("made-in-china"), results: psiChecks({ ok: true, status: 200, payload: fxPsi("made-in-china"), requestedUrl: url }) });
const okLh = async () => ({ report: fxLh("globalsources"), reason: null, durationMs: 20_000, killConfirmed: null });

const BASE = {
  robotsAllowedPage: true,
  psiApiKey: "k",
  proxyPort: 1,
  nodePath: "/n",
  lighthouseBin: "/lh",
  chromePath: "/c",
};

const byId = (results, id) => results.find((r) => r.id === id);
const group = (results, g) => results.filter((r) => r.group === g);

// ---------------------------------------------------------------------------
// 并行与部分失败——本文件最要紧的部分
// ---------------------------------------------------------------------------

test("PSI 与 Lighthouse 并行发起，不串行", async () => {
  // 串行会让最坏路径变成 75 + 75 = 150 s，直接击穿 90 s 硬超时。
  const started = [];
  const slow = (label, ms, value) => async () => {
    started.push({ label, at: Date.now() });
    await new Promise((r) => setTimeout(r, ms));
    return value;
  };
  const t0 = Date.now();
  await runDeepAudit("https://x.example/", {
    ...BASE,
    runPsi: slow("psi", 60, { raw: null, results: psiChecks({ ok: true, status: 200, payload: fxPsi("made-in-china"), requestedUrl: "https://x.example/" }) }),
    runLighthouse: slow("lh", 60, { report: fxLh("globalsources"), reason: null, durationMs: 60, killConfirmed: null }),
  });
  const elapsed = Date.now() - t0;
  assert.equal(started.length, 2);
  assert.ok(Math.abs(started[0].at - started[1].at) < 30, "两边应几乎同时发起");
  assert.ok(elapsed < 110, `并行总耗时应接近单边（~60ms），实测 ${elapsed}ms——串行会接近 120ms`);
});

test("Lighthouse 崩了不影响 PSI 已经拿到的结果（allSettled 而非 all）", async () => {
  // 用 Promise.all 的话，一边 reject 会把另一边**已经拿到的结果**一起丢掉，
  // 等于把一次部分成功谎报成一次完全失败。
  const results = (await runDeepAudit("https://www.made-in-china.com/", {
    ...BASE,
    runPsi: okPsi,
    runLighthouse: async () => { throw new Error("Chrome 起不来"); },
  })).results;

  const perf = group(results, "performance");
  assert.equal(perf.length, 2);
  assert.ok(perf.every((r) => r.state === "ready"), "PSI 的两项必须照常呈现");
  assert.equal(byId(results, "performance.psi-score").verdict, "warn");

  const agent = group(results, "agent");
  assert.equal(agent.length, 2);
  assert.ok(agent.every((r) => r.state === "not_wired"), "只有 agent 组是 not_wired");
  assert.match(agent[0].observation, /Chrome 起不来/, "原因要原样带出去，不许糊成「未知错误」");
});

test("PSI 挂了不影响 Lighthouse 的结果", async () => {
  const results = (await runDeepAudit("https://www.globalsources.com/", {
    ...BASE,
    runPsi: async () => { throw new Error("缺密钥"); },
    runLighthouse: okLh,
  })).results;

  assert.ok(group(results, "performance").every((r) => r.state === "not_wired"));
  const cls = byId(results, "agent.cls");
  assert.equal(cls.state, "ready");
  assert.equal(cls.verdict, "pass", "globalsources 快照的真实 CLS 是 0.0857 → pass");
});

test("信号量占用（busy）与真实异常必须给出不同文案", async () => {
  // 两者都是 not_wired，但运维的处置完全不同：一个该扩容/排队，
  // 一个该去查 bug。文案一样就无从判断。
  const busy = (await runDeepAudit("https://x.example/", {
    ...BASE, runPsi: okPsi, runLighthouse: async () => { throw new LighthouseBusyError(); },
  })).results;
  const broken = (await runDeepAudit("https://x.example/", {
    ...BASE, runPsi: okPsi, runLighthouse: async () => { throw new Error("TypeError: 我们的代码坏了"); },
  })).results;

  const busyObs = byId(busy, "agent.cls").observation;
  const brokenObs = byId(broken, "agent.cls").observation;
  assert.match(busyObs, /busy/);
  assert.notEqual(busyObs, brokenObs, "容量问题与代码 bug 必须能从文案上分开");
});

test("两边都失败时，四项都是 not_wired，且仍然返回完整的四项", async () => {
  const results = (await runDeepAudit("https://x.example/", {
    ...BASE,
    runPsi: async () => { throw new Error("psi 挂了"); },
    runLighthouse: async () => { throw new Error("lh 挂了"); },
  })).results;
  assert.equal(results.length, 4, "无论成败，深检查的四个项都必须出现——缺项会让呈现层的分母算错");
  assert.ok(results.every((r) => r.state === "not_wired"));
});

// ---------------------------------------------------------------------------
// robots 禁止时不启动——以及它与「出站 UA 用 Chrome 默认」的绑定关系
// ---------------------------------------------------------------------------

test("robots 禁止时抛 RobotsDisallowedError，且一次网络都不发", async () => {
  let called = 0;
  await assert.rejects(
    () => runDeepAudit("https://x.example/blocked", {
      ...BASE,
      robotsAllowedPage: false,
      runPsi: async () => { called += 1; return { raw: null, results: [] }; },
      runLighthouse: async () => { called += 1; return { report: null, reason: null }; },
    }),
    (err) => err instanceof RobotsDisallowedError && err.reason === "skipped_robots",
  );
  assert.equal(called, 0, "禁止时两边都不能发起——Lighthouse 导航的是同一个 URL");
});

test("robotsAllowedPage 缺失/非布尔时抛 TypeError，绝不默认放行也不默认禁止", async () => {
  // 两种默认都是错的：
  //   默认放行 → 我们用 Chrome 默认 UA 去抓一个可能被禁止的路径
  //   默认禁止 → 把「调用方漏传」伪装成「该站禁止抓取」，一个从未观测到的事实
  for (const bad of [undefined, null, "true", 1, 0]) {
    await assert.rejects(
      () => runDeepAudit("https://x.example/", { ...BASE, robotsAllowedPage: bad, runPsi: okPsi, runLighthouse: okLh }),
      TypeError,
      `robotsAllowedPage=${JSON.stringify(bad)} 必须被拒`,
    );
  }
});

// ---------------------------------------------------------------------------
// 落到别的主机的提示要贯通到编排层
// ---------------------------------------------------------------------------

test("baseHost 从目标 URL 推出，并传给 lighthouse-map 产生「落到别的主机」提示", async () => {
  const results = (await runDeepAudit("https://www.made-in-china.com/", {
    ...BASE,
    runPsi: okPsi,
    runLighthouse: async () => ({ report: fxLh("made-in-china"), reason: null, durationMs: 1, killConfirmed: null }),
  })).results;
  for (const r of group(results, "agent")) {
    assert.match(r.limitation ?? "", /m\.made-in-china\.com/, "Lighthouse 落到移动站必须标出");
  }
});

// ---------------------------------------------------------------------------
// 预算闭合
// ---------------------------------------------------------------------------

test("深检查硬超时必须覆盖并行执行的最坏边", () => {
  // 并行，所以取 max 而不是和；但硬超时必须比它大，否则任何一边跑满
  // 都会被外层判成超时，把「跑满了预算」错记成「我们没测成」。
  const worstBranch = Math.max(PSI_TIMEOUT_MS, LIGHTHOUSE_TIMEOUT_MS);
  assert.equal(worstBranch, 75_000);
  assert.ok(
    DEEP_TIMEOUT_MS > worstBranch,
    `深检查硬超时 ${DEEP_TIMEOUT_MS}ms 必须大于最坏单边 ${worstBranch}ms`,
  );
  assert.ok(
    DEEP_TIMEOUT_MS - worstBranch >= 10_000,
    "余量至少 10 s：并行两边的启动开销、报告读盘、JSON 解析都在预算内",
  );
});

test("返回耗时与进程树回收确认，供运维观测", async () => {
  const out = await runDeepAudit("https://x.example/", {
    ...BASE,
    runPsi: okPsi,
    runLighthouse: async () => ({ report: fxLh("globalsources"), reason: null, durationMs: 33_000, killConfirmed: false }),
  });
  assert.equal(out.lighthouseMs, 33_000);
  assert.equal(out.lighthouseKillConfirmed, false, "确认不了就如实报 false，不假装清理成功");
});

// ---------------------------------------------------------------------------
// 诊断信息不能被丢掉，也不能泄露给用户
// ---------------------------------------------------------------------------

test("Lighthouse 失败时把 stderr 尾部带出来给调用方记日志", async () => {
  // 早先的版本在这里把 stderrTail 丢了，一次真实的崩溃只留下一句
  // 「crashed」——排查 TasksMax 不足导致的 Chrome 崩溃时，
  // 正是因为这条信息不在，才不得不手工复现才定位到根因。
  const out = await runDeepAudit("https://x.example/", {
    ...BASE,
    runPsi: okPsi,
    runLighthouse: async () => ({ report: null, reason: "crashed", durationMs: 100, killConfirmed: null, stderrTail: "FATAL: fork failed" }),
  });
  assert.equal(out.lighthouseStderrTail, "FATAL: fork failed");
});

test("成功时不带 stderr（没有诊断价值，只是噪音）", async () => {
  const out = await runDeepAudit("https://x.example/", {
    ...BASE, runPsi: okPsi,
    runLighthouse: async () => ({ report: fxLh("globalsources"), reason: null, durationMs: 1, killConfirmed: null, stderrTail: "一堆 dbus 噪音" }),
  });
  assert.equal(out.lighthouseStderrTail, null);
});

test("stderr 绝不进 CheckResult——那是给用户看的公开报告", async () => {
  const out = await runDeepAudit("https://x.example/", {
    ...BASE, runPsi: okPsi,
    runLighthouse: async () => ({ report: null, reason: "crashed", durationMs: 1, killConfirmed: null, stderrTail: "/opt/miaowa-site-audit/current/src/... 内部路径与堆栈" }),
  });
  for (const r of out.results) {
    const text = `${r.observation}${r.limitation ?? ""}`;
    assert.ok(!text.includes("/opt/"), `${r.id} 的用户可见文案里不得出现内部路径`);
    assert.ok(!text.includes("堆栈"), `${r.id} 的用户可见文案里不得出现堆栈`);
  }
});
