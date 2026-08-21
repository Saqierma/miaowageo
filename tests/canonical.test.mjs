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

test("抓取失败时 canonical / noindex / snippet 都记 no_data，且不带 verdict", () => {
  const results = canonicalChecks({ ok: false, reason: "timeout" }, "https://example.com/a");
  assert.equal(results.length, 3);
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

// ---------------------------------------------------------------------------
// 片段级抑制指令
//
// 这一组补的是此前二十七项里最明显的一个缺口。
//
// `noindex` 的后果是「整页从索引里消失」——很显眼，所有 SEO 工具都查。
// `nosnippet` 的后果是「页面在索引里，但任何摘要、任何引用片段都不许展示」。
// 对传统 SEO 只是搜索结果少一行描述；**对 GEO 这是致命的**——
// 生成式引擎的引用本质就是摘录一段话，不许摘录等于不可能被引用。
//
// 正因为它在传统 SEO 里看起来无关痛痒，从来没人查。
// ---------------------------------------------------------------------------

const snippetOf = (html, headers = {}) =>
  canonicalChecks(
    { ok: true, status: 200, headers, body: html, finalUrl: "https://example.com/a", reason: null },
    "https://example.com/a",
  ).find((r) => r.id === "access.snippet");

test("**nosnippet 判 fail：页面进得了索引，却没有一句话可以被摘录**", () => {
  const r = snippetOf('<html><head><meta name="robots" content="index,nosnippet"></head></html>');
  assert.equal(r.verdict, "fail");
  assert.match(r.observation, /nosnippet/);
  assert.match(r.limitation, /摘录/, "要讲清它为什么对 AI 引用是决定性的");
});

test("**X-Robots-Tag 响应头与 meta 同等对待**", () => {
  // 只查 meta 会漏掉一整类站点——很多 CDN 与框架是在响应头里下这个指令的。
  const r = snippetOf("<html></html>", { "x-robots-tag": "noarchive, nosnippet" });
  assert.equal(r.verdict, "fail");
  assert.match(r.observation, /X-Robots-Tag/);
});

test("max-snippet:0 等同 nosnippet；max-snippet:-1 是「不限制」，不得误判", () => {
  assert.equal(snippetOf('<html><head><meta name="robots" content="max-snippet:0"></head></html>').verdict, "fail");
  // -1 是规范里的「无上限」，是默认值。把它当成抑制会误伤一大批正常站点。
  assert.equal(snippetOf('<html><head><meta name="robots" content="max-snippet:-1"></head></html>').verdict, "pass");
  assert.equal(snippetOf('<html><head><meta name="robots" content="max-snippet:20"></head></html>').verdict, "warn");
});

test("**data-nosnippet 要数出现次数，因为它是逐块生效的**", () => {
  // 它常被用来遮价格或时间戳，而一个没收好的标签就能把整段正文包进去，
  // 且页面在浏览器里看起来毫无异样。
  const r = snippetOf('<div data-nosnippet>a</div><span data-nosnippet="">b</span><p data-nosnippet/>');
  assert.equal(r.verdict, "warn");
  assert.equal(r.evidence.dataNosnippetBlocks, 3);
  assert.match(r.limitation, /误伤正文/, "要提醒他确认包住的到底是什么");
});

test("干净页面判 pass，不制造无中生有的问题", () => {
  const r = snippetOf("<html><head><title>t</title></head><body>hi</body></html>");
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.evidence.directives, []);
});

test("片段抑制是计分项——它是能不能被引用的必要条件", () => {
  assert.equal(snippetOf("<html></html>").scored, true);
});
