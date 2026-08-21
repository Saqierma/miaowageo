import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVENANCE_SIGNATURES,
  splitProvenance,
  parseContentSignals,
  CONTENT_SIGNAL_FIELDS,
} from "../src/checks/robots-provenance.mjs";
import { robotsChecks } from "../src/checks/robots.mjs";

/**
 * robots.txt 的归属切分。
 *
 * 这一组守的核心只有一条：**认不出就说认不出，绝不猜归属。**
 * 把 CDN 注入的规则算到站长头上，会让他去改一个他没写过的东西；
 * 反过来会让他以为进控制台点一下就行，而实际得改源站文件。
 * 两种猜错都比不做这个功能更糟。
 */

/** Cloudflare 托管块 prepend 到源站文件之前的真实形态。 */
const CF_MANAGED = `# Content Signals Policy
# As used in this document, the terms below have the following meanings:
# (a) "search": building a search index and providing search results
# (b) "ai-input": inputting the content into one or more AI models
# (c) "ai-train": training or fine-tuning AI models

User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /
`;

const ORIGIN_PART = `User-agent: *
Disallow: /admin/
Sitemap: https://example.com/sitemap.xml
`;

const ok = (body) => ({ ok: true, status: 200, headers: {}, body, finalUrl: "u", reason: null });

// ---------------------------------------------------------------------------
// 切分
// ---------------------------------------------------------------------------

test("**托管块与源站内容被正确切开**", () => {
  const p = splitProvenance(CF_MANAGED + "\n" + ORIGIN_PART);
  assert.equal(p.vendor.id, "cloudflare");
  assert.equal(p.confidence, "high", "有 Content-Signal 指令时归属是硬的");
  assert.ok(p.managedLineCount > 0, "应当认出托管块");
  assert.ok(p.originLineCount > 0, "源站部分不该被吃光");
  assert.deepEqual(p.managedAgents.sort(), ["claudebot", "gptbot"]);
});

test("**站长自己封 GPTBot，绝不能算到 CDN 头上**", () => {
  // 这是最危险的误判方向：告诉用户「这不是你写的，去控制台改」，
  // 而他进了控制台什么都找不到，真正要改的是自己的源站文件。
  const p = splitProvenance("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
  assert.equal(p.vendor, null, "没有厂商标识就不该启动切分");
  assert.equal(p.managedLineCount, 0);
});

test("**源站规则不得被吃进托管块**", () => {
  // 遇到第一个不符合托管形态的组就停。站长的 Disallow: /admin/ 必须留在源站段。
  const p = splitProvenance(CF_MANAGED + "\n" + ORIGIN_PART);
  const lines = (CF_MANAGED + "\n" + ORIGIN_PART).split("\n");
  const managed = lines.slice(0, p.managedLineCount).join("\n");
  assert.ok(!managed.includes("/admin/"), "站长的 Disallow: /admin/ 被误算进了托管块");
  assert.ok(!managed.includes("Sitemap:"), "站长的 Sitemap 行被误算进了托管块");
});

test("**源站段之后再出现「长得像托管」的组，也不许回头认领**", () => {
  // 这条是 break 真正防的东西，也是第一版 fixture 没测到的：
  // 站长自己在文件后半段封了 GPTBot——那一组的形态（已知 AI 爬虫 + 整站 Disallow）
  // 与托管块完全一样。若扫描不在第一个非托管组停下，它会被回头认领成 CDN 注入，
  // 于是我们告诉用户「这不是你写的，去控制台改」，而他在控制台里什么都找不到。
  const body = [
    "# Content Signals Policy",
    '# (a) "search": ...',
    "",
    "User-agent: *",
    "Content-Signal: search=yes,ai-train=no",
    "Allow: /",
    "",
    "User-agent: *",        // ← 从这里开始是源站
    "Disallow: /admin/",
    "",
    "User-agent: GPTBot",   // ← 站长自己封的，形态与托管块一模一样
    "Disallow: /",
    "",
  ].join("\n");

  const p = splitProvenance(body);
  const lines = body.split("\n");
  const managed = lines.slice(0, p.managedLineCount).join("\n");
  const origin = lines.slice(p.managedLineCount).join("\n");

  assert.ok(!managed.includes("/admin/"), "站长的规则被吃进了托管块");
  assert.ok(origin.includes("GPTBot"), "站长自己封的 GPTBot 被回头认领成了 CDN 注入");
  assert.ok(!p.managedAgents.includes("gptbot"), "gptbot 不该出现在托管清单里——那一组是站长写的");
});

test("只有政策文本、没有托管规则时，如实说「没有注入的规则」", () => {
  // 免费套餐上「CDN 展示了政策说明、但站长没启用托管功能」的典型形态。
  const p = splitProvenance('# Content Signals Policy\n# (a) "search": ...\n\nUser-agent: *\nDisallow: /private/\n');
  assert.equal(p.vendor.id, "cloudflare");
  assert.equal(p.managedLineCount, 0, "没有托管规则组，切分点应当在开头");
  assert.equal(p.confidence, "medium", "只有政策文本时置信度是软的");
});

test("认不出时返回 vendor: null，绝不猜", () => {
  for (const body of ["", "User-agent: *\nDisallow: /\n", "<!doctype html><html></html>", null, undefined]) {
    assert.equal(splitProvenance(body).vendor, null, JSON.stringify(body));
  }
});

test("**特征表必须带 source 与 verifiedAt**", () => {
  // 这里依赖的是厂商自己的输出文本，对方随时可以改。
  // 没有出处和核实日期，下一个人无从判断某条特征是不是已经过期。
  for (const sig of PROVENANCE_SIGNATURES) {
    assert.match(sig.source, /^https?:\/\//, `${sig.id} 的 source 不是一个可查的地址`);
    assert.match(sig.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, `${sig.id} 缺少核实日期`);
    assert.ok(sig.markers.length > 0, `${sig.id} 没有任何特征`);
  }
});

// ---------------------------------------------------------------------------
// Content-Signal
// ---------------------------------------------------------------------------

test("读出各组的 Content-Signal 取值", () => {
  const groups = parseContentSignals(CF_MANAGED);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].agents, ["*"]);
  assert.deepEqual(groups[0].signals, { search: "yes", "ai-train": "no", use: "reference" });
});

test("**未知字段照收，不写死白名单**", () => {
  // Cloudflare 已经加过一次新字段（use=reference）。写死白名单会让
  // 下一次扩展静默消失——而我们不会知道自己漏了什么。
  const groups = parseContentSignals("User-agent: *\nContent-Signal: search=yes,brand-new-field=maybe\n");
  assert.equal(groups[0].signals["brand-new-field"], "maybe");
});

test("没有 Content-Signal 时返回空数组，不抛错", () => {
  assert.deepEqual(parseContentSignals("User-agent: *\nDisallow: /\n"), []);
  assert.deepEqual(parseContentSignals("<!doctype html>"), []);
});

test("**Content-Signal 恒不计分**", () => {
  // Google 已公开表示没有任何爬虫或 LLM 读取这个指令。
  // 拿一个没人读的指令扣分，与本项目把 llms.txt 降级为参考项的理由完全一样——
  // 对它换一套标准，第一原则就守不住了。
  for (const body of [CF_MANAGED, "User-agent: *\nDisallow: /\n"]) {
    const item = robotsChecks(ok(body), "u").find((r) => r.id === "access.content-signal");
    assert.equal(item.scored, false, "Content-Signal 不得进分母");
  }
  assert.ok(Object.keys(CONTENT_SIGNAL_FIELDS).includes("ai-input"));
});

test("**归属项也恒不计分**", () => {
  // 用了托管 robots.txt 既不加分也不扣分，它只是「这行是谁写的」这条信息的载体。
  for (const body of [CF_MANAGED, "User-agent: *\nDisallow: /\n"]) {
    const item = robotsChecks(ok(body), "u").find((r) => r.id === "access.robots-provenance");
    assert.equal(item.scored, false);
  }
});

// ---------------------------------------------------------------------------
// 接线
// ---------------------------------------------------------------------------

test("**两条路径的项数必须一致**", () => {
  // 抓不到 robots.txt 时若少两项，分母会随「有没有抓到」变化，
  // 站点之间的通过率就失去可比性。与 CRAWLERS 恒为同一组是同一条约定。
  const okCount = robotsChecks(ok("User-agent: *\nAllow: /\n"), "u").length;
  const failCount = robotsChecks({ ok: false, status: 429, reason: "throttled" }, "u").length;
  assert.equal(okCount, failCount, "成功与失败两条路径的项数不一致");
});

test("认出托管块时，措辞要点明「这不是你写的」", () => {
  // 这是整份报告里最可能产生直接行动的一句话。
  const item = robotsChecks(ok(CF_MANAGED + "\n" + ORIGIN_PART), "u")
    .find((r) => r.id === "access.robots-provenance");
  assert.match(item.observation, /由 Cloudflare 注入/);
  assert.match(item.limitation, /不是你写的/);
  assert.match(item.limitation, /控制台/, "要告诉他去哪儿改");
});
