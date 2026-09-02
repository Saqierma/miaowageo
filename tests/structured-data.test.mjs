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

// ---------------------------------------------------------------------------
// Microdata / RDFa 廉价探测（issue #2）
//
// 不少老建站系统和 WordPress 主题默认输出 Microdata。用它标注了完整
// Organization 的站，被判成「未发现任何结构化数据」的 fail，是一个假结论。
// 我们只探测、不解析——解析这两种老格式投入产出比不高，「疑似存在」
// 降级为 warn 已经足够让报告说实话。
// ---------------------------------------------------------------------------

test("无 JSON-LD 但有 Microdata 标注 → warn 而不是 fail（issue #2）", () => {
  const html = `<html><body>
    <div itemscope itemtype="https://schema.org/Organization">
      <span itemprop="name">Acme</span>
    </div></body></html>`;
  const r = byId(structuredChecks(ok(html), "u"), "structured.jsonld");
  assert.equal(r.verdict, "warn", "完整的 Microdata 站不该与「什么都没有」同罪");
  assert.match(r.observation, /Microdata/);
  assert.match(r.observation, /疑似/, "我们没解析，不能把探测说成确认");
  assert.match(r.limitation, /不解析|只探测/, "必须说明本工具不解析这两种格式");
});

test("无 JSON-LD 但有 RDFa 标注（typeof/vocab）→ warn", () => {
  const html = `<html><body vocab="https://schema.org/" typeof="Organization">
    <span property="name">Acme</span></body></html>`;
  const r = byId(structuredChecks(ok(html), "u"), "structured.jsonld");
  assert.equal(r.verdict, "warn");
  assert.match(r.observation, /RDFa/);
});

test("只有 Open Graph 的页面仍判 fail：og 的 property= 不算 RDFa 探测命中", () => {
  // 几乎每个现代页面都有 <meta property="og:...">。若把裸 property=
  // 当成 RDFa 信号，fail 分支将几乎永远走不到，这项检查等于被废掉。
  const html = `<html><head><meta property="og:title" content="A"></head><body></body></html>`;
  assert.equal(byId(structuredChecks(ok(html), "u"), "structured.jsonld").verdict, "fail");
});

test("script 字符串里的 itemscope 不算数；class 撞名也不算", () => {
  // 与 html-meta 的去噪原则一致：JS 模板字符串不是页面标注。
  const inScript = `<html><script>const t = '<div itemscope itemtype="x">';</script><body></body></html>`;
  assert.equal(byId(structuredChecks(ok(inScript), "u"), "structured.jsonld").verdict, "fail");

  const classClash = `<html><body><div class="itemscope"></div></body></html>`;
  assert.equal(byId(structuredChecks(ok(classClash), "u"), "structured.jsonld").verdict, "fail");
});

test("未闭合的 <script> 不得让 JS 源码冒充页面标注（评审发现）", () => {
  // 浏览器把未闭合 script 之后的所有字节都当脚本文本，去噪必须照剥，
  // 否则整段 JS 源码进入属性正则，fail 被误降级成 warn。
  const html = `<html><script>var t = "<div itemscope itemtype=x>";`;
  assert.equal(byId(structuredChecks(ok(html), "u"), "structured.jsonld").verdict, "fail");
});

test("已有 JSON-LD 时探测不介入，判定与原来一致", () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Organization"}</script></head>
    <body itemscope itemtype="https://schema.org/WebPage"></body></html>`;
  assert.equal(byId(structuredChecks(ok(html), "u"), "structured.jsonld").verdict, "pass");
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
