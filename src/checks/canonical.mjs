import { checkResult } from "../types.mjs";
import { outcomeToState, OK } from "./fetch-outcome.mjs";

/**
 * 「自指」判定前必须做的规范化（设计文档第六节 2a）：小写 host、丢弃查询串、去尾部斜杠。
 * 不做这一步，`https://x.com/a` 与 `https://x.com/a/` 会被判成指向他页——
 * 这跟本工具在 robots partial 判定上已经明确拒绝过的假阳性是同一类错误：
 * 把「写法不同」误判成「配置不同」。
 *
 * 协议（http/https）刻意不参与归一化：设计文档只列了这三条规则，页面若真的把
 * canonical 指向另一个协议，那是一个值得呈现的事实，不该被悄悄抹平。
 */
function normalize(urlString) {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${url.protocol}//${host}${pathname}`;
  } catch {
    return null;
  }
}

/** `<link rel="canonical" href="...">`，属性顺序不定，分别在整个标签内查找。 */
function extractCanonicalHref(html) {
  const tags = String(html ?? "").match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/rel\s*=\s*["']canonical["']/i.test(tag)) continue;
    const match = tag.match(/href\s*=\s*["']([^"']*)["']/i);
    if (match) return match[1];
  }
  return null;
}

/** `<meta name="robots" content="...">`，同样不假设属性顺序。 */
function extractMetaRobotsContent(html) {
  const tags = String(html ?? "").match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/name\s*=\s*["']robots["']/i.test(tag)) continue;
    const match = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * noindex 有两个独立来源：meta robots（HTML 内）与 X-Robots-Tag（响应头）。
 * headers 可能不存在（旧 fixture、上游未接好），用可选链让它退化为「没有」而不是抛错。
 */
function hasNoindex(html, headers) {
  const meta = extractMetaRobotsContent(html);
  if (meta && /noindex/i.test(meta)) return true;
  const xRobotsTag = headers?.["x-robots-tag"];
  return Boolean(xRobotsTag && /noindex/i.test(xRobotsTag));
}

/**
 * 片段级抑制指令：页面进得了索引，但**没有一句话可以被摘录**。
 *
 * ---------------------------------------------------------------------------
 * 为什么它值得和 noindex 分开、单独计一分
 *
 * `noindex` 的后果是「整页从索引里消失」——很显眼，几乎所有 SEO 工具都查。
 * `nosnippet` 的后果是「页面在索引里，但任何摘要、任何引用片段都不许展示」。
 * 对传统 SEO，这只是搜索结果里少一行描述；**对 GEO 这是致命的**——
 * 生成式引擎的引用，本质就是摘录一段话。不许摘录，等于不可能被引用。
 *
 * 正因为它在传统 SEO 里看起来无关痛痒，**从来没人查**。这是本工具此前
 * 二十七项里最明显的一个缺口。
 *
 * ---------------------------------------------------------------------------
 * 四种写法，效果不同
 *
 *   nosnippet          完全不许展示文本片段
 *   max-snippet:0      等同 nosnippet
 *   max-snippet:N      片段最多 N 个字符（N 很小时几乎等于禁用）
 *   noarchive/nocache  不保留缓存副本，影响间接取用
 *   data-nosnippet     HTML 属性，**逐块**抑制——最阴险的一种
 *
 * `data-nosnippet` 常被用来遮价格或时间戳，而一个没收好的 `<div>` 就能把正文
 * 主体整个包进去。所以这里不只看它存不存在，还要统计包了多少个元素。
 */
const SNIPPET_SOURCES = ["meta robots", "X-Robots-Tag"];

function collectRobotsDirectives(html, headers) {
  const meta = extractMetaRobotsContent(html) ?? "";
  const header = String(headers?.["x-robots-tag"] ?? "");
  return { meta: meta.toLowerCase(), header: header.toLowerCase() };
}

/** 数出 data-nosnippet 包了多少个元素。属性形态多样，只认属性名本身。 */
function countDataNosnippet(html) {
  return (String(html ?? "").match(/\sdata-nosnippet(?=[\s/>=])/gi) ?? []).length;
}

function snippetCheck(outcome, pageUrl) {
  const state = outcomeToState(outcome);
  if (state !== OK) {
    return checkResult({
      id: "access.snippet",
      group: "access",
      scored: true,
      state: state.state,
      reason: state.reason,
      observation: `${state.observation}片段抑制指令未测。`,
      evidence: { url: pageUrl },
    });
  }

  const html = outcome.body;
  const { meta, header } = collectRobotsDirectives(html, outcome.headers);
  const both = `${meta} ${header}`;

  const hits = [];
  if (/\bnosnippet\b/.test(both)) hits.push("nosnippet");
  const maxSnippet = both.match(/\bmax-snippet\s*:\s*(-?\d+)/);
  // max-snippet:-1 是「不限制」，是默认值，不算抑制。
  if (maxSnippet && Number(maxSnippet[1]) >= 0) hits.push(`max-snippet:${maxSnippet[1]}`);
  if (/\bnoarchive\b|\bnocache\b/.test(both)) hits.push("noarchive");
  const blocks = countDataNosnippet(html);

  const where = [meta && "meta robots", header && "X-Robots-Tag"].filter(Boolean).join(" 与 ");
  void SNIPPET_SOURCES;

  // 完全禁摘 → fail；限长或仅缓存限制 → warn；只有 data-nosnippet → warn。
  const blocksAll = hits.includes("nosnippet") || hits.some((h) => h === "max-snippet:0");
  if (blocksAll) {
    return checkResult({
      id: "access.snippet",
      group: "access",
      scored: true,
      state: "ready",
      verdict: "fail",
      observation: `页面声明了 ${hits.join("、")}（来自 ${where}），任何文本片段都不许被展示。`,
      limitation:
        "**页面仍然可以被收录，只是没有一句话可以被摘录。** 生成式引擎的引用本质就是摘录，" +
        "所以这一条对能不能被 AI 引用是决定性的，而它在传统 SEO 的报告里几乎看不出来。",
      evidence: { url: pageUrl, directives: hits, dataNosnippetBlocks: blocks },
    });
  }

  if (hits.length > 0 || blocks > 0) {
    const parts = [];
    if (hits.length > 0) parts.push(`${hits.join("、")}（来自 ${where}）`);
    if (blocks > 0) parts.push(`页面里有 ${blocks} 处 data-nosnippet 属性，被包住的内容不会被摘录`);
    return checkResult({
      id: "access.snippet",
      group: "access",
      scored: true,
      state: "ready",
      verdict: "warn",
      observation: `页面对可摘录内容做了限制：${parts.join("；")}。`,
      limitation:
        "限长与逐块抑制都是合理用法（遮价格、遮时间戳）。**要确认的是它有没有误伤正文**——" +
        "一个没收好的标签能把整段正文包进去，而页面在浏览器里看起来毫无异样。" +
        "本工具只统计出现次数，不判断它到底包住了什么。",
      evidence: { url: pageUrl, directives: hits, dataNosnippetBlocks: blocks },
    });
  }

  return checkResult({
    id: "access.snippet",
    group: "access",
    scored: true,
    state: "ready",
    verdict: "pass",
    observation: "未发现片段抑制指令，页面内容可以被正常摘录与引用。",
    evidence: { url: pageUrl, directives: [], dataNosnippetBlocks: 0 },
  });
}

/**
 * 产出 access.canonical 与 access.noindex 两条 scored 结果。
 *
 * 页面抓取失败时两条一律 no_data，**不对 404 特判**：与 robots.txt / sitemap.xml 不同，
 * 页面本身 404 只说明「这次没取到页面」，不是「该站没有 canonical」这种可断言的事实——
 * 后者需要先拿到页面才能判断。
 */
export function canonicalChecks(outcome, pageUrl) {
  const state = outcomeToState(outcome);
  if (state !== OK) {
    return [
      checkResult({ id: "access.canonical", group: "access", scored: true, state: state.state, reason: state.reason, observation: `${state.observation}canonical 未测。`, evidence: { url: pageUrl } }),
      checkResult({ id: "access.noindex", group: "access", scored: true, state: state.state, reason: state.reason, observation: `${state.observation}noindex 未测。`, evidence: { url: pageUrl } }),
      snippetCheck(outcome, pageUrl),
    ];
  }

  const html = outcome.body;
  const href = extractCanonicalHref(html);

  let canonicalVerdict;
  let canonicalObservation;
  if (!href) {
    canonicalVerdict = "fail";
    canonicalObservation = "页面未声明 canonical 标签。";
  } else {
    let resolved;
    try { resolved = new URL(href, pageUrl).toString(); } catch { resolved = href; }
    const normalizedTarget = normalize(resolved);
    const selfReferencing = normalizedTarget !== null && normalizedTarget === normalize(pageUrl);
    canonicalVerdict = selfReferencing ? "pass" : "warn";
    canonicalObservation = selfReferencing
      ? `canonical 自指本页（${resolved}）。`
      : `canonical 指向另一个地址：${resolved}。`;
  }

  const noindex = hasNoindex(html, outcome.headers);
  const noindexVerdict = noindex ? "fail" : "pass";
  const noindexObservation = noindex
    ? "页面通过 meta robots 或 X-Robots-Tag 声明了 noindex，会被搜索引擎排除收录。"
    : "未发现 noindex 声明（meta robots 与 X-Robots-Tag 均未阻止收录）。";

  return [
    checkResult({
      id: "access.canonical",
      group: "access",
      scored: true,
      state: "ready",
      verdict: canonicalVerdict,
      observation: canonicalObservation,
      evidence: { url: pageUrl, canonical: href },
    }),
    checkResult({
      id: "access.noindex",
      group: "access",
      scored: true,
      state: "ready",
      verdict: noindexVerdict,
      observation: noindexObservation,
      evidence: { url: pageUrl, xRobotsTag: outcome.headers?.["x-robots-tag"] ?? null },
    }),
    snippetCheck(outcome, pageUrl),
  ];
}
