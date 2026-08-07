import assert from "node:assert/strict";
import test from "node:test";

import { NO_DATA_REASONS } from "../src/types.mjs";
import { htmlMetaChecks } from "../src/checks/html-meta.mjs";
import { canonicalChecks } from "../src/checks/canonical.mjs";
import { structuredChecks } from "../src/checks/structured-data.mjs";
import { readabilityCheck } from "../src/checks/static-readability.mjs";
import { sitemapCheck } from "../src/checks/sitemap.mjs";
import { robotsChecks } from "../src/checks/robots.mjs";
import { agentChannelChecks } from "../src/checks/agent-channels.mjs";
import { psiChecks } from "../src/checks/psi-map.mjs";
import { lighthouseChecks } from "../src/checks/lighthouse-map.mjs";

/**
 * 跨模块合约：**「没测到」的原因必须分类正确。**
 *
 * types.mjs 的必填约束只保证每一项都**有**一个 reason，保不了这个 reason
 * 是**对的**。而对不对，决定了报告顶部那句结论说什么：
 *
 *   not_applicable 一类   → 「这些项对该页面不适用」，无须任何人做任何事
 *   其余（对方侧）一类     → 「站点没让本工具取得内容」，这是要修的
 *
 * 分错的后果是具体的：一个只是缺 /sitemap.xml 的健康站点，会被写成
 * 「站点拒绝了本工具的访问」；反过来，一个真的把我们 403 挡在门外的站点，
 * 会被写成「这些项不适用」，于是本次最严重的发现被说成无事发生。
 */

const PAGE = "https://x.example/";
const blocked = { ok: false, status: 403, headers: {}, body: null, finalUrl: PAGE, reason: "http_error" };
const okPage = (body) => ({ ok: true, status: 200, headers: {}, body, finalUrl: PAGE, reason: null });

/** 「对方没让我们拿到内容」这一族。not_applicable 与 worker_error 都不在其中。 */
const TARGET_SIDE = NO_DATA_REASONS.filter((r) => r !== "not_applicable" && r !== "worker_error");

test("对方 403 时，所有由页面推导的检查都必须记成对方侧原因", () => {
  const results = [
    ...htmlMetaChecks(blocked, PAGE),
    ...canonicalChecks(blocked, PAGE),
    ...structuredChecks(blocked, PAGE),
    readabilityCheck(blocked, PAGE),
  ];
  assert.ok(results.length >= 13, `期望至少 13 项，实测 ${results.length}`);
  for (const r of results) {
    assert.equal(r.state, "no_data", `${r.id} 的 state 不该是 ${r.state}`);
    assert.equal(
      r.reason,
      "http_error",
      `${r.id} 被记成了 ${r.reason}——403 是对方把我们挡在门外，不是「这一项不适用」`,
    );
  }
});

test("**页面里没有 <img> 时，img-alt 记 not_applicable 而不是对方侧原因**", () => {
  // 这一条与上面那条是一对：同一个检查项、同样显示成灰色的「未测到」，
  // 原因码必须相反。两者同码，reason 这个字段就白加了。
  const r = htmlMetaChecks(okPage("<html><body><p>纯文字</p></body></html>"), PAGE)
    .find((x) => x.id === "metadata.img-alt");
  assert.equal(r.state, "no_data");
  assert.equal(r.reason, "not_applicable");
  assert.ok(!TARGET_SIDE.includes(r.reason), "页面没有图片是事实，不是对方拦了我们");
});

test("「该资源确实不存在」的三处都在 404 上判 ready，不进未测到统计", () => {
  // robots / sitemap / agent-channels 各自用 outcome.status === 404 拦在
  // outcomeToState 之前，把 404 判成**可断言的事实**而不是「没测到」。
  // 这条契约直接决定顶部结论：一个只是缺 sitemap 的健康站点，
  // 若把 404 记成未测到，就会被算进「站点没让本工具取得内容」。
  const url = `${PAGE}sitemap.xml`;
  const notFound = { ok: false, status: 404, headers: {}, body: null, finalUrl: url, reason: "http_error" };

  const sitemap = sitemapCheck(notFound, url);
  assert.equal(sitemap.state, "ready", "缺 sitemap 是查得清清楚楚的事实");
  assert.equal(sitemap.verdict, "fail");
  assert.equal(sitemap.reason, null, "ready 的项不得带 reason");

  const llms = agentChannelChecks({ ucp: notFound, agentsMd: notFound, llmsTxt: notFound }, PAGE);
  for (const r of llms) {
    assert.equal(r.state, "ready", `${r.id}：没有这个文件是事实，不是没测到`);
    assert.equal(r.reason, null);
  }
});

test("robots.txt 抓不到时，13 项爬虫准入全部记成对方侧原因", () => {
  const results = robotsChecks(
    { ok: false, status: null, headers: {}, body: null, finalUrl: `${PAGE}robots.txt`, reason: "timeout" },
    `${PAGE}robots.txt`,
  );
  assert.ok(results.length > 0);
  for (const r of results) assert.equal(r.reason, "timeout", `${r.id}`);
});

test("四个 AI 代理通道被 robots 禁止时记 robots_disallowed，不与超时混为一谈", () => {
  const disallowed = { ok: false, status: null, headers: {}, body: null, finalUrl: PAGE, reason: "robots_disallowed" };
  const results = agentChannelChecks({ ucp: disallowed, agentsMd: disallowed, llmsTxt: disallowed }, PAGE);
  for (const r of results) assert.equal(r.reason, "robots_disallowed", `${r.id}`);
});

test("我方侧失败一律记 worker_error，绝不记成对方侧", () => {
  // 把我们自己的故障说成对方的问题，是这份报告最不能犯的错——
  // 客户会照着去改一个根本没坏的站点。
  const psi = psiChecks({ ok: false, status: null, payload: null, requestedUrl: PAGE, workerReason: "缺密钥" });
  for (const r of psi) {
    assert.equal(r.state, "not_wired");
    assert.equal(r.reason, "worker_error", `${r.id}`);
  }
  const lh = lighthouseChecks({ report: null, requestedUrl: PAGE, runnerReason: "timeout", baseHost: "x.example" });
  for (const r of lh) {
    assert.equal(r.state, "not_wired");
    assert.equal(r.reason, "worker_error", `${r.id}`);
  }
});

test("CrUX 无字段数据记 not_applicable —— 小站没样本不是站点的问题", () => {
  const payload = { lighthouseResult: { categories: { performance: { score: 0.9 } } }, loadingExperience: {} };
  const crux = psiChecks({ ok: true, status: 200, payload, requestedUrl: PAGE, workerReason: null })
    .find((r) => r.id === "performance.crux-field");
  assert.equal(crux.state, "no_data");
  assert.equal(crux.reason, "not_applicable");
});

test("抓取成功的项一律不带 reason", () => {
  // 留着一个陈旧的 reason，呈现层统计「有多少项没覆盖到」时会把已测项也算进去。
  const results = htmlMetaChecks(
    okPage('<html lang="en"><head><title>标题</title></head><body><h1>H</h1><img src=a alt="x"></body></html>'),
    PAGE,
  );
  const ready = results.filter((r) => r.state === "ready");
  assert.ok(ready.length >= 4);
  for (const r of ready) assert.equal(r.reason, null, `${r.id} 是 ready，却带着 reason=${r.reason}`);
});
