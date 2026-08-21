/**
 * 探针阶段的编排：UA 差分矩阵 + WAF 指纹。
 *
 * **刻意不与深检查合并。** 深检查要起 Chrome、吃 1~2 GB 内存、全局并发只有 1；
 * 而这一阶段只发七个 HTTP 请求。把便宜且高价值的东西排在昂贵且稀缺的东西后面，
 * 是没有道理的——两者并行跑，各自有各自的容量。
 *
 * 也刻意不并进轻检查：轻检查是**用户同步等待**的，硬超时 11 秒、最坏路径已经
 * 用掉 10.7 秒，没有余量再塞七个请求进去。
 */

import { checkResult } from "./types.mjs";
import { parseRobots, groupFor, pathAllowed } from "./checks/robots-parse.mjs";
import { PRODUCT_TOKEN } from "./orchestrate-light.mjs";
import { runUaMatrix, uaMatrixChecks, stripBodies } from "./probe/ua-matrix.mjs";
import { identifyFromMatrix, guideFor, GENERIC_GUIDE } from "./probe/waf-fingerprint.mjs";

const GROUP = "access";

/**
 * WAF 指纹产出的检查项。
 *
 * **恒为 advisory（不计分）。** 用了 Cloudflare 既不加分也不扣分——
 * 它只是「怎么改」这条信息的载体。把它计进分母，会让一个用了 CDN 的站
 * 无缘无故多一个计分项，站点之间失去可比性。
 */
function vendorCheck(vendor, pageUrl) {
  if (!vendor) {
    return checkResult({
      id: "access.waf-vendor",
      group: GROUP,
      scored: false,
      state: "ready",
      verdict: "info",
      observation: "未能从响应头识别出 CDN 或 WAF 厂商。",
      limitation: GENERIC_GUIDE,
      evidence: { url: pageUrl },
    });
  }
  // 弱信号（目前只有 server: tengine）不能用确证的句式说出来。
  // 「该站点前面有阿里云 WAF」和「像阿里云，但也可能是自建」之间的差别，
  // 对一个照着指引去翻控制台的人来说是全部的差别。
  const weak = vendor.confidence === "weak";
  const observation = weak
    ? `该站点的 ${vendor.evidence}，通常意味着 ${vendor.name}——但这不是确证：${vendor.caveat}`
    : `该站点前面有 ${vendor.name}（依据：${vendor.evidence}）。`;
  const limitation = weak
    ? `请先确认你确实在用这家产品，再照下面的路径操作。${guideFor(vendor.id)}`
    : guideFor(vendor.id);

  return checkResult({
    id: "access.waf-vendor",
    group: GROUP,
    scored: false,
    state: "ready",
    verdict: "info",
    observation,
    limitation,
    evidence: { url: pageUrl, vendor: vendor.id, seenOn: vendor.seenOn, confidence: vendor.confidence },
  });
}

/**
 * @param {string} pageUrl 已规范化的页面地址（轻检查的 finalUrl）
 * @param {object} deps
 * @param {Function} deps.safeFetch
 * @returns {Promise<{results: object[], matrix: Array|null, vendor: object|null}>}
 */
export async function runProbeAudit(pageUrl, deps = {}) {
  const { safeFetch } = deps;
  if (typeof safeFetch !== "function") {
    throw new TypeError("runProbeAudit 需要通过 deps.safeFetch 注入抓取实现");
  }

  const target = new URL(pageUrl);
  const baseUrl = target.origin;

  // **robots.txt 照旧遵守。** 换一个 UA 去探测，不等于可以无视对方的抓取规则；
  // 一个自称「标明来意」的工具，在这一点上让步就没有立场了。
  const robotsOutcome = await safeFetch(`${baseUrl}/robots.txt`, { timeoutMs: 3000 });
  const groups = robotsOutcome?.ok ? parseRobots(robotsOutcome.body) : null;
  const group = groupFor(groups, PRODUCT_TOKEN);
  const allowed = pathAllowed(group, target.pathname || "/");

  if (!allowed) {
    const blocked = Object.freeze({
      ok: false, status: null, headers: {}, body: null, finalUrl: pageUrl, reason: "robots_disallowed",
    });
    return {
      results: [
        ...uaMatrixChecks(null, pageUrl, blocked),
        vendorCheck(null, pageUrl),
        // 这一支也要出这一项，否则项数随「robots 允不允许」变化，分母失去可比性。
        checkResult({
          id: "access.edge-ai-policy",
          group: GROUP,
          scored: false,
          state: "no_data",
          reason: "robots_disallowed",
          observation: "robots.txt 不允许抓取该路径，边缘层策略未测。",
          evidence: { url: pageUrl },
        }),
      ],
      matrix: null,
      vendor: null,
    };
  }

  const matrix = await runUaMatrix(pageUrl, { safeFetch });
  const vendor = identifyFromMatrix(matrix);

  // 广告变现信号。**一次请求**，与 llms.txt / agents.md 同属根文件探测。
  // 它存在的唯一目的是给对照探针的歧义提供旁证——见 ua-matrix.mjs 里
  // interpretMatrix 的头注释（Cloudflare 2026-09-15 的默认变更）。
  const adsOutcome = await safeFetch(`${baseUrl}/ads.txt`, { timeoutMs: 3000 });
  const monetized = detectAdMonetization(adsOutcome, matrix);

  const context = { vendorId: vendor?.id ?? null, adMonetized: monetized.adMonetized };

  return {
    results: [
      ...uaMatrixChecks(matrix, pageUrl, null, context),
      vendorCheck(vendor, pageUrl),
      edgePolicyCheck(vendor, monetized, pageUrl),
    ],
    // **返回的矩阵也要剥正文。** 它会一路进数据库、进报告页的表格。
    matrix: stripBodies(matrix),
    vendor,
  };
}

/**
 * 页面是否广告变现。
 *
 * 两个来源，任一命中即算：
 *   - `/ads.txt` 可达且有内容（IAB 规范，只有卖广告位的站才会放）
 *   - 探针拿到的 HTML 片段里出现广告脚本
 *
 * 探针只取前 8KB，所以第二个来源**只能证有、不能证无**——广告脚本可能在
 * 截断之外。这个不对称必须写进 limitation，不能让「没看到」被读成「没有」。
 */
function detectAdMonetization(adsOutcome, matrix) {
  const hasAdsTxt = Boolean(adsOutcome?.ok && String(adsOutcome.body ?? "").trim().length > 0);

  const bodies = (matrix ?? []).map((r) => String(r?.body ?? "")).join("\n");
  const scriptHit = /adsbygoogle|googletagservices|googlesyndication|\bgoogletag\b|prebid/i.test(bodies);

  return {
    adMonetized: hasAdsTxt || scriptHit,
    hasAdsTxt,
    scriptHit,
  };
}

/**
 * 边缘层 AI 策略的暴露面。**恒为参考项。**
 *
 * 它不判对错，只回答一个有时间性的问题：**2026-09-15 之后，这个站点会不会
 * 因为 CDN 的默认值变化而把 AI 爬虫挡在门外？**
 *
 * 外部只测得到两个条件里的两个：是否在 Cloudflare 后面、页面是否广告变现。
 * 套餐层级与账号新旧从外面看不见，所以结论只能是**条件句**——
 * 告诉用户「该去哪儿确认」，而不是「你一定会/不会被影响」。
 */
function edgePolicyCheck(vendor, monetized, pageUrl) {
  const base = {
    id: "access.edge-ai-policy",
    group: GROUP,
    scored: false,
    state: "ready",
    verdict: "info",
    evidence: {
      url: pageUrl,
      vendor: vendor?.id ?? null,
      adMonetized: monetized.adMonetized,
      hasAdsTxt: monetized.hasAdsTxt,
      adScriptSeen: monetized.scriptHit,
    },
  };

  if (vendor?.id !== "cloudflare") {
    return checkResult({
      ...base,
      observation: "未识别出会在近期变更 AI 爬虫默认策略的边缘层产品。",
      limitation:
        "目前只跟踪 Cloudflare 已公布的一项变更（2026-09-15 起在含广告页面默认封禁训练类爬虫）。" +
        "其他厂商也可能有类似策略，本工具尚未覆盖——**没提到不等于没有**。",
    });
  }

  if (!monetized.adMonetized) {
    return checkResult({
      ...base,
      observation: "该站点在 Cloudflare 后面，但未发现广告变现的迹象。",
      limitation:
        "Cloudflare 自 2026-09-15 起的默认封禁**只作用于含广告的页面**，所以这个站大概率不受影响。" +
        "但我们只看了 /ads.txt 与探针取到的前 8KB HTML——**广告脚本可能在截断之外**，" +
        "没看到不等于没有。以你自己在 Cloudflare 控制台里看到的为准。",
    });
  }

  return checkResult({
    ...base,
    observation:
      "该站点在 Cloudflare 后面，且检测到广告变现迹象" +
      `（${[monetized.hasAdsTxt && "/ads.txt 可达", monetized.scriptHit && "页面含广告脚本"].filter(Boolean).join("、")}）。`,
    limitation:
      "**Cloudflare 自 2026-09-15 起，在含广告的页面上默认封禁训练类爬虫**，" +
      "并把 Googlebot、Bingbot、Applebot 归为多用途爬虫、按最严格的规则一起拦下。" +
      "该默认变更适用于新客户、现有客户的新站点与全部免费套餐用户；" +
      "**现有付费客户不受自动影响，可在控制台覆盖。**\n" +
      "套餐层级与账号新旧从站外看不到，所以我们无法判定你是否在适用范围内——" +
      "请到 Cloudflare 控制台 → Security → Settings → AI 爬虫策略确认，" +
      "并为 Googlebot / Bingbot 单独写放行规则（否则搜索收录会被一起波及）。",
  });
}
