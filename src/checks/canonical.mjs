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
  ];
}
