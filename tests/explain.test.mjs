import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_EXPLANATIONS,
  EXPLAIN_LOCALES,
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
 *
 * ---------------------------------------------------------------------------
 * 多语言之后，「漏一项」多了一个维度
 *
 * 加英文之后，覆盖率不再是「每个 id 有没有解释」，而是
 * **每个 id × 每种语言**。少写一种语言，英文报告会静悄悄落到兜底文案
 * 「This check looks at one technical detail of your site.」——
 * 页面照常渲染、其他测试照常绿，只有真的切到英文看一眼才发现。
 *
 * 所以下面凡是逐条断言的测试，一律**对 EXPLAIN_LOCALES 里的每种语言各跑一遍**，
 * 而不是只跑中文。新增语言时不必改测试，加进那个数组即可。
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

/**
 * 每种语言各自的「措辞守则」判据。
 *
 * 中文那几条正则搬到英文一定失效——不是翻译问题，是**中英文的过度承诺
 * 长得完全不一样**。中文靠「就能／保证／一定」这类副词，英文靠
 * guarantee / ensure / will 这类情态动词，两套词表没有交集。
 */
const WORDING = {
  zh: {
    // **中间允许夹词**：第一版写死「就能被收录」，而「就能被 AI 引用」
    // 因为中间多了「AI」两个字就漏过去了——变异测试当场抓到。
    promises: /(就能|即可|马上|立刻|保证|一定)[^。；]{0,12}(被收录|被引用|收录|引用|上排名|提升排名)/,
    // 否定式是这个工具的核心修辞：不说「加了就能被引用」，只说「不加一定过不去」。
    negated: /(不|没有|无法|绝不|别)/,
    needsDev: /开发|维护网站的人/,
    notApplicable: /不适用|只有一种语言|单语言/,
    llmsTxtHonest: /不是强制标准|不使用/,
  },
  en: {
    // 英文的过度承诺集中在情态动词 + 结果名词。窗口取 40 字符：
    // 比中文的 12 宽，因为英文一个词平均更长，"will get you cited by AI" 就有 24。
    promises:
      /\b(guarantee[sd]?|ensure[sd]?|will|immediately|instantly)\b[^.;]{0,40}?\b(cited|citation|index(?:ed|ing)|rank(?:s|ed|ing|ings)?|top result)\b/i,
    // **否定式必须放行**，否则「no AI will cite it」「without it this will not
    // be indexed」这类正确写法会被误判。这是整条规则里最容易写错的一处：
    // 只封正面承诺，不封负面确定性。
    negated: /\b(no|not|never|cannot|can't|without|nothing|neither)\b/i,
    needsDev: /developer|whoever maintains/i,
    notApplicable: /does not apply|only one language/i,
    llmsTxtHonest: /not a required standard|does not use it/i,
  },
};

/** 逐条遍历「id × 语言」，body 拿到的是那一份 { what, risk, fix }。 */
function forEachExplanation(body) {
  for (const locale of EXPLAIN_LOCALES) {
    for (const [id, byLocale] of Object.entries(CHECK_EXPLANATIONS)) {
      body(byLocale[locale], `${id}[${locale}]`, locale);
    }
  }
}

/**
 * 找出一段文案里的过度承诺；没有则返回 null。
 *
 * **逐句判断，不整段一起看。** 整段判会出现「洗白」：前一句写了
 * 「Adding this will get you cited」，后一句碰巧有个 not，
 * 整段的否定词检查就把违规句放过去了。
 *
 * **命中后还要看是不是否定式。** 这个工具的核心修辞恰恰是负面确定性——
 * 「不加，这个环节一定过不去」「no AI will cite it」都是正确写法，
 * 而它们在词表上与正面承诺高度重合。只封正面，不封负面。
 */
function overPromises(text, locale) {
  const { promises, negated } = WORDING[locale];
  for (const sentence of text.split(/(?<=[。；.;])/)) {
    const hit = sentence.match(promises);
    if (hit && !negated.test(hit[0])) return hit[0];
  }
  return null;
}

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

  // **每种语言各查一遍。** 只查中文的话，加一项新检查却忘了写英文，
  // 英文报告会静悄悄落到兜底文案，这条测试照样绿。
  for (const locale of EXPLAIN_LOCALES) {
    const missing = all.map((r) => r.id).filter((id) => !hasExplanation(id, locale));
    assert.deepEqual(missing, [], `这些检查项还没有 ${locale} 解释：${missing.join(", ")}`);
  }
});

test("解释永远是三段齐全的，不能只写一半", () => {
  forEachExplanation((e, label) => {
    assert.ok(e, `${label} 整份缺失`);
    for (const field of ["what", "risk", "fix"]) {
      assert.ok(typeof e[field] === "string" && e[field].length >= 10, `${label}.${field} 太短或缺失`);
    }
  });
});

test("**英文不是中文的翻译占位，两边必须真的不同**", () => {
  // 防的是「先把中文原样复制过去占位，回头再翻」——那种半成品一旦上线，
  // 英文用户看到的是一屏中文，比兜底文案更糟，而所有覆盖率测试都是绿的。
  for (const [id, byLocale] of Object.entries(CHECK_EXPLANATIONS)) {
    for (const field of ["what", "risk", "fix"]) {
      assert.notEqual(byLocale.en[field], byLocale.zh[field], `${id}.${field} 的英文与中文完全相同`);
      assert.doesNotMatch(byLocale.en[field], /[一-龥]/, `${id}.${field} 的英文里混进了汉字`);
    }
  }
});

test("**非法语言回落中文，不返回 undefined**", () => {
  // explainFor 的返回值会被呈现端直接解构成 what/risk/fix。
  // 返回 undefined 会让整份报告炸掉，而不是少一段说明。
  for (const bogus of ["fr", "zh-CN", "", null, undefined, 42]) {
    const e = explainFor("access.noindex", bogus);
    assert.equal(e, CHECK_EXPLANATIONS["access.noindex"].zh, `locale=${String(bogus)} 应回落中文`);
  }
  // 未知 id 同样不能返回 undefined。
  assert.ok(explainFor("no.such.check", "en").what.length > 10);
});

test("14 个爬虫共用一份解释，不是 14 份", () => {
  // 逐个写会让读者以为有 13 件事要做，其实是同一件。
  for (const locale of EXPLAIN_LOCALES) {
    const x = explainFor("robots.oai-searchbot", locale);
    const y = explainFor("robots.claudebot", locale);
    assert.equal(x, y, `${locale}：应是同一个对象，不是内容相同的两份`);
    assert.equal(explainFor("robots.oai-searchbot.rollup", locale), x);
    assert.match(x.fix, /robots\.txt/, `${locale}：怎么改要说清楚去哪看`);
  }
  // 两种语言之间必须是不同对象，否则说明某一种语言根本没写。
  assert.notEqual(explainFor("robots.gptbot", "zh"), explainFor("robots.gptbot", "en"));
});

// ---------------------------------------------------------------------------
// 措辞：这些是这个工具的立身之本，不是文案偏好
// ---------------------------------------------------------------------------

test("**「怎么改」里不承诺结果**", () => {
  // 「加上 canonical 就能被 AI 引用」是假话。能说的只有
  // 「不加，这个环节一定过不去」。整份报告的可信度建立在不说满话上。
  forEachExplanation((e, label, locale) => {
    for (const field of ["fix", "risk"]) {
      const hit = overPromises(e[field], locale);
      assert.equal(hit, null, `${label}.${field} 承诺了结果：「${hit}」`);
    }
  });
});

test("**过度承诺的判据本身是有效的**——正例必须被抓到", () => {
  // 上一条测试全绿有两种可能：文案确实干净，或者正则根本抓不到东西。
  // 所以这里喂进**明知违规**的句子，正则必须报出来。
  const violations = {
    zh: ["加上 canonical 就能被 AI 引用。", "配置好了保证被收录。", "改完立刻提升排名。"],
    en: [
      "Adding this will get you cited by AI.",
      "This guarantees indexing within a week.",
      "Setting it up immediately improves rankings.",
    ],
  };
  for (const [locale, samples] of Object.entries(violations)) {
    for (const s of samples) {
      assert.ok(overPromises(s, locale), `${locale}：这句该被判为过度承诺，却漏过去了 —— 「${s}」`);
    }
  }

  // 反过来，**否定式必须放行**，否则整个工具没法说话了。
  const legitimate = {
    zh: ["不加，这个环节一定过不去。", "没有它，不会被任何 AI 引用。"],
    en: ["Without it, this page will not be indexed.", "No AI will cite content it cannot read."],
  };
  for (const [locale, samples] of Object.entries(legitimate)) {
    for (const s of samples) {
      assert.equal(overPromises(s, locale), null, `${locale}：否定式被误判成承诺 —— 「${s}」`);
    }
  }
});

test("需要开发介入的项要明说，不假装点两下就能搞定", () => {
  // 让一个不懂技术的老板以为「改一下就好」，他去找建站公司时说不清要什么。
  for (const locale of EXPLAIN_LOCALES) {
    for (const id of ["readability.static-text", "agent.accessibility-tree", "agent.cls"]) {
      assert.match(explainFor(id, locale).fix, WORDING[locale].needsDev, `${id}[${locale}] 没说清楚要找谁`);
    }
  }
});

test("单语言站的 hreflang 要明说「对你不适用」", () => {
  // 这一项判 warn，但对只有一种语言的站，不做才是对的。
  // 不说清楚，等于让做对了的人去修一个不存在的问题。
  for (const locale of EXPLAIN_LOCALES) {
    const e = explainFor("metadata.hreflang", locale);
    assert.match(`${e.risk}${e.fix}`, WORDING[locale].notApplicable, `hreflang[${locale}]`);
  }
});

test("llms.txt 要如实说明「Google 已明确不使用」", () => {
  // 大量 GEO 文章把它吹成必做项。我们查它，但要给出诚实结论。
  for (const locale of EXPLAIN_LOCALES) {
    assert.match(explainFor("agent.llms-txt", locale).risk, WORDING[locale].llmsTxtHonest, `llms-txt[${locale}]`);
  }
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

test("14 个爬虫只出一条待办，不是 14 条", () => {
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
  // 语言参数也不能把空输入弄崩。
  assert.deepEqual(actionPlan([], "en"), []);
  assert.deepEqual(actionPlan(undefined, "en"), []);
});

test("**语言只换文案，不换待办的成员与顺序**", () => {
  // 同一个站的中英文报告如果给出两套不同的待办，那就不是同一份事实的两种说法，
  // 而是两个互相矛盾的结论。过滤、14 个爬虫折叠、fail/warn 排序都必须与语言无关。
  const raw = [
    item({ id: "metadata.img-alt", verdict: "fail" }),
    item({ id: "access.noindex", verdict: "warn" }),
    item({ id: "robots.gptbot", verdict: "fail" }),
    item({ id: "robots.claudebot", verdict: "fail" }),
    item({ id: "metadata.title", verdict: "pass" }),
    item({ id: "agent.cls", state: "no_data", verdict: "fail", reason: "http_error" }),
  ];
  const zh = actionPlan(raw, "zh");
  const en = actionPlan(raw, "en");

  assert.deepEqual(en.map((a) => a.id), zh.map((a) => a.id), "两种语言的待办 id 与顺序必须一致");
  assert.deepEqual(en.map((a) => a.priority), zh.map((a) => a.priority));
  assert.deepEqual(en.map((a) => a.verdict), zh.map((a) => a.verdict));
  assert.ok(zh.length > 1, "sanity：样本要足以体现顺序，否则这条断言没有意义");

  // 而文案必须真的换了——否则「语言无关」是靠英文根本没生效换来的。
  for (let i = 0; i < zh.length; i += 1) {
    assert.notEqual(en[i].what, zh[i].what, `${zh[i].id} 的英文待办文案没有生效`);
  }
});

test("默认语言仍是中文——既有调用方不带参数，行为不得改变", () => {
  // 呈现端现在还在用 actionPlan(items) / explainFor(id) 的旧签名。
  // 加了 locale 参数后如果默认值写错，中文报告会整屏变英文，而所有多语言测试照样绿。
  const plan = actionPlan([item({ id: "access.noindex", verdict: "fail" })]);
  assert.deepEqual(plan, actionPlan([item({ id: "access.noindex", verdict: "fail" })], "zh"));
  assert.equal(explainFor("access.noindex"), CHECK_EXPLANATIONS["access.noindex"].zh);
});


test("文案里的强调标记必须成对出现", () => {
  // 呈现端会把 `**强调**` 渲染成加粗。落单的星号会原样漏到页面上——
  // 这在主站上真实发生过一次，页面照常渲染、测试照常绿，只有看截图才发现。
  const marked = { zh: 0, en: 0 };
  forEachExplanation((e, label, locale) => {
    for (const field of ["what", "risk", "fix"]) {
      const n = (e[field].match(/\*\*/g) ?? []).length;
      assert.equal(n % 2, 0, `${label}.${field} 里的 ** 没有成对，会有星号漏到页面上`);
      marked[locale] += n;
    }
  });
  // **每种语言分别 sanity。** 合在一起数的话，中文有标记、英文一个都没有，
  // 总数照样大于 0，这条 sanity 就废了。
  for (const locale of EXPLAIN_LOCALES) {
    assert.ok(marked[locale] > 0, `sanity：${locale} 文案里应当有强调标记，否则这条断言没有意义`);
  }
});
