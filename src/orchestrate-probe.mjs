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
import { runUaMatrix, uaMatrixChecks } from "./probe/ua-matrix.mjs";
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
      results: [...uaMatrixChecks(null, pageUrl, blocked), vendorCheck(null, pageUrl)],
      matrix: null,
      vendor: null,
    };
  }

  const matrix = await runUaMatrix(pageUrl, { safeFetch });
  const vendor = identifyFromMatrix(matrix);

  return {
    results: [...uaMatrixChecks(matrix, pageUrl), vendorCheck(vendor, pageUrl)],
    matrix,
    vendor,
  };
}
