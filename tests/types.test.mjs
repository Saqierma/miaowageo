import assert from "node:assert/strict";
import test from "node:test";

import { CHECK_GROUPS, NO_DATA_REASONS, checkResult } from "../src/types.mjs";

/**
 * CheckResult 是整个服务对外的唯一数据形状，主站的呈现层完全依赖它。
 * 这里守三条设计文档第四节的硬约束：
 *   1. state !== "ready" 时不得携带 verdict —— 否则主站会渲染出一个没有依据的判断；
 *   2. scored 是检查项的固有属性，构造时必须显式给出，不能从结果推断；
 *   3. state !== "ready" 时 reason 必填 —— 见下面那一组的说明。
 */

test("state 不是 ready 时，verdict 被强制清空", () => {
  const result = checkResult({
    id: "robots.oai-searchbot",
    group: "access",
    scored: true,
    state: "no_data",
    reason: "throttled",
    verdict: "fail",
    observation: "对方站点限流，本次未测到",
    evidence: { url: "https://example.com/robots.txt" },
  });
  assert.equal(result.verdict, null);
});

test("state 是 ready 时，verdict 保留", () => {
  const result = checkResult({
    id: "robots.oai-searchbot",
    group: "access",
    scored: true,
    state: "ready",
    verdict: "fail",
    observation: "针对 OAI-SearchBot 的规则为整站不允许抓取",
    evidence: { url: "https://example.com/robots.txt" },
  });
  assert.equal(result.verdict, "fail");
});

test("scored 缺省时抛错，不得静默当成 false", () => {
  assert.throws(() => checkResult({
    id: "x", group: "access", state: "ready", verdict: "pass",
    observation: "o", evidence: { url: "u" },
  }), /scored/);
});

test("分组名是封闭集合", () => {
  assert.deepEqual(
    [...CHECK_GROUPS],
    ["access", "metadata", "readability", "structured", "agent", "performance"],
  );
  assert.throws(() => checkResult({
    id: "x", group: "typo", scored: true, state: "ready", verdict: "pass",
    observation: "o", evidence: { url: "u" },
  }), /group/);
});

// ---------------------------------------------------------------------------
// reason：未测到的**原因**必须机器可读
//
// 这一组守的是一件具体的事：报告顶部要写一句结论给客户看，而结论的分支
// 取决于「这些项为什么没测到」。若原因只存在于中文 observation 里，
// 呈现层就只能去正则匹配文案——这个项目已经因为「用正则去猜语义」
// 栽过三次。所以原因必须是封闭集合里的码，且**漏填要当场炸**。
// ---------------------------------------------------------------------------

const base = { id: "metadata.title", group: "metadata", scored: true, observation: "o", evidence: { url: "u" } };

test("state 非 ready 时漏填 reason 直接抛错，不得静默当成 null", () => {
  // 做成必填而不是可选，是因为可选的漏填**不会有任何测试变红**：
  // 那一项会安静地变成「未分类」，然后被结论横幅算进「站点把我们挡在门外」。
  assert.throws(() => checkResult({ ...base, state: "no_data" }), /reason/);
  assert.throws(() => checkResult({ ...base, state: "not_wired" }), /reason/);
});

test("reason 是封闭集合，拼错要炸", () => {
  assert.throws(() => checkResult({ ...base, state: "no_data", reason: "http-error" }), /reason/);
  assert.throws(() => checkResult({ ...base, state: "no_data", reason: "blocked" }), /reason/);
  for (const reason of NO_DATA_REASONS) {
    assert.equal(checkResult({ ...base, state: "no_data", reason }).reason, reason);
  }
});

test("state 为 ready 的项不得带 reason", () => {
  // 一个 ready 项若还留着 reason，呈现层统计「未覆盖多少项」时会把它算进去，
  // 于是一份完整的报告会显示成「有 N 项没测到」。
  assert.throws(
    () => checkResult({ ...base, state: "ready", verdict: "pass", reason: "timeout" }),
    /ready/,
  );
  assert.equal(checkResult({ ...base, state: "ready", verdict: "pass" }).reason, null);
});

test("**「本就不适用」与「对方拦着」必须是不同的 reason**", () => {
  // 这是整个 reason 字段存在的理由，用一句断言钉死：
  // 「页面里没有 <img>」和「对方返回 403」在报告里都显示成灰色的「未测到」，
  // 但前者无害、后者是本次最严重的发现。两者同码 = 这个字段白加了。
  const notApplicable = checkResult({ ...base, state: "no_data", reason: "not_applicable" });
  const blocked = checkResult({ ...base, state: "no_data", reason: "http_error" });
  assert.notEqual(notApplicable.reason, blocked.reason);
  assert.ok(NO_DATA_REASONS.includes("not_applicable"));
});
