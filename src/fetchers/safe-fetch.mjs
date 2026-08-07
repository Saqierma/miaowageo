import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import zlib from "node:zlib";

import { isPrivateAddress, sameRegistrableDomain, resolveAndGuard, assertNotOwnPublicIp, GuardError, GUARD_ERROR_CODES } from "./net-guard.mjs";

/**
 * safe-fetch —— 本 Worker 唯一的出网入口。
 *
 * 契约：`safeFetch(url, options)` 永不抛出，统一返回
 * `{ ok, status, headers, body, finalUrl, reason }`，调用方（各 check 模块、
 * `fetch-outcome.mjs`）靠 `reason` 决定项级状态是 `no_data` 还是 `not_wired`。
 * `reason` 的封闭取值：`throttled`、`timeout`、`too_large`、
 * `cross_domain_redirect`、`too_many_redirects`、`private_address`、
 * `network`、`http_error`。新增取值必须同步更新 `fetch-outcome.mjs` 的映射表，
 * 否则会落到 `worker_error` 兜底，把「对方的问题」错记成「我们没测成」。
 *
 * 这里手动实现重定向跟随，而不是交给运行时自动跟随，原因是 net-guard 的
 * SSRF 防线只挡得住「我们自己调用的每一跳」——一次先落在公网、下一跳跳到
 * 169.254.169.254 或本机公网 IP 的重定向，如果自动跟随，防线形同虚设。
 *
 * C3（连接钉死，已闭合）：每一跳的实际请求不再用全局 `fetch()` 发出。
 * `guardHop()` 里 `resolveAndGuard()` 校验过的地址会被原样带到
 * `performRequest()`，通过 `node:http`/`node:https` 的 `lookup` 选项直接
 * 交给 socket 连接——不再触发针对同一个主机名的第二次独立 DNS 解析，
 * DNS-rebinding（权威 DNS 对两次查询给出不同答案）因此失去了可乘之机。
 * 放弃 `fetch()` 意味着要自己找回它免费带的两样东西：TLS SNI 与 Host 头
 * （`performRequest()` 显式把两者设成真实主机名，不是已钉死的 IP，否则
 * 证书校验和虚拟主机分发都会跟着错），以及 gzip/deflate/br 自动解压
 * （改由 `node:zlib` 在 `decompressStream()` 里显式处理）。两者都是
 * Node 22+ 的内建模块，没有引入新依赖。
 */

// ---------------------------------------------------------------------------
// 规范取值（来自设计文档第三节的时序预算表，不得另定）
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 3500;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const DEFAULT_THROTTLE_INTERVAL_MS = 300;

// 出站 UA：RFC 9309 的专属组匹配、以及故障矩阵里"标明来意"都靠它。
//
// 里面那个 URL 会出现在**每一个被检测站点的访问日志**里，是对方运维
// 唯一能顺着查到「这是谁在抓我」的线索。所以它必须是一个真的能打开的页面——
// 2026-08-07 工具页从 /check 改名到 /geocheck 时，这里同步改了；
// 留着旧地址虽然还能靠 308 跳过去，但让对方多跳一次才看到说明，
// 是我们这种「标明来意」的爬虫最不该省的一步。
export const OUTBOUND_USER_AGENT = "MiaowaGEO-Audit/1.0 (+https://miaowageo.com/geocheck; contact@miaowageo.com)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// 同源节流：模块级状态，逐跳都计入（编排层看不见重定向的中间跳，只有这里能做到）
// ---------------------------------------------------------------------------

// 记录的是"发起时刻"，不是"响应时刻"——见下方 throttleHost() 的注释。
const lastRequestStartedAt = new Map();

// Map 里的条目只在"最近一次节流窗口内"有意义；这是一个匿名公开服务，
// 提交的域名理论上无穷多，若从不清理，Map 会随进程存活时间无限增长。
// 300 ms 的节流间隔用不到这么久的历史，60 s 是留足够余量后的保守选择。
const THROTTLE_ENTRY_TTL_MS = 60_000;

let defaultThrottleIntervalMs = DEFAULT_THROTTLE_INTERVAL_MS;

/** 供调用方覆盖全局节流间隔，而不必逐处传参（批量检测时常需要放慢）。 */
export function setDefaultThrottleIntervalMs(ms) {
  defaultThrottleIntervalMs = ms;
}

/** 供测试重置节流状态，避免前一个测试用例的请求历史影响下一个。 */
export function resetThrottleState() {
  lastRequestStartedAt.clear();
}

function pruneThrottleMap(now) {
  for (const [host, startedAt] of lastRequestStartedAt) {
    if (now - startedAt > THROTTLE_ENTRY_TTL_MS) lastRequestStartedAt.delete(host);
  }
}

// 可被 signal 提前中断的 delay：如果整链的超时已经到了，没必要傻等节流窗口
// 走完再去发一个注定失败的请求——直接把等待权交还给调用方，让实际发起请求
// 那一步（performRequest / 注入的 transport）去产出真正的 timeout 结果。
//
// 注意：signal 若已经处于 aborted 状态，再对它 addEventListener("abort", …)
// 不会补发一次事件（DOM 事件语义如此）——必须显式检查 signal.aborted，
// 否则超时已到期时这里会傻等满 ms 才返回，白白拖长失败响应的时间。
//
// M7：signal 是覆盖整条重定向链的同一个 AbortSignal.timeout()，一次
// safeFetch 调用里 throttleHost 每一跳都可能新建一个 delay()。旧实现里
// timer 先赢的那条路径（正常情况——节流等待正常到点）不会移除 abort
// 监听器，监听器要一直挂到整条链的 signal 最终触发（或者永远不触发）才会
// 被动清理，多跳重定向会在同一个 signal 上累积好几个不会再被用到的监听器。
// 这里让 timer 赢的分支也主动 removeEventListener，两条路径都自己收尾。
function delay(ms, signal) {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 节流按"距上一次向该主机发起请求"计，起算点是发起时刻而不是响应时刻。
 * 键只用主机名（不含端口）：生产场景里同一个被审计域名的子请求端口恒定，
 * 这样设计才能让"同源节流"名副其实；本地测试里多个用例共用 127.0.0.1
 * 只是端口不同，会有轻微的跨用例节流延迟，但不影响正确性。
 *
 * C2：设计文档要求五个子请求并行发起，节流完全靠这一个函数兜底——
 * 早期实现是"读 Map → await 等待 → 写 Map"，读到写之间隔着一次 await，
 * N 个并发调用会在 await 之前读到同一个 last，算出同一个 waitMs，
 * 然后一起醒来同时放行，节流形同虚设（实测 5 个并发请求 9ms 内全部打到目标）。
 * 这里改成"同步预定档期"：读 Map、算 slot、写 Map 之间不能有 await，
 * 让并发调用在 JS 单线程的同一个 tick 内依次拿号，job 之间必然错开
 * intervalMs；只有算出的等待时间才去 await。
 */
async function throttleHost(host, intervalMs, signal) {
  const now = Date.now();
  pruneThrottleMap(now);
  const last = lastRequestStartedAt.get(host);
  // 同步预定档期：读到写之间不能有 await，否则并发调用会读到同一个 last 而同时放行
  const slot = last === undefined ? now : Math.max(now, last + intervalMs);
  lastRequestStartedAt.set(host, slot);
  const waitMs = slot - now;
  if (waitMs > 0) await delay(waitMs, signal);
}

// ---------------------------------------------------------------------------
// 逐跳 SSRF 守卫
// ---------------------------------------------------------------------------

/** 内部用的守卫拒绝信号，携带 reason 以便直接映射到 safeFetch 的返回值。 */
class GuardRejection extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

function stripBrackets(hostname) {
  return hostname.replace(/^\[|\]$/g, "");
}

/**
 * 让一个不认识 AbortSignal 的 promise 也能被整链超时截停。
 *
 * `resolveAndGuard()` 内部是 `dns.lookup()`，node:dns/promises 不支持传入
 * signal——一个恶意或失控的权威 DNS 迟迟不响应，就能让 DNS 解析本身
 * 无限期挂起，绕开我们对"每个请求必须在 timeoutMs 内结束"的承诺。
 * 这里用 race 兜底：拿不到真正取消底层 DNS 查询的能力（它可能在后台
 * 继续跑到自然结束），但至少保证调用方不会被它拖过整链预算。
 */
function withSignal(promise, signal) {
  if (signal.aborted) {
    // 早退之前必须先给 promise 挂一个空 catch：它仍然可能在后台跑完并 reject，
    // 没人等待的 rejection 会被 Node 记成 unhandledRejection。
    promise.catch(() => {});
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

/**
 * 校验单跳的目标主机。返回值是 `{ hostname, pinnedAddress }`：`hostname` 是
 * 校验通过后的裸主机名（供节流用作键），`pinnedAddress` 是
 * `resolveAndGuard()` 校验过的地址之一（未做校验时为 `undefined`）——
 * 调用方把它原样交给 `performRequest()` 做连接钉死，是 C3 修复的关键接线：
 * 校验用的地址和实际建连用的地址必须是同一个，否则钉死没有意义。
 *
 * 顺序很关键，三条测试分别钉住三个阶段：
 *   1. 先用 isPrivateAddress 对字面量 IP 做同步判断（不需要 DNS）——
 *      这一步必须先于跨域比较，否则"重定向到 169.254.169.254"会被
 *      误判成"跨域"（IP 字面量套用可注册域算法本来就没有意义）。
 *   2. 再比较可注册域——跨域的目标（如 evil.example）到这里就会被拒绝，
 *      从而不会走到下一步的真实 DNS 解析，避免了对一个不存在的域名
 *      发起真实查询（既拖慢测试，也没有必要）。
 *   3. 最后才对同域的域名目标做 resolveAndGuard + assertNotOwnPublicIp——
 *      因为 isPrivateAddress(hostname) 只认字面量 IP，
 *      `internal.corp.example → 10.0.0.1` 这种"域名指向私网"必须解析后才能拦。
 *
 * `allowPrivate` 只在"这一跳的主机名与起始主机名完全相同"时才生效——
 * 这就是测试用的本地 127.0.0.1 服务器能被访问、但重定向到
 * 169.254.169.254 仍然会被拒绝的原因：后者是不同的主机名，不享受豁免。
 * 命中这个豁免（`bypass === true`）时 `resolveAndGuard` 整个被跳过，
 * 自然也拿不到可钉死的地址——`pinnedAddress` 是 `undefined`，
 * `performRequest()` 会退回让 Node 用正常方式解析主机名。这不是安全回退：
 * `allowPrivate` 本身就是仅供测试的开关，生产调用永远不传。
 *
 * `resolve` 是仅供测试注入的 DNS 解析函数，原样透传给 `resolveAndGuard`——
 * 和 `allowPrivate` 一样的用法。I1：这条注入通道以前根本不存在，`guardHop`
 * 无参数调用 `resolveAndGuard(bare)`，net-guard 里为测试专门留的 `resolve`
 * seam 从 safe-fetch 这一层完全够不到，导致"域名解析到私网"这条最容易漏的
 * 防线在本文件的测试里从未被真正执行过——删掉整个 resolveAndGuard 调用，
 * safe-fetch 自己的测试套件照样全绿。
 */
async function guardHop(hostname, { baseHost, allowPrivate, ownIp, signal, resolve }) {
  const bare = stripBrackets(hostname);
  const bypass = allowPrivate && bare === baseHost;

  if (!bypass && isPrivateAddress(bare)) {
    throw new GuardRejection("private_address", `目标主机 ${bare} 是私网/保留网段的字面量地址`);
  }

  if (!sameRegistrableDomain(bare, baseHost)) {
    throw new GuardRejection("cross_domain_redirect", `重定向目标 ${bare} 与起始域 ${baseHost} 不属于同一可注册域`);
  }

  let pinnedAddress;
  if (!bypass) {
    let addresses;
    try {
      addresses = await withSignal(resolveAndGuard(bare, { resolve }), signal);
    } catch (err) {
      // 整链超时先于 DNS 解析结果到达：必须归 timeout，不能归 network——
      // 我们自己的预算到点了，不是对方 DNS 出了问题。
      if (signal.aborted) {
        throw new GuardRejection("timeout", "DNS 解析超出整链超时预算");
      }
      // I3：改用 net-guard 抛出的 GuardError.code 做分类，不再用正则匹配中文
      // 错误文案——文案随手一改就会让正则静默失配，把"我们主动拒绝的私网
      // 地址"错误地归类成"network"（对方的问题），这类回归不会在测试里报错，
      // 只会在生产里悄悄失效。
      if (err instanceof GuardError && err.code === GUARD_ERROR_CODES.PRIVATE_ADDRESS) {
        throw new GuardRejection("private_address", err.message);
      }
      throw new GuardRejection("network", err.message);
    }
    try {
      assertNotOwnPublicIp(addresses, ownIp);
    } catch (err) {
      // I3：以前这里不分青红皂白，把 assertNotOwnPublicIp 抛出的任何错误都
      // 盖章成 private_address；现在先确认这确实是它自己抛出的、带类型标记的
      // 拒绝，不是别的意外异常（比如它自己的一个真实 bug），再做映射，
      // 否则会把"我们的代码坏了"悄悄伪装成"安全拦截生效了"。
      if (err instanceof GuardError && err.code === GUARD_ERROR_CODES.OWN_PUBLIC_IP) {
        throw new GuardRejection("private_address", err.message);
      }
      throw err;
    }
    // C3：resolveAndGuard 校验过的地址不止一个时，钉死用第一个——数组里每一个
    // 都已经逐一过了 isPrivateAddress，选哪个都安全，选第一个只是图确定性。
    [pinnedAddress] = addresses;
  }

  return { hostname: bare, pinnedAddress };
}

// ---------------------------------------------------------------------------
// 连接钉死（connection pinning）—— C3 的核心
// ---------------------------------------------------------------------------

/**
 * 构造一个 `node:http`/`node:https` 的 `lookup` 选项：签名与 `dns.lookup`
 * 相同，但不做任何真实解析，直接把 `guardHop()` 校验过的地址回调回去。
 * `net.connect`/`tls.connect` 在决定往哪个 IP 建连时只认这个函数的结果——
 * 这就是"钉死"的机制本身：从 DNS 解析到实际建连之间不再有第二次查询，
 * 也就没有 DNS-rebinding 可以利用的窗口。
 *
 * 必须处理 `options.all` 这个分支：Node 的 happy-eyeballs 连接逻辑
 * （`lookupAndConnectMultiple`）以 `{ all: true }` 调用 `lookup`，
 * 期望回调传一个 `[{address, family}]` 数组，而不是单个地址——传错形状
 * 会在 `net` 内部炸出 `ERR_INVALID_IP_ADDRESS`（实测复现过）。
 *
 * 导出仅为可测性：连接钉死是一条**没有可观测输出**的安全机制——它正确时
 * 与不正确时，safeFetch 的返回值一模一样。变异测试证实过：把下面 `options.lookup`
 * 那一行删掉，safe-fetch 的 24 条测试全部照旧通过。只有直接对这个原语和
 * `performRequest` 断言，才可能把"钉死没生效"变成一个会红的测试。
 */
export function makePinnedLookup(address) {
  const family = isIP(address) || 4;
  return (_hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options ?? {};
    if (opts.all) {
      cb(null, [{ address, family }]);
    } else {
      cb(null, address, family);
    }
  };
}

/**
 * 执行单跳的实际 HTTP(S) 请求，是 `safeFetch()` 默认使用的 `transport`。
 *
 * 三件事撑起 C3 的修复：
 *   1. `pinnedAddress` 存在时通过 `lookup` 选项钉死连接目标——不给
 *      `net`/`tls` 任何机会重新解析主机名。
 *   2. `hostname`/`servername`/`Host` 头永远是真实主机名，不是钉死的 IP——
 *      否则 TLS 证书校验和虚拟主机分发都会跟着错（很多目标站靠 Host 头
 *      在同一个 IP 上分发多个域名）。
 *   3. `agent: false`：每一跳都是刚校验过的独立地址，绝不能让 keep-alive
 *      连接池把这次连接复用给下一跳——下一跳很可能钉死的是完全不同的地址，
 *      复用连接会悄悄绕开这一跳自己的钉死结果。
 *
 * 不做自动解压——响应体的 gzip/deflate/br 解压是 `readBodyCapped()` 那边
 * 用 `node:zlib` 显式做的（放弃 `fetch()` 之后必须自己找回这一块）。
 *
 * 导出仅为可测性，理由同 `makePinnedLookup`：钉死生效与否不改变 safeFetch
 * 的任何返回值，只有直接调用这一层、用一个**保证永不解析**的主机名
 * （RFC 2606 的 `.invalid`）当靶子，"钉死失效"才会表现为一个失败的测试。
 */
export function performRequest(targetUrl, { pinnedAddress, signal }) {
  return new Promise((resolvePromise, reject) => {
    const isHttps = targetUrl.protocol === "https:";
    const mod = isHttps ? httpsRequest : httpRequest;
    const port = targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80;
    const options = {
      method: "GET",
      hostname: targetUrl.hostname,
      port,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: {
        host: targetUrl.host,
        "user-agent": OUTBOUND_USER_AGENT,
      },
      signal,
      agent: false,
    };
    if (pinnedAddress) {
      options.lookup = makePinnedLookup(pinnedAddress);
    }
    if (isHttps) {
      options.servername = targetUrl.hostname;
    }
    const req = mod(options, (res) => resolvePromise(res));
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 响应处理
// ---------------------------------------------------------------------------

// Node 的 IncomingMessage.headers 已经是小写键的普通对象；重复出现的头
// （比如 Set-Cookie）会被 Node 聚成数组而不是逗号拼接的字符串，这里统一
// 拼成字符串，与之前 fetch() Headers.entries() 给出的形状保持一致。
function collectHeaders(res) {
  const headers = {};
  for (const [key, value] of Object.entries(res.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/**
 * 按 Content-Encoding 选一个 zlib 解压流接在响应体后面；无编码或不认识的
 * 编码原样透传。放弃 `fetch()` 之后，这是找回它免费带的 gzip/deflate/br
 * 自动解压的地方——现实世界里绝大多数网站都会启用压缩，这一步跟不上，
 * 几乎所有抓取都会拿到解压前的乱码。
 *
 * `rawStream.pipe(transform)` 不会在 `rawStream` 出错时自动 destroy
 * `transform`（Node stream 的一个已知坑）：源中途断开连接时，如果没有这行
 * 转发，下游读 `transform` 的 `for await` 会既不 resolve 也不 reject，
 * 直接挂住，直到整链超时的 signal 把 socket 强制切断才会解开——依赖那条
 * 兜底虽然不会真的死锁，但会把一个网络错误活活拖成一次 timeout，错误归因
 * 就错了。显式转发让错误立刻传导到下游。
 */
function decompressStream(rawStream, encoding) {
  const label = (encoding ?? "").trim().toLowerCase();
  let transform;
  if (label === "gzip" || label === "x-gzip") transform = zlib.createGunzip();
  else if (label === "br") transform = zlib.createBrotliDecompress();
  else if (label === "deflate") transform = zlib.createInflate();
  else return rawStream;
  rawStream.on("error", (err) => transform.destroy(err));
  return rawStream.pipe(transform);
}

// I2：Content-Type 里的 charset 参数，形如 `text/html; charset=GBK` 或
// `text/html; charset="gb2312"`。取不到时返回 null，调用方落回 utf-8。
function parseCharset(contentType) {
  if (!contentType) return null;
  const match = /charset\s*=\s*"?([^\s;"]+)"?/i.exec(contentType);
  return match ? match[1].trim() : null;
}

/**
 * 把响应体字节按 charset 解码成字符串。
 *
 * I2：此前这里统一按 utf-8 解码，对中文市场并非边角情况——GBK/GB2312/
 * Big5 在较老的中文网站上仍然常见。reviewer 实测 8 个 GBK 字节（4 个正确汉字）
 * 被硬解成 7 个替换字符，膨胀了约 1.75 倍；这个字符串又直接喂给
 * `visibleTextLength` 的字符数阈值（500 pass / 200 warn），
 * 于是一个只有 300 个真实字符的 GBK 页面被判成 pass，而不是 warn——
 * 一个直接展示给付费客户、还带分数的错误结论。
 *
 * `new TextDecoder(charset)`（Node 22+ 自带 full-icu）能处理 gbk 等常见编码；
 * label 未知/不受支持时 TextDecoder 构造函数会抛 RangeError，这里兜底回退到
 * utf-8，绝不能让一个奇怪的 Content-Type 声明直接搞挂整次抓取。
 */
function decodeBody(bytes, charset) {
  const label = (charset ?? "").trim().toLowerCase();
  if (label && label !== "utf-8" && label !== "utf8") {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // 未知/不支持的 charset 标签：回退 utf-8，而不是让整个请求因为对方
      // 网站声明了一个奇怪甚至拼错的 charset 而报错、把 no_data 变成 worker_error。
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 流式读取响应体，一旦累计字节数超过 maxBytes 立刻中止读取——
 * 不能先把整个响应缓冲进内存再判断长度，那样"上限"形同虚设：
 * 一个恶意或失控的目标站完全可以在检查长度之前就把内存吃满。
 *
 * 计的是解压后的字节数，不是线上传输的压缩字节数——和改造前 fetch() 时代
 * 的语义一致（`response.body` 当时也已经是解压后的流），也是
 * `visibleTextLength` 之类下游检查真正关心的尺寸。`decompressStream()`
 * 先解压，这里再按 maxBytes 计数，顺序不能反。
 */
async function readBodyCapped(res, maxBytes, charset) {
  const stream = decompressStream(res, res.headers["content-encoding"]);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      res.destroy();
      return { body: null, tooLarge: true };
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return { body: decodeBody(bytes, charset), tooLarge: false };
}

function failure(reason, finalUrl, extra = {}) {
  return { ok: false, status: null, headers: {}, body: null, finalUrl, reason, ...extra };
}

function isAbortLike(err, signal) {
  return signal.aborted || err?.name === "TimeoutError" || err?.name === "AbortError";
}

// ---------------------------------------------------------------------------
// 对外导出
// ---------------------------------------------------------------------------

/**
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3500] 覆盖整条重定向链的超时（不是每跳独立计时）
 * @param {number} [options.maxBytes=5MB] 响应体大小上限
 * @param {boolean} [options.allowPrivate=false] 仅供测试：放行"起始主机名"自身的私网校验，
 *   不影响重定向目标（见 guardHop 的注释）。生产调用绝不传 true。
 * @param {number} [options.throttleIntervalMs] 覆盖本次调用使用的节流间隔，默认取模块级配置
 * @param {Function} [options.resolve] 仅供测试：注入 resolveAndGuard 使用的 DNS 解析函数
 *   （同 net-guard.mjs 的 resolve 参数）。生产调用不传，落回默认的 dns.lookup。
 * @param {Function} [options.transport] 仅供测试：替换本跳实际发起请求的函数
 *   （签名同 `performRequest`：`(url, {pinnedAddress, signal}) => Promise<IncomingMessage 形状的响应>`）。
 *   生产调用不传，落回默认的 `performRequest`（node:http/https + 连接钉死）。
 *   存在的意义：有些测试场景（比如"跨子域重定向、且 resolveAndGuard 真的对
 *   新主机名执行了一次"）没法只用本地 127.0.0.1 服务器复现——resolveAndGuard
 *   对非起始主机名的私网地址永远拒绝，127.0.0.1 绕不开这条检查，
 *   这类测试因此需要在真正发起连接这一步整体替身。
 * @returns {Promise<{ok:boolean, status:number|null, headers:object, body:string|null, finalUrl:string|null, reason:string|null}>}
 */
export async function safeFetch(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    allowPrivate = false,
    throttleIntervalMs = defaultThrottleIntervalMs,
    resolve,
    transport = performRequest,
  } = options;

  let currentUrl;
  try {
    currentUrl = new URL(url);
  } catch {
    return failure("network", url);
  }

  const baseHost = stripBrackets(currentUrl.hostname);
  const ownIp = process.env.MIAOWA_AUDIT_OWN_PUBLIC_IP;
  // 覆盖整条重定向链的唯一 signal——这是"超时按单请求计"里"单请求"的真正含义：
  // 一次 safeFetch 调用（哪怕内部走了好几跳重定向）算一次请求。
  const signal = AbortSignal.timeout(timeoutMs);

  let hops = 0;

  while (true) {
    // 只放行 http/https。既拦住第一跳提交了别的协议的怪 URL，也拦住
    // "重定向到 file:// / ftp:// 等协议"这类花招——同主机同注册域的字符串
    // 比较拦不住协议切换，必须单独查协议。
    if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
      return failure("network", currentUrl.href);
    }

    let hop;
    try {
      hop = await guardHop(currentUrl.hostname, { baseHost, allowPrivate, ownIp, signal, resolve });
    } catch (err) {
      if (err instanceof GuardRejection) return failure(err.reason, currentUrl.href);
      return failure("network", currentUrl.href);
    }

    await throttleHost(hop.hostname, throttleIntervalMs, signal);

    // C3（已闭合）：guardHop 上面校验过的地址（hop.pinnedAddress）原样传给
    // transport（默认 performRequest），它通过 node:http/https 的 lookup
    // 选项把连接直接钉死在这个地址上——不再对同一个主机名发起第二次独立
    // DNS 解析，DNS-rebinding 没有可乘之机。
    let res;
    try {
      res = await transport(currentUrl, { pinnedAddress: hop.pinnedAddress, signal });
    } catch (err) {
      return failure(isAbortLike(err, signal) ? "timeout" : "network", currentUrl.href);
    }

    if (res.statusCode === 429 || res.statusCode === 503) {
      res.resume();
      return { ok: false, status: res.statusCode, headers: collectHeaders(res), body: null, finalUrl: currentUrl.href, reason: "throttled" };
    }

    if (REDIRECT_STATUSES.has(res.statusCode)) {
      const location = res.headers.location;
      res.resume();
      if (!location) {
        // 3xx 却没有 Location：对方响应畸形，算它的问题而不是我们的。
        return { ok: false, status: res.statusCode, headers: collectHeaders(res), body: null, finalUrl: currentUrl.href, reason: "http_error" };
      }
      hops += 1;
      if (hops > MAX_REDIRECTS) {
        return failure("too_many_redirects", currentUrl.href);
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        return failure("network", currentUrl.href);
      }
      continue;
    }

    if (res.statusCode >= 400) {
      res.resume();
      return { ok: false, status: res.statusCode, headers: collectHeaders(res), body: null, finalUrl: currentUrl.href, reason: "http_error" };
    }

    let bodyResult;
    try {
      bodyResult = await readBodyCapped(res, maxBytes, parseCharset(res.headers["content-type"]));
    } catch (err) {
      return failure(isAbortLike(err, signal) ? "timeout" : "network", currentUrl.href);
    }

    if (bodyResult.tooLarge) {
      return { ok: false, status: res.statusCode, headers: collectHeaders(res), body: null, finalUrl: currentUrl.href, reason: "too_large" };
    }

    return { ok: true, status: res.statusCode, headers: collectHeaders(res), body: bodyResult.body, finalUrl: currentUrl.href, reason: null };
  }
}
