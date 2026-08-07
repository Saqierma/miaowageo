import { runPsi as defaultRunPsi } from "./psi.mjs";
import { runLighthouse as defaultRunLighthouse, LighthouseBusyError } from "./lighthouse-runner.mjs";
import { lighthouseChecks } from "./checks/lighthouse-map.mjs";
import { psiChecks } from "./checks/psi-map.mjs";

/**
 * 深检查编排：PSI 与本地 Lighthouse **并行**，汇总成一份 CheckResult[]。
 *
 * ---------------------------------------------------------------------------
 * 为什么是 allSettled 而不是 all
 *
 * `Promise.all` 一边 reject 就整体 reject，另一边**已经拿到的结果会被丢掉**。
 * 而这两边测的是完全不同的东西：PSI 给 performance 组，Lighthouse 给 agent 组。
 * Lighthouse 崩了不该让 PSI 的性能分跟着消失——那是把一次部分成功
 * 谎报成一次完全失败，等于丢掉我们确实观测到的事实。
 *
 * 并行也是预算要求：设计文档第三节写明「PSI 往返与 Lighthouse 并行，不叠加」。
 * 串行会让最坏路径变成 75 + 75 = 150 s，直接击穿 90 s 硬超时。
 *
 * ---------------------------------------------------------------------------
 * robots 禁止时不启动深检查——这不是可选项
 *
 * 设计文档第二节：页面路径被 Disallow 时，跳过页面 HTML 抓取**并跳过整个
 * 深检查**（Lighthouse 导航的是同一个 URL）。
 *
 * 第三节还有一条与之绑定的取舍：**深检查的出站 UA 保持 Chrome 默认**，
 * 不注入 MiaowaGEO-Audit 令牌——伪装成非浏览器会改变许多站点返回的内容，
 * 破坏检测结果的效度。这个取舍成立的**前提**就是「深检查启动前一定已经
 * 拿到 robots 判定」。若哪天放宽了跳过分支，那条 UA 决定必须同时重新评估。
 *
 * 所以这里把前提写成**显式断言**，而不是靠调用方自觉：调用方必须传
 * robotsAllowedPage，传不传得对由类型和断言守着。漏传等于我们在没有
 * robots 判定的情况下用浏览器 UA 去抓一个可能被禁止的路径。
 */

// 计划 2 第二节按实测重算：深检查 Worker 硬超时 90 s
// （覆盖 75 s 执行 + 15 s 余量）。设计文档原值 60 s 在实测下不够：
// Lighthouse 最坏 61.3 s、PSI 最坏 52.5 s。
export const DEEP_TIMEOUT_MS = 90_000;

export const DEEP_SKIP_REASONS = Object.freeze({
  ROBOTS: "skipped_robots",
});

export class RobotsDisallowedError extends Error {
  constructor(url) {
    super(`robots.txt 禁止抓取 ${url}，深检查不启动`);
    this.name = "RobotsDisallowedError";
    this.reason = DEEP_SKIP_REASONS.ROBOTS;
  }
}

/**
 * @param {string} targetUrl 轻检查确定的基准 URL（不是用户提交的原始 URL）
 * @param {object} deps
 * @param {boolean} deps.robotsAllowedPage 轻检查得出的「页面路径是否被 robots 放行」
 * @param {string} deps.psiApiKey
 * @param {number} deps.proxyPort  allowlist-proxy 端口
 * @param {string} deps.nodePath
 * @param {string} deps.lighthouseBin
 * @param {string} deps.chromePath
 * @param {Function} [deps.runPsi]
 * @param {Function} [deps.runLighthouse]
 * @returns {Promise<{results: object[], psiMs: number|null, lighthouseMs: number|null, lighthouseKillConfirmed: boolean|null}>}
 */
export async function runDeepAudit(targetUrl, deps = {}) {
  const {
    robotsAllowedPage,
    psiApiKey,
    proxyPort,
    nodePath,
    lighthouseBin,
    chromePath,
    runPsi = defaultRunPsi,
    runLighthouse = defaultRunLighthouse,
  } = deps;

  // 显式断言，不接受 undefined。传 undefined 时 `!robotsAllowedPage` 会
  // 悄悄走进「禁止」分支，看起来像正常跳过——那会把「调用方忘了传」
  // 伪装成「该站禁止抓取」，一个我们从未观测到的事实。
  if (typeof robotsAllowedPage !== "boolean") {
    throw new TypeError(
      "runDeepAudit 必须显式传入 robotsAllowedPage（布尔）：" +
        "深检查用 Chrome 默认 UA 出网，这个取舍成立的前提就是启动前已拿到 robots 判定",
    );
  }
  if (!robotsAllowedPage) throw new RobotsDisallowedError(targetUrl);

  let baseHost = null;
  try {
    baseHost = new URL(targetUrl).host;
  } catch {
    // 基准 URL 不合法属于接线错误，但不该把整次深检查炸掉——
    // 交给下游按「拿不到主机名」处理，只是失去「落到别的主机」的提示。
  }

  const [psiSettled, lhSettled] = await Promise.allSettled([
    runPsi(targetUrl, { apiKey: psiApiKey }),
    runLighthouse(targetUrl, { nodePath, lighthouseBin, chromePath, proxyPort }),
  ]);

  const results = [];
  let psiMs = null;
  let lighthouseMs = null;
  let lighthouseKillConfirmed = null;
  // Lighthouse 崩溃时它的 stderr 是**唯一**的诊断线索。runner 已经捕获了
  // 尾部，这里必须把它带出去交给调用方记日志——早先的版本在这里把它丢了，
  // 结果一次真实的崩溃只留下一句「crashed」，排障时完全无从下手。
  // 注意：它只进服务端日志，绝不进 CheckResult 的 observation
  // （那是给用户看的公开报告，不该泄露我们的内部路径与堆栈）。
  let lighthouseStderrTail = null;

  if (psiSettled.status === "fulfilled") {
    results.push(...psiSettled.value.results);
  } else {
    // runPsi 抛错只可能是接线问题（缺密钥）——safeFetch 本身永不抛。
    // 归我方侧，且把原因原样带出去，不要糊成「未知错误」。
    results.push(
      ...psiChecks({
        ok: false,
        status: null,
        payload: null,
        requestedUrl: targetUrl,
        workerReason: String(psiSettled.reason?.message ?? psiSettled.reason),
      }),
    );
  }

  if (lhSettled.status === "fulfilled") {
    const { report, reason, durationMs, killConfirmed, stderrTail } = lhSettled.value;
    lighthouseMs = durationMs ?? null;
    lighthouseKillConfirmed = killConfirmed ?? null;
    if (reason) lighthouseStderrTail = stderrTail ?? null;
    results.push(...lighthouseChecks({ report, requestedUrl: targetUrl, runnerReason: reason, baseHost }));
  } else {
    // 信号量占用（LighthouseBusyError）与真实异常要分开：前者是容量，
    // 后者是我们的代码坏了。两者都是 not_wired，但文案必须不同，
    // 否则运维看到「未取得浏览器检测结果」时无从判断该扩容还是该查 bug。
    const busy = lhSettled.reason instanceof LighthouseBusyError;
    results.push(
      ...lighthouseChecks({
        report: null,
        requestedUrl: targetUrl,
        runnerReason: busy ? "busy" : String(lhSettled.reason?.message ?? lhSettled.reason),
        baseHost,
      }),
    );
  }

  return { results, psiMs, lighthouseMs, lighthouseKillConfirmed, lighthouseStderrTail };
}
