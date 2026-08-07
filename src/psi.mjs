import { safeFetch as defaultSafeFetch } from "./fetchers/safe-fetch.mjs";
import { psiChecks } from "./checks/psi-map.mjs";

/**
 * PageSpeed Insights 客户端。
 *
 * 只做三件事：拼 URL、发请求、把结果交给 psi-map.mjs 那个纯函数。
 * **任何判断逻辑都不在这里**——这条边界与 checks/ 的其余部分一致。
 *
 * 走 safeFetch 而不是裸 fetch：PSI 是 Google 的公网 API，同样要过出网守卫
 * （统一入口不留例外，否则「唯一出网入口」这句话就不成立了），也顺带拿到
 * 统一的超时、大小上限与失败原因分类。
 */

// 设计文档第三节的时序预算表（计划 2 按实测重算）：PSI 往返 ≤ 75 s，
// 与本地 Lighthouse 并行，不叠加。
//
// 75 而不是文档原来的 45：2026-08-06 实测 globalsources.com 往返 52.5 s、
// 40.0 s 两次，均超过 45 s。45 是拍出来的，75 是实测最坏值加余量。
export const PSI_TIMEOUT_MS = 75_000;

export const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

// PSI 响应带完整 trace，实测 0.9–1.2 MB。safeFetch 的默认上限是 5 MB，
// 这里显式放宽到 8 MB：一个页面资源特别多的站点，响应体会比实测样本更大，
// 而截断响应体只会让我们把「拿到了但没读完」错记成失败。
export const PSI_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 只请求 mobile 一种 strategy（设计文档第五节，不得回退）。
 * category 同时要 performance 与 agentic-browsing：后者是本地 Lighthouse
 * 长期不可用时的降级来源，多要一个分类不额外增加往返次数。
 */
export function buildPsiUrl(targetUrl, apiKey) {
  const url = new URL(PSI_ENDPOINT);
  url.searchParams.set("url", targetUrl);
  url.searchParams.set("strategy", "mobile");
  url.searchParams.append("category", "performance");
  url.searchParams.append("category", "agentic-browsing");
  if (apiKey) url.searchParams.set("key", apiKey);
  return url.toString();
}

/**
 * @param {string} targetUrl 要检测的站点 URL（应当是轻检查确定的基准 URL）
 * @param {object} deps
 * @param {string} deps.apiKey GOOGLE_PSI_API_KEY
 * @param {Function} [deps.safeFetch]
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<{results: object[], raw: object|null}>}
 */
export async function runPsi(targetUrl, deps = {}) {
  const { apiKey, safeFetch = defaultSafeFetch, timeoutMs = PSI_TIMEOUT_MS } = deps;

  if (!apiKey) {
    // 到这一步还没有密钥属于接线错误——startServer() 的 assertDeepCheckConfig()
    // 本该在启动时就拦下（D3）。这里再拦一道，且**明确抛错而不是静默降级**：
    // 无密钥调用 PSI 会拿到 429，那会伪装成「配额耗尽」，正是 D3 要防的事。
    throw new Error("runPsi 需要 apiKey；无密钥调用 PSI 会返回 429，被误读成配额耗尽");
  }

  const outcome = await safeFetch(buildPsiUrl(targetUrl, apiKey), {
    timeoutMs,
    maxBytes: PSI_MAX_BYTES,
  });

  let payload = null;
  if (outcome.body) {
    try {
      payload = JSON.parse(outcome.body);
    } catch {
      payload = null;
    }
  }

  // safeFetch 对 4xx/5xx 会给 ok:false + reason:"http_error" 且 body 为 null——
  // 但 PSI 的错误详情**正在 body 里**，而那正是区分「对方站打不开(400)」与
  // 「我们配额用完(429)」的唯一依据。拿不到 body 时只能退回按状态码分类，
  // 这一点如实传给 psiChecks，不假装我们知道得更多。
  const workerReason = outcome.ok || payload ? null : outcome.reason;

  return {
    raw: payload,
    results: psiChecks({
      ok: outcome.ok,
      status: outcome.status,
      payload,
      requestedUrl: targetUrl,
      workerReason,
    }),
  };
}
