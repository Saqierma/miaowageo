import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";

import { assertNoProxyEnv, assertValidOwnPublicIp } from "./fetchers/net-guard.mjs";
import { runLightAudit as defaultRunLightAudit } from "./orchestrate-light.mjs";
import { safeFetch as defaultSafeFetch } from "./fetchers/safe-fetch.mjs";
import { runDeepAudit as defaultRunDeepAudit, DEEP_TIMEOUT_MS, RobotsDisallowedError } from "./orchestrate-deep.mjs";
import { runProbeAudit as defaultRunProbeAudit } from "./orchestrate-probe.mjs";
import { startAllowlistProxy as defaultStartAllowlistProxy } from "./proxy/allowlist-proxy.mjs";

/**
 * HTTP 边界。只做四件事：Bearer 鉴权、并发池、超时、把结果序列化成 JSON。
 * 判断逻辑一律不在这里——那是 orchestrate-light.mjs 和 checks/*.mjs 的职责。
 *
 * ---------------------------------------------------------------------------
 * 请求 / 响应 JSON 形状（本文件自定，刻意保持最小）：
 *
 *   POST /audit/light
 *   Header: Authorization: Bearer <MIAOWA_AUDIT_WORKER_TOKEN>
 *   Body:   { "url": "https://example.com/" }
 *
 *   200 成功：直接透传 runLightAudit() 的返回形状，外面套一层 { ok: true, ... }：
 *     { ok: true, baseUrl, finalUrl, robotsAllowedPage, results: CheckResult[] }
 *
 *   200 超时（8 秒硬超时触发，见下方 AUDIT_TIMEOUT_MS）：
 *     { ok: false, reason: "worker_error", results: [] }
 *     状态码仍是 200——超时是本服务契约里「已知的正常退化路径」（呼应
 *     fetch-outcome.mjs 里 worker_error 到 not_wired 的语义），不是传输层故障，
 *     主站按 body 里的 ok/reason 字段处理，不需要特判 HTTP 状态码。
 *
 *   500 意外内部异常（runLightAudit 本身抛错，超时之外的情况）：
 *     { ok: false, reason: "worker_error", results: [] }
 *     与超时共用同一个 body 形状，但状态码不同——500 留给「这次真的是我们的
 *     代码坏了」，方便运维从访问日志的状态码分布里把两类问题分开看。
 *
 *   401 鉴权失败：       { ok: false, reason: "unauthorized" }
 *   503 并发池已满：     { ok: false, reason: "capacity" }（不排队，立即拒绝）
 *   400 请求体不合法：   { ok: false, reason: "bad_request" }
 *   404 路由不匹配：     { ok: false, reason: "not_found" }
 * ---------------------------------------------------------------------------
 */

export const DEFAULT_PORT = 4319;

// 轻检查并发池 20，满则立即 503，不排队（设计文档第三节，不得回退）。
export const MAX_CONCURRENCY = 20;

// 轻检查 Worker 硬超时。
//
// D1/D4（2026-08-06 首次真实部署时实测发现）：这里原本是 8000，注释写
// 「最坏 3.0 + 1.2 + 3.5 = 7.7 s」——那条算式**算漏了预飞的 3.0 s**。
// 它照抄了设计文档的结论，却没照抄它的前提（文档假设预飞不占预算），
// 而实现里预飞就在 runLightAudit 内部，被本超时一并包住。
//
// 真实最坏路径，逐项写清楚，不要再简写：
//
//   3.0  预飞规范化      PREFLIGHT_TIMEOUT_MS
// + 3.0  robots.txt      ROBOTS_TIMEOUT_MS
// + 1.2  子请求错开       TARGET_STAGGER_COUNT(4) × DEFAULT_THROTTLE_INTERVAL_MS(300ms)
// + 3.5  最后一个子请求   TARGET_TIMEOUT_MS
// ─────
//  10.7 s  <  11 s ✓
//
// 后果不是「慢」，是**归错责任**：撞上硬超时后整次审计变成
// worker_error → 全部 not_wired（我方没测成）。而实测撞上它的 hm.com、
// muji.com 是对方的机器人防护在 TLS 握手后掐断连接——那是**对方侧的事实**，
// 本该是 no_data。设计文档「每个子请求独立超时是正确性要求，不是优化」
// 那一段防的就是这件事，第一次真实跑就撞上了。
//
// 实测发生率：跨境/外贸 B2B 24 站 0 次（最慢 exporthub.com 7214 ms，
// 已用掉旧预算的 90%）；消费零售大牌 12 站 3 次（hm/uniqlo/muji）。
//
// 改这个数之前先看 tests/server.test.mjs 里那条**真的做加法**的断言。
export const AUDIT_TIMEOUT_MS = 11000;

/**
 * 探针阶段的硬超时。
 *
 * 七个探针 + 一次 robots.txt = 8 个请求，全部串行、共用 safe-fetch 的
 * 300ms 同源节流：节流铺开约 2.4s，每个请求自身上限 4s。
 * 最坏路径 2.4 + 4 = 6.4s，取 15s 留足余量。
 *
 * **它有自己的并发池，不与深检查共用。** 深检查要起 Chrome、吃 1~2 GB、
 * 全局只允许一个；而这一阶段只发几个 HTTP 请求。把便宜且高价值的东西
 * 排在昂贵且稀缺的东西后面没有道理。
 */
export const PROBE_TIMEOUT_MS = 15000;
export const PROBE_MAX_CONCURRENCY = 4;

// 请求体只装一个 URL 字符串；16 KB 已经非常宽松，同时挡掉恶意超大 body
// 在读完之前就把内存吃满——呼应 safe-fetch.mjs 对响应体设的同类上限。
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 逐块累加，一旦超过上限立刻中止读取——不能等读完整个 body 再检查长度。 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("请求体超过上限"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** 常量时间比较，避免逐字节比较 token 时的计时侧信道。长度不等时直接判负，不进入比较。 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf-8");
  const bufB = Buffer.from(String(b ?? ""), "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function checkAuth(req, token) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return safeEqual(match[1], token);
}

const TIMEOUT = Symbol("audit-timeout");

/** 返回一个到点 resolve 的 promise 及其 cancel()；赢家已定后必须 cancel，避免定时器悬空阻止进程退出。 */
function timeoutAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * 一个模块级信号量：占用中直接拒绝，不设等待队列（设计文档「任何一侧都不排队」）。
 * acquire() 满员时返回 null；否则返回一个幂等的 release()。
 */
function createConcurrencyGate(max) {
  let count = 0;
  return {
    acquire() {
      if (count >= max) return null;
      count += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count -= 1;
      };
    },
  };
}

/**
 * 构造 node:http 的请求监听函数。依赖全部注入：
 *   - token：鉴权比对的期望值（必填，通常来自 MIAOWA_AUDIT_WORKER_TOKEN）
 *   - runLightAudit / safeFetch：生产用真实实现，测试用假实现，保证本文件的测试不联网
 *   - maxConcurrency / timeoutMs：覆盖默认值，测试用更小的值加速用例
 *
 * 并发计数的 release() 绑定在“真实工作完成”上（audit 的 promise 本身 settle 时），
 * 而不是绑定在“响应已经发出”上——超时那条路径先把响应发出去，但对应的 runLightAudit
 * 仍在后台跑，此时这个槽位仍然代表真实占用的资源，过早松开会让 20 的并发上限形同虚设。
 * 三条早退路径（路由不匹配、鉴权失败、并发池满）在拿到 release 之前就返回，本来就不持有槽位；
 * body 不合法这条路径已经 acquire 了槽位但还没开始真正的审计，必须显式 release()。
 */
export function createRequestListener(deps) {
  const {
    token,
    runLightAudit = defaultRunLightAudit,
    safeFetch = defaultSafeFetch,
    maxConcurrency = MAX_CONCURRENCY,
    timeoutMs = AUDIT_TIMEOUT_MS,
    // 深检查。deepEnabled 由 startServer() 的 assertDeepCheckConfig() 断言得出；
    // 默认 false 只对**直接构造 listener 的测试**生效，生产路径永远经过
    // startServer()，而它要求 MIAOWA_AUDIT_DEEP_ENABLED 显式写 "1"/"0"。
    deepEnabled = false,
    runDeepAudit = defaultRunDeepAudit,
    deepTimeoutMs = DEEP_TIMEOUT_MS,
    deepConfig = {},
    runProbeAudit = defaultRunProbeAudit,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    probeMaxConcurrency = PROBE_MAX_CONCURRENCY,
  } = deps ?? {};

  if (!token) {
    throw new Error("createRequestListener 需要 deps.token（通常取自 MIAOWA_AUDIT_WORKER_TOKEN）");
  }

  const gate = createConcurrencyGate(maxConcurrency);
  // 探针阶段独立的池：见 PROBE_TIMEOUT_MS 的注释。
  const probeGate = createConcurrencyGate(probeMaxConcurrency);

  return async function requestListener(req, res) {
    // 匿名公开端点，任何人都能连上来又中途掐断连接。req/res 在客户端异常断开时
    // 可能各自发出 'error'——EventEmitter 的 'error' 事件没有监听者时会被当成
    // 未捕获异常直接打崩进程。这里用空操作监听器兜底，把「客户端跑了」
    // 降级成静默丢弃，而不是让一个不相干客户端的异常网络行为拖垮整个服务。
    req.on("error", () => {});
    res.on("error", () => {});

    const isLight = req.method === "POST" && req.url === "/audit/light";
    const isDeep = req.method === "POST" && req.url === "/audit/deep";
    const isProbe = req.method === "POST" && req.url === "/audit/probe";

    if (!isLight && !isDeep && !isProbe) {
      sendJson(res, 404, { ok: false, reason: "not_found" });
      return;
    }

    if (!checkAuth(req, token)) {
      sendJson(res, 401, { ok: false, reason: "unauthorized" });
      return;
    }

    // 鉴权之后才回这个——不能让未鉴权的调用方靠状态码探出本机开了哪些能力。
    // 用 deep_disabled 而不是 404：两者在排障时含义完全不同，
    // 404 是「地址打错了」，deep_disabled 是「地址对，这台机器没开这个能力」。
    if (isDeep && !deepEnabled) {
      sendJson(res, 503, { ok: false, reason: "deep_disabled", results: [] });
      return;
    }

    const release = (isProbe ? probeGate : gate).acquire();
    if (!release) {
      sendJson(res, 503, { ok: false, reason: "capacity" });
      return;
    }

    let url;
    let robotsAllowedPage;
    try {
      const rawBody = await readBody(req, MAX_BODY_BYTES);
      const parsed = JSON.parse(rawBody);
      if (typeof parsed?.url !== "string" || parsed.url.length === 0) {
        throw new Error("缺少合法的 url 字段");
      }
      new URL(parsed.url); // 只验证形态；真正的私网/SSRF 逐跳校验在 safeFetch 内部做。
      url = parsed.url;

      if (isDeep) {
        // 深检查必须由调用方显式带上轻检查得出的 robots 判定。
        //
        // 不给默认值、也不在这里自己去抓一次 robots：设计文档第三节的
        // 「深检查出站 UA 保持 Chrome 默认」这个取舍，成立的前提就是
        // 「启动前一定已经拿到 robots 判定」。缺这个字段时若默认放行，
        // 我们就会用浏览器 UA 去抓一个可能被禁止的路径；若默认禁止，
        // 又会把「调用方漏传」伪装成「该站禁止抓取」——一个我们从未
        // 观测到的事实。两种默认都是错的，所以只能要求显式传入。
        if (typeof parsed.robotsAllowedPage !== "boolean") {
          throw new Error("深检查必须显式传入 robotsAllowedPage（布尔）");
        }
        robotsAllowedPage = parsed.robotsAllowedPage;
      }
    } catch {
      release();
      sendJson(res, 400, { ok: false, reason: "bad_request" });
      return;
    }

    // 用一个内部永不 reject 的 promise 包住真实审计：无论成功、失败还是超时竞态谁先到，
    // release() 都通过这里唯一的 .finally() 触发恰好一次。
    const auditPromise = (async () => {
      try {
        if (isDeep) {
          const result = await runDeepAudit(url, { ...deepConfig, robotsAllowedPage });
          return { ok: true, result };
        }
        if (isProbe) {
          // 探针自己抓 robots.txt 并逐路径求值（见 orchestrate-probe.mjs）——
          // 与深检查不同，这里不需要调用方传 robotsAllowedPage：
          // 深检查那条要求成立的前提是「浏览器 UA 不受我们控制」，
          // 而探针的每一个 UA 都是我们自己选的，可以自己先读规则。
          const result = await runProbeAudit(url, { safeFetch });
          return { ok: true, result };
        }
        const result = await runLightAudit(url, { safeFetch });
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err };
      }
    })();
    auditPromise.finally(release);

    const { promise: timeoutPromise, cancel } = timeoutAfter(isDeep ? deepTimeoutMs : isProbe ? probeTimeoutMs : timeoutMs);
    const winner = await Promise.race([
      auditPromise.then((outcome) => ({ kind: "settled", outcome })),
      timeoutPromise.then(() => ({ kind: "timeout" })),
    ]);
    cancel();

    if (winner.kind === "timeout") {
      // 硬超时到点：连接不能再挂着。审计仍在后台跑，release() 会在它真正
      // settle 时触发（见上面 auditPromise.finally）。
      sendJson(res, 200, { ok: false, reason: "worker_error", results: [] });
      return;
    }

    // robots 禁止是**正常终态**，不是错误：设计文档第六节要求它落
    // skipped_robots，呈现层按 no_data 渲染（那是对方侧的事实，不是我方失败）。
    // 走 500/worker_error 会把它错记成我们没测成。
    if (!winner.outcome.ok && winner.outcome.error instanceof RobotsDisallowedError) {
      sendJson(res, 200, { ok: false, reason: "skipped_robots", results: [] });
      return;
    }

    if (!winner.outcome.ok) {
      // 记下来，否则一个真实的内部 bug 会在响应里坍缩成同一句「worker_error」
      // 悄悄消失，运维除了状态码分布什么都看不到。
      console.error(`[audit] ${isDeep ? "runDeepAudit" : isProbe ? "runProbeAudit" : "runLightAudit"} 内部异常：`, winner.outcome.error);
      sendJson(res, 500, { ok: false, reason: "worker_error", results: [] });
      return;
    }

    // Lighthouse 崩溃时把它的 stderr 尾部写进服务端日志。响应体里不带——
    // 那是给用户看的公开报告。没有这条，一次崩溃在日志里只剩「crashed」。
    if (winner.outcome.result?.lighthouseStderrTail) {
      console.error("[audit/deep] Lighthouse 未能完成，stderr 尾部：", winner.outcome.result.lighthouseStderrTail);
    }
    const { lighthouseStderrTail, ...publicResult } = winner.outcome.result ?? {};
    sendJson(res, 200, { ok: true, ...publicResult });
  };
}

/**
 * 启动时确定是否启用 TLS，并在启用时把证书与私钥读进来。
 *
 * **`MIAOWA_AUDIT_TLS` 没有默认值，必须显式写 "1" 或 "0"**，理由与
 * MIAOWA_AUDIT_DEEP_ENABLED 完全一样：一个「默认关闭」的 TLS，
 * 在运维忘了配置时的表现是「服务正常启动、跨境调用悄悄退回明文」——
 * 而明文意味着 Bearer token 在网上裸奔。这种降级必须是**有人明确选的**，
 * 不能是忘了配的副产品。
 *
 * 允许 "0"（明文）的唯一正当场景：本机自测（curl 127.0.0.1:4319）。
 * 跨境部署必须是 "1"。
 */
export function assertTlsConfig(env, readFile = readFileSync) {
  const raw = env?.MIAOWA_AUDIT_TLS;
  if (raw !== "0" && raw !== "1") {
    throw new Error(
      `MIAOWA_AUDIT_TLS 必须显式设为 "1" 或 "0"（当前：${JSON.stringify(raw)}），拒绝启动：` +
        "不给默认值是刻意的——默认明文时，「忘了配 TLS」与「有意用明文自测」无法区分，" +
        "而前者会让 Bearer token 在跨境链路上裸奔",
    );
  }
  if (raw === "0") return { tls: null };

  const certPath = env.MIAOWA_AUDIT_TLS_CERT_PATH;
  const keyPath = env.MIAOWA_AUDIT_TLS_KEY_PATH;
  if (!certPath || !keyPath) {
    throw new Error("MIAOWA_AUDIT_TLS=1 时必须同时配 MIAOWA_AUDIT_TLS_CERT_PATH 与 MIAOWA_AUDIT_TLS_KEY_PATH，拒绝启动");
  }
  let cert;
  let key;
  try {
    cert = readFile(certPath);
    key = readFile(keyPath);
  } catch (err) {
    // 读不到证书时**拒绝启动**，而不是退回明文。退回明文是最坏的处置：
    // 服务看起来好好的，主站那边的指纹校验会失败并把它记成「Worker 挂了」，
    // 而真正的原因（证书文件权限错了）没人看得见。
    throw new Error(`读取 TLS 证书/私钥失败（${err.message}），拒绝启动——绝不退回明文`);
  }
  return { tls: { cert, key } };
}

/**
 * 启动时确定深检查是否启用，并在启用时断言它需要的每一项配置都在。
 *
 * **`MIAOWA_AUDIT_DEEP_ENABLED` 没有默认值，必须显式写 `"1"` 或 `"0"`。**
 * 这与 `types.mjs` 里 `scored` 必须显式传入是同一条理由：一个「默认关闭」的
 * 深检查，在运维忘了配置时的表现是「服务正常启动、深检查静默不可用」——
 * 而那与「深检查坏了」在外部完全无法区分。逼运维写一个字符，
 * 换的是「这台机器到底该不该跑深检查」有一个明确答案。
 *
 * D3（2026-08-06 实测发现）：PSI 密钥文件 `seo+geo工具/.env.local.txt` 里的
 * 变量名是 `Google_PSI_API_key`，而代码与设计文档约定的是 `GOOGLE_PSI_API_KEY`。
 * 大小写不匹配时读到的是 `undefined`，无密钥调用 PSI 会直接拿到 **429**——
 * 于是 performance 组一片 not_wired，运维看到的现象是「PSI 配额耗尽」，
 * 而真相是「变量名写错了」。这两件事的处置方式完全相反（等配额恢复 vs 改配置），
 * 所以必须在启动期就把它们分开：密钥缺失 = 拒绝启动，绝不允许带病跑到线上
 * 再伪装成配额问题。
 */
export function assertDeepCheckConfig(env) {
  const raw = env?.MIAOWA_AUDIT_DEEP_ENABLED;
  if (raw !== "0" && raw !== "1") {
    throw new Error(
      `MIAOWA_AUDIT_DEEP_ENABLED 必须显式设为 "1" 或 "0"（当前：${JSON.stringify(raw)}），拒绝启动：` +
        "不给默认值是刻意的——默认关闭时，「忘了配」与「深检查坏了」在外部无法区分",
    );
  }
  if (raw === "0") return { deepEnabled: false };

  if (!env.GOOGLE_PSI_API_KEY) {
    throw new Error(
      "深检查已启用（MIAOWA_AUDIT_DEEP_ENABLED=1）但缺少 GOOGLE_PSI_API_KEY，拒绝启动：" +
        "无密钥调用 PSI 会拿到 429，报告里会表现成「配额耗尽」，掩盖掉真正的原因是配置缺失。" +
        "注意密钥文件里的变量名可能是 Google_PSI_API_key，大小写必须改成 GOOGLE_PSI_API_KEY",
    );
  }
  if (!env.MIAOWA_AUDIT_CHROME_PATH) {
    throw new Error(
      "深检查已启用但缺少 MIAOWA_AUDIT_CHROME_PATH，拒绝启动：" +
        "Lighthouse 找不到 Chrome 时的报错发生在子进程里，会被归成「Lighthouse 崩溃」，" +
        "同样掩盖掉真正的原因",
    );
  }
  return { deepEnabled: true };
}

/**
 * 启动 HTTP 服务。assertNoProxyEnv / assertValidOwnPublicIp 必须是这里最先做的事，
 * 且必须是同步的、在创建/监听任何端口之前——本服务与 sing-box 共享主机，代理
 * 环境变量存在、或本机公网 IP 配错时，私网防线不可靠（详见 net-guard.mjs 顶部
 * 与 assertValidOwnPublicIp 的注释），宁可拒绝启动也不要带病运行。
 *
 * env 可注入（测试用假环境模拟“存在代理变量”/“IP 配错”，不必污染真实 process.env）。
 */
export function startServer({
  env = process.env,
  port = Number(env.PORT) || DEFAULT_PORT,
  token = env.MIAOWA_AUDIT_WORKER_TOKEN,
  runLightAudit,
  safeFetch,
  maxConcurrency,
  timeoutMs,
  assertNoProxy = assertNoProxyEnv,
  assertOwnPublicIp = assertValidOwnPublicIp,
  assertDeepConfig = assertDeepCheckConfig,
  assertTls = assertTlsConfig,
  startAllowlistProxy = defaultStartAllowlistProxy,
  runDeepAudit,
} = {}) {
  assertNoProxy(env);
  // M6/D2：MIAOWA_AUDIT_OWN_PUBLIC_IP 缺失或打错一个字符，assertNotOwnPublicIp()
  // 的字符串比较就永远不会命中——这条检查会静默失效，所以放在启动路径上，
  // 用同步抛错宁可拒绝启动。
  assertOwnPublicIp(env);
  // D3：深检查的配置缺失会伪装成「PSI 配额耗尽」「Lighthouse 崩溃」这类
  // 完全不同的故障，处置方向相反。在启动期分开。
  const { deepEnabled } = assertDeepConfig(env);
  const { tls } = assertTls(env);

  if (!token) {
    throw new Error("缺少 MIAOWA_AUDIT_WORKER_TOKEN，拒绝启动");
  }

  // 到这里为止全部是**同步**的。这不是风格偏好：上面每一条都是
  // 「配置有问题就绝不带病运行」的把关，而 startServer 的调用方
  // （src/server.mjs 底部的 isMain 分支、以及测试）依赖「配置问题以
  // 同步异常呈现、且发生在监听任何端口之前」这个性质。
  // 下面真正的启动过程需要 await（要先把 allowlist 代理起起来），
  // 所以包进一个内部 async 函数，而不是把 startServer 自己变成 async——
  // 后者会把上面的同步抛错统统变成 rejected promise。
  return startListening();

  async function startListening() {

    // 深检查启用时**必须**把 allowlist 代理真的起起来。
    //
    // 这条接线曾经漏掉过：代理模块写完了、13 条测试全绿，但没有任何地方
    // 调用 startAllowlistProxy()——Chrome 会去连一个不存在的 127.0.0.1:4320。
    // 那不会静默放行（Chrome 连不上代理就报错），但故障现象会变成
    // 「所有深检查都失败」，而真正的原因是「代理压根没启动」。
    //
    // 这正是本仓库反复出现的形态：**守卫本身正确，在集成处失效**。
    // 下面的 proxyPort 断言与 tests/server.test.mjs 里那条「深检查启用时
    // 必须启动代理」的测试，就是为了让这条接线不能再被悄悄拆掉。
    const deepProxy = deepEnabled ? await startAllowlistProxy({
      port: Number(env.MIAOWA_AUDIT_PROXY_PORT) || 0,
      ownPublicIp: env.MIAOWA_AUDIT_OWN_PUBLIC_IP,
    }) : null;

    const listener = createRequestListener({
      token,
      runLightAudit,
      safeFetch,
      maxConcurrency,
      timeoutMs,
      deepEnabled,
      runDeepAudit,
      deepConfig: {
        psiApiKey: env.GOOGLE_PSI_API_KEY,
        chromePath: env.MIAOWA_AUDIT_CHROME_PATH,
        nodePath: env.MIAOWA_AUDIT_NODE_PATH ?? process.execPath,
        lighthouseBin: env.MIAOWA_AUDIT_LIGHTHOUSE_BIN,
        // 用代理**实际监听**的端口，不是配置里写的那个。端口配 0 时由内核
        // 分配；即使配了固定端口，也该以实际值为准——两者不一致时
        // Chrome 会连到一个没人监听的端口，而配置文件看起来完全正常。
        proxyPort: deepProxy?.port,
      },
    });
    // 并发槽位在 gate.acquire() 成功、body 读完之前就已经占用（见 createRequestListener
    // 顶部注释）。若不限制"接收完整请求"本身能花多久，一个只发头不发（或慢速trickle）body
    // 的客户端能把槽位挂到 Node 默认的 5 分钟超时——20 个这样的连接就能把并发池锁死一整个下午，
    // 且完全绕开下面 8 秒的审计硬超时（那个计时器根本还没启动）。这里的请求体只装一个 URL
    // 字符串，收完整请求应当近乎瞬时，10 秒已经是很宽松的上限。
    // TLS 启用时用 https，否则明文 http。两条路的超时参数完全一致——
    // 那两个超时守的是「慢速 body」这类攻击，与传输层加不加密无关。
    const serverOptions = { requestTimeout: 10_000, headersTimeout: 8_000 };
    const httpServer = tls
      ? createHttpsServer({ ...serverOptions, cert: tls.cert, key: tls.key }, listener)
      : createHttpServer(serverOptions, listener);

    const server = await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, () => resolve(httpServer));
    });

    // 让调用方关服务时把代理一起收掉，否则测试与优雅重启都会漏一个监听中的
    // socket 出去。
    const originalClose = server.close.bind(server);
    server.close = (cb) => originalClose(async () => {
      await deepProxy?.close();
      cb?.();
    });
    server.deepProxyPort = deepProxy?.port ?? null;
    server.tlsEnabled = Boolean(tls);
    return server;
  }
}

// 只有直接 node src/server.mjs 运行时才真正启动监听；被 import（测试）时不产生副作用。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // startServer() 对 assertNoProxyEnv / 缺 token 是同步抛错（测试靠这一点用 assert.throws
  // 直接断言，不必 await）。这里用 Promise.resolve().then() 把调用推迟到微任务里，
  // 让同步抛错也能被下面的 .catch() 收住，而不是变成未捕获异常、把进程带崩且不打印中文提示。
  Promise.resolve()
    .then(() => startServer())
    .then((server) => {
      const { port } = server.address();
      console.log(`site-audit-worker 已监听 :${port}（${server.tlsEnabled ? "TLS" : "明文 HTTP"}）`);
    })
    .catch((err) => {
      console.error(`拒绝启动：${err.message}`);
      process.exitCode = 1;
    });
}
