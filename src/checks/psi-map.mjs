import { checkResult } from "../types.mjs";

/**
 * PageSpeed Insights 响应 → CheckResult[]。**纯函数，不碰网络。**
 *
 * 这条边界与 checks/ 下其余模块一致，理由也一致：2026-08-06 的假阳性
 * （把 robots 白名单误判成整站封禁）之所以测不出来，就是判断逻辑与抓取
 * 缠在一起。这里输入的是「已经拿到的 PSI 响应」，输出是结构化结果，
 * 全部分支都能用 fixtures/psi/ 下的真实快照离线驱动。
 *
 * 产出两项，取值与阈值来自设计文档第五节的分组表，不得另定：
 *
 *   performance.psi-score   scored   ≥90 pass / 50–89 warn / <50 fail
 *   performance.crux-field  scored   全 good → pass；有 needs-improvement 无 poor → warn；
 *                                    有 poor → fail；一个指标都没返回 → no_data
 *
 * `agent` 组的可访问性树与 CLS **不在这里**——那两项由本地 Lighthouse 产出
 * （见 checks/lighthouse-map.mjs）。PSI 其实也返回完整的 agentic-browsing
 * 分类，但产品负责人 2026-08-06 决定自建以保证观测点自主。
 * 保留这条注释是因为：PSI 的 agentic 结果是本地 Lighthouse 长期不可用时
 * 唯一的降级路径，也是两边数字对不上时的交叉验证手段。
 */

// PSI 的 CrUX 指标用 FAST / AVERAGE / SLOW 三档（对应 Web Vitals 的
// good / needs-improvement / poor）。这是 API 的实际取值，不是我们的命名。
const CRUX_GOOD = "FAST";
const CRUX_NEEDS_IMPROVEMENT = "AVERAGE";
const CRUX_POOR = "SLOW";

/**
 * 把 PSI 的错误响应分成「对方侧」与「我方侧」。
 *
 * **这是本文件最要紧的一段。** 设计文档第七节要求 404 与 429 必须分开：
 * 前者是「该站确实没有」，可断言；后者是「我们没测到」，不可断言。
 * PSI 的错误响应里，同样两类混在同一个 HTTP 状态码空间里：
 *
 *   400 + reason=lighthouseUserError   目标站自己加载不起来（实测
 *                                      busytrade.com：FAILED_DOCUMENT_REQUEST /
 *                                      net::ERR_CONNECTION_FAILED）→ **对方侧**
 *   429 + reason=rateLimitExceeded     我们的配额用完了 → **我方侧**
 *   403 / 401                          密钥无效或被禁用 → **我方侧**
 *   5xx                                Google 自己挂了 → **我方侧**
 *
 * 两者的处置方向完全相反：前者要如实告诉客户「你的站 PSI 打不开」，
 * 后者绝不能这么说——那是在报告一件我们从未观测到的事。
 *
 * fixtures/psi/bad-request-400.json 与 nokey-429.json 是这两类的真实快照。
 */
export function classifyPsiError(payload, httpStatus) {
  const error = payload?.error;
  const code = error?.code ?? httpStatus ?? 0;
  const reasons = [
    ...(error?.errors ?? []).map((e) => e?.reason),
    ...(error?.details ?? []).map((d) => d?.reason),
  ].filter(Boolean);

  const isTargetFault =
    reasons.includes("lighthouseUserError") ||
    (error?.errors ?? []).some((e) => e?.domain === "lighthouse");

  if (isTargetFault) {
    return {
      state: "no_data",
      reason: "network",
      observation: `PSI 未能加载该页面：${shortMessage(error?.message)}`,
      limitation: "这是目标站点自身的加载失败（Google 的检测器也打不开），不是本工具未能完成检测。",
    };
  }

  if (code === 429 || reasons.includes("rateLimitExceeded") || error?.status === "RESOURCE_EXHAUSTED") {
    return {
      state: "not_wired",
      reason: "worker_error",
      observation: "本次未取得 PSI 数据：本工具的 PageSpeed Insights 配额已用尽。",
      limitation: "这是本工具侧的限制，与该站点的实际性能无关，不能据此对该站做任何判断。",
    };
  }

  return {
    state: "not_wired",
    reason: "worker_error",
    observation: `本次未取得 PSI 数据（PSI 返回 ${code}）。`,
    limitation: "这是本工具侧未能完成检测，与该站点的实际性能无关。",
  };
}

function shortMessage(message) {
  const text = String(message ?? "").trim();
  if (!text) return "未提供原因";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function scoreVerdict(score100) {
  if (score100 >= 90) return "pass";
  if (score100 >= 50) return "warn";
  return "fail";
}

/**
 * @param {object} input
 * @param {boolean} input.ok            HTTP 层面是否成功
 * @param {number|null} input.status    HTTP 状态码
 * @param {object|null} input.payload   已解析的 PSI JSON（失败时可能是错误体）
 * @param {string} input.requestedUrl   我们请求 PSI 检测的 URL
 * @param {string|null} [input.workerReason] safeFetch 的 reason（超时/网络等），有值代表连 PSI 都没打通
 * @returns {object[]} CheckResult[]
 */
export function psiChecks(input) {
  const { ok, status, payload, requestedUrl, workerReason } = input ?? {};
  const evidence = { url: requestedUrl ?? "" };

  // 连 Google 都没打通：这毫无疑问是我方侧（我们的机器、我们的网络、我们的超时）。
  if (workerReason) {
    const observation = `本次未取得 PSI 数据（调用 PageSpeed Insights 失败：${workerReason}）。`;
    const limitation = "这是本工具侧未能完成检测，与该站点的实际性能无关。";
    return [
      psiScoreResult({ state: "not_wired", reason: "worker_error", observation, limitation, evidence }),
      cruxResult({ state: "not_wired", reason: "worker_error", observation, limitation, evidence }),
    ];
  }

  if (!ok || payload?.error) {
    const { state, observation, limitation, reason } = classifyPsiError(payload, status);
    return [
      psiScoreResult({ state, observation, limitation, evidence, reason }),
      cruxResult({ state, observation, limitation, evidence, reason }),
    ];
  }

  return [buildScoreCheck(payload, evidence), buildCruxCheck(payload, evidence)];
}

function psiScoreResult({ state, verdict = null, observation, limitation, evidence, reason = null }) {
  return checkResult({
    id: "performance.psi-score",
    group: "performance",
    scored: true,
    state,
    verdict,
    observation,
    evidence,
    limitation,
    reason,
  });
}

function cruxResult({ state, verdict = null, observation, limitation, evidence, reason = null }) {
  return checkResult({
    id: "performance.crux-field",
    group: "performance",
    scored: true,
    state,
    verdict,
    observation,
    evidence,
    limitation,
    reason,
  });
}

function buildScoreCheck(payload, evidence) {
  const raw = payload?.lighthouseResult?.categories?.performance?.score;
  if (typeof raw !== "number") {
    // PSI 返回了 200，但没给性能分——这是我们请求的分类没拿到，属我方侧
    // （多半是 category 参数没带对），不能算成该站点性能差。
    return psiScoreResult({
      state: "not_wired",
      reason: "worker_error",
      observation: "PSI 响应中没有性能分类的分数。",
      limitation: "本次调用未取得性能分，不能据此对该站做任何判断。",
      evidence,
    });
  }
  const score100 = Math.round(raw * 100);

  // 深检查必须记录并展示它实际测量的最终 URL（设计文档第三节）。
  // 实测 made-in-china.com 的 PSI 落在了 m.made-in-china.com——同一份报告里
  // 性能数字来自另一台主机，而读者无从知晓，那是不可接受的。
  const finalUrl = payload?.lighthouseResult?.finalDisplayedUrl ?? payload?.lighthouseResult?.finalUrl ?? null;
  const requested = payload?.lighthouseResult?.requestedUrl ?? evidence.url;
  const redirected = finalUrl && requested && hostOf(finalUrl) !== hostOf(requested);

  return psiScoreResult({
    state: "ready",
    verdict: scoreVerdict(score100),
    observation: `PageSpeed Insights 移动端性能分 ${score100}（满分 100）。`,
    limitation: redirected
      ? `该测量实际落在 ${finalUrl}，与提交的 ${requested} 不是同一主机——移动端跳转会改变被测对象。`
      : null,
    evidence: { url: finalUrl ?? evidence.url },
  });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function buildCruxCheck(payload, evidence) {
  const metrics = payload?.loadingExperience?.metrics;
  const entries = metrics ? Object.entries(metrics) : [];

  if (entries.length === 0) {
    // 设计文档第五节：一个指标都没返回 = 样本不足 = **对方侧的正常事实**。
    // 低流量站点普遍如此，把它记成我方失败是错的。
    return cruxResult({
      state: "no_data",
      reason: "not_applicable",
      observation: "Chrome 用户体验报告（CrUX）没有该站点的字段数据。",
      limitation: "CrUX 只覆盖有足够真实用户流量的站点，样本不足是常见情况，不代表站点有问题。",
      evidence,
    });
  }

  // 只对**实际返回的**指标求值（设计文档第五节明确要求）。
  // 低流量站尤其常缺 INP，按缺失即失败会系统性冤枉小站。
  const categories = entries.map(([, value]) => value?.category);
  const poor = categories.filter((c) => c === CRUX_POOR).length;
  const needs = categories.filter((c) => c === CRUX_NEEDS_IMPROVEMENT).length;

  let verdict;
  if (poor > 0) verdict = "fail";
  else if (needs > 0) verdict = "warn";
  else verdict = "pass";

  const detail = entries
    .map(([name, value]) => `${friendlyMetric(name)} ${value?.category ?? "?"}`)
    .join("、");

  return cruxResult({
    state: "ready",
    verdict,
    observation: `CrUX 真实用户数据共 ${entries.length} 项指标：${detail}。`,
    limitation:
      entries.length < 5
        ? `只有 ${entries.length} 项指标有足够样本，判定仅基于这几项（缺失的指标不参与判定，也不算失败）。`
        : null,
    evidence,
  });
}

const METRIC_LABELS = Object.freeze({
  LARGEST_CONTENTFUL_PAINT_MS: "LCP",
  FIRST_CONTENTFUL_PAINT_MS: "FCP",
  CUMULATIVE_LAYOUT_SHIFT_SCORE: "CLS",
  INTERACTION_TO_NEXT_PAINT: "INP",
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: "TTFB",
});

function friendlyMetric(name) {
  return METRIC_LABELS[name] ?? name;
}
