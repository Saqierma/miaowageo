import assert from "node:assert/strict";
import test from "node:test";

import { canonicalChecks } from "../src/checks/canonical.mjs";

const byId = (results, id) => results.find((item) => item.id === id);
const ok = (body, headers) => ({ ok: true, status: 200, body, headers });
const withCanonical = (href, extraHead = "") =>
  `<html><head><link rel="canonical" href="${href}">${extraHead}</head><body></body></html>`;

/**
 * canonical 与 noindex 是两条独立的 scored 判定，用同一次页面抓取产出。
 *
 * 「自指」必须先规范化再比较（设计文档第六节 2a：小写 host、丢弃查询串、去尾部斜杠），
 * 否则 `https://x.com/a` 与 `https://x.com/a/` 会被误判成指向他页——
 * 这正是本工具在 robots partial 判定上已经栽过跟头的同类错误。
 */

test("自指 canonical 判为 pass", () => {
  const results = canonicalChecks(ok(withCanonical("https://example.com/a")), "https://example.com/a");
  assert.equal(byId(results, "access.canonical").verdict, "pass");
  assert.equal(byId(results, "access.canonical").scored, true);
});

test("canonical 与页面 URL 仅相差尾部斜杠，仍判为自指", () => {
  const withSlash = canonicalChecks(ok(withCanonical("https://example.com/a")), "https://example.com/a/");
  const withoutSlash = canonicalChecks(ok(withCanonical("https://example.com/a/")), "https://example.com/a");
  assert.equal(byId(withSlash, "access.canonical").verdict, "pass");
  assert.equal(byId(withoutSlash, "access.canonical").verdict, "pass");
});

test("canonical 与页面 URL 仅相差查询串与 host 大小写，仍判为自指", () => {
  const results = canonicalChecks(ok(withCanonical("HTTPS://EXAMPLE.com/a?utm_source=newsletter")), "https://example.com/a");
  assert.equal(byId(results, "access.canonical").verdict, "pass");
});

test("canonical 指向另一个页面判为 warn，并在 observation 中带出目标地址", () => {
  const results = canonicalChecks(ok(withCanonical("https://example.com/other-page")), "https://example.com/a");
  const item = byId(results, "access.canonical");
  assert.equal(item.verdict, "warn");
  assert.match(item.observation, /other-page/);
});

test("缺失 canonical 标签判为 fail", () => {
  const results = canonicalChecks(ok("<html><head></head><body></body></html>"), "https://example.com/a");
  assert.equal(byId(results, "access.canonical").verdict, "fail");
});

test("meta robots noindex 判为 fail，且不影响 canonical 的独立判定", () => {
  const html = withCanonical("https://example.com/a", '<meta name="robots" content="noindex, nofollow">');
  const results = canonicalChecks(ok(html), "https://example.com/a");
  assert.equal(byId(results, "access.noindex").verdict, "fail");
  assert.equal(byId(results, "access.canonical").verdict, "pass", "noindex 不应该污染 canonical 的独立判定");
});

test("X-Robots-Tag 响应头 noindex 同样判为 fail", () => {
  const html = withCanonical("https://example.com/a");
  const results = canonicalChecks(ok(html, { "x-robots-tag": "noindex" }), "https://example.com/a");
  assert.equal(byId(results, "access.noindex").verdict, "fail");
});

test("既无 meta robots 也无 X-Robots-Tag 声明 noindex，判为 pass", () => {
  const html = withCanonical("https://example.com/a");
  const results = canonicalChecks(ok(html), "https://example.com/a");
  assert.equal(byId(results, "access.noindex").verdict, "pass");
});

test("headers 缺失时不抛错，按无 noindex 处理", () => {
  const html = withCanonical("https://example.com/a");
  const results = canonicalChecks({ ok: true, status: 200, body: html }, "https://example.com/a");
  assert.equal(byId(results, "access.noindex").verdict, "pass");
});

test("抓取失败时 canonical 与 noindex 都记 no_data，且不带 verdict", () => {
  const results = canonicalChecks({ ok: false, reason: "timeout" }, "https://example.com/a");
  assert.equal(results.length, 2);
  for (const item of results) {
    assert.equal(item.state, "no_data");
    assert.equal(item.verdict, null);
    assert.equal(item.scored, true);
  }
});

test("404 属于抓取失败（页面本身取不到），不是「该站没有 canonical」的可断言事实，记 no_data", () => {
  const results = canonicalChecks({ ok: false, status: 404, reason: "http_error" }, "https://example.com/a");
  for (const item of results) assert.equal(item.state, "no_data");
});
