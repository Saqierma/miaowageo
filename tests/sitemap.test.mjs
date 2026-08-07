import assert from "node:assert/strict";
import test from "node:test";

import { sitemapCheck } from "../src/checks/sitemap.mjs";

const ok = (body) => ({ ok: true, status: 200, body });

const urlsetWithEntries = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;

const emptyUrlset = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;

const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-products.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`;

/**
 * 404 与 429/超时必须分开：前者是「该站确实没有 sitemap」，可以断言为 fail；
 * 后者是「我们这次没测到」，断言为 fail 就是在指控一件没有观测过的事——
 * 这正是 robots.mjs 里 404 特判的同一条原则，用 outcome.status === 404 分离。
 */

test("<urlset> 有条目判为 pass", () => {
  const result = sitemapCheck(ok(urlsetWithEntries), "https://example.com/sitemap.xml");
  assert.equal(result.verdict, "pass");
  assert.equal(result.scored, true);
});

test("<urlset> 为空判为 warn", () => {
  const result = sitemapCheck(ok(emptyUrlset), "https://example.com/sitemap.xml");
  assert.equal(result.verdict, "warn");
});

test("404 判为 fail：该站确实没有 sitemap，是可断言的事实", () => {
  const result = sitemapCheck({ ok: false, status: 404, reason: "http_error" }, "https://example.com/sitemap.xml");
  assert.equal(result.state, "ready");
  assert.equal(result.verdict, "fail");
});

test("429 判为 no_data：根本没测到，不是对方没有", () => {
  const result = sitemapCheck({ ok: false, status: 429, reason: "throttled" }, "https://example.com/sitemap.xml");
  assert.equal(result.state, "no_data");
  assert.equal(result.verdict, null, "no_data 的项不得携带 verdict");
});

test("超时判为 no_data，不得与 404 坍缩成同一个 fail", () => {
  const result = sitemapCheck({ ok: false, reason: "timeout" }, "https://example.com/sitemap.xml");
  assert.equal(result.state, "no_data");
});

test("<sitemapindex> 判为 pass，且 limitation 写明 V1 不展开子文件", () => {
  const result = sitemapCheck(ok(sitemapIndex), "https://example.com/sitemap.xml");
  assert.equal(result.verdict, "pass");
  assert.match(result.limitation, /V1/);
  assert.match(result.limitation, /不展开/);
});

test("404 与 429 的 verdict 必须不同：不能把两种未观测/已观测的情况合并成一个结论", () => {
  const notFound = sitemapCheck({ ok: false, status: 404, reason: "http_error" }, "u");
  const throttled = sitemapCheck({ ok: false, status: 429, reason: "throttled" }, "u");
  assert.notEqual(notFound.verdict, throttled.verdict);
  assert.notEqual(notFound.state, throttled.state);
});
