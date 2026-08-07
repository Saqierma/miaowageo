import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_EXPLANATIONS,
  actionPlan,
  explainFor,
  hasExplanation,
} from "../src/explain.mjs";

/**
 * 大白话解释层。
 *
 * 由来是一个具体的用户反馈：报告只说观测事实（「meta description 共 51 个
 * 字符」），而这个工具的真实用户是第一次听说 GEO 的中小企业老板。
 * 他看到一屏「需改进」，唯一能得到的信息是「我好像有问题」。
 *
 * 下面守的都是「不写会静悄悄退化成没用」的性质：
 * 漏掉某项的解释、待办清单排错序、把不该修的东西列成待办——
 * 页面照常渲染、测试照常绿，只是用户看完还是不知道该干嘛。
 */

const item = (over = {}) => ({
  id: "metadata.title",
  group: "metadata",
  scored: true,
  state: "ready",
  verdict: "fail",
  observation: "o",
  reason: null,
  ...over,
});

// ---------------------------------------------------------------------------
// 覆盖率：这是整个模块最要紧的一条
// ---------------------------------------------------------------------------

test("**worker 产出的每一个检查项都必须有解释**", async () => {
  // 手工维护一份 id 清单迟早会漏——worker 加了新检查项，这里没跟上，
  // 用户就会看到一条走兜底文案的「这一项检查网站的一个技术细节」。
  // 所以这条测试**真的去跑检查模块**，拿到真实的 id 全集来核对。
  // 检查模块就在本仓库里，**不加任何跳过分支**：
  // 「找不到就 return」的写法会让这条测试在路径变动后静默变成空转。
  const modules = {
    light: await import("../src/orchestrate-light.mjs"),
    psi: await import("../src/checks/psi-map.mjs"),
    lh: await import("../src/checks/lighthouse-map.mjs"),
  };

  const html =
    '<html lang="en"><head><title>t</title><meta name="description" content="d">' +
    '<meta name="viewport" content="width=device-width">' +
    '<link rel="canonical" href="https://x.example/"></head>' +
    "<body><h1>h</h1><img src=a alt=b></body></html>";

  const { results } = await modules.light.runLightAudit("https://x.example/", {
    safeFetch: async (u) => ({
      ok: true,
      status: 200,
      headers: {},
      body: u.endsWith("robots.txt") ? "User-agent: *\nAllow: /" : html,
      finalUrl: u,
      reason: null,
    }),
  });
  const deep = [
    ...modules.psi.psiChecks({ ok: false, status: null, payload: null, requestedUrl: "u", workerReason: "x" }),
    ...modules.lh.lighthouseChecks({ report: null, requestedUrl: "u", runnerReason: "x", baseHost: "x" }),
  ];

  const all = [...results, ...deep];
  assert.ok(all.length >= 30, `只拿到 ${all.length} 项，检查模块多半没跑起来`);

  const missing = all.map((r) => r.id).filter((id) => !hasExplanation(id));
  assert.deepEqual(missing, [], `这些检查项还没有大白话解释：${missing.join(", ")}`);
});

test("解释永远是三段齐全的，不能只写一半", () => {
  for (const [id, e] of Object.entries(CHECK_EXPLANATIONS)) {
    for (const field of ["what", "risk", "fix"]) {
      assert.ok(typeof e[field] === "string" && e[field].length >= 10, `${id}.${field} 太短或缺失`);
    }
  }
});

test("13 个爬虫共用一份解释，不是 13 份", () => {
  // 逐个写会让读者以为有 13 件事要做，其实是同一件。
  const a = explainFor("robots.oai-searchbot");
  const b = explainFor("robots.claudebot");
  assert.equal(a, b, "同一个对象，不是内容相同的两份");
  // 折叠出来的条目 id 带 .rollup 后缀，也必须命中。
  assert.equal(explainFor("robots.oai-searchbot.rollup"), a);
  assert.match(a.fix, /robots\.txt/, "怎么改要说清楚去哪看");
});

// ---------------------------------------------------------------------------
// 措辞：这些是这个工具的立身之本，不是文案偏好
// ---------------------------------------------------------------------------

test("**「怎么改」里不承诺结果**", () => {
  // 「加上 canonical 就能被 AI 引用」是假话。能说的只有
  // 「不加，这个环节一定过不去」。整份报告的可信度建立在不说满话上。
  // **中间允许夹词**：第一版写死「就能被收录」，而「就能被 AI 引用」
  // 因为中间多了「AI」两个字就漏过去了——变异测试当场抓到。
  const promises = /(就能|即可|马上|立刻|保证|一定)[^。；]{0,12}(被收录|被引用|收录|引用|上排名|提升排名)/;
  for (const [id, e] of Object.entries(CHECK_EXPLANATIONS)) {
    assert.doesNotMatch(e.fix, promises, `${id}.fix 承诺了结果`);
    assert.doesNotMatch(e.risk, promises, `${id}.risk 承诺了结果`);
  }
});

test("需要开发介入的项要明说，不假装点两下就能搞定", () => {
  // 让一个不懂技术的老板以为「改一下就好」，他去找建站公司时说不清要什么。
  for (const id of ["readability.static-text", "agent.accessibility-tree", "agent.cls"]) {
    assert.match(explainFor(id).fix, /开发|维护网站的人/, `${id} 没说清楚要找谁`);
  }
});

test("单语言站的 hreflang 要明说「对你不适用」", () => {
  // 这一项判 warn，但对只有一种语言的站，不做才是对的。
  // 不说清楚，等于让做对了的人去修一个不存在的问题。
  const e = explainFor("metadata.hreflang");
  assert.match(`${e.risk}${e.fix}`, /不适用|只有一种语言|单语言/);
});

test("llms.txt 要如实说明「Google 已明确不使用」", () => {
  // 大量 GEO 文章把它吹成必做项。我们查它，但要给出诚实结论。
  assert.match(explainFor("agent.llms-txt").risk, /不是强制标准|不使用/);
});

// ---------------------------------------------------------------------------
// 待办清单
// ---------------------------------------------------------------------------

test("只收 fail 与 warn，通过的项不进待办", () => {
  const plan = actionPlan([
    item({ id: "metadata.title", verdict: "pass" }),
    item({ id: "metadata.h1", verdict: "fail" }),
    item({ id: "metadata.og", verdict: "warn" }),
    item({ id: "structured.sameas", verdict: "info", scored: false }),
  ]);
  assert.deepEqual(plan.map((a) => a.id), ["metadata.h1", "metadata.og"]);
});

test("**被 403 挡住的项不进待办**——那是整份报告的前提，不是十几件事", () => {
  // 混进来会让用户以为有十几件事要做，其实是同一件，
  // 而且顶部结论横幅已经专门讲过了。
  const blocked = Array.from({ length: 8 }, (_, i) =>
    item({ id: `metadata.x${i}`, state: "no_data", verdict: null, reason: "http_error" }),
  );
  assert.deepEqual(actionPlan(blocked), []);

  // **上面那组数据其实测不到 state 那道防线**：verdict 是 null，
  // 会被下一行的 verdict 过滤先挡掉。变异测试当场抓到——
  // 把 state 判断整个删掉，测试依然全绿。
  // 所以这里再构造一组「非 ready 却带着 verdict」的脏数据：
  // 现实中 worker 保证不会出现，但 actionPlan 收的是裸 API 数据，
  // 而一条凭空冒出来的待办会让用户去修一件我们从没测过的事。
  const dirty = [
    item({ id: "metadata.title", state: "no_data", verdict: "fail", reason: "http_error" }),
    item({ id: "metadata.h1", state: "not_wired", verdict: "warn", reason: "worker_error" }),
  ];
  assert.deepEqual(actionPlan(dirty), [], "非 ready 的项即使带着 verdict 也不得进待办");
});

test("13 个爬虫只出一条待办，不是 13 条", () => {
  const plan = actionPlan([
    item({ id: "robots.claudebot", verdict: "fail" }),
    item({ id: "robots.gptbot", verdict: "fail" }),
    item({ id: "robots.applebot", verdict: "warn" }),
  ]);
  assert.equal(plan.length, 1, `爬虫类应折叠成一条，实测 ${plan.length} 条`);
});

test("**fail 一律排在 warn 前面**，哪怕那个 warn 的严重程度更高", () => {
  // **必须让 warn 的优先级数字比 fail 更小**，否则测不出「fail 优先」这条：
  // 第一版挑的两个 fail 恰好优先级也更靠前，把 verdict 比较整个删掉，
  // 排序结果一模一样，测试照样绿。变异测试抓到的。
  const plan = actionPlan([
    item({ id: "access.noindex", verdict: "warn" }), // 优先级 10（最高）但只是 warn
    item({ id: "agent.cls", verdict: "fail" }), //     优先级 105（最低）但是 fail
  ]);
  assert.deepEqual(
    plan.map((a) => a.id),
    ["agent.cls", "access.noindex"],
    "fail 必须排在 warn 前面，即使那个 warn 的严重程度更高",
  );
});

test("同为 fail 时，按严重程度排——noindex 第一", () => {
  // 用户多半只认真看前三条，那三条必须是最要紧的。
  const plan = actionPlan([
    item({ id: "metadata.img-alt", verdict: "fail" }),
    item({ id: "metadata.title", verdict: "fail" }),
    item({ id: "access.noindex", verdict: "fail" }),
  ]);
  assert.equal(
    plan[0].id,
    "access.noindex",
    "noindex 是唯一一个能让整页从所有索引里消失的项，必须排第一",
  );
  assert.deepEqual(plan.map((a) => a.id), ["access.noindex", "metadata.title", "metadata.img-alt"]);
});

test("待办条目自带三段说明，读者不必再去下面翻", () => {
  const [a] = actionPlan([item({ id: "readability.static-text", verdict: "fail", observation: "正文很少" })]);
  assert.equal(a.observation, "正文很少", "要保留原始观测，否则读者不知道是哪一项");
  for (const f of ["what", "risk", "fix"]) {
    assert.ok(a[f].length > 10, `待办缺少 ${f}`);
  }
});

test("空输入不崩", () => {
  assert.deepEqual(actionPlan([]), []);
  assert.deepEqual(actionPlan(undefined), []);
  assert.deepEqual(actionPlan(null), []);
});





test("文案里的强调标记必须成对出现", () => {
  // 呈现端会把 `**强调**` 渲染成加粗。落单的星号会原样漏到页面上——
  // 这在主站上真实发生过一次，页面照常渲染、测试照常绿，只有看截图才发现。
  let marked = 0;
  for (const [id, e] of Object.entries(CHECK_EXPLANATIONS)) {
    for (const field of ["what", "risk", "fix"]) {
      const n = (e[field].match(/\*\*/g) ?? []).length;
      assert.equal(n % 2, 0, `${id}.${field} 里的 ** 没有成对，会有星号漏到页面上`);
      marked += n;
    }
  }
  assert.ok(marked > 0, "sanity：文案里应当有强调标记，否则这条断言没有意义");
});
