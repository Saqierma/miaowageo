import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

import { isPrivateAddress, resolveAndGuard, assertNotOwnPublicIp, GuardError, GUARD_ERROR_CODES } from "../fetchers/net-guard.mjs";

/**
 * Chrome 专用的出网允许列表代理。
 *
 * ---------------------------------------------------------------------------
 * 为什么非有不可
 *
 * `safe-fetch.mjs` 只约束 **Worker 自己发出的** 请求。headless Chrome 自己
 * 解析 DNS、自己跟随重定向、自己加载子资源，整条 SSRF 防线完全绕过它。
 * 在 AWS 上 `169.254.169.254`（实例元数据）永远可达——一次指向它的重定向
 * 或子资源就是一条完整的凭证泄露通道；一次指向本机公网 IP 的重定向
 * 能直接打到本机上任何一个「只对内网开放」的端口。
 *
 * 因此 Chrome 必须 `--proxy-server=127.0.0.1:<本代理端口>`，
 * 而本代理对**每一条连接**做三步，缺一不可：
 *
 *   1. 解析目标主机名，得到 IP 列表
 *   2. 判定：全部交给 net-guard 的 isPrivateAddress()，外加本实例自身公网 IP
 *   3. **连接到第 2 步刚校验过的那个 IP，不得再次解析主机名**
 *
 * 第 3 步是 TOCTOU 的真正闭合点，也是本仓库已经踩过一次的坑：
 * `safe-fetch.mjs` 的 C3 就是「校验了，然后把结果丢掉，让运行时重新解析」。
 * 这里用 `net.connect({ host: 已校验IP })`，**绝不把主机名交给 net.connect**。
 *
 * ---------------------------------------------------------------------------
 * 为什么不解密 TLS
 *
 * CONNECT 建立后本代理只做字节转发，Chrome 直接与源站完成 TLS 握手——
 * 证书校验、SNI、HSTS 全部在 Chrome 侧按**真实主机名**进行。
 * 钉死 IP 不影响它们，因为我们改的是「连到哪个地址」，不是「握手时报哪个名字」。
 *
 * **绝不能自签证书做中间人。** 那会让所有证书错误在 Chrome 眼里消失，
 * 而证书错误本身就是这个工具要检测的信号之一。
 *
 * ---------------------------------------------------------------------------
 * 调用方必须配合的 Chrome 参数（见 lighthouse-runner.mjs）
 *
 *   --proxy-server=127.0.0.1:<port>
 *   --proxy-bypass-list=<-loopback>       ← 不加这个，本文件全部白写
 *   --force-webrtc-ip-handling-policy=disable_non_proxied_udp
 *
 * **`<-loopback>` 不是可选项。** Chrome 默认绕过代理直连 localhost /
 * 127.0.0.1 / [::1]，一次指向 `http://127.0.0.1:<端口>/` 的重定向会
 * 完全绕开本代理，上面三步做得再对也拦不住。这是整块防御里最容易漏、
 * 漏了最致命的一行。
 */

// 单个 Chrome 页面能开几十条连接；没有上限时，一个恶意或失控的页面
// （大量 iframe / 图片 / XHR）可以把代理的 socket 与 DNS 线程池全部耗尽，
// 进而影响同进程的轻检查。256 对一次 Lighthouse 导航绰绰有余。
export const DEFAULT_MAX_CONNECTIONS = 256;

// 空闲连接回收。Lighthouse 单次执行预算 75s，比它略大即可；
// 真正的兜底是调用方的整体超时与进程树回收。
export const DEFAULT_SOCKET_TIMEOUT_MS = 90_000;

// 拒绝理由，写进日志与统计。封闭取值，便于调用方聚合。
export const PROXY_REJECT_REASONS = Object.freeze({
  PRIVATE_ADDRESS: "private_address",
  OWN_PUBLIC_IP: "own_public_ip",
  RESOLUTION_FAILED: "resolution_failed",
  BAD_TARGET: "bad_target",
  TOO_MANY_CONNECTIONS: "too_many_connections",
});

export class ProxyRejection extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "ProxyRejection";
    this.reason = reason;
  }
}

/**
 * 对一个目标主机做「解析 → 判定」两步，返回可用于钉死的地址。
 *
 * 顺序与 safe-fetch.mjs 的 guardHop() 一致，理由也一致：
 * 先用 isPrivateAddress 对**字面量 IP** 同步判断（不需要 DNS，也不该为一个
 * 已经确定非法的目标去发真实 DNS 查询），再对域名做 resolveAndGuard。
 *
 * @param {string} hostname 裸主机名或 IP 字面量（不含方括号）
 * @param {{ ownPublicIp?: string, resolve?: Function }} options
 * @returns {Promise<string>} 已校验、可直接用于 net.connect 的 IP
 * @throws {ProxyRejection}
 */
export async function guardTarget(hostname, { ownPublicIp, resolve } = {}) {
  const bare = String(hostname ?? "").replace(/^\[|\]$/g, "");
  if (!bare) throw new ProxyRejection(PROXY_REJECT_REASONS.BAD_TARGET, "空主机名");

  // 字面量 IP：同步判定，通过则它自己就是要钉死的地址。
  if (isPrivateAddress(bare)) {
    throw new ProxyRejection(PROXY_REJECT_REASONS.PRIVATE_ADDRESS, `目标 ${bare} 落在私网/保留网段`);
  }

  let addresses;
  try {
    addresses = await resolveAndGuard(bare, { resolve });
  } catch (err) {
    if (err instanceof GuardError && err.code === GUARD_ERROR_CODES.PRIVATE_ADDRESS) {
      throw new ProxyRejection(PROXY_REJECT_REASONS.PRIVATE_ADDRESS, err.message);
    }
    throw new ProxyRejection(PROXY_REJECT_REASONS.RESOLUTION_FAILED, err.message);
  }

  try {
    assertNotOwnPublicIp(addresses, ownPublicIp);
  } catch (err) {
    if (err instanceof GuardError && err.code === GUARD_ERROR_CODES.OWN_PUBLIC_IP) {
      throw new ProxyRejection(PROXY_REJECT_REASONS.OWN_PUBLIC_IP, err.message);
    }
    throw err;
  }

  // 与 safe-fetch 的 C3 修复完全一致：数组里每一个都已逐一过了 isPrivateAddress，
  // 选哪个都安全，选第一个只是图确定性。
  return addresses[0];
}

// IPv6 字面量形如 [::1]:443。用 String.match 而不是 RegExp.exec，与仓库其余
// 部分保持一致，也避开把正则 exec 误读成 child_process.exec 的静态检查。
const IPV6_AUTHORITY_RE = /^\[([^\]]+)\](?::(\d+))?$/;

function parseHostPort(authority, defaultPort) {
  const v6 = String(authority ?? "").match(IPV6_AUTHORITY_RE);
  if (v6) return { hostname: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort };

  const text = String(authority ?? "");
  const idx = text.lastIndexOf(":");
  if (idx === -1) return text ? { hostname: text, port: defaultPort } : null;
  const port = Number(text.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const hostname = text.slice(0, idx);
  return hostname ? { hostname, port } : null;
}

/**
 * 启动代理。**只监听 127.0.0.1**——它是给同机 Chrome 用的，绝不对外。
 *
 * @param {object} options
 * @param {number} [options.port=0] 0 表示由内核分配（测试用）
 * @param {string} options.ownPublicIp 本实例公网 IP，进拒绝名单
 * @param {Function} [options.resolve] 仅供测试注入的 DNS 解析函数
 * @param {Function} [options.connect] 仅供测试注入的 TCP 连接函数（签名同 net.connect）
 * @param {(event: object) => void} [options.onEvent] 放行/拒绝事件回调，供统计与测试断言
 * @returns {Promise<{ port: number, close: () => Promise<void>, stats: () => object }>}
 */
export function startAllowlistProxy(options = {}) {
  const {
    port = 0,
    ownPublicIp,
    resolve,
    connect = netConnect,
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    socketTimeoutMs = DEFAULT_SOCKET_TIMEOUT_MS,
    onEvent = () => {},
  } = options;

  const stats = { allowed: 0, rejected: 0, byReason: Object.create(null) };
  let active = 0;

  function note(event) {
    if (event.allowed) {
      stats.allowed += 1;
    } else {
      stats.rejected += 1;
      stats.byReason[event.reason] = (stats.byReason[event.reason] ?? 0) + 1;
    }
    onEvent(event);
  }

  const server = createHttpServer();

  // 明文 HTTP：Chrome 以绝对 URI 形式发过来（GET http://host/path HTTP/1.1）。
  server.on("request", async (req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});

    let target;
    try {
      target = new URL(req.url);
      if (target.protocol !== "http:") throw new Error("非 http");
    } catch {
      note({ allowed: false, reason: PROXY_REJECT_REASONS.BAD_TARGET, host: req.url });
      res.writeHead(400).end();
      return;
    }

    let pinned;
    try {
      pinned = await guardTarget(target.hostname, { ownPublicIp, resolve });
    } catch (err) {
      note({ allowed: false, reason: err.reason ?? "unknown", host: target.hostname, message: err.message });
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(`allowlist-proxy 拒绝：${err.message}`);
      return;
    }

    note({ allowed: true, host: target.hostname, pinned });

    // createConnection 是这里的钉死接线点：Node 的 http 客户端建连时只认它
    // 返回的 socket，不会再对 hostname 做任何解析。请求头原样透传，
    // 因此 Host 头保持真实主机名——否则虚拟主机分发会拿错站点。
    const upstream = httpRequest(
      {
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: req.headers,
        createConnection: () => connect({ host: pinned, port: Number(target.port) || 80 }),
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS：CONNECT host:443。建立后纯字节转发，绝不解密。
  server.on("connect", async (req, clientSocket, head) => {
    clientSocket.on("error", () => {});

    if (active >= maxConnections) {
      note({ allowed: false, reason: PROXY_REJECT_REASONS.TOO_MANY_CONNECTIONS, host: req.url });
      clientSocket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }

    const parsed = parseHostPort(req.url, 443);
    if (!parsed) {
      note({ allowed: false, reason: PROXY_REJECT_REASONS.BAD_TARGET, host: req.url });
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    let pinned;
    try {
      pinned = await guardTarget(parsed.hostname, { ownPublicIp, resolve });
    } catch (err) {
      note({ allowed: false, reason: err.reason ?? "unknown", host: parsed.hostname, message: err.message });
      // 403 而不是静默断开：Chrome 会把它呈现成一个明确的代理拒绝，
      // 排障时能立刻看出是我们拦的，而不是目标站点不可达。
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }

    note({ allowed: true, host: parsed.hostname, pinned });
    active += 1;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      active = Math.max(0, active - 1);
    };

    // **钉死在这一行**：host 是已校验的 IP，绝不是 parsed.hostname。
    const upstream = connect({ host: pinned, port: parsed.port });

    upstream.on("error", () => {
      clientSocket.destroy();
      done();
    });
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    for (const s of [clientSocket, upstream]) {
      s.setTimeout(socketTimeoutMs, () => s.destroy());
      s.once("close", done);
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolvePromise({
        port: server.address().port,
        stats: () => ({ ...stats, byReason: { ...stats.byReason } }),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
