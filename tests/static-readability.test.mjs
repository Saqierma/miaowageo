import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { visibleTextLength, readabilityCheck } from "../src/checks/static-readability.mjs";

const ok = (body) => ({ ok: true, status: 200, body });

const html = (name) => readFileSync(new URL(`../fixtures/html/${name}.html`, import.meta.url), "utf8");

/**
 * 「不执行 JS 时能读到多少字」——这个数就是 AI 爬虫看到的内容量，
 * 因为 OpenAI 的爬虫会下载 .js 但不运行它。
 *
 * 500 字符这个阈值是本工具最有分量的一个数字，来自实测：
 * Shopify 服务端渲染首页约 3,500–24,000 字符，Vue 空壳约 80 字符。
 * 500 是一个宽松的下界——宁可漏报，不可误报。
 *
 * 注意统计的是**字符数**不是单词数：500 字符对英文站约合 80 个单词。
 */

test("script 与 style 的内容不计入可见正文", () => {
  const length = visibleTextLength(`<body><script>const a = "很长很长的脚本内容".repeat(100);</script><p>hi</p></body>`);
  assert.ok(length < 20, `期望只剩 "hi" 量级，实际 ${length}`);
});

test("Vue 空壳判为 fail", () => {
  const result = readabilityCheck(ok(html("vue-shell")), "https://example.com/");
  assert.equal(result.verdict, "fail");
  assert.equal(result.scored, true);
  assert.match(result.observation, /不执行 JavaScript/);
});

test("服务端渲染判为 pass", () => {
  assert.equal(readabilityCheck(ok(html("shopify-ssr")), "https://example.com/").verdict, "pass");
});

test("边界值 200 与 500", () => {
  const make = (n) => ok(`<body><p>${"a".repeat(n)}</p></body>`);
  assert.equal(readabilityCheck(make(199), "u").verdict, "fail");
  assert.equal(readabilityCheck(make(200), "u").verdict, "warn");
  assert.equal(readabilityCheck(make(499), "u").verdict, "warn");
  assert.equal(readabilityCheck(make(500), "u").verdict, "pass");
});

test("四种失败原因产出四段不同的文案，且都不带 verdict", () => {
  const reasons = ["throttled", "timeout", "cross_domain_redirect", "robots_disallowed"];
  const texts = reasons.map((reason) => {
    const result = readabilityCheck({ ok: false, reason }, "https://example.com/");
    assert.equal(result.state, "no_data", `${reason} 应记 no_data`);
    assert.equal(result.verdict, null, "no_data 的项不得携带 verdict");
    return result.observation;
  });
  assert.equal(new Set(texts).size, 4, "四种原因必须呈现四段不同的文案，不得坍缩成一句「本次未测到」");
});

// ---------------------------------------------------------------------------
// 代码审查（2026-09）：与 html-meta 共用 stripNoise，口径不再漂移
// ---------------------------------------------------------------------------

import { visibleTextLength as vtl } from "../src/checks/static-readability.mjs";
import { extractH1s as h1sOf } from "../src/checks/html-meta.mjs";

test("**template 里的正文与内联 svg 的 <title> 不计入静态可读字数**——与 html-meta 同口径", () => {
  // 此前：正文全在 <template> 里 + 40 个图标 <title> 的 CSR 页，readability 判 pass
  // 「静态可读 678 字」，而同一页面 html-meta 判「无 h1」——同一份报告自相矛盾。
  const icons = Array.from({ length: 40 }, () => `<svg><title>图标</title><path d="M0 0L1 1"/></svg>`).join("");
  const body = "正文".repeat(300);
  const html = `<html><body><template><h1>标题</h1><p>${body}</p></template>${icons}</body></html>`;
  assert.ok(vtl(html) < 200, `template/svg 里的文字被算成了静态可读内容：${vtl(html)}`);
  assert.deepEqual(h1sOf(html), [], "两个检查对 template 内容的口径必须一致");
});

test("noscript 仍按本检查独有的口径剥掉（这次不改这条决策）", () => {
  assert.equal(vtl(`<html><body><noscript>${"x".repeat(600)}</noscript></body></html>`), 0);
});
