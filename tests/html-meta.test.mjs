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
import { displayWidth } from "../src/checks/html-text.mjs";

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

test("title 超限时 limitation 必须承认宽度折算仍是近似", () => {
  // Google 按像素宽度截断，我们按「全角 2 / 半角 1」折算——比纯字符数
  // 准得多，但仍是近似（比例字体下 i 和 W 也不一样宽）。
  // 把近似说成精确，正是这个工具最不该犯的错——所以超限时必须带上说明。
  const long = byId(run(`<title>${"标".repeat(50)}</title>`), "metadata.title");
  assert.equal(long.verdict, "warn");
  assert.match(long.limitation, /近似/);
  assert.match(long.limitation, /像素宽度/);

  const good = byId(run("<title>妙蛙 GEO 海外搜索可见性检测</title>"), "metadata.title");
  assert.equal(good.verdict, "pass");
  assert.equal(good.limitation, null, "合格时不该编一条限制说明出来");
});

test("长度按**视觉宽度**折算：全角计 2、半角计 1、组合标记计 0", () => {
  // Google 按像素宽度截断，中文字符约是拉丁字符的两倍宽。
  // 折算后同一套上限对两种文字都成立：60 半角单位 ≈ 中文 30 字 ≈ 英文 60 字符——
  // 这正是 explain.mjs 里中英文建议（30 字 / 60 characters）各自的数字。
  assert.equal(displayWidth("abcde"), 5);
  assert.equal(displayWidth("中文标题"), 8);
  assert.equal(displayWidth("Acme阀门"), 8, "混排：4 半角 + 2 全角");
  assert.equal(displayWidth("，。"), 4, "全角标点也是全角宽");

  // 组合标记不占宽。NFD 形态的重音、越南语声调若各计 1，
  // 一个正常长度的越南语标题会被凭空推过上限。
  assert.equal(displayWidth("Café".normalize("NFD")), 4, "分解形态与合成形态同宽");
  assert.equal(displayWidth("Café".normalize("NFC")), 4);
  assert.equal(displayWidth("👨‍👩‍👧"), 6, "ZWJ 计 0；仍是近似（实际约 2），但不再把连接符也算进去");
});

test("正常长度的英文标题不得再被判 warn（issue #1）", () => {
  // 60 个拉丁字符的标题在搜索结果里不会被截断。旧实现按字符数
  // 与中文共用 30 的上限，等于给所有写得规范的英文站各扣一个莫须有的 warn。
  const title = "Acme Stainless Steel Pipe Supplier | ISO 9001 Certified"; // 56 字符
  const r = byId(run(`<title>${title}</title>`), "metadata.title");
  assert.equal(r.verdict, "pass", `56 个拉丁字符应为 pass，实得 ${r.verdict}：${r.limitation}`);

  // 真正过长的英文标题（>60 半角单位）仍要如实警告。
  const long = byId(run(`<title>${"word ".repeat(16)}end</title>`), "metadata.title");
  assert.equal(long.verdict, "warn");
});

test("下限按**字符数**判，不随宽度翻倍（评审发现的反向误报）", () => {
  // 下限量的是「说没说清主题」这个信息量，不是像素——中文每字信息
  // 密度更高，同一字符数下限对两种文字同样成立。若下限也按宽度折算，
  // 已发布案例 03 里 12 字符的正常英文标题「home - Kutuo」会从 pass
  // 翻成 warn，在下界复刻 issue #1。
  assert.equal(byId(run("<title>home - Kutuo</title>"), "metadata.title").verdict, "pass");
  assert.equal(byId(run(`<meta name="description" content="${"x".repeat(53)}"><title>t</title>`), "metadata.description").verdict, "pass", "53 字符英文描述沿旧口径 pass");
});

test("纯中文标题的判定边界与旧实现完全一致", () => {
  assert.equal(byId(run(`<title>${"标".repeat(30)}</title>`), "metadata.title").verdict, "pass", "30 个全角 = 60 单位，恰在上限");
  assert.equal(byId(run(`<title>${"标".repeat(31)}</title>`), "metadata.title").verdict, "warn");
  assert.equal(byId(run(`<title>${"标".repeat(10)}</title>`), "metadata.title").verdict, "pass", "10 个字符，恰在下限");
  assert.equal(byId(run(`<title>${"标".repeat(9)}</title>`), "metadata.title").verdict, "warn");
});

test("description 上限校准到 160 单位：英文 160 字符、中文 80 字", () => {
  // 英文侧：explain.mjs 的建议是 roughly 150 characters，150 必须 pass。
  const en = "A".repeat(150);
  assert.equal(byId(run(`<meta name="description" content="${en}">`), "metadata.description").verdict, "pass");
  const enLong = "A".repeat(161);
  assert.equal(byId(run(`<meta name="description" content="${enLong}">`), "metadata.description").verdict, "warn");

  // 中文侧：这是本次**有意收紧**的一处——旧上限 120 字远超搜索结果的
  // 实际展示（70–90 字），explain.mjs 自己的建议也是 70–80 字。
  // 维持 120 等于对中文站把话说满。
  assert.equal(byId(run(`<meta name="description" content="${"描".repeat(80)}">`), "metadata.description").verdict, "pass", "80 全角 = 160 单位，恰在上限");
  assert.equal(byId(run(`<meta name="description" content="${"描".repeat(81)}">`), "metadata.description").verdict, "warn");
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
