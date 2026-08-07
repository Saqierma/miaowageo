import assert from "node:assert/strict";
import test from "node:test";

import { outcomeToState, OK } from "../src/checks/fetch-outcome.mjs";
import { NO_DATA_REASONS } from "../src/types.mjs";

/**
 * 「没拿到内容」有四种含义，设计文档第七节要求它们呈现四段不同的文案，
 * 且分属两种项级状态：
 *
 *   no_data   —— 对方侧的正常事实（404、限流、超时、跨域跳转、robots 禁止）
 *   not_wired —— 我方侧未能完成（Worker 崩了、配额耗尽）
 *
 * 把它们混成一句「本次未测到」，等于放弃了三态原则里最有价值的那条区分：
 * 到底是**对方的问题**还是**我们的问题**——读报告的人一定会问，而这两种情况
 * 对应的下一步完全相反：一个要去改自己的站，一个只需要过会儿重测。
 */

test("成功抓取返回 OK", () => {
  assert.equal(outcomeToState({ ok: true, status: 200, body: "x" }), OK);
});

test("404 是对方侧事实，且要能与其他失败区分", () => {
  const state = outcomeToState({ ok: false, status: 404, reason: "http_error" });
  assert.equal(state.state, "no_data");
  assert.match(state.observation, /不存在|404/);
});

test("429 明确写成对方站点限流", () => {
  const state = outcomeToState({ ok: false, reason: "throttled", status: 429 });
  assert.equal(state.state, "no_data");
  assert.match(state.observation, /限流/);
});

test("超时不得说成对方站点有问题", () => {
  const state = outcomeToState({ ok: false, reason: "timeout" });
  assert.equal(state.state, "no_data");
  assert.match(state.observation, /超时/);
});

test("跨域跳转有专属文案", () => {
  const state = outcomeToState({ ok: false, reason: "cross_domain_redirect", finalUrl: "https://evil.example/" });
  assert.equal(state.state, "no_data");
  assert.match(state.observation, /其他域/);
});

test("robots 禁止是对方侧事实，且措辞必须是「禁止本工具」", () => {
  const state = outcomeToState({ ok: false, reason: "robots_disallowed" });
  assert.equal(state.state, "no_data");
  assert.match(state.observation, /禁止本工具/);
  assert.doesNotMatch(state.observation, /通用爬虫/,
    "我们对自己的产品令牌做了 RFC 9309 专属组匹配，说成「禁止通用爬虫」是错的");
});

test("我方原因归 not_wired，不得混进 no_data", () => {
  assert.equal(outcomeToState({ ok: false, reason: "worker_error" }).state, "not_wired");
});

// ---------------------------------------------------------------------------
// reason 原因码：给呈现层做判断用的那一份
// ---------------------------------------------------------------------------

test("每一种失败都回传一个封闭集合里的 reason", () => {
  // observation 是给人读的，reason 是给代码读的。少了后者，呈现层写结论时
  // 只能去正则匹配中文文案。
  const outcomes = [
    { ok: false, reason: "http_error", status: 403 },
    { ok: false, reason: "throttled", status: 429 },
    { ok: false, reason: "timeout" },
    { ok: false, reason: "network" },
    { ok: false, reason: "too_large" },
    { ok: false, reason: "cross_domain_redirect", finalUrl: "https://x.example/" },
    { ok: false, reason: "too_many_redirects" },
    { ok: false, reason: "private_address" },
    { ok: false, reason: "robots_disallowed" },
    { ok: false, reason: "worker_error" },
  ];
  for (const o of outcomes) {
    const state = outcomeToState(o);
    assert.ok(NO_DATA_REASONS.includes(state.reason), `${o.reason} 的 reason 不在封闭集合里：${state.reason}`);
  }
});

test("未知的 reason 回落到 worker_error，而不是回落成 undefined", () => {
  // 回落成 undefined 会让 checkResult 抛错，把一次「没见过的失败」
  // 升级成一次服务崩溃。
  const state = outcomeToState({ ok: false, reason: "某种以后才会有的失败" });
  assert.equal(state.state, "not_wired");
  assert.equal(state.reason, "worker_error");
});

test("**404 不在这里开特例，仍记 http_error**", () => {
  // 「资源不存在是正常结论」的三处（robots / sitemap / agent-channels）
  // 都在调用 outcomeToState **之前**就拦下了 404，各自判成 ready。
  // 能走到这里的 404 只剩页面本身，而那意味着「用户提交的地址不存在」——
  // 是要处理的问题，不是「不适用」。
  assert.equal(outcomeToState({ ok: false, reason: "http_error", status: 404 }).reason, "http_error");
  assert.equal(outcomeToState({ ok: false, reason: "http_error", status: 403 }).reason, "http_error");
  assert.notEqual(outcomeToState({ ok: false, reason: "http_error", status: 404 }).reason, "not_applicable");
});
