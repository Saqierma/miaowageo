import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { psiChecks, classifyPsiError } from "../src/checks/psi-map.mjs";

/**
 * PSI 响应 → CheckResult[]。全部用 fixtures/psi/ 下的**真实响应快照**驱动，
 * 一次网络都不发。
 *
 * 用快照而不是打线上 API，与 fixtures/robots/globalsources-snapshot.txt
 * 是同一条理由：把测试挂在第三方的当前行为上，对方改一次我们就无故红绿。
 *
 * 快照是从真实响应裁剪出来的（全量 0.9–1.2 MB，只保留映射会读到的字段），
 * 裁剪逻辑记录在生成它们的那次会话里；重新采集时只要保留
 * loadingExperience / lighthouseResult.categories / 相关 audits 即可。
 */

const fx = (name) => JSON.parse(readFileSync(new URL(`../fixtures/psi/${name}.json`, import.meta.url), "utf8"));

const byId = (results, id) => results.find((r) => r.id === id);

// ---------------------------------------------------------------------------
// 成功路径
// ---------------------------------------------------------------------------

test("made-in-china：性能分 55 → warn；CrUX 有 5 项且含 AVERAGE → warn", () => {
  const results = psiChecks({ ok: true, status: 200, payload: fx("made-in-china"), requestedUrl: "https://www.made-in-china.com/" });
  assert.equal(results.length, 2);

  const score = byId(results, "performance.psi-score");
  assert.equal(score.state, "ready");
  assert.equal(score.verdict, "warn", "0.55 → 55 分，落在 50–89 的 warn 档");
  assert.match(score.observation, /55/);
  assert.equal(score.scored, true, "计分性是固有属性，与本次结果无关");

  const crux = byId(results, "performance.crux-field");
  assert.equal(crux.state, "ready");
  assert.equal(crux.verdict, "warn", "有 AVERAGE（needs-improvement）无 SLOW → warn");
  assert.match(crux.observation, /5 项/);
});

test("globalsources：性能分 25 → fail", () => {
  const results = psiChecks({ ok: true, status: 200, payload: fx("globalsources"), requestedUrl: "https://www.globalsources.com/" });
  const score = byId(results, "performance.psi-score");
  assert.equal(score.verdict, "fail", "25 分 < 50，落在 fail 档");
  assert.match(score.observation, /25/);
});

test("PSI 落到了另一台主机时必须在 limitation 里说出来", () => {
  // 实测：提交 https://www.made-in-china.com/，PSI 实际测的是 m.made-in-china.com。
  // 设计文档第三节要求「深检查必须记录并展示它实际测量的最终 URL」——
  // 否则同一份报告里性能数字来自另一台主机，而读者无从知晓。
  const results = psiChecks({ ok: true, status: 200, payload: fx("made-in-china"), requestedUrl: "https://www.made-in-china.com/" });
  const score = byId(results, "performance.psi-score");
  assert.match(score.limitation ?? "", /m\.made-in-china\.com/, "跳到移动站必须显式标出，不能默默用另一台主机的数字");
  assert.equal(score.evidence.url, "https://m.made-in-china.com/", "证据链接应指向实际被测的 URL");
});

test("同主机时不产生多余的 limitation", () => {
  const results = psiChecks({ ok: true, status: 200, payload: fx("globalsources"), requestedUrl: "https://www.globalsources.com/" });
  const score = byId(results, "performance.psi-score");
  assert.equal(score.limitation, null, "没跳主机就不该编一条限制说明出来");
});

// ---------------------------------------------------------------------------
// 失败路径：对方侧 vs 我方侧，这是本文件最要紧的部分
// ---------------------------------------------------------------------------

test("400 + lighthouseUserError → no_data（目标站自己加载不起来，是对方侧事实）", () => {
  // 真实快照来自 busytrade.com：FAILED_DOCUMENT_REQUEST / net::ERR_CONNECTION_FAILED。
  // Google 自己的检测器都打不开这个站——那是可以如实告诉客户的事实。
  const payload = fx("bad-request-400");
  const results = psiChecks({ ok: false, status: 400, payload, requestedUrl: "https://busytrade.com/" });
  for (const r of results) {
    assert.equal(r.state, "no_data", `${r.id} 应记为对方侧的 no_data`);
    assert.equal(r.verdict, null, "非 ready 的项不得带 verdict");
  }
  assert.match(results[0].observation, /PSI 未能加载该页面/);
  assert.match(results[0].limitation, /不是本工具未能完成检测/);
});

test("429 配额耗尽 → not_wired（我方侧，绝不能据此评价站点）", () => {
  const payload = fx("nokey-429");
  const results = psiChecks({ ok: false, status: 429, payload, requestedUrl: "https://example.com/" });
  for (const r of results) {
    assert.equal(r.state, "not_wired", `${r.id} 应记为我方侧的 not_wired`);
    assert.equal(r.verdict, null);
  }
  assert.match(results[0].observation, /配额已用尽/);
  assert.match(results[0].limitation, /与该站点的实际性能无关/);
});

test("400 与 429 绝不能坍缩成同一种状态", () => {
  // 设计文档第七节：404 与 429 必须分开——前者是「该站确实没有」可断言，
  // 后者是「我们没测到」不可断言。PSI 这一层是同一条原则的另一处应用。
  const bad = psiChecks({ ok: false, status: 400, payload: fx("bad-request-400"), requestedUrl: "https://x.example/" });
  const quota = psiChecks({ ok: false, status: 429, payload: fx("nokey-429"), requestedUrl: "https://x.example/" });
  assert.notEqual(
    bad[0].state,
    quota[0].state,
    "「目标站打不开」与「我们配额用完」处置方向完全相反，必须是不同的 state",
  );
  assert.notEqual(bad[0].observation, quota[0].observation, "四种失败原因要有四段不同的文案，不得坍缩");
});

test("连 PSI 都没打通（超时/网络）→ not_wired", () => {
  const results = psiChecks({ ok: false, status: null, payload: null, requestedUrl: "https://x.example/", workerReason: "timeout" });
  for (const r of results) assert.equal(r.state, "not_wired");
  assert.match(results[0].observation, /timeout/);
});

test("403（密钥无效）→ not_wired，不是 no_data", () => {
  const payload = { error: { code: 403, message: "API key not valid", errors: [{ reason: "forbidden", domain: "global" }] } };
  const results = psiChecks({ ok: false, status: 403, payload, requestedUrl: "https://x.example/" });
  for (const r of results) assert.equal(r.state, "not_wired", "密钥问题是我方配置问题，与站点无关");
});

test("classifyPsiError 认 lighthouse domain，而不只认 reason 字符串", () => {
  // 只匹配 reason 字符串太脆：Google 换个 reason 名我们就会把对方的问题
  // 记到自己头上。domain === "lighthouse" 是更稳的信号，两者取其一即可。
  const onlyDomain = { error: { code: 400, message: "x", errors: [{ domain: "lighthouse", reason: "somethingNew" }] } };
  assert.equal(classifyPsiError(onlyDomain, 400).state, "no_data");
});

// ---------------------------------------------------------------------------
// CrUX 的缺失处理
// ---------------------------------------------------------------------------

test("CrUX 一个指标都没返回 → no_data（样本不足是对方侧的正常事实）", () => {
  const payload = { lighthouseResult: { categories: { performance: { score: 0.9 } } } };
  const results = psiChecks({ ok: true, status: 200, payload, requestedUrl: "https://tiny.example/" });
  const crux = byId(results, "performance.crux-field");
  assert.equal(crux.state, "no_data");
  assert.match(crux.limitation, /样本不足是常见情况/);

  // 关键：性能分不受影响，仍然照常判定。两项互不牵连。
  const score = byId(results, "performance.psi-score");
  assert.equal(score.state, "ready");
  assert.equal(score.verdict, "pass");
});

test("CrUX 只返回部分指标时，只对返回的求值，缺失项不算失败", () => {
  // 设计文档第五节点名：低流量站尤其常缺 INP，按缺失即失败会系统性冤枉小站。
  const payload = {
    lighthouseResult: { categories: { performance: { score: 0.95 } } },
    loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1200, category: "FAST" } } },
  };
  const crux = byId(psiChecks({ ok: true, status: 200, payload, requestedUrl: "https://x.example/" }), "performance.crux-field");
  assert.equal(crux.state, "ready");
  assert.equal(crux.verdict, "pass", "唯一返回的指标是 FAST，就该 pass，不能因为缺了 4 项而降级");
  assert.match(crux.limitation, /只有 1 项指标/, "但必须如实说明判定只基于这一项");
});

test("CrUX 有 SLOW → fail，且 SLOW 优先于 AVERAGE", () => {
  const payload = {
    lighthouseResult: { categories: { performance: { score: 0.4 } } },
    loadingExperience: {
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { category: "SLOW" },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { category: "AVERAGE" },
        INTERACTION_TO_NEXT_PAINT: { category: "FAST" },
      },
    },
  };
  const crux = byId(psiChecks({ ok: true, status: 200, payload, requestedUrl: "https://x.example/" }), "performance.crux-field");
  assert.equal(crux.verdict, "fail");
});

test("CrUX 全 FAST → pass", () => {
  const payload = {
    lighthouseResult: { categories: { performance: { score: 0.99 } } },
    loadingExperience: {
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { category: "FAST" },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { category: "FAST" },
      },
    },
  };
  const crux = byId(psiChecks({ ok: true, status: 200, payload, requestedUrl: "https://x.example/" }), "performance.crux-field");
  assert.equal(crux.verdict, "pass");
  assert.match(crux.limitation, /只有 2 项指标/, "不足 5 项时仍要如实说明判定基于几项——全 FAST 不代表覆盖完整");
});

test("CrUX 五项俱全时不再附加「样本项数」说明", () => {
  // 与上一条成对：limitation 只在样本不完整时出现，不是每次都挂一句。
  const crux = psiChecks({ ok: true, status: 200, payload: fx("made-in-china"), requestedUrl: "https://www.made-in-china.com/" })
    .find((r) => r.id === "performance.crux-field");
  assert.equal(crux.limitation, null, "made-in-china 的快照里 5 项指标齐全");
});

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

test("两项恒为 scored，且恒在 performance 组——计分性不随结果变化", () => {
  const inputs = [
    { ok: true, status: 200, payload: fx("made-in-china") },
    { ok: false, status: 429, payload: fx("nokey-429") },
    { ok: false, status: 400, payload: fx("bad-request-400") },
    { ok: false, status: null, payload: null, workerReason: "network" },
  ];
  for (const input of inputs) {
    for (const r of psiChecks({ ...input, requestedUrl: "https://x.example/" })) {
      assert.equal(r.scored, true, `${r.id} 的计分性必须是固有属性`);
      assert.equal(r.group, "performance");
    }
  }
});

test("性能分 200 但没有 performance 分类 → not_wired，不是判该站性能差", () => {
  const payload = { lighthouseResult: { categories: {} } };
  const score = byId(psiChecks({ ok: true, status: 200, payload, requestedUrl: "https://x.example/" }), "performance.psi-score");
  assert.equal(score.state, "not_wired");
  assert.equal(score.verdict, null);
});
