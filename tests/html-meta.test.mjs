import assert from "node:assert/strict";
import test from "node:test";

import {
  htmlMetaChecks,
  extractTitle,
  extractMetaByName,
  extractMetaByProperty,
  extractHtmlLang,
  extractH1s,
  extractHreflangs,
  hasResponsiveViewport,
  imgAltCoverage,
} from "../src/checks/html-meta.mjs";

/**
 * 基础技术 SEO 的八项检查。
 *
 * 这一组是 2026-08-07 补的，起因是一次真实复盘：此前 18 个计分项里
 * 有 9 个是「robots.txt 没拦你」，而那是互联网的默认状态——任何站点
 * 打开都是一片绿，真正的问题被淹没。
 *
 * 所以这里每条测试守的都是「会不会造出一个假结论」：
 * 把脚本里的字符串当成页面内容、把 alt="" 当成缺失、把单语言站的
 * 无 hreflang 当成错误——每一个都会让报告说出一件不成立的事。
 */

const ok = (body) => ({ ok: true, status: 200, headers: {}, body, finalUrl: "https://x.example/", reason: null });
const byId = (rs, id) => rs.find((r) => r.id === id);
const run = (html) => htmlMetaChecks(ok(html), "https://x.example/");

// ---------------------------------------------------------------------------
// 解析：先去噪是正确性要求，不是优化
// ---------------------------------------------------------------------------

test("script 里的假标签不得被当成页面内容", () => {
  // 单页应用的 bundle 里全是这种模板字符串。先去标签再解析的话，
  // 一个 JS 变量就能让空壳站看起来元信息齐全——那是凭空造出来的结论。
  const html = `
    <html><head>
      <script>const tpl = '<title>脚本里的假标题</title><h1>假H1</h1><img src=x>';</script>
      <title>真标题</title>
    </head><body></body></html>`;
  assert.equal(extractTitle(html), "真标题");
  assert.deepEqual(extractH1s(html), []);
  assert.equal(imgAltCoverage(html).total, 0, "脚本字符串里的 <img> 不算数");
});

test("HTML 注释里的标签同样不算数", () => {
  assert.equal(extractTitle("<!-- <title>注释里的</title> --><title>真的</title>"), "真的");
});

test("meta 的属性顺序两种都要认", () => {
  assert.equal(extractMetaByName('<meta name="description" content="A">', "description"), "A");
  assert.equal(extractMetaByName('<meta content="B" name="description">', "description"), "B");
  assert.equal(extractMetaByProperty('<meta content="C" property="og:title">', "og:title"), "C");
});

test("实体被解码，空白被压平", () => {
  assert.equal(extractTitle("<title>  A &amp;\n  B  </title>"), "A & B");
});

test("多个 title 只取第一个（浏览器也只认第一个）", () => {
  assert.equal(extractTitle("<title>一</title><title>二</title>"), "一");
});

// ---------------------------------------------------------------------------
// title / description
// ---------------------------------------------------------------------------

test("缺 title 判 fail，并说明后果", () => {
  const r = byId(run("<html><head></head><body></body></html>"), "metadata.title");
  assert.equal(r.verdict, "fail");
  assert.match(r.limitation, /引擎会自行拼凑/);
});

test("title 长度按**字符数**判，且 limitation 必须承认这是近似", () => {
  // Google 按像素宽度截断，中文字符更宽。把近似说成精确，正是这个工具
  // 最不该犯的错——所以超限时必须带上这句说明。
  const long = byId(run(`<title>${"标".repeat(50)}</title>`), "metadata.title");
  assert.equal(long.verdict, "warn");
  assert.match(long.limitation, /近似/);
  assert.match(long.limitation, /像素宽度/);

  const good = byId(run("<title>妙蛙 GEO 海外搜索可见性检测</title>"), "metadata.title");
  assert.equal(good.verdict, "pass");
  assert.equal(good.limitation, null, "合格时不该编一条限制说明出来");
});

test("缺 description 判 fail：摘录内容不受站点控制", () => {
  const r = byId(run("<title>x</title>"), "metadata.description");
  assert.equal(r.verdict, "fail");
  assert.match(r.limitation, /不受站点控制/);
});

// ---------------------------------------------------------------------------
// h1
// ---------------------------------------------------------------------------

test("无 h1 → fail；唯一 h1 → pass；多个 h1 → warn 而不是 fail", () => {
  assert.equal(byId(run("<body></body>"), "metadata.h1").verdict, "fail");
  assert.equal(byId(run("<h1>唯一主题</h1>"), "metadata.h1").verdict, "pass");

  const multi = byId(run("<h1>A</h1><h1>B</h1>"), "metadata.h1");
  assert.equal(multi.verdict, "warn", "HTML5 允许多个 H1，判 fail 是把规范说错了");
  assert.match(multi.limitation, /不是错误/);
});

test("空的 h1 不算数（常见于用 h1 做 logo 占位）", () => {
  assert.equal(byId(run("<h1>   </h1>"), "metadata.h1").verdict, "fail");
});

test("h1 里的内联标签被剥掉，只留文本", () => {
  assert.deepEqual(extractH1s("<h1>妙蛙 <span>GEO</span></h1>"), ["妙蛙 GEO"]);
});

// ---------------------------------------------------------------------------
// lang / hreflang —— 外贸站的命脉
// ---------------------------------------------------------------------------

test("缺 <html lang> → fail", () => {
  const r = byId(run("<html><body></body></html>"), "metadata.lang");
  assert.equal(r.verdict, "fail");
  assert.match(r.limitation, /多语言站/);
});

test("有 lang 时也要说明我们没核对它与正文是否一致", () => {
  const r = byId(run('<html lang="en"><body>中文内容</body></html>'), "metadata.lang");
  assert.equal(r.verdict, "pass");
  assert.match(r.limitation, /未核对/, "声明了 en 而正文是中文，我们查不出来——必须说清楚");
});

test("**无 hreflang 判 warn 不判 fail**：单语言站没有它是完全正确的", () => {
  // 我们从一个页面无法判断这个站到底有没有多语言版本。
  // 判 fail 等于对所有单语言站扣一个莫须有的分。
  const r = byId(run("<html lang='en'></html>"), "metadata.hreflang");
  assert.equal(r.verdict, "warn");
  assert.match(r.limitation, /单语言站点无需 hreflang/);
});

test("有 hreflang 但缺 x-default → warn；齐全 → pass", () => {
  const partial = byId(run(`
    <link rel="alternate" hreflang="en" href="/en">
    <link rel="alternate" hreflang="zh" href="/zh">`), "metadata.hreflang");
  assert.equal(partial.verdict, "warn");
  assert.match(partial.limitation, /x-default/);

  const full = byId(run(`
    <link rel="alternate" hreflang="en" href="/en">
    <link rel="alternate" hreflang="x-default" href="/">`), "metadata.hreflang");
  assert.equal(full.verdict, "pass");
  assert.match(full.limitation, /双向一致性/, "我们没核对互指，必须说明");
});

test("hreflang 大小写归一（en-US 与 en-us 是同一个）", () => {
  assert.deepEqual(
    extractHreflangs('<link rel="alternate" hreflang="en-US"><link rel="alternate" hreflang="X-Default">'),
    ["en-us", "x-default"],
  );
});

// ---------------------------------------------------------------------------
// viewport
// ---------------------------------------------------------------------------

test("viewport 必须含 width=device-width，光有 meta 不算", () => {
  assert.equal(hasResponsiveViewport('<meta name="viewport" content="width=1024">'), false);
  assert.equal(hasResponsiveViewport('<meta name="viewport" content="width=device-width, initial-scale=1">'), true);

  const r = byId(run('<meta name="viewport" content="width=1024">'), "metadata.viewport");
  assert.equal(r.verdict, "fail");
  assert.match(r.limitation, /索引以移动端为准/);
});

// ---------------------------------------------------------------------------
// Open Graph
// ---------------------------------------------------------------------------

test("OG 全缺 → fail；部分缺 → warn 并点名缺哪个；齐全 → pass", () => {
  assert.equal(byId(run("<head></head>"), "metadata.og").verdict, "fail");

  const partial = byId(run('<meta property="og:title" content="A">'), "metadata.og");
  assert.equal(partial.verdict, "warn");
  assert.match(partial.limitation, /og:description/);
  assert.match(partial.limitation, /og:image/);

  const full = byId(run(`
    <meta property="og:title" content="A">
    <meta property="og:description" content="B">
    <meta property="og:image" content="/x.png">`), "metadata.og");
  assert.equal(full.verdict, "pass");
});

// ---------------------------------------------------------------------------
// 图片 alt
// ---------------------------------------------------------------------------

test('**alt="" 算已声明**——那是装饰性图片的正确写法，不是遗漏', () => {
  // 判成缺失等于让做对的人被扣分。
  assert.deepEqual(imgAltCoverage('<img src=a alt=""><img src=b alt="说明">'), { total: 2, withAlt: 2 });
  assert.equal(byId(run('<img src=a alt=""><img src=b alt="x">'), "metadata.img-alt").verdict, "pass");
});

test("覆盖率分三档，且文案里给出真实分子分母", () => {
  const html = (n, withAlt) =>
    Array.from({ length: n }, (_, i) => (i < withAlt ? '<img src=x alt="a">' : "<img src=x>")).join("");
  assert.equal(byId(run(html(10, 10)), "metadata.img-alt").verdict, "pass");
  assert.equal(byId(run(html(10, 7)), "metadata.img-alt").verdict, "warn");
  assert.equal(byId(run(html(10, 3)), "metadata.img-alt").verdict, "fail");
  assert.match(byId(run(html(10, 7)), "metadata.img-alt").observation, /10 个.*7 个.*70%/);
});

test("页面没有 img 时判 no_data，**既不是通过也不是失败**", () => {
  // 判 pass 会凭空造出一个「做得好」，判 fail 会凭空造出一个问题。
  const r = byId(run("<body>纯文字</body>"), "metadata.img-alt");
  assert.equal(r.state, "no_data");
  assert.equal(r.verdict, null);
  assert.match(r.limitation, /JavaScript 注入/, "要说明我们看不到脚本注入的图片");
});

// ---------------------------------------------------------------------------
// 抓不到页面时
// ---------------------------------------------------------------------------

test("抓不到页面时八项全部按对方侧原因记，且文案各不相同", () => {
  const outcome = { ok: false, status: 429, headers: {}, body: null, finalUrl: "https://x.example/", reason: "throttled" };
  const rs = htmlMetaChecks(outcome, "https://x.example/");
  assert.equal(rs.length, 8);
  for (const r of rs) {
    assert.notEqual(r.state, "ready");
    assert.equal(r.verdict, null, "非 ready 的项不得带 verdict");
  }
  const texts = new Set(rs.map((r) => r.observation));
  assert.equal(texts.size, 8, "八项要有八段不同的文案，不得坍缩成同一句「未测到」");
});

test("八项恒为 scored，且恒在 metadata 组", () => {
  for (const input of [run("<html lang='en'><title>x</title></html>"), htmlMetaChecks({ ok: false, reason: "timeout", body: null }, "u")]) {
    assert.equal(input.length, 8);
    for (const r of input) {
      assert.equal(r.scored, true, `${r.id} 的计分性必须是固有属性`);
      assert.equal(r.group, "metadata");
    }
  }
});

// ---------------------------------------------------------------------------
// 这一组存在的理由：让报告不再一片绿
// ---------------------------------------------------------------------------

test("一个「什么都没配」的站点，这八项会真的暴露问题", () => {
  // 这正是补这一组的目的。一个裸 HTML 页面此前在我们的报告里几乎全绿
  // （因为 robots.txt 没拦人 = 9 项通过），现在会如实暴露出缺失。
  const bare = "<html><body><p>hello</p></body></html>";
  const rs = run(bare);
  const bad = rs.filter((r) => r.verdict === "fail" || r.verdict === "warn");
  assert.ok(bad.length >= 6, `裸页面应暴露至少 6 项问题，实测 ${bad.length}：${rs.map((r) => r.id + "=" + r.verdict).join(", ")}`);
});
