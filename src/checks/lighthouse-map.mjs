import { checkResult } from "../types.mjs";

/**
 * Lighthouse 报告 JSON → CheckResult[]。**纯函数，不碰网络、不起 Chrome。**
 *
 * 产出 `agent` 组的两个 scored 项（设计文档第五节的分组表）：
 *
 *   agent.accessibility-tree  scored  Lighthouse 判定通过 → pass，未通过 → fail
 *   agent.cls                 scored  ≤0.10 pass / >0.10 且 ≤0.25 warn / >0.25 fail
 *
 * 同组的 WebMCP / ucp / agents.md / llms.txt 一律 advisory，且由轻检查产出，
 * 不在这里——设计文档第九节自己写了这些协议「格局未定」，
 * 用未定的协议给用户扣分，是该文档在 llms.txt 上已经拒绝过的矛盾。
 *
 * ---------------------------------------------------------------------------
 * 两种 scoreDisplayMode 的取值方式不同，不能混用
 *
 *   agent-accessibility-tree   mode=binary   看 score（0/1）
 *   cumulative-layout-shift    mode=numeric  看 numericValue（真实 CLS 值）
 *
 * 对 numeric 项直接读 score 会拿到 Lighthouse 自己的评分曲线（0–1 的连续值），
 * 那与设计文档规定的 0.10 / 0.25 阈值是两套标准，混用会得出与文档不符的判定。
 * 对 binary 项去读 numericValue 则根本没有这个字段。
 *
 * 还有第三种要单独处理：`notApplicable`。它表示「这一项对本页面不适用」，
 * 是**对方侧的事实**（no_data），不是 fail——实测 PSI 对 made-in-china.com
 * 的三个 WebMCP 审计正是这个值。把 notApplicable 当 fail 会凭空造出失败。
 */

// 设计文档第五节：CLS ≤0.10 pass；>0.10 且 ≤0.25 warn；>0.25 fail。
export const CLS_PASS_MAX = 0.1;
export const CLS_WARN_MAX = 0.25;

const AUDIT_ACCESSIBILITY_TREE = "agent-accessibility-tree";
const AUDIT_CLS = "cumulative-layout-shift";

/**
 * Lighthouse 运行失败时，把失败原因分成对方侧与我方侧。
 *
 * 与 psi-map.mjs 的 classifyPsiError 是同一条原则的另一处应用，
 * 也是设计文档第七节「404 与 429 必须分开」的延伸：
 *
 *   目标站加载不起来（Lighthouse 的 runtimeError）→ no_data（对方侧）
 *   Chrome 起不来 / 超时 / 我们把它杀了            → not_wired（我方侧）
 *
 * Lighthouse 报告里 runtimeError.code 常见取值：
 *   FAILED_DOCUMENT_REQUEST / NO_FCP / ERRORED_DOCUMENT_REQUEST
 *   → 都是目标站没能正常加载，属对方侧
 *   PROTOCOL_TIMEOUT / TARGET_CRASHED → Chrome 侧的问题，属我方侧
 */
export const TARGET_SIDE_RUNTIME_ERRORS = Object.freeze([
  "FAILED_DOCUMENT_REQUEST",
  "ERRORED_DOCUMENT_REQUEST",
  "NO_FCP",
  "NO_DOCUMENT_REQUEST",
  "INVALID_URL",
  "PAGE_HUNG",
]);

export function classifyRuntimeError(runtimeError) {
  const code = runtimeError?.code ?? "";
  if (TARGET_SIDE_RUNTIME_ERRORS.includes(code)) {
    return {
      state: "no_data",
      reason: "network",
      observation: `浏览器从本工具的海外检测点未能加载出该页面的内容（Lighthouse：${code}）。`,
      // 措辞是刻意的，不能写成「该站点自身加载失败」。
      //
      // 2026-08-06 用 miaowageo.com 实测：从首尔的检测机 NO_FCP，而 PSI
      // （Google 在美国的机器）同一时刻给了 97 分——站点本身好得很，
      // 不通的是首尔↔北京那条路。Lighthouse 的 NO_FCP 分不清
      // 「站坏了」与「我们这条路不通」，我们也不该替它下结论。
      //
      // 但这个观察对本工具的用户**仍然有价值**：他们要回答的正是
      // 「海外访问者/AI 爬虫能不能加载这个站」。所以如实说清楚
      // 「从我们的海外检测点没加载出来」，而不是既不说也不猜。
      limitation:
        "这说明从本工具所在的海外检测点未能加载出页面内容，可能是站点问题，" +
        "也可能是该站与本检测点之间的网络路径不通。同一份报告里的 PSI 分数由 " +
        "Google 自己的机器测得，可与此项对照——两者不一致时，多半是网络路径而非站点本身。",
    };
  }
  return {
    state: "not_wired",
    reason: "worker_error",
    observation: `本次未取得浏览器检测结果${code ? `（${code}）` : ""}。`,
    limitation: "这是本工具侧未能完成检测，与该站点无关，不能据此对该站做任何判断。",
  };
}

function agentResult(id, { state, verdict = null, observation, limitation = null, evidence, reason = null }) {
  return checkResult({
    id,
    group: "agent",
    scored: true,
    state,
    verdict,
    observation,
    evidence,
    limitation,
    reason,
  });
}

/**
 * @param {object} input
 * @param {object|null} input.report   Lighthouse 的 JSON 报告
 * @param {string} input.requestedUrl  我们请求检测的 URL
 * @param {string|null} [input.runnerReason] runner 侧的失败原因（timeout / crashed / chrome_missing…）
 * @param {string|null} [input.baseHost] 轻检查确定的基准主机，用于「深检查落到别的主机」提示
 * @returns {object[]} CheckResult[]
 */
export function lighthouseChecks(input) {
  const { report, requestedUrl, runnerReason, baseHost } = input ?? {};
  const evidence = { url: requestedUrl ?? "" };

  if (runnerReason) {
    // runner 侧失败（Chrome 起不来、超时被我们杀掉、报告读不出来）一律我方侧。
    const observation = `本次未取得浏览器检测结果（${runnerReason}）。`;
    const limitation = "这是本工具侧未能完成检测，与该站点无关。";
    return [
      agentResult("agent.accessibility-tree", { state: "not_wired", reason: "worker_error", observation, limitation, evidence }),
      agentResult("agent.cls", { state: "not_wired", reason: "worker_error", observation, limitation, evidence }),
    ];
  }

  if (!report || typeof report !== "object") {
    const observation = "本次未取得浏览器检测结果（报告为空）。";
    const limitation = "这是本工具侧未能完成检测，与该站点无关。";
    return [
      agentResult("agent.accessibility-tree", { state: "not_wired", reason: "worker_error", observation, limitation, evidence }),
      agentResult("agent.cls", { state: "not_wired", reason: "worker_error", observation, limitation, evidence }),
    ];
  }

  if (report.runtimeError) {
    const { state, observation, limitation, reason } = classifyRuntimeError(report.runtimeError);
    return [
      agentResult("agent.accessibility-tree", { state, observation, limitation, evidence, reason }),
      agentResult("agent.cls", { state, observation, limitation, evidence, reason }),
    ];
  }

  // 深检查必须记录并展示它实际测量的最终 URL（设计文档第三节）。
  // 若落地主机与轻检查基准主机不同，报告须显式标出——否则同一份报告里
  // agent 组的数字来自另一台主机，而读者无从知晓。
  const finalUrl = report.finalDisplayedUrl ?? report.finalUrl ?? requestedUrl ?? null;
  const hostNote = hostMismatchNote(finalUrl, baseHost);
  const actualEvidence = { url: finalUrl ?? evidence.url };

  return [
    buildAccessibilityTree(report, actualEvidence, hostNote),
    buildCls(report, actualEvidence, hostNote),
  ];
}

function hostMismatchNote(finalUrl, baseHost) {
  if (!finalUrl || !baseHost) return null;
  let host;
  try {
    host = new URL(finalUrl).host;
  } catch {
    return null;
  }
  if (host === baseHost) return null;
  return `浏览器检测实际落在 ${finalUrl}（主机 ${host}），与轻检查的基准主机 ${baseHost} 不同。`;
}

/** 把 limitation 与「落到别的主机」提示合成一条，两者都要可见，不折叠。 */
function mergeLimitation(base, hostNote) {
  if (base && hostNote) return `${base} ${hostNote}`;
  return base ?? hostNote ?? null;
}

function buildAccessibilityTree(report, evidence, hostNote) {
  const audit = report.audits?.[AUDIT_ACCESSIBILITY_TREE];
  const id = "agent.accessibility-tree";

  if (!audit) {
    return agentResult(id, {
      state: "not_wired",
      reason: "worker_error",
      observation: "本次检测未包含可访问性树审计。",
      limitation: mergeLimitation("这是本工具侧的检测配置问题，与该站点无关。", hostNote),
      evidence,
    });
  }

  if (audit.scoreDisplayMode === "notApplicable") {
    // 「不适用」是对方侧的事实，不是失败。当成 fail 会凭空造出一个失败结论。
    return agentResult(id, {
      state: "no_data",
      reason: "not_applicable",
      observation: "该页面不适用可访问性树审计。",
      limitation: mergeLimitation(null, hostNote),
      evidence,
    });
  }

  if (audit.scoreDisplayMode === "error" || audit.score === null || audit.score === undefined) {
    return agentResult(id, {
      state: "not_wired",
      reason: "worker_error",
      observation: `可访问性树审计未能完成${audit.errorMessage ? `：${audit.errorMessage}` : ""}。`,
      limitation: mergeLimitation("这是本工具侧未能完成检测。", hostNote),
      evidence,
    });
  }

  // binary 模式：score 就是 0/1。设计文档：通过 → pass，未通过 → fail（无 warn 档）。
  const passed = audit.score >= 1;
  return agentResult(id, {
    state: "ready",
    verdict: passed ? "pass" : "fail",
    observation: passed
      ? "浏览器构建出的可访问性树结构完整，AI 代理能据此理解页面结构。"
      : `浏览器构建出的可访问性树结构不完整（Lighthouse：${audit.title ?? "未通过"}）。`,
    limitation: mergeLimitation(null, hostNote),
    evidence,
  });
}

function buildCls(report, evidence, hostNote) {
  const audit = report.audits?.[AUDIT_CLS];
  const id = "agent.cls";

  if (!audit) {
    return agentResult(id, {
      state: "not_wired",
      reason: "worker_error",
      observation: "本次检测未包含 CLS 审计。",
      limitation: mergeLimitation("这是本工具侧的检测配置问题，与该站点无关。", hostNote),
      evidence,
    });
  }

  if (audit.scoreDisplayMode === "notApplicable") {
    return agentResult(id, {
      state: "no_data",
      reason: "not_applicable",
      observation: "该页面不适用累积布局偏移（CLS）审计。",
      limitation: mergeLimitation(null, hostNote),
      evidence,
    });
  }

  // numeric 模式：必须读 numericValue（真实 CLS 值），**不能读 score**。
  // score 是 Lighthouse 自己的评分曲线（0–1 连续值），与设计文档规定的
  // 0.10 / 0.25 阈值是两套标准，混用会得出与文档不符的判定。
  const value = audit.numericValue;
  if (typeof value !== "number" || Number.isNaN(value)) {
    return agentResult(id, {
      state: "not_wired",
      observation: `CLS 审计未能给出数值${audit.errorMessage ? `：${audit.errorMessage}` : ""}。`,
      limitation: mergeLimitation("这是本工具侧未能完成检测。", hostNote),
      evidence,
    });
  }

  let verdict;
  if (value <= CLS_PASS_MAX) verdict = "pass";
  else if (value <= CLS_WARN_MAX) verdict = "warn";
  else verdict = "fail";

  return agentResult(id, {
    state: "ready",
    verdict,
    observation: `累积布局偏移（CLS）实测 ${value.toFixed(3)}。`,
    limitation: mergeLimitation(null, hostNote),
    evidence,
  });
}
