import { checkResult } from "../types.mjs";
import { outcomeToState, OK } from "./fetch-outcome.mjs";
import { stripNoise, displayWidth } from "./html-text.mjs";

/**
 * 基础技术 SEO：页面元信息与国际化。**纯函数，输入已抓到的 HTML。**
 *
 * ---------------------------------------------------------------------------
 * 为什么补这一组
 *
 * 2026-08-07 用真实站点复盘时发现：18 个计分项里有 **9 个是爬虫准入**
 * （`robots.txt 未限制 X 抓取本站`，文案只换名字），占一半。而
 * **「没有拦你」是互联网的默认状态**——一个从没碰过 robots.txt 的站全绿。
 * 于是任何站点打开都是一片绿，真正的问题被淹没。
 *
 * 光折叠呈现不够，根子是**检测项的构成**：任何 SEO 工具的第一屏内容——
 * title、description、h1、lang、hreflang、Open Graph、viewport、图片 alt——
 * 我们一项都没查。
 *
 * 这八项全部能从**已经抓到的页面 HTML** 里判定：不多发一次请求、
 * 不增加对方站点负担、不动任何超时预算。
 *
 * ---------------------------------------------------------------------------
 * 阈值的来源，以及为什么它只是近似
 *
 * title 与 description 的长度区间来自 Google 搜索结果的实际截断行为，
 * 而 Google 截断按**像素宽度**算，不按字符数——中文字符约是拉丁字符的两倍宽。
 *
 * 最初的实现直接数字符、阈值按中文校准（标题上限 30），于是一个 56 字符的
 * 正常英文标题会被系统性判 warn——对以英文站为主的外贸客户，这是打在
 * 核心场景上的误报（GitHub issue #1）。
 *
 * 修法是把**上限**换成按显示宽度（html-text.mjs 的 displayWidth，
 * 全角计 2、半角计 1）比较：截断是物理现象，量的就该是宽度。
 * 60 单位 ≈ 中文 30 字 ≈ 英文 60 字符，与 explain.mjs 中英文各自的
 * 建议数字一致。**下限保持按字符数**：下限量的是「说没说清主题」这个
 * 信息量，中文每字信息密度更高，同一字符数下限对两种文字同样成立——
 * 若把下限也按宽度翻倍，12 字符的正常英文标题（如已发布案例 03 的
 * "home - Kutuo"）会在下界产生与 issue #1 同类的新误报。
 *
 * 折算后仍是近似——比例字体下同为半角的 i 和 W 宽度并不相同。
 * **不要把近似说成精确**，那正是这个工具最不能犯的错。
 */

// ---------------------------------------------------------------------------
// 解析
//
// 一律先剥掉 script/style/注释（html-text.mjs 的 stripNoise）再解析。
// 顺序很重要：脚本里常有含 `<title>` 或 `<img>` 字样的模板字符串，
// 先去噪才不会把它们当成页面内容。
// ---------------------------------------------------------------------------

function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** `<title>` 的文本。取第一个——多个 title 时浏览器也只认第一个。 */
export function extractTitle(html) {
  const m = stripNoise(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : null;
}

/** 取某个 `<meta name="...">` 的 content。属性顺序两种都要认。 */
export function extractMetaByName(html, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const s = stripNoise(html);
  const m =
    s.match(new RegExp(`<meta[^>]*\\bname\\s*=\\s*["']${esc}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`, "i")) ??
    s.match(new RegExp(`<meta[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\bname\\s*=\\s*["']${esc}["']`, "i"));
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : null;
}

/** 取某个 `<meta property="og:...">` 的 content。 */
export function extractMetaByProperty(html, property) {
  const esc = String(property).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const s = stripNoise(html);
  const m =
    s.match(new RegExp(`<meta[^>]*\\bproperty\\s*=\\s*["']${esc}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`, "i")) ??
    s.match(new RegExp(`<meta[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\bproperty\\s*=\\s*["']${esc}["']`, "i"));
  return m ? decodeEntities(m[1]).trim() : null;
}

/** `<html lang="...">`。 */
export function extractHtmlLang(html) {
  const m = stripNoise(html).match(/<html[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  return m ? m[1].trim() : null;
}

/** 全部 `<h1>` 的文本。 */
export function extractH1s(html) {
  return [...stripNoise(html).matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
    decodeEntities(m[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  );
}

/** 全部 hreflang 声明（`<link rel="alternate" hreflang="...">`）。 */
export function extractHreflangs(html) {
  return [...stripNoise(html).matchAll(/<link[^>]*\brel\s*=\s*["']alternate["'][^>]*>/gi)]
    .map((m) => m[0].match(/\bhreflang\s*=\s*["']([^"']+)["']/i))
    .filter(Boolean)
    .map((m) => m[1].trim().toLowerCase());
}

/** `<meta name="viewport">` 是否声明了响应式宽度。 */
export function hasResponsiveViewport(html) {
  const content = extractMetaByName(html, "viewport");
  return content ? /width\s*=\s*device-width/i.test(content) : false;
}

/**
 * 统计 `<img>` 的 alt 覆盖率。
 *
 * `alt=""` 算**已声明**——那是「装饰性图片」在规范里的正确写法。
 * 把它算成缺失，等于让做对的人被扣分。
 */
export function imgAltCoverage(html) {
  const imgs = [...stripNoise(html).matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const withAlt = imgs.filter((tag) => /\balt\s*=\s*(["'])[\s\S]*?\1/i.test(tag)).length;
  return { total: imgs.length, withAlt };
}

// ---------------------------------------------------------------------------
// 检查项
// ---------------------------------------------------------------------------

// 下限单位是**字符数**（量信息量，两种文字同一口径，沿用旧值）；
// 上限单位是**半角字符宽度**（displayWidth，量物理截断）。
// 标题上限 60 单位 ≈ 中文 30 字 ≈ 英文 60 字符。
// 描述上限 160 单位 ≈ 中文 80 字 ≈ 英文 160 字符——旧实现允许中文到
// 120 字，但搜索结果对中文摘要的实际展示只有 70–90 字，explain.mjs 的
// 建议也是 70–80 字，旧上限本身把话说满了，这里一并校准。
const TITLE_MIN_CHARS = 10;
const TITLE_MAX_WIDTH = 60;
const DESC_MIN_CHARS = 50;
const DESC_MAX_WIDTH = 160;

const GROUP = "metadata";
const LENGTH_CAVEAT =
  "宽度按「全角计 2、半角计 1」近似折算，Google 实际按像素宽度截断，比例字体下同为半角的字符宽度也不同。";

function unavailable(id, state, suffix, url) {
  return checkResult({
    id,
    group: GROUP,
    scored: true,
    state: state.state,
    reason: state.reason,
    observation: `${state.observation}${suffix}`,
    evidence: { url },
  });
}

/**
 * @param {object} outcome safeFetch 的完整结果（不是裸 HTML）
 * @param {string} pageUrl
 * @returns {object[]} CheckResult[]
 */
export function htmlMetaChecks(outcome, pageUrl) {
  const state = outcomeToState(outcome);
  if (state !== OK) {
    // 拿不到页面时八项全部按同一个原因记，且**保持各自不同的文案**——
    // 「四种失败原因产出四段不同文案」这条原则在这里同样适用。
    return [
      unavailable("metadata.title", state, "页面标题未测。", pageUrl),
      unavailable("metadata.description", state, "页面描述未测。", pageUrl),
      unavailable("metadata.h1", state, "H1 结构未测。", pageUrl),
      unavailable("metadata.lang", state, "语言声明未测。", pageUrl),
      unavailable("metadata.hreflang", state, "hreflang 未测。", pageUrl),
      unavailable("metadata.viewport", state, "移动端视口未测。", pageUrl),
      unavailable("metadata.og", state, "Open Graph 未测。", pageUrl),
      unavailable("metadata.img-alt", state, "图片替代文本未测。", pageUrl),
    ];
  }

  const html = outcome.body;
  const evidence = { url: pageUrl };
  return [
    titleCheck(html, evidence),
    descriptionCheck(html, evidence),
    h1Check(html, evidence),
    langCheck(html, evidence),
    hreflangCheck(html, evidence),
    viewportCheck(html, evidence),
    ogCheck(html, evidence),
    imgAltCheck(html, evidence),
  ];
}

function titleCheck(html, evidence) {
  const title = extractTitle(html);
  if (!title) {
    return checkResult({
      id: "metadata.title", group: GROUP, scored: true, state: "ready", verdict: "fail",
      observation: "页面未声明 <title>。",
      limitation: "标题是搜索结果与 AI 引用时最先被读到的文本，缺失时引擎会自行拼凑。",
      evidence,
    });
  }
  const n = [...title].length;
  const width = displayWidth(title);
  const verdict = n >= TITLE_MIN_CHARS && width <= TITLE_MAX_WIDTH ? "pass" : "warn";
  return checkResult({
    id: "metadata.title", group: GROUP, scored: true, state: "ready", verdict,
    observation: `页面标题共 ${n} 个字符，宽度约合 ${width} 个半角字符：「${title.slice(0, 60)}${title.length > 60 ? "…" : ""}」`,
    limitation:
      verdict === "pass"
        ? null
        : n < TITLE_MIN_CHARS
          ? `短于 ${TITLE_MIN_CHARS} 个字符，可能不足以说明页面主题。`
          : `宽度超过 ${TITLE_MAX_WIDTH} 个半角字符（约合中文 ${TITLE_MAX_WIDTH / 2} 字或英文 ${TITLE_MAX_WIDTH} 字符），在搜索结果中可能被截断。${LENGTH_CAVEAT}`,
    evidence,
  });
}

function descriptionCheck(html, evidence) {
  const desc = extractMetaByName(html, "description");
  if (!desc) {
    return checkResult({
      id: "metadata.description", group: GROUP, scored: true, state: "ready", verdict: "fail",
      observation: "页面未声明 meta description。",
      limitation: "缺失时搜索引擎会从正文中自行摘录，摘出哪一段不受站点控制。",
      evidence,
    });
  }
  const n = [...desc].length;
  const width = displayWidth(desc);
  const verdict = n >= DESC_MIN_CHARS && width <= DESC_MAX_WIDTH ? "pass" : "warn";
  return checkResult({
    id: "metadata.description", group: GROUP, scored: true, state: "ready", verdict,
    observation: `meta description 共 ${n} 个字符，宽度约合 ${width} 个半角字符。`,
    limitation:
      verdict === "pass"
        ? null
        : n < DESC_MIN_CHARS
          ? `短于 ${DESC_MIN_CHARS} 个字符，可能不足以概括页面内容。`
          : `宽度超过 ${DESC_MAX_WIDTH} 个半角字符（约合中文 ${DESC_MAX_WIDTH / 2} 字或英文 ${DESC_MAX_WIDTH} 字符），超出部分在搜索结果中不会展示。${LENGTH_CAVEAT}`,
    evidence,
  });
}

function h1Check(html, evidence) {
  const h1s = extractH1s(html).filter((t) => t.length > 0);
  if (h1s.length === 0) {
    return checkResult({
      id: "metadata.h1", group: GROUP, scored: true, state: "ready", verdict: "fail",
      observation: "页面未发现非空的 <h1>。",
      limitation: "H1 是页面主题的结构化声明，缺失时机器只能从正文推断。",
      evidence,
    });
  }
  if (h1s.length > 1) {
    return checkResult({
      id: "metadata.h1", group: GROUP, scored: true, state: "ready", verdict: "warn",
      observation: `页面有 ${h1s.length} 个 <h1>。`,
      limitation: "HTML5 允许多个 H1，但多个同级主标题会让「这一页讲什么」变得含糊。这是结构信号，不是错误。",
      evidence,
    });
  }
  return checkResult({
    id: "metadata.h1", group: GROUP, scored: true, state: "ready", verdict: "pass",
    observation: `页面有唯一的 <h1>：「${h1s[0].slice(0, 50)}${h1s[0].length > 50 ? "…" : ""}」`,
    evidence,
  });
}

function langCheck(html, evidence) {
  const lang = extractHtmlLang(html);
  if (!lang) {
    return checkResult({
      id: "metadata.lang", group: GROUP, scored: true, state: "ready", verdict: "fail",
      observation: "<html> 未声明 lang 属性。",
      limitation: "语言声明是搜索引擎与 AI 判断内容语言的首要信号，对多语言站尤其关键。",
      evidence,
    });
  }
  return checkResult({
    id: "metadata.lang", group: GROUP, scored: true, state: "ready", verdict: "pass",
    observation: `<html lang="${lang}">。`,
    limitation: "本工具只检查是否声明，未核对声明的语言与正文实际语言是否一致。",
    evidence,
  });
}

function hreflangCheck(html, evidence) {
  const tags = extractHreflangs(html);
  if (tags.length === 0) {
    // **单语言站没有 hreflang 是完全正确的**，所以是 warn 不是 fail——
    // 我们无法从一个页面判断这个站到底有没有多语言版本。
    return checkResult({
      id: "metadata.hreflang", group: GROUP, scored: true, state: "ready", verdict: "warn",
      observation: "页面未声明 hreflang。",
      limitation:
        "单语言站点无需 hreflang，此项可忽略。若站点有多语言版本，缺失 hreflang 会让各语言版本互相竞争同一批搜索结果。",
      evidence,
    });
  }
  const hasXDefault = tags.includes("x-default");
  const unique = [...new Set(tags)];
  return checkResult({
    id: "metadata.hreflang", group: GROUP, scored: true, state: "ready",
    verdict: hasXDefault ? "pass" : "warn",
    observation: `页面声明了 ${tags.length} 个 hreflang：${unique.slice(0, 8).join("、")}${unique.length > 8 ? " 等" : ""}。`,
    limitation: hasXDefault
      ? "本工具只检查声明是否存在，未核对各语言版本之间是否互相指回（双向一致性）。"
      : "未声明 x-default。缺少它时，语言与地区都不匹配的访问者由引擎自行挑选版本。",
    evidence,
  });
}

function viewportCheck(html, evidence) {
  if (!hasResponsiveViewport(html)) {
    return checkResult({
      id: "metadata.viewport", group: GROUP, scored: true, state: "ready", verdict: "fail",
      observation: "页面未声明响应式 viewport（width=device-width）。",
      limitation: "移动端会按桌面宽度渲染再整体缩放。Google 的索引以移动端为准，这会直接影响可用性评估。",
      evidence,
    });
  }
  return checkResult({
    id: "metadata.viewport", group: GROUP, scored: true, state: "ready", verdict: "pass",
    observation: "页面声明了响应式 viewport。",
    evidence,
  });
}

function ogCheck(html, evidence) {
  const present = [
    extractMetaByProperty(html, "og:title") && "og:title",
    extractMetaByProperty(html, "og:description") && "og:description",
    extractMetaByProperty(html, "og:image") && "og:image",
  ].filter(Boolean);

  if (present.length === 0) {
    return checkResult({
      id: "metadata.og", group: GROUP, scored: true, state: "ready", verdict: "fail",
      observation: "页面未声明 Open Graph 标签。",
      limitation: "被分享或被 AI 引用时，标题、摘要与配图由对方自行抓取，呈现效果不受站点控制。",
      evidence,
    });
  }
  if (present.length < 3) {
    const missing = ["og:title", "og:description", "og:image"].filter((k) => !present.includes(k));
    return checkResult({
      id: "metadata.og", group: GROUP, scored: true, state: "ready", verdict: "warn",
      observation: `Open Graph 不完整，已声明 ${present.join("、")}。`,
      limitation: `缺少 ${missing.join("、")}。`,
      evidence,
    });
  }
  return checkResult({
    id: "metadata.og", group: GROUP, scored: true, state: "ready", verdict: "pass",
    observation: "Open Graph 的标题、描述与配图均已声明。",
    evidence,
  });
}

function imgAltCheck(html, evidence) {
  const { total, withAlt } = imgAltCoverage(html);
  if (total === 0) {
    // 页面没有 img 时这项**不适用**——不是通过，也不是失败。
    // 判成 pass 会凭空造出一个「做得好」，判成 fail 会凭空造出一个问题。
    return checkResult({
      id: "metadata.img-alt", group: GROUP, scored: true, state: "no_data", reason: "not_applicable",
      observation: "页面中未发现 <img> 元素，图片替代文本不适用。",
      limitation: "若图片由 JavaScript 注入，本工具在不执行脚本的前提下看不到它们。",
      evidence,
    });
  }
  const pct = Math.round((withAlt / total) * 100);
  const verdict = pct >= 90 ? "pass" : pct >= 60 ? "warn" : "fail";
  return checkResult({
    id: "metadata.img-alt", group: GROUP, scored: true, state: "ready", verdict,
    observation: `${total} 个 <img> 中有 ${withAlt} 个声明了 alt（${pct}%）。`,
    limitation: 'alt="" 算作已声明——那是装饰性图片的正确写法。本工具不评价 alt 文本的质量，只看是否声明。',
    evidence,
  });
}
