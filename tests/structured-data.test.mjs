import assert from "node:assert/strict";
import test from "node:test";

import { structuredChecks } from "../src/checks/structured-data.mjs";

const byId = (results, id) => results.find((item) => item.id === id);
const ok = (body) => ({ ok: true, status: 200, body });
const wrap = (json) => ok(`<html><head><script type="application/ld+json">${json}</script></head><body></body></html>`);

/**
 * JSON-LD 只判两件事：有没有主体类型（Organization / Product），以及 sameAs 是否存在。
 * sameAs 是 advisory —— 它是实体一致性的参考，不是可以背书好坏的判断。
 *
 * 三个必须覆盖的真实形态：多个 script 块、@graph 嵌套、格式错误的 JSON。
 */

test("含 Organization 判为 pass", () => {
  const results = structuredChecks(wrap(`{"@context":"https://schema.org","@type":"Organization","name":"Acme"}`), "u");
  assert.equal(byId(results, "structured.jsonld").verdict, "pass");
});

test("有 JSON-LD 但无主体类型判为 warn", () => {
  const results = structuredChecks(wrap(`{"@type":"BreadcrumbList"}`), "u");
  assert.equal(byId(results, "structured.jsonld").verdict, "warn");
});

test("完全没有 JSON-LD 判为 fail", () => {
  assert.equal(byId(structuredChecks(ok("<html></html>"), "u"), "structured.jsonld").verdict, "fail");
});

test("@graph 嵌套里的类型能被识别", () => {
  const results = structuredChecks(wrap(`{"@graph":[{"@type":"WebSite"},{"@type":"Organization"}]}`), "u");
  assert.equal(byId(results, "structured.jsonld").verdict, "pass");
});

test("多个 script 块只要有一个含主体类型即 pass", () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"WebSite"}</script>
    <script type="application/ld+json">{"@type":"Product","name":"X"}</script>
  </head></html>`;
  assert.equal(byId(structuredChecks(ok(html), "u"), "structured.jsonld").verdict, "pass");
});

test("格式错误的 JSON 块被跳过，不让整个检查崩掉", () => {
  const html = `<html><head>
    <script type="application/ld+json">{ 这不是 JSON </script>
    <script type="application/ld+json">{"@type":"Organization"}</script>
  </head></html>`;
  assert.equal(byId(structuredChecks(ok(html), "u"), "structured.jsonld").verdict, "pass");
});

test("sameAs 恒为 advisory，任何结果都不进分母", () => {
  const withSameAs = structuredChecks(wrap(`{"@type":"Organization","sameAs":["https://x.com/a"]}`), "u");
  const without = structuredChecks(wrap(`{"@type":"Organization"}`), "u");
  assert.equal(byId(withSameAs, "structured.sameas").scored, false);
  assert.equal(byId(without, "structured.sameas").scored, false);
});

test("四种失败原因产出四段不同的文案，且都不带 verdict", () => {
  const reasons = ["throttled", "timeout", "cross_domain_redirect", "robots_disallowed"];
  const texts = reasons.map((reason) => {
    const results = structuredChecks({ ok: false, reason }, "https://example.com/");
    const jsonld = byId(results, "structured.jsonld");
    assert.equal(jsonld.state, "no_data", `${reason} 应记 no_data`);
    assert.equal(jsonld.verdict, null, "no_data 的项不得携带 verdict");
    return jsonld.observation;
  });
  assert.equal(new Set(texts).size, 4, "四种原因必须呈现四段不同的文案，不得坍缩成一句「本次未测到」");
});
