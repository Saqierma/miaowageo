import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 本地 Lighthouse 执行器。
 *
 * ---------------------------------------------------------------------------
 * 为什么是子进程
 *
 * 仓库的硬约束是「零第三方依赖」。Lighthouse 是唯一的破例（依赖树约 162 MB），
 * 破例范围被严格限制成：**只以子进程方式调用它的 CLI，绝不 import 进主进程**。
 * 这条边界同时解决三件事：
 *
 *   1. 162 MB 的依赖树不污染主进程的模块图
 *   2. Lighthouse 自己崩溃（它会）不会带走整个 Worker
 *   3. 超时后可以把**整棵进程树**一次性回收——Chrome 是多进程，
 *      只杀 Lighthouse 那个 node 进程不会带走 renderer 与 GPU 进程
 *
 * 第 3 点是选子进程最实际的理由。2026-08-06 实测：Lighthouse 峰值内存
 * 581–1073 MB，留下的孤儿 Chrome 进程会一直占着这些内存直到机器 OOM。
 *
 * ---------------------------------------------------------------------------
 * Chrome 参数是安全边界的一部分，不是调优
 *
 *   --proxy-server=127.0.0.1:<代理端口>
 *   --proxy-bypass-list=<-loopback>    ← 缺这一行，整个 allowlist-proxy 白写
 *   --force-webrtc-ip-handling-policy=disable_non_proxied_udp
 *
 * **不加 `--no-sandbox`**（设计文档第三节的决定，非待办）。
 * Ubuntu 24.04 默认 kernel.apparmor_restrict_unprivileged_userns=1 会让
 * Chrome 的命名空间沙箱起不来，正确做法是给 Chrome 二进制单独配一份
 * AppArmor profile 授予 userns，而不是关掉沙箱或全局关掉那条加固。
 * 做过 A/B 对照：装 profile 正常运行，
 * 卸掉 profile 立刻 `FATAL: No usable sandbox!`。
 */

// 计划 2 第二节按实测重算的预算：Lighthouse 单次执行 ≤ 75 s。
// 75 而不是设计文档原来的 45：2026-08-06 在 2 GB 机器上实测
// globalsources.com 耗时 61.3 s，超过 45 s 预算。
export const LIGHTHOUSE_TIMEOUT_MS = 75_000;

// 全局并发 1（设计文档第三节，不得回退）。占用中立即拒绝，**不排队**。
// 理由是内存：单次峰值超过 1 GB，两个并发会直接把 4 GB 机器打满。
const SEMAPHORE = { busy: false };

/** 供测试重置信号量，避免上一个用例的占用泄漏到下一个。 */
export function resetLighthouseSemaphore() {
  SEMAPHORE.busy = false;
}

export function isLighthouseBusy() {
  return SEMAPHORE.busy;
}

export const RUNNER_REASONS = Object.freeze({
  BUSY: "busy",
  TIMEOUT: "timeout",
  CRASHED: "crashed",
  BAD_REPORT: "bad_report",
});

export class LighthouseBusyError extends Error {
  constructor() {
    super("本地 Lighthouse 正在执行另一次检测，本次不排队直接拒绝");
    this.name = "LighthouseBusyError";
    this.reason = RUNNER_REASONS.BUSY;
  }
}

/**
 * 拼 Chrome 启动参数。导出是为了让测试能直接断言那几个安全相关的开关——
 * 它们没有任何可观测输出（缺了照样跑得通，只是防线没了），
 * 与 safe-fetch 的连接钉死同型，只能靠对参数本身断言来守。
 */
export function buildChromeFlags({ proxyPort, userDataDir }) {
  return [
    "--headless=new",
    "--disable-gpu",
    // /dev/shm 默认只有 64 MB，Chrome 会因共享内存不足而崩。
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    // 无会话总线的服务器上，dbus 连接失败会刷满 stderr。
    "--disable-dbus",
    `--user-data-dir=${userDataDir}`,
    // ↓↓↓ 以下三行是安全边界，删任何一行都会让 allowlist-proxy 失效 ↓↓↓
    `--proxy-server=127.0.0.1:${proxyPort}`,
    // Chrome 默认绕过代理直连 localhost。不加这一行，一次指向
    // http://127.0.0.1:<端口>/ 的重定向或子资源会完全绕开代理。
    "--proxy-bypass-list=<-loopback>",
    // WebRTC 走 UDP，不经 HTTP 代理，是又一条绕过通道。
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

export function buildLighthouseArgs({ targetUrl, outputPath, chromeFlags }) {
  return [
    targetUrl,
    "--output=json",
    `--output-path=${outputPath}`,
    // 只跑 agentic 分类里需要浏览器的两项。
    //
    // 理由是**不产出用不到的结果**，不是省内存——2026-08-06 实测反直觉：
    // 窄配置（globalsources 1073 MB）内存反而**高于**完整 performance 分类
    // （walmart 849 MB），因为吃内存的是采集阶段（页面加载 + trace +
    // 可访问性树），不是审计计算。设计文档「用 --only-audits 省执行成本」
    // 那句话对内存不成立，不得再作为内存预算的依据。
    "--only-audits=agent-accessibility-tree,cumulative-layout-shift",
    `--chrome-flags=${chromeFlags.join(" ")}`,
  ];
}

/**
 * 把整棵进程树杀干净，并**确认**它真的没了。
 *
 * spawn 时用 detached:true 让子进程自成进程组，这里就能用 kill(-pid) 一次性
 * 覆盖 Lighthouse 的 node 进程与它拉起的全部 Chrome 进程。只 kill(pid) 会留下
 * 孤儿 renderer，每个都占几百 MB。
 *
 * 先 SIGTERM 给它收尾的机会，宽限期后再 SIGKILL；最后回报是否确认清理干净，
 * 确认不了就如实说，让调用方记录并交给 systemd 的 MemoryMax 兜底——
 * **不假装清理成功**，那正是本仓库反复出现的「注释声称已关闭，实际敞开」。
 */
async function killProcessTree(child, { graceMs = 3000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return { confirmed: true };
  const pgid = -child.pid;

  try {
    process.kill(pgid, "SIGTERM");
  } catch {
    // 进程组已经不在了
    return { confirmed: true };
  }

  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);
  if (exited) return { confirmed: true };

  try {
    process.kill(pgid, "SIGKILL");
  } catch {
    return { confirmed: true };
  }

  const killed = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  return { confirmed: killed };
}

/**
 * 跑一次 Lighthouse。
 *
 * @param {string} targetUrl
 * @param {object} deps
 * @param {string} deps.nodePath        跑 Lighthouse CLI 用的 node（生产是 /opt/node22/bin/node）
 * @param {string} deps.lighthouseBin   Lighthouse CLI 的绝对路径
 * @param {string} deps.chromePath      Chrome 可执行文件（写进子进程的 CHROME_PATH）
 * @param {number} deps.proxyPort       allowlist-proxy 的端口
 * @param {number} [deps.timeoutMs]
 * @param {Function} [deps.spawnFn]     仅供测试注入
 * @returns {Promise<{report: object|null, reason: string|null, durationMs: number, killConfirmed: boolean|null}>}
 */
export async function runLighthouse(targetUrl, deps = {}) {
  const {
    nodePath,
    lighthouseBin,
    chromePath,
    proxyPort,
    timeoutMs = LIGHTHOUSE_TIMEOUT_MS,
    spawnFn = spawn,
  } = deps;

  if (SEMAPHORE.busy) throw new LighthouseBusyError();
  SEMAPHORE.busy = true;

  const workDir = await mkdtemp(join(tmpdir(), "miaowa-lh-"));
  const outputPath = join(workDir, "report.json");
  const userDataDir = join(workDir, "chrome-profile");
  const startedAt = Date.now();

  let child;
  let timer;
  let killConfirmed = null;

  try {
    const chromeFlags = buildChromeFlags({ proxyPort, userDataDir });
    const args = buildLighthouseArgs({ targetUrl, outputPath, chromeFlags });

    child = spawnFn(nodePath, [lighthouseBin, ...args], {
      // 自成进程组，才能用 kill(-pid) 覆盖 Chrome 的全部子进程。
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: workDir,
        CHROME_PATH: chromePath,
        // 代理环境变量必须显式清空：本进程树里任何一个代理变量都会让
        // Chrome 绕开我们的 allowlist-proxy（net-guard.mjs 顶部的同款理由）。
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        http_proxy: "",
        https_proxy: "",
      },
    });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      // 只留尾部：Lighthouse 的 stderr 在 verbose 下能到几 MB。
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });

    // timedOut 必须存在，不能只靠 Promise 的「先到先得」。
    //
    // 超时路径要先 kill 进程树，而 kill 会让子进程发出 exit——于是下面的
    // exit 监听器和超时分支会赛跑。exit 拿到的退出码非 0（被信号杀死），
    // 若让它先 resolve，一次**超时**就会被报成 **crashed**。
    // 两者最终都是 not_wired，用户看到的状态一样，但诊断方向完全不同：
    // 「超过 75 秒预算」要去看目标站和预算，「Lighthouse 崩了」要去看
    // Chrome 和依赖。把两件事混成一件，排障就会从第一步走错。
    let timedOut = false;

    const outcome = await new Promise((resolve) => {
      timer = setTimeout(async () => {
        timedOut = true;
        const { confirmed } = await killProcessTree(child);
        killConfirmed = confirmed;
        resolve({ reason: RUNNER_REASONS.TIMEOUT });
      }, timeoutMs);

      child.once("error", () => {
        if (timedOut) return;
        resolve({ reason: RUNNER_REASONS.CRASHED });
      });
      child.once("exit", (code) => {
        // 已经进入超时处置的话，这次 exit 正是我们自己杀出来的，不是崩溃。
        if (timedOut) return;
        resolve(code === 0 ? { reason: null } : { reason: RUNNER_REASONS.CRASHED, code });
      });
    });
    clearTimeout(timer);

    // 非零退出**不等于**我们崩了——先去看有没有报告。
    //
    // 2026-08-06 用 miaowageo.com 实测撞到的归因缺陷：该站托管在北京，
    // 从首尔的检测机根本连不通，Lighthouse 以 `NO_FCP` 结束并**非零退出**，
    // 但它**已经把报告写出来了**，里面清清楚楚写着
    // `runtimeError.code = "NO_FCP"`——而 NO_FCP 在 checks/lighthouse-map.mjs
    // 的 TARGET_SIDE_RUNTIME_ERRORS 里，属于**对方侧**（页面没能渲染出内容）。
    //
    // 旧实现一看退出码非 0 就直接返回 crashed，那份报告连读都不读，
    // 于是「目标站加载不出来」被记成「我们的 Lighthouse 崩了」——
    // 分类表写对了，接线把它跳过了。这正是本仓库反复出现的形态。
    //
    // 超时是唯一的例外：那份报告（如果有）来自一次被我们中途掐断的运行，
    // 不完整也不可信，必须按我方侧处理。
    const timedOutBranch = outcome.reason === RUNNER_REASONS.TIMEOUT;

    let report = null;
    if (!timedOutBranch) {
      try {
        report = JSON.parse(await readFile(outputPath, "utf8"));
      } catch {
        report = null;
      }
    }

    if (report) {
      // 有报告就以报告为准，退出码只作为参考。报告里带 runtimeError 时，
      // 归因交给 lighthouse-map.mjs 的分类表，那里区分对方侧与我方侧。
      return { report, reason: null, durationMs: Date.now() - startedAt, killConfirmed, stderrTail: outcome.reason ? stderr.slice(-1024) : undefined };
    }

    if (outcome.reason) {
      return { report: null, reason: outcome.reason, durationMs: Date.now() - startedAt, killConfirmed, stderrTail: stderr.slice(-1024) };
    }

    // 退出码 0 却没有可解析的报告：这确实是我们这边的问题。
    return { report: null, reason: RUNNER_REASONS.BAD_REPORT, durationMs: Date.now() - startedAt, killConfirmed, stderrTail: stderr.slice(-1024) };
  } finally {
    clearTimeout(timer);
    // 无论走哪条路径都要放开信号量。漏放一次，这台机器的深检查就永久 503——
    // 而且不会有任何报错，只会表现成「深检查总是容量不足」。
    SEMAPHORE.busy = false;
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
