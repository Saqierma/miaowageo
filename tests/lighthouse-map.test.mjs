import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { lighthouseChecks, classifyRuntimeError, CLS_PASS_MAX, CLS_WARN_MAX } from "../src/checks/lighthouse-map.mjs";

/**
 * Lighthouse 报告 → CheckResult[]。全部用 fixtures/lighthouse/ 下的**真实报告
 * 快照**驱动，不起 Chrome、不发网络。
 *
 * 快照取自真实检测机（Lighthouse 13.4.1 + Chrome for Testing
 * 151.0.7922.76）对真实站点跑出来的，只保留映射会读到的字段。
 */

const fx = (name) => JSON.parse(readFileSync(new URL(`../fixtures/lighthouse/${name}.json`, import.meta.url), "utf8"));
const byId = (results, id) => results.find((r) => r.id === id);

// ---------------------------------------------------------------------------
// 两种 scoreDisplayMode 必须分开取值——本文件最要紧的一条
// ---------------------------------------------------------------------------

test("numeric 项必须读 numericValue，不能读 score", () => {
  // 这条来自真实快照里的一个反例：globalsources 的 CLS 审计
  //   score = 0.93        ← Lighthouse 自己的评分曲线（0–1 连续值）
  //   numericValue = 0.0857  ← 真实的 CLS 值
  // 设计文档第五节规定的阈值是 0.10 / 0.25，那是给**真实 CLS 值**用的。
  // 拿 0.93 去套 0.10/0.25 会判成 fail，而正确答案是 pass。
  // 两套标准混用，结果看起来完全合理，却是错的。
  const raw = fx("globalsources").audits["cumulative-layout-shift"];
  assert.equal(raw.scoreDisplayMode, "numeric");
  assert.equal(raw.score, 0.93, "快照里的 score 是评分曲线值");
  assert.ok(raw.numericValue < CLS_PASS_MAX, "而真实 CLS 值落在 pass 档");

  const cls = byId(lighthouseChecks({ report: fx("globalsources"), requestedUrl: "https://www.globalsources.com/" }), "agent.cls");
  assert.equal(cls.state, "ready");
  assert.equal(cls.verdict, "pass", "必须按 numericValue(0.0857) 判 pass，而不是按 score(0.93) 判 fail");
  assert.match(cls.observation, /0\.086/, "观察里要给出真实 CLS 值");
});

test("binary 项按 score 判，且没有 warn 档", () => {
  // 真实快照：两个站的可访问性树审计都是 mode=binary、score=0 → fail。
  for (const name of ["made-in-china", "globalsources"]) {
    const raw = fx(name).audits["agent-accessibility-tree"];
    assert.equal(raw.scoreDisplayMode, "binary");
    const tree = byId(lighthouseChecks({ report: fx(name), requestedUrl: "https://x.example/" }), "agent.accessibility-tree");
    assert.equal(tree.state, "ready");
    assert.equal(tree.verdict, "fail", `${name} 的 score=0 应判 fail`);
  }
});

test("binary 项 score=1 → pass", () => {
  const report = { audits: { "agent-accessibility-tree": { scoreDisplayMode: "binary", score: 1, title: "ok" } } };
  const tree = byId(lighthouseChecks({ report, requestedUrl: "https://x.example/" }), "agent.accessibility-tree");
  assert.equal(tree.verdict, "pass");
});

// ---------------------------------------------------------------------------
// CLS 三档边界
// ---------------------------------------------------------------------------

test("CLS 三档边界：0.10 是 pass 的上界（含），0.25 是 warn 的上界（含）", () => {
  const at = (v) => {
    const report = { audits: { "cumulative-layout-shift": { scoreDisplayMode: "numeric", score: 0.5, numericValue: v } } };
    return byId(lighthouseChecks({ report, requestedUrl: "https://x.example/" }), "agent.cls").verdict;
  };
  assert.equal(at(0), "pass");
  assert.equal(at(CLS_PASS_MAX), "pass", "0.10 本身算 pass（设计文档写的是 ≤ 0.10）");
  assert.equal(at(CLS_PASS_MAX + 0.0001), "warn");
  assert.equal(at(CLS_WARN_MAX), "warn", "0.25 本身算 warn（设计文档写的是 > 0.10 且 ≤ 0.25）");
  assert.equal(at(CLS_WARN_MAX + 0.0001), "fail");
});

// ---------------------------------------------------------------------------
// notApplicable：对方侧的事实，不是 fail
// ---------------------------------------------------------------------------

test("notApplicable → no_data，绝不能当成 fail", () => {
  // 实测 PSI 对 made-in-china.com 的三个 WebMCP 审计正是 notApplicable。
  // 把「这一项对本页面不适用」当成失败，会凭空造出一个失败结论。
  const report = {
    audits: {
      "agent-accessibility-tree": { scoreDisplayMode: "notApplicable", score: null },
      "cumulative-layout-shift": { scoreDisplayMode: "notApplicable", score: null },
    },
  };
  for (const r of lighthouseChecks({ report, requestedUrl: "https://x.example/" })) {
    assert.equal(r.state, "no_data", `${r.id} 的 notApplicable 应记为 no_data`);
    assert.equal(r.verdict, null, "非 ready 的项不得带 verdict");
  }
});

test("审计项整个缺失 → not_wired（是我们的检测配置问题，不是站点问题）", () => {
  const results = lighthouseChecks({ report: { audits: {} }, requestedUrl: "https://x.example/" });
  for (const r of results) {
    assert.equal(r.state, "not_wired");
    assert.match(r.limitation, /本工具侧/);
  }
});

// ---------------------------------------------------------------------------
// 失败归因：对方侧 vs 我方侧
// ---------------------------------------------------------------------------

test("runtimeError 是目标站加载失败 → no_data（对方侧）", () => {
  for (const code of ["FAILED_DOCUMENT_REQUEST", "NO_FCP", "ERRORED_DOCUMENT_REQUEST", "PAGE_HUNG"]) {
    const results = lighthouseChecks({ report: { runtimeError: { code, message: "x" } }, requestedUrl: "https://x.example/" });
    for (const r of results) assert.equal(r.state, "no_data", `${code} 是对方站没能加载起来`);
  }
});

test("runtimeError 是 Chrome 侧问题 → not_wired（我方侧）", () => {
  for (const code of ["PROTOCOL_TIMEOUT", "TARGET_CRASHED", "CHROME_INTERSTITIAL_ERROR"]) {
    const results = lighthouseChecks({ report: { runtimeError: { code } }, requestedUrl: "https://x.example/" });
    for (const r of results) assert.equal(r.state, "not_wired", `${code} 是我们这边的问题`);
  }
});

test("对方侧与我方侧的 runtimeError 不得坍缩成同一种状态", () => {
  const target = classifyRuntimeError({ code: "FAILED_DOCUMENT_REQUEST" });
  const ours = classifyRuntimeError({ code: "PROTOCOL_TIMEOUT" });
  assert.notEqual(target.state, ours.state);
  assert.notEqual(target.observation, ours.observation, "四种失败原因要有四段不同的文案");
});

test("runner 侧失败（超时被杀、Chrome 起不来）→ not_wired", () => {
  for (const reason of ["timeout", "crashed", "bad_report"]) {
    const results = lighthouseChecks({ report: null, requestedUrl: "https://x.example/", runnerReason: reason });
    for (const r of results) {
      assert.equal(r.state, "not_wired");
      assert.match(r.observation, new RegExp(reason));
    }
  }
});

test("报告为空 → not_wired，不崩", () => {
  for (const report of [null, undefined, "不是对象", 42]) {
    const results = lighthouseChecks({ report, requestedUrl: "https://x.example/" });
    assert.equal(results.length, 2);
    for (const r of results) assert.equal(r.state, "not_wired");
  }
});

// ---------------------------------------------------------------------------
// 深检查落到别的主机时必须显式标出（设计文档第三节）
// ---------------------------------------------------------------------------

test("落地主机与轻检查基准主机不同时，两项都要标出", () => {
  // 真实快照：提交 www.made-in-china.com，Lighthouse 实际测的是
  // m.made-in-china.com——同一份报告里 agent 组的数字来自另一台主机，
  // 读者无从知晓，那是不可接受的。
  const results = lighthouseChecks({
    report: fx("made-in-china"),
    requestedUrl: "https://www.made-in-china.com/",
    baseHost: "www.made-in-china.com",
  });
  for (const r of results) {
    assert.match(r.limitation ?? "", /m\.made-in-china\.com/, `${r.id} 必须标出实际落地主机`);
    assert.match(r.limitation ?? "", /基准主机/);
  }
  assert.equal(results[0].evidence.url, "https://m.made-in-china.com/", "证据链接指向实际被测 URL");
});

test("落地主机与基准主机相同时不产生多余提示", () => {
  const results = lighthouseChecks({
    report: fx("globalsources"),
    requestedUrl: "https://www.globalsources.com/",
    baseHost: "www.globalsources.com",
  });
  for (const r of results) assert.equal(r.limitation, null, `${r.id} 不该编一条限制说明出来`);
});

test("没传 baseHost 时不做主机比较（不能凭空报「落到别的主机」）", () => {
  const results = lighthouseChecks({ report: fx("made-in-china"), requestedUrl: "https://www.made-in-china.com/" });
  for (const r of results) assert.equal(r.limitation, null);
});

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

test("两项恒为 scored 且恒在 agent 组——计分性不随结果变化", () => {
  const inputs = [
    { report: fx("made-in-china") },
    { report: { runtimeError: { code: "NO_FCP" } } },
    { report: null, runnerReason: "timeout" },
    { report: { audits: {} } },
  ];
  for (const input of inputs) {
    const results = lighthouseChecks({ ...input, requestedUrl: "https://x.example/" });
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.scored, true);
      assert.equal(r.group, "agent");
    }
  }
});
