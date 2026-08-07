import { groupFor, parseRobots, pathAllowed } from "./checks/robots-parse.mjs";
import { robotsChecks } from "./checks/robots.mjs";
import { readabilityCheck } from "./checks/static-readability.mjs";
import { structuredChecks } from "./checks/structured-data.mjs";
import { htmlMetaChecks } from "./checks/html-meta.mjs";
import { canonicalChecks } from "./checks/canonical.mjs";
import { sitemapCheck } from "./checks/sitemap.mjs";
import { agentChannelChecks } from "./checks/agent-channels.mjs";

/**
 * 轻检查编排 —— 把网络层（safe-fetch）和纯检查函数（各 checks/*.mjs）缝合起来。
 *
 * 三条最容易做错、也是本模块存在的理由：
 *
 *   1. 产品令牌必须显式传 "MiaowaGEO-Audit"，不能图省事用 "*"。
 *      `groupFor()` 按 RFC 9309 §2.2.1 先找精确匹配我们自己的组，没有才回落到 `*`。
 *      若直接传 "*"，一个明确屏蔽了 MiaowaGEO-Audit、却放行 `*` 的站点会被判成允许，
 *      而故障矩阵里「该站 robots.txt 禁止本工具抓取此路径」这句话就成了没有依据的话。
 *
 *   2. Disallow 是按路径求值的，不是按站点。页面路径被禁不代表 /sitemap.xml 也被禁——
 *      本模块对页面 HTML、/sitemap.xml、/llms.txt、/agents.md、/.well-known/ucp
 *      这 5 个目标路径各自单独调用 pathAllowed()，只有页面路径被禁时才跳过页面抓取，
 *      其余四个路径照常发起真实请求。
 *
 *   3. 路径被禁时仍要产出结果，但不发真实请求：直接构造
 *      `{ ok:false, reason:"robots_disallowed" }` 交给对应的 check 模块，
 *      这样呈现给用户的文案走 fetch-outcome.mjs 的统一映射，不是编排层自己写一句话。
 *
 * `robots.txt` 本身永远真实抓取（它是规则的来源，不受自己判定的规则约束）。
 *
 * safeFetch 通过 deps 注入，测试用假实现替换，保证本模块的测试不联网、
 * 也不依赖 safe-fetch.mjs 自己的节流状态。
 */

// 出站产品令牌：必须与 safe-fetch.mjs 的 OUTBOUND_USER_AGENT 前缀一致，
// 否则「我们自己的专属分组」和「实际出网时报的身份」对不上，RFC 9309 匹配就没有意义。
export const PRODUCT_TOKEN = "MiaowaGEO-Audit";

// 三个时序预算，字面量取自设计文档第三节的时序预算表：
//   预飞 3s；robots.txt 3s；5 个目标路径各自 3.5s（与 safe-fetch 的默认单请求超时一致）。
//
// D1（2026-08-06 实测修正）：设计文档说预飞「独立计 3s、不占用轻量审计自身的预算」。
// **那与本文件的实现不符**——预飞就在 runLightAudit 内部（下面的 ①），
// 而 server.mjs 的硬超时包住的正是整个 runLightAudit，所以预飞**计入**预算。
// 真实最坏路径因此是 3.0 + 3.0 + 1.2 + 3.5 = 10.7s，而不是文档和旧注释说的 7.7s。
//
// 三个常量必须导出：server.mjs 的预算测试要拿它们**真的做一遍加法**，而不是
// 硬编码一个总数去比对。硬编码的断言在下次有人调这里任一个数值时不会变红——
// 那正是 D1 能一路活到首次真实部署才被发现的机制。
export const PREFLIGHT_TIMEOUT_MS = 3000;
export const ROBOTS_TIMEOUT_MS = 3000;
export const TARGET_TIMEOUT_MS = 3500;

// 5 个子请求之间是 4 个节流间隔（错开发起、并行等待，见下方 ⑤⑥）。
// 间隔本身不在本文件里，它是 safe-fetch 的 DEFAULT_THROTTLE_INTERVAL_MS，
// 由 throttleHost() 施加；这里只记录「几个间隔」这件编排层才知道的事。
export const TARGET_STAGGER_COUNT = 4;

/** 被 robots 禁止的路径不发真实请求，直接构造这个失败结果交给对应的 check。 */
function robotsDisallowedOutcome(url) {
  return Object.freeze({ ok: false, status: null, headers: {}, body: null, finalUrl: url, reason: "robots_disallowed" });
}

/**
 * 5 个目标路径：页面本身 + 4 个站点级文件。页面用 pathname（不含查询串）
 * 参与 robots 求值——`pathAllowed` 匹配的是路径语义，query 不参与 robots 规则。
 */
function buildTargets(baseUrl, pageUrl) {
  const pagePath = new URL(pageUrl).pathname || "/";
  return {
    page: { path: pagePath, url: pageUrl },
    sitemap: { path: "/sitemap.xml", url: `${baseUrl}/sitemap.xml` },
    llmsTxt: { path: "/llms.txt", url: `${baseUrl}/llms.txt` },
    agentsMd: { path: "/agents.md", url: `${baseUrl}/agents.md` },
    ucp: { path: "/.well-known/ucp", url: `${baseUrl}/.well-known/ucp` },
  };
}

/**
 * @param {string} submittedUrl 用户提交的原始 URL
 * @param {object} deps
 * @param {(url: string, options?: object) => Promise<object>} deps.safeFetch 唯一的出网入口，测试注入假实现
 * @returns {Promise<{baseUrl: string, finalUrl: string, results: object[], robotsAllowedPage: boolean}>}
 */
export async function runLightAudit(submittedUrl, deps = {}) {
  const { safeFetch } = deps;
  if (typeof safeFetch !== "function") {
    throw new TypeError("runLightAudit 需要通过 deps.safeFetch 注入抓取实现（测试用假实现，生产用 src/fetchers/safe-fetch.mjs）");
  }

  // ① 预飞规范化：GET 站点根，safeFetch 内部已经跟完重定向链，
  // 编排层只看得到最终结果——最终落地的主机是后续每一个子请求的基准。
  const preflight = await safeFetch(submittedUrl, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
  const finalUrl = preflight?.finalUrl ?? submittedUrl;
  const baseUrl = new URL(finalUrl).origin;

  // ② robots.txt：永远真实抓取，它是规则的来源，不受自己判定的规则约束。
  const robotsUrl = `${baseUrl}/robots.txt`;
  const robotsOutcome = await safeFetch(robotsUrl, { timeoutMs: ROBOTS_TIMEOUT_MS });

  // ③ 产品令牌优先；robots.txt 取不到或内容不可用时按「无规则 = 全部放行」处理，
  // 与 robots-parse.mjs 的既有约定一致（parseRobots 返回 null → groupFor 返回 null →
  // pathAllowed 默认放行）。
  const groups = robotsOutcome?.ok ? parseRobots(robotsOutcome.body) : null;
  const group = groupFor(groups, PRODUCT_TOKEN);

  // ④ 对 5 个目标路径各自求 pathAllowed —— 按路径独立求值，页面被禁不代表其余四个也被禁。
  const targets = buildTargets(baseUrl, finalUrl);
  const allowed = Object.fromEntries(
    Object.entries(targets).map(([key, { path }]) => [key, pathAllowed(group, path)]),
  );

  // ⑤ ⑥ 允许的路径并行发起、并行等待；被禁的路径不发请求，直接构造统一失败结果。
  // 用 Promise.all 而不是逐个 await：串行 await 在一个 1.5s RTT 的海外站点上会
  // 直接打穿轻检查的时间预算。
  const fetchedEntries = await Promise.all(
    Object.entries(targets).map(async ([key, { url }]) => {
      if (!allowed[key]) return [key, robotsDisallowedOutcome(url)];
      return [key, await safeFetch(url, { timeoutMs: TARGET_TIMEOUT_MS })];
    }),
  );
  const outcomes = Object.fromEntries(fetchedEntries);

  // ⑦ 六个 check 模块拼成 CheckResult[]。
  // structuredChecks 与其余 check 模块同形：接收 safeFetch 的完整 outcome，
  // 自己通过 fetch-outcome.mjs 区分失败原因，而不是编排层预先摘出 body
  // 把 429/超时/robots 禁止这些不同原因坍缩成同一个 null。
  const results = [
    ...robotsChecks(robotsOutcome, robotsUrl),
    readabilityCheck(outcomes.page, finalUrl),
    ...structuredChecks(outcomes.page, finalUrl),
    ...canonicalChecks(outcomes.page, finalUrl),
    // 基础技术 SEO。全部从**已经抓到的** page HTML 判定，不多发请求。
    ...htmlMetaChecks(outcomes.page, finalUrl),
    sitemapCheck(outcomes.sitemap, targets.sitemap.url),
    ...agentChannelChecks({ ucp: outcomes.ucp, agentsMd: outcomes.agentsMd, llmsTxt: outcomes.llmsTxt }, baseUrl),
  ];

  // robotsAllowedPage 单独返回：计划 3 的主站用它决定要不要触发深检查，
  // 与「页面这次到底有没有抓成功」是两回事——即使页面允许抓取但本次超时，
  // robotsAllowedPage 依然是 true。
  return { baseUrl, finalUrl, results, robotsAllowedPage: allowed.page };
}
