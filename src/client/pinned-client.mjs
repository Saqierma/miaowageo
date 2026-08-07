import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";

/**
 * 调用检测 Worker 的客户端：TLS + **证书指纹固定**。
 *
 * ---------------------------------------------------------------------------
 * 为什么是指纹固定，而不是常规的证书校验
 *
 * Worker 用自签证书，且主站按 **IP** 调用它（`https://<worker-ip>:4319/`）。
 * 两件事都让常规 PKI 校验失去意义：没有公共 CA 会签这张证书，
 * 而按 IP 连接时「主机名校验」本来就无从谈起。
 *
 * 剩下唯一有意义的问题是：**我连上的这台，是不是我认识的那台？**
 * 只能靠比对证书指纹回答。
 *
 * ---------------------------------------------------------------------------
 * 校验必须由 TLS 层在握手阶段完成，不能等握手之后
 *
 * 自签证书场景下，绝大多数实现写成 `rejectUnauthorized: false`——
 * 连接是加密的，但**完全没有认证**：任何能劫持这条链路的人都能冒充 Worker，
 * 而调用方看到的是一个 `https://` 开头的地址和一次成功的请求。
 * **那比明文 HTTP 更危险**，因为它给人一种安全的错觉。
 *
 * 本文件的第一版犯过一个更隐蔽的错：`rejectUnauthorized: false` 加上
 * 在 `secureConnect` 事件里比对指纹、不匹配就 destroy socket。看起来对，
 * 但**不能保证请求头没被写出去**——Node 的 http 客户端在 socket 可写时就会
 * flush 头部，等我们的监听器跑到时，`Authorization: Bearer …` 可能已经
 * 发给冒充者了。**校验发生在数据之后，等于没校验。**
 *
 * 现在的做法把两件事都交给 TLS 层，在握手阶段完成，握手不通过就没有任何
 * 应用数据能发出去：
 *
 *   ca: [workerCertPem]     自签证书当作它自己的 CA，链校验因此可以正常做
 *   rejectUnauthorized: true 让 Node 真的去校验（false 会让下面那行**不被调用**）
 *   checkServerIdentity     在这里比对指纹——这是真正的认证
 *
 * 三行缺一不可，尤其是 `rejectUnauthorized: true`：设成 false 时 Node
 * **根本不会调用** `checkServerIdentity`，指纹比对会静默失效，
 * 而代码看起来仍然「有在校验」。
 *
 * tests/pinned-client.test.mjs 用真实的 TLS 服务器守这三行，
 * 每一行都有对应的变异测试。
 */

/** 把 Node 给的 `AA:BB:CC:…` 规范化成小写无冒号，便于比较与写进配置。 */
export function normalizeFingerprint(value) {
  return String(value ?? "").replace(/:/g, "").trim().toLowerCase();
}

/** 从 PEM 证书算 SHA-256 指纹，与 `openssl x509 -fingerprint -sha256` 一致。 */
export function fingerprintFromPem(pem) {
  const body = String(pem)
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return createHash("sha256").update(Buffer.from(body, "base64")).digest("hex");
}

export class FingerprintMismatchError extends Error {
  constructor(expected, actual) {
    super(
      `Worker 证书指纹不匹配：期望 ${expected}，实际 ${actual}。` +
        "TLS 握手已被拒绝，没有任何请求数据发出。" +
        "这要么是 Worker 换了证书（需同步更新主站配置），要么是有人在冒充它。",
    );
    this.name = "FingerprintMismatchError";
    this.reason = "fingerprint_mismatch";
  }
}

/**
 * 构造传给 `https.request` 的 TLS 选项。
 *
 * 导出是为了可测：这三个字段没有可观测输出——配错了连接照样成功、
 * 请求照样返回 200，只是认证没了。只能对选项本身断言。
 */
export function buildTlsOptions({ caPem, fingerprint256 }) {
  const expected = normalizeFingerprint(fingerprint256);
  return {
    // agent: false —— **不复用连接**。
    //
    // 2026-08-07 从北京跨境实测抓到的安全缺陷：Node 的 https 全局 Agent
    // 会按 host:port 复用连接池里的 socket，而**缓存键不包含
    // checkServerIdentity**。于是第一次用正确指纹建好连接后，
    // 后续拿着**错误指纹**的调用会直接复用那条 socket——没有新握手，
    // 指纹比对根本不会被调用，请求照常成功。
    //
    // 实测现象就是「指纹改一个字符，调用仍然返回 200」。
    // 单测每条用全新的服务器和端口，永远命中不到连接复用，所以全绿。
    //
    // 这与 fetchers/safe-fetch.mjs 里连接钉死那处的 `agent: false` 是
    // 同一条道理：**每一次连接都必须自己重新校验，绝不继承上一次的结论。**
    agent: false,
    ca: [caPem],
    // 必须是 true。设成 false 时 Node 不会调用 checkServerIdentity，
    // 下面那段指纹比对会静默失效，而代码看起来仍然「有在校验」。
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) => {
      // 刻意**不**做主机名校验：我们按 IP 连接，自签证书里也没有可信的
      // 主机名信息。认证完全由指纹承担。
      const actual = normalizeFingerprint(cert?.fingerprint256);
      if (actual !== expected) return new FingerprintMismatchError(expected, actual || "(拿不到证书)");
      return undefined;
    },
  };
}

/**
 * 向 Worker 发一次 JSON 请求。
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path            `/audit/light` 或 `/audit/deep`
 * @param {object} options.body
 * @param {string} options.token           Bearer token
 * @param {string} options.fingerprint256  期望的证书 SHA-256 指纹（大小写与冒号随意）
 * @param {string} options.caPem           Worker 的自签证书 PEM
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.requestFn]   仅供测试注入
 * @returns {Promise<{status:number, json:object|null}>}
 */
export function callWorker(options) {
  const {
    host,
    port,
    path,
    body,
    token,
    fingerprint256,
    caPem,
    timeoutMs = 120_000,
    requestFn = httpsRequest,
  } = options ?? {};

  // 三个必填项各自缺失时的后果都是「静默降级成没有认证」，所以一律拒绝，
  // 不给任何「没配就跳过」的余地——那正是本文件想防的失效方式。
  if (!normalizeFingerprint(fingerprint256)) {
    return Promise.reject(new Error("callWorker 必须传 fingerprint256：没有它就只是加密而没有认证，比明文更危险"));
  }
  if (!caPem) {
    return Promise.reject(new Error("callWorker 必须传 caPem：没有它 Node 无法完成自签证书的链校验，checkServerIdentity 不会被调用"));
  }
  if (!token) return Promise.reject(new Error("callWorker 必须传 token"));

  const payload = JSON.stringify(body ?? {});

  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };

    const req = requestFn(
      {
        host,
        port,
        path,
        method: "POST",
        ...buildTlsOptions({ caPem, fingerprint256 }),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { json = null; }
          ok({ status: res.statusCode, json });
        });
        res.on("error", fail);
      },
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`调用 Worker 超时（${timeoutMs}ms）`)));
    req.on("error", fail);
    req.end(payload);
  });
}
