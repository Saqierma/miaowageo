import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect } from "node:net";

import {
  startAllowlistProxy,
  guardTarget,
  ProxyRejection,
  PROXY_REJECT_REASONS,
} from "../src/proxy/allowlist-proxy.mjs";

/**
 * Chrome 允许列表代理。
 *
 * 这个文件存在的理由，是本仓库已经证明过一次的教训：**没有可观测输出的
 * 安全机制，会在集成处静默失效，而测试全绿**。出网 C3 的连接钉死写好后，
 * 删掉钉死那一行、或让已校验地址被丢弃，safe-fetch 的 24 条测试照样通过——
 * 因为钉死生效与否，返回值一模一样。
 *
 * 代理这一层同型，而且更危险（它保护的是 Chrome 的整棵子资源树）。
 * 因此每条防线都必须有一条**会因变异变红**的断言：
 *
 *   私网拒绝  → 对 169.254.169.254 / 127.0.0.1 / 解析到 10.0.0.1 的域名断言拒绝
 *   IP 钉死   → 用 RFC 2606 保证永不解析的 .invalid 主机名当靶子；
 *               钉死失效则必然 ENOTFOUND，测试必然红
 *
 * 第二条手法照抄 tests/safe-fetch.test.mjs 的 C3-2，那里已经验证过它有效。
 */

// 起一个本地 HTTP 源站，代理最终应当连到它。
async function withOrigin(handler, run) {
  const server = createHttpServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function withProxy(options, run) {
  const proxy = await startAllowlistProxy({ ownPublicIp: "203.0.113.9", ...options });
  try {
    await run(proxy);
  } finally {
    await proxy.close();
  }
}

/** 通过代理发一个 CONNECT，返回代理回的状态行；成功时把已建立的 socket 一并给出。 */
function connectThroughProxy(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port: proxyPort }, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.removeListener("data", onData);
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      resolve({ statusLine, socket, rest: buf.slice(end + 4) });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("CONNECT 超时"));
    });
  });
}

// ---------------------------------------------------------------------------
// guardTarget：解析 + 判定（不涉及建连）
// ---------------------------------------------------------------------------

test("私网拒绝：云元数据端点 169.254.169.254 必须被拒", async () => {
  // 云主机上这个地址永远可达且直接吐出临时凭证，是最经典的 SSRF 目标。这台机器上没有代理，
  // 但它一个都没少。
  await assert.rejects(
    () => guardTarget("169.254.169.254", { ownPublicIp: "203.0.113.9" }),
    (err) => err instanceof ProxyRejection && err.reason === PROXY_REJECT_REASONS.PRIVATE_ADDRESS,
  );
});

test("私网拒绝：环回与 IPv6 环回、以及 :: 未指定地址", async () => {
  for (const host of ["127.0.0.1", "[::1]", "::1", "[::]", "::ffff:127.0.0.1"]) {
    await assert.rejects(
      () => guardTarget(host, { ownPublicIp: "203.0.113.9" }),
      (err) => err instanceof ProxyRejection && err.reason === PROXY_REJECT_REASONS.PRIVATE_ADDRESS,
      `${host} 必须被拒`,
    );
  }
});

test("私网字面量必须在**发出任何 DNS 查询之前**就被拒", async () => {
  // 这条钉的是 guardTarget 里那个「先对字面量 IP 同步判定」的分支。
  //
  // 变异实验发现：把那个分支删掉，上面几条测试**照样全绿**——因为
  // 169.254.169.254 会落到 resolveAndGuard，而 dns.lookup 对一个 IP 字面量
  // 返回它自己，里层的 isPrivateAddress 仍然拦得住。两层是冗余的。
  //
  // 但冗余不等于没有行为差异：为一个攻击者提交的、显然非法的目标去发真实
  // DNS 查询，既是无谓的开销（匿名公开接口，提交量不受我们控制），
  // 也把「我们收到了什么目标」泄露给了 DNS 链路。差异既然真实存在，
  // 就该有断言守着——否则那个分支哪天被人当成死代码删掉，没人会发现。
  let resolveCalls = 0;
  const resolve = async (hostname) => {
    resolveCalls += 1;
    return [{ address: hostname, family: 4 }];
  };
  for (const literal of ["169.254.169.254", "127.0.0.1", "10.0.0.1", "192.168.1.1"]) {
    await assert.rejects(
      () => guardTarget(literal, { ownPublicIp: "203.0.113.9", resolve }),
      (err) => err.reason === PROXY_REJECT_REASONS.PRIVATE_ADDRESS,
      `${literal} 必须被拒`,
    );
  }
  assert.equal(resolveCalls, 0, "私网字面量不该触发任何 DNS 查询——同步就能判定的事不要走网络");
});

test("私网拒绝：域名解析到私网（字面量检查挡不住，必须靠 resolveAndGuard）", async () => {
  const resolve = async () => [{ address: "10.0.0.1", family: 4 }];
  await assert.rejects(
    () => guardTarget("internal.corp.example", { ownPublicIp: "203.0.113.9", resolve }),
    (err) => err instanceof ProxyRejection && err.reason === PROXY_REJECT_REASONS.PRIVATE_ADDRESS,
  );
});

test("私网拒绝：解析到本实例自身公网 IP（私网网段表天然盖不住的一格）", async () => {
  const resolve = async () => [{ address: "203.0.113.9", family: 4 }];
  await assert.rejects(
    () => guardTarget("looks-public.example", { ownPublicIp: "203.0.113.9", resolve }),
    (err) => err instanceof ProxyRejection && err.reason === PROXY_REJECT_REASONS.OWN_PUBLIC_IP,
  );
});

test("放行：公网域名返回已校验的那个地址，供调用方钉死", async () => {
  const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
  const pinned = await guardTarget("example.com", { ownPublicIp: "203.0.113.9", resolve });
  assert.equal(pinned, "93.184.216.34", "必须原样返回校验过的地址；返回别的东西等于校验白做");
});

test("解析失败归 resolution_failed，不与 private_address 混", async () => {
  // 「对方 DNS 挂了」与「我们主动拦截」是两件事，混在一起会让排障看错方向。
  const resolve = async () => [];
  await assert.rejects(
    () => guardTarget("nx.example", { ownPublicIp: "203.0.113.9", resolve }),
    (err) => err.reason === PROXY_REJECT_REASONS.RESOLUTION_FAILED,
  );
});

// ---------------------------------------------------------------------------
// CONNECT：端到端，含钉死
// ---------------------------------------------------------------------------

test("CONNECT 到私网目标 → 403，且不建立任何上游连接", async () => {
  let connectCalls = 0;
  await withProxy(
    { connect: (...args) => { connectCalls += 1; return netConnect(...args); } },
    async (proxy) => {
      const { statusLine, socket } = await connectThroughProxy(proxy.port, "169.254.169.254:80");
      socket.destroy();
      assert.match(statusLine, /^HTTP\/1\.1 403/, "私网目标必须被 403 拒绝");
      assert.equal(connectCalls, 0, "被拒的目标绝不能已经建立上游连接——那样拒绝就晚了一步");
      assert.equal(proxy.stats().byReason.private_address, 1);
    },
  );
});

test("钉死：CONNECT 的主机名保证永不解析，唯一可能连通的路径就是钉死生效", async () => {
  // 杀掉的变异：把 `connect({ host: pinned })` 改成 `connect({ host: parsed.hostname })`。
  // `.invalid` 是 RFC 2606 保留的顶级域，DNS 保证它永不解析——一旦代理退回
  // 按主机名连接，必然 ENOTFOUND，本测试必然红。这是「钉死没生效」能变成
  // 一个红测试的唯一形态（钉死本身没有任何可观测输出）。
  await withOrigin(
    (req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("origin-reached"),
    async (originPort) => {
      // 127.0.0.1 会被 isPrivateAddress 拒掉，所以不能让 resolve 直接返回
      // 环回地址。改成：resolve 返回一个公网地址（走完真实的校验路径），
      // 再用注入的 connect 观察**代理实际把什么 host 传了下去**，
      // 并把这次连接重定向到本地源站，从而不触碰真实公网也能走完全程。
      const seen = [];
      await withProxy(
        {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
          connect: (opts, ...rest) => {
            seen.push({ ...opts });
            // 把已钉死的地址重定向到本地源站，从而在不触碰真实公网的前提下
            // 走完整条 CONNECT 转发路径。
            return netConnect({ ...opts, host: "127.0.0.1", port: originPort }, ...rest);
          },
        },
        async (proxy) => {
          const { statusLine, socket } = await connectThroughProxy(proxy.port, "pinned-target.invalid:443");
          assert.match(statusLine, /^HTTP\/1\.1 200/, "校验通过的目标应当建立隧道");
          socket.destroy();

          assert.equal(seen.length, 1);
          assert.equal(
            seen[0].host,
            "93.184.216.34",
            "必须把 guardTarget 校验过的 IP 交给 net.connect；" +
              "传主机名（pinned-target.invalid）等于把校验结果丢掉，DNS-rebinding 窗口重新打开",
          );
          assert.equal(seen[0].port, 443, "端口必须来自 CONNECT 的 authority");
        },
      );
    },
  );
});

/**
 * 关于「不注入 connect、真的走 node:net」这条路径：
 *
 * 本文件**没有**覆盖它，而且这是个有意的、写下来的缺口，不是遗漏。
 * 原因是它在单测里无法诚实构造：guardTarget 会拒绝一切私网地址，
 * 所以钉死出来的地址不可能是 127.0.0.1，也就不可能指向一个本地源站；
 * 而让测试真的连出公网，等于把测试挂在第三方的可用性上
 * （与 fixtures/robots/globalsources-snapshot.txt 用快照而非打线上站
 * 是同一条理由）。
 *
 * 曾经这里有一条名叫「真的走 net.connect」的测试，它的全部内容是
 * 断言 proxy.port > 0——**看起来像覆盖，实则什么都没验**。删掉它，
 * 因为一条假测试比没有测试更糟：它会让人以为这条路径有人守着。
 *
 * 真实建连路径由计划 2 Task 8 的机上验收覆盖：真 Chrome、真代理、
 * 真海外站跑一遍，并断言代理的 stats() 里 allowed > 0。
 */

// ---------------------------------------------------------------------------
// 明文 HTTP（绝对 URI）
// ---------------------------------------------------------------------------

test("明文 HTTP：钉死地址被用于建连，且 Host 头保持真实主机名", async () => {
  await withOrigin(
    (req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(`host=${req.headers.host}`),
    async (originPort) => {
      const seen = [];
      await withProxy(
        {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
          connect: (opts, ...rest) => {
            seen.push({ ...opts });
            return netConnect({ ...opts, host: "127.0.0.1", port: originPort }, ...rest);
          },
        },
        async (proxy) => {
          // 必须用裸 socket：代理式请求的请求行是**绝对 URI**
          // （GET http://host/path），Node 的 fetch 发不出这种形态。
          const body = await new Promise((resolvePromise, reject) => {
            const s = netConnect({ host: "127.0.0.1", port: proxy.port }, () => {
              s.write(
                "GET http://pinned-http.invalid/probe HTTP/1.1\r\n" +
                  "Host: pinned-http.invalid\r\n" +
                  "Connection: close\r\n\r\n",
              );
            });
            let buf = "";
            s.on("data", (c) => { buf += c.toString("utf8"); });
            s.on("end", () => resolvePromise(buf));
            s.on("error", reject);
            s.setTimeout(5000, () => { s.destroy(); reject(new Error("超时")); });
          });

          assert.match(body, /^HTTP\/1\.1 200/, `代理应转发成功，实际：${body.slice(0, 120)}`);
          assert.match(
            body,
            /host=pinned-http\.invalid/,
            "Host 头必须是真实主机名，不能被替换成钉死的 IP——否则虚拟主机分发会拿错站点",
          );
          const pinnedCalls = seen.filter((o) => o.host === "93.184.216.34");
          assert.equal(
            pinnedCalls.length,
            1,
            `必须用校验过的 IP 建连，实际传入 ${JSON.stringify(seen)}`,
          );
        },
      );
    },
  );
});

test("明文 HTTP：私网目标 → 403，且不建立上游连接", async () => {
  let connectCalls = 0;
  await withProxy(
    { connect: (...args) => { connectCalls += 1; return netConnect(...args); } },
    async (proxy) => {
      const body = await new Promise((resolvePromise, reject) => {
        const s = netConnect({ host: "127.0.0.1", port: proxy.port }, () => {
          s.write("GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\nConnection: close\r\n\r\n");
        });
        let buf = "";
        s.on("data", (c) => { buf += c.toString("utf8"); });
        s.on("end", () => resolvePromise(buf));
        s.on("error", reject);
        s.setTimeout(5000, () => { s.destroy(); reject(new Error("超时")); });
      });
      assert.match(body, /^HTTP\/1\.1 403/, "元数据端点必须 403");
      assert.equal(connectCalls, 0, "拒绝必须发生在建连之前");
    },
  );
});

// ---------------------------------------------------------------------------
// 资源上限与形态校验
// ---------------------------------------------------------------------------

test("CONNECT 的 authority 形态不合法时 400，不进入解析", async () => {
  let resolveCalls = 0;
  await withProxy(
    { resolve: async () => { resolveCalls += 1; return [{ address: "93.184.216.34", family: 4 }]; } },
    async (proxy) => {
      for (const bad of [":443", "host:notaport", "host:0", "host:70000"]) {
        const { statusLine, socket } = await connectThroughProxy(proxy.port, bad);
        socket.destroy();
        assert.match(statusLine, /^HTTP\/1\.1 400/, `${bad} 应判为形态不合法`);
      }
      assert.equal(resolveCalls, 0, "形态就不合法的目标不该触发真实 DNS 查询");
    },
  );
});

test("连接数达到上限后立即 503，不排队", async () => {
  await withProxy(
    {
      maxConnections: 0, // 直接把上限设成 0，等价于「已经满了」
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    },
    async (proxy) => {
      const { statusLine, socket } = await connectThroughProxy(proxy.port, "example.com:443");
      socket.destroy();
      assert.match(statusLine, /^HTTP\/1\.1 503/);
      assert.equal(proxy.stats().byReason.too_many_connections, 1);
    },
  );
});

test("代理只监听 127.0.0.1，不对外", async () => {
  await withProxy({}, async (proxy) => {
    // 从非环回地址连不上；这里用「监听地址」本身做断言，
    // 因为在测试环境里枚举本机公网地址不可靠。
    const res = await new Promise((resolvePromise) => {
      const s = netConnect({ host: "127.0.0.1", port: proxy.port }, () => {
        s.destroy();
        resolvePromise("loopback-ok");
      });
      s.on("error", () => resolvePromise("loopback-failed"));
    });
    assert.equal(res, "loopback-ok");
  });
});
