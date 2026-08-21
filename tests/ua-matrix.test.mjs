import assert from "node:assert/strict";
import test from "node:test";

import { PROBES, PROBE_IDENTITY_HEADER, runUaMatrix, interpretMatrix, uaMatrixChecks, stripBodies } from "../src/probe/ua-matrix.mjs";
import { runProbeAudit } from "../src/orchestrate-probe.mjs";

/**
 * UA 差分矩阵。
 *
 * 这一组守的核心只有一条：**不许把「我们测不出来」说成「你被拦了」**。
 *
 * 检测机不在这些爬虫官方公布的 IP 段里，Cloudflare 的「已验证机器人」机制
 * 会正确地拒绝我们这个未经验证的 GPTBot 声明，而放行真正的 GPTBot。
 * 若不区分这两种情况，这个功能会系统性地冤枉一批**配置完全正确**的站点——
 * 而且冤枉得毫无迹象：矩阵看起来铁证如山。
 */

const ok = (status = 200, headers = {}) => ({ ok: status < 400, status, headers, body: "x", finalUrl: "https://x.example/", reason: null });
const denied = (status = 403, headers = {}) => ({ ok: false, status, headers, body: null, finalUrl: "https://x.example/", reason: "http_error" });

/** 按 role 造一张矩阵，省得每条测试都手写七行。 */
function matrix({ baseline = 200, generic = 200, control = 200, ai = 200, headers = {} } = {}) {
  const pick = (role) => ({ baseline, generic, control, ai }[role]);
  return PROBES.map((p) => ({
    id: p.id,
    label: p.label,
    role: p.role,
    status: pick(p.role),
    reason: null,
    headers,
    finalUrl: "https://x.example/",
  }));
}

// ---------------------------------------------------------------------------
// 探针本身
// ---------------------------------------------------------------------------

test("七个探针的 UA 各不相同，且包含基线/泛化/对照/被测四种角色", () => {
  const uas = PROBES.map((p) => p.ua);
  assert.equal(new Set(uas).size, PROBES.length, "UA 有重复，矩阵就测不出差分");
  const roles = new Set(PROBES.map((p) => p.role));
  for (const r of ["baseline", "generic", "control", "ai"]) {
    assert.ok(roles.has(r), `缺少 ${r} 角色的探针`);
  }
  assert.ok(PROBES.filter((p) => p.role === "ai").length >= 4, "被测的 AI 爬虫至少四个");
});

test("**必须有 Googlebot 对照探针**——没有它就分不出「拦 AI」与「拦未验证声明」", () => {
  const control = PROBES.filter((p) => p.role === "control");
  assert.equal(control.length, 1, "对照探针有且只有一个");
  assert.match(control[0].ua, /Googlebot/, "对照必须是 Googlebot：几乎没有人会故意封它");
});

test("**UA 必须逐字节等于各家官方公布的串**", () => {
  // 产品决定：完全仿冒，不加后缀。理由是 WAF 规则常按精确串匹配，
  // 加一个后缀就可能让规则不命中，测出来的是「没拦」——而实际拦了。
  //
  // **断言必须对写死的字面量，不能拿 PROBES 跟自己比**：
  // 第一版写的是 opts.userAgent === PROBES[i].ua，改了表两边一起变，
  // 「给 UA 加后缀」这个变异当场存活。这是同义反复的标准形态。
  const ua = (id) => PROBES.find((p) => p.id === id)?.ua;
  assert.equal(ua("gptbot"), "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot");
  assert.equal(ua("claudebot"), "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)");
  assert.equal(ua("oai-searchbot"), "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)");
  assert.equal(ua("googlebot"), "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
  assert.equal(ua("curl"), "curl/8.4.0");
  // 产品名不得出现在 UA 里——那正是「加后缀」这个错误的形态。
  for (const p of PROBES) {
    assert.ok(!/MiaowaGEO|miaowageo/i.test(p.ua), `${p.id} 的 UA 里混进了本产品标识，会破坏精确匹配`);
  }
});

test("每个探针都带 X-Probed-By 身份头", async () => {
  // UA 仿冒是产品决定（WAF 常按精确串匹配，加后缀会让规则不命中）；
  // 但身份头必须在——对方运维查日志时要能看到究竟是谁在探测。
  const seen = [];
  await runUaMatrix("https://x.example/", {
    safeFetch: async (_u, opts) => { seen.push(opts); return ok(); },
  });
  assert.equal(seen.length, PROBES.length);
  for (const [i, opts] of seen.entries()) {
    assert.equal(opts.extraHeaders["x-probed-by"], PROBE_IDENTITY_HEADER["x-probed-by"]);
  }
});

test("正文被 maxBytes 截断不算失败——我们本来就只要状态码", async () => {
  const rows = await runUaMatrix("https://x.example/", {
    safeFetch: async () => ({ ok: false, status: 200, headers: {}, body: null, finalUrl: "u", reason: "too_large" }),
  });
  for (const r of rows) {
    assert.equal(r.status, 200);
    assert.equal(r.reason, null, "too_large 是我们自己设的上限，不该记成对方的失败");
  }
});

// ---------------------------------------------------------------------------
// 解读：本功能的全部风险都在这里
// ---------------------------------------------------------------------------

test("全部放行 → all_open", () => {
  assert.equal(interpretMatrix(matrix()).kind, "all_open");
});

test("浏览器与 Googlebot 都进得去、AI 被拦 → ai_blocked（结论扎实）", () => {
  const m = interpretMatrix(matrix({ ai: 403 }));
  assert.equal(m.kind, "ai_blocked");
  assert.equal(m.blockedAi.length, PROBES.filter((p) => p.role === "ai").length);
});

test("**Googlebot 也被拦 → verification，不得判成 ai_blocked**", () => {
  // 这是整个功能最容易说错话的地方。几乎没有人会故意封 Googlebot，
  // 它挂了说明拦的是「未经验证的机器人声明」本身——
  // 而真正的 GPTBot 能通过验证，我们测不出来。
  const m = interpretMatrix(matrix({ control: 403, ai: 403 }));
  assert.equal(m.kind, "verification", "对照探针被拦时必须降级为「无法判定」");
  assert.notEqual(m.kind, "ai_blocked");
});

test("连 curl 都被拦 → non_browser_block，说法范围要跟着变大", () => {
  const m = interpretMatrix(matrix({ generic: 403, ai: 403 }));
  assert.equal(m.kind, "non_browser_block");
});

test("浏览器自己都进不去 → baseline_failed，本项无从判定", () => {
  const m = interpretMatrix(matrix({ baseline: 403, generic: 403, control: 403, ai: 403 }));
  assert.equal(m.kind, "baseline_failed");
});

test("3xx 算「进得去」——跳转不是拦截", () => {
  assert.equal(interpretMatrix(matrix({ ai: 301 })).kind, "all_open");
});

// ---------------------------------------------------------------------------
// 判定与措辞
// ---------------------------------------------------------------------------

test("**verification 判 warn 不判 fail**", () => {
  // 判 fail 就是在指控一件我们没有观测到的事。
  const [r] = uaMatrixChecks(matrix({ control: 403, ai: 403 }), "https://x.example/");
  assert.equal(r.state, "ready");
  assert.equal(r.verdict, "warn");
  assert.notEqual(r.verdict, "fail");
});

test("**verification 的说明里必须写明我们无法判定**", () => {
  const [r] = uaMatrixChecks(matrix({ control: 403, ai: 403 }), "https://x.example/");
  assert.match(r.limitation, /无法判定/);
  assert.match(r.limitation, /已验证机器人|未经验证/);
  assert.match(r.limitation, /服务器日志/, "要给出可自查的下一步");
});

test("ai_blocked 的说明要点出「Googlebot 能进」这条依据", () => {
  // 结论之所以扎实，全靠这条对照。不写出来，读者无从判断我们凭什么这么说。
  const [r] = uaMatrixChecks(matrix({ ai: 403 }), "https://x.example/");
  assert.equal(r.verdict, "fail");
  assert.match(r.limitation, /Googlebot/);
});

test("baseline_failed 记 no_data，不判失败", () => {
  const [r] = uaMatrixChecks(matrix({ baseline: 500, generic: 500, control: 500, ai: 500 }), "https://x.example/");
  assert.notEqual(r.state, "ready");
  assert.equal(r.verdict, null, "没测到就不该有判定");
});

test("整张矩阵进 evidence，读者能一眼数回到原始观测", () => {
  const rows = matrix({ ai: 403 });
  const [r] = uaMatrixChecks(rows, "https://x.example/");
  assert.equal(r.evidence.matrix.length, PROBES.length);
  assert.equal(r.evidence.interpretation, "ai_blocked");
});

test("**每一支都必须把 interpretation 带进 evidence，包括没测出结论的那些**", () => {
  // 漏掉过一次，后果是跨模块的：报告页顶部的结论横幅按 interpretation 选文案，
  // baseline_failed 那一支没带，横幅就回落去说「两者只差一个 User-Agent，
  // 说明按 UA 拦截」——而 baseline_failed 恰恰**证伪**了这句话
  // （冒充浏览器也被拦）。同一份报告里两句话打架。
  //
  // 「没测出准入状态」≠「没有观测可报」。
  const cases = [
    ["all_open", matrix()],
    ["ai_blocked", matrix({ ai: 403 })],
    ["verification", matrix({ control: 403, ai: 403 })],
    ["non_browser_block", matrix({ generic: 403, ai: 403 })],
    // 连基线都被拦：项是 no_data，但 interpretation 照样要带上
    ["baseline_failed", matrix({ baseline: 403, generic: 403, control: 403, ai: 403 })],
  ];
  for (const [expected, rows] of cases) {
    const [r] = uaMatrixChecks(rows, "https://x.example/");
    assert.equal(r.evidence?.interpretation, expected, `${expected} 这一支没把 interpretation 带进 evidence`);
    assert.ok(Array.isArray(r.evidence?.matrix), `${expected} 这一支没把矩阵带进 evidence`);
  }
});

test("阶段整体失败时按对方侧原因记，且带 reason", () => {
  const [r] = uaMatrixChecks(null, "https://x.example/", { ok: false, status: null, reason: "timeout" });
  assert.equal(r.state, "no_data");
  assert.equal(r.reason, "timeout");
  assert.equal(r.verdict, null);
});

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

test("**robots.txt 禁止该路径时，一个探针都不许发**", async () => {
  // 换一个 UA 去探测，不等于可以无视对方的抓取规则。
  const calls = [];
  const { results } = await runProbeAudit("https://x.example/secret", {
    safeFetch: async (u) => {
      calls.push(u);
      if (u.endsWith("/robots.txt")) {
        return { ok: true, status: 200, headers: {}, body: "User-agent: *\nDisallow: /secret", finalUrl: u, reason: null };
      }
      return ok();
    },
  });
  assert.deepEqual(calls, ["https://x.example/robots.txt"], "除了 robots.txt 不该有任何请求");
  const m = results.find((r) => r.id === "access.ua-matrix");
  assert.equal(m.reason, "robots_disallowed");
});

test("WAF 厂商项恒为 advisory，不进分母", async () => {
  // 用了 Cloudflare 既不加分也不扣分。把它计分会让用了 CDN 的站
  // 无缘无故多一个计分项，站点之间失去可比性。
  for (const headers of [{ "cf-ray": "abc" }, {}]) {
    const { results } = await runProbeAudit("https://x.example/", {
      safeFetch: async (u) => (u.endsWith("/robots.txt") ? ok(200, {}) : ok(200, headers)),
    });
    const v = results.find((r) => r.id === "access.waf-vendor");
    assert.equal(v.scored, false);
    assert.equal(v.verdict, "info");
  }
});

test("**弱信号厂商不得用确证句式说出来**", async () => {
  // 「该站点前面有阿里云 WAF」和「像阿里云，但也可能是自建」之间的差别，
  // 对一个照着指引去翻控制台的人来说是全部的差别。
  const { results } = await runProbeAudit("https://x.example/", {
    safeFetch: async (u) => (u.endsWith("/robots.txt") ? ok(200, {}) : ok(200, { server: "Tengine" })),
  });
  const v = results.find((r) => r.id === "access.waf-vendor");
  assert.doesNotMatch(v.observation, /前面有/, "弱信号用了确证句式");
  assert.match(v.observation, /不是确证/);
  assert.match(v.observation, /自建/);
  assert.match(v.limitation, /先确认/, "弱信号的指引要先让人确认");
  assert.equal(v.evidence.confidence, "weak");
});

test("强信号厂商照旧直接下结论", async () => {
  // 弱信号那条措辞不能反过来把确证也说软了——认出 cf-ray 就是认出了。
  const { results } = await runProbeAudit("https://x.example/", {
    safeFetch: async (u) => (u.endsWith("/robots.txt") ? ok(200, {}) : ok(200, { "cf-ray": "8a1b" })),
  });
  const v = results.find((r) => r.id === "access.waf-vendor");
  assert.match(v.observation, /前面有 Cloudflare/);
  assert.doesNotMatch(v.observation, /不是确证/);
  assert.equal(v.evidence.confidence, "strong");
});

test("探针串行发出，不并发打对方站", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await runUaMatrix("https://x.example/", {
    safeFetch: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return ok();
    },
  });
  assert.equal(maxInFlight, 1, "七个请求同时打一个站，从对方视角看就像攻击");
});

test("all_open 的文案不留空括号、不多空格", () => {
  // 第一版写的是「全部取得内容（含 ${条件 ? "…" : ""}）」——
  // 条件不成立时会渲染出「（含 ）」，成立时多一个空格。
  // 真机跑出来才看到，单元测试里没人看文案。
  const [r] = uaMatrixChecks(matrix(), "https://x.example/");
  assert.doesNotMatch(r.observation, /（\s*）|（含\s*）/, "出现了空括号");
  assert.doesNotMatch(r.observation, /\s{2,}|含\s+全部/, "多余空格");
});

test("**baseline_failed 要说明「这不是按 UA 拦的」**", () => {
  // 真机实测：某 Cloudflare 站点对全部七个探针一律 403（含 Chrome UA），
  // 而真实无头浏览器进得去——说明它在做 TLS 指纹或 JS 质询，
  // 与探针自称是谁无关。不写清楚，读者会以为「七个都被拦=拦得最狠」。
  const [r] = uaMatrixChecks(matrix({ baseline: 403, generic: 403, control: 403, ai: 403 }), "https://x.example/");
  assert.match(r.limitation, /不是按 User-Agent/);
  assert.match(r.limitation, /TLS 指纹|JS 质询/);
  assert.match(r.limitation, /无头浏览器/, "要指路到真正能说明问题的那几项");
});

// ---------------------------------------------------------------------------
// 对照探针的前提正在被一个外部事件推翻
//
// 这套判定的地基是「几乎没有人会故意封 Googlebot」。2026-09-15 起，
// Cloudflare 把 Googlebot / Bingbot / Applebot 归为多用途爬虫，
// 在含广告页面上按最严格规则默认封禁训练类爬虫——适用于新客户、
// 现有客户的新站点与**全部免费套餐用户**。
//
// 那之后，Googlebot 的 403 会有一个与「已验证机器人校验」毫无关系的成因。
// 若继续说「真 GPTBot 可能进得去」，我们就在**放行方向上说错话**，
// 那比说不出结论糟得多。
// ---------------------------------------------------------------------------

test("**两个旁证齐备时，改判 control_ambiguous，不再单说验证机制**", () => {
  const rows = matrix({ control: 403, ai: 403 });
  const m = interpretMatrix(rows, { vendorId: "cloudflare", adMonetized: true });
  assert.equal(m.kind, "control_ambiguous");

  const [r] = uaMatrixChecks(rows, "https://x.example/", null, { vendorId: "cloudflare", adMonetized: true });
  assert.equal(r.verdict, "warn", "两种解释里有一种意味着真爬虫进得去，判 fail 就是指控没观测到的事");
  assert.match(r.limitation, /两种解释/);
  assert.match(r.limitation, /2026-09-15/, "要写明这个时间点，用户才知道该不该现在去看");
  assert.match(r.limitation, /控制台/, "要给出可自查的下一步");
});

test("**旁证不全时必须退回 verification，不许自行脑补**", () => {
  // 没有证据就不启用新分支——宁可少说一种可能，不可凭空多说一种。
  const rows = matrix({ control: 403, ai: 403 });
  for (const ctx of [
    {},
    { vendorId: "cloudflare" },
    { adMonetized: true },
    { vendorId: "fastly", adMonetized: true },
    { vendorId: "cloudflare", adMonetized: false },
  ]) {
    assert.equal(interpretMatrix(rows, ctx).kind, "verification", JSON.stringify(ctx));
  }
});

test("对照正常时，旁证再全也不该走这一支", () => {
  // control_ambiguous 只解释「对照为什么会被拦」，对照没被拦就无从谈起。
  const m = interpretMatrix(matrix({ ai: 403 }), { vendorId: "cloudflare", adMonetized: true });
  assert.equal(m.kind, "ai_blocked");
});

test("**矩阵进 evidence 前必须剥掉正文**", () => {
  // 正文只在进程内用一次（广告脚本检测）。它会一路进数据库、进报告页的表格——
  // 把第三方站点的 HTML 带过去，既撑大存储，也等于把别人的内容搬进我们的页面。
  const rows = matrix({ ai: 403 }).map((r) => ({ ...r, body: "<html>secret</html>" }));
  const [item] = uaMatrixChecks(rows, "https://x.example/");
  const serialized = JSON.stringify(item.evidence);
  assert.ok(!serialized.includes("secret"), "第三方页面正文泄进了 evidence");
  assert.ok(!serialized.includes('"body"'), "evidence 里不该有 body 字段");
});

test("stripBodies 只删 body，其余字段一个不少", () => {
  const rows = matrix({ ai: 403 }).map((r) => ({ ...r, body: "x" }));
  const out = stripBodies(rows);
  assert.equal(out.length, rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const { body, ...expected } = rows[i];
    void body;
    assert.deepEqual(out[i], expected);
  }
});
