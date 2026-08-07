import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Readable } from "node:stream";

import { safeFetch, resetThrottleState, setDefaultThrottleIntervalMs, OUTBOUND_USER_AGENT, DEFAULT_THROTTLE_INTERVAL_MS, performRequest, makePinnedLookup } from "../src/fetchers/safe-fetch.mjs";

/**
 * safe-fetch 是本服务唯一的出网入口，这些测试守的是「对方的问题不能算到我们头上」。
 *
 * 最要紧的一条：单个请求必须独立超时。若没有，一个挂住的 sitemap.xml 会拖垮
 * 整次审计的 8 秒硬超时，结果被判成 unavailable（我方失败）而不是 no_data（对方问题）——
 * 那会让报告把责任归错，违反设计文档第四节的三态区分。
 */

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

/**
 * `options.transport` 替身返回的响应对象。safeFetch 对这一层的期望就是
 * 「`node:http` 的 IncomingMessage 形状」，具体用到四样东西，缺一不可：
 * `statusCode`、小写键的 `headers`、可 `for await` 的字节流，
 * 以及 `resume()` / `destroy()`（重定向和超限分支要把没读的响应体排空/丢弃，
 * 不排空会让 socket 悬着）。`Readable.from()` 天然满足后三项。
 *
 * 用真实 Readable 而不是手写一个 `{ [Symbol.asyncIterator] }` 字面量，是为了
 * 让 `decompressStream()` 的 `rawStream.on("error", …)` 与 `.pipe()` 这条
 * 真实代码路径也被覆盖到——替身越接近真身，测试才越有资格代表生产行为。
 *
 * ⚠️ 这个工厂之前**根本不存在**：C3（连接钉死）那次改动把 I1-1 改写成用
 * `transport` 注入，却漏了写它。`fakeResponse is not defined` 抛出的
 * ReferenceError 被 safeFetch 里 transport 外层的 catch 接住，映射成
 * `reason: "network"`——**我方的编程错误被伪装成对方的网络问题**。
 * 这与本仓库反复出现的形态一致：守卫写对了，接线断了，而断掉的证据
 * 被归错了责任方。
 */
function fakeResponse(statusCode, headers = {}, body = "") {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.statusCode = statusCode;
  stream.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return stream;
}

/**
 * I2（reviewer 实测复现）：此前响应体一律按 utf-8 解码。GBK/GB2312/Big5
 * 在中文市场的老站点上并非边角情况。这里用 8 个 GBK 字节（"你好你好"，
 * 4 个正确汉字）复现 reviewer 的实测：按 utf-8 硬解会得到 7 个替换字符，
 * 字符数从 4 膨胀到 7（约 1.75 倍）——而这个字符数直接喂给
 * visibleTextLength 的阈值判断，膨胀方向錯了会让一个内容不够的页面
 * 被误判为 pass。
 */
test("I2：Content-Type 声明 GBK 时按 GBK 解码响应体，而不是硬解成 utf-8 的乱码", async () => {
  const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xc4, 0xe3, 0xba, 0xc3]); // "你好你好" 的 GBK 编码
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=GBK" });
    res.end(gbkBytes);
  }, async (base) => {
    const result = await safeFetch(`${base}/gbk`, { allowPrivate: true });
    assert.equal(result.ok, true);
    assert.equal(result.body, "你好你好", `期望按声明的 GBK 解码，实际得到 ${JSON.stringify(result.body)}`);
    assert.equal([...result.body].length, 4, "4 个真实汉字不应该膨胀成更多字符");
  });
});

test("I2：未声明 charset 或 charset 是垃圾值时回退 utf-8，不抛错", async () => {
  await withServer((req, res) => {
    if (req.url === "/no-charset") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>纯 utf-8 正文</p>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=totally-not-a-real-charset" });
    res.end("<p>纯 utf-8 正文</p>");
  }, async (base) => {
    const noCharset = await safeFetch(`${base}/no-charset`, { allowPrivate: true });
    assert.equal(noCharset.ok, true);
    assert.match(noCharset.body, /纯 utf-8 正文/);

    const bogusCharset = await safeFetch(`${base}/bogus`, { allowPrivate: true });
    assert.equal(bogusCharset.ok, true, "未知 charset 标签不应该让整个请求失败");
    assert.match(bogusCharset.body, /纯 utf-8 正文/, "未知/不支持的 charset 应回退 utf-8");
  });
});

test("429 归为 no_data，且不重试", async () => {
  let hits = 0;
  await withServer((req, res) => { hits += 1; res.writeHead(429).end(); }, async (base) => {
    const result = await safeFetch(`${base}/x`, { allowPrivate: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "throttled");
    assert.equal(hits, 1, "429 不得重试，避免加重对方负担");
  });
});

test("超时按单请求计，返回 timeout 而不是抛出", async () => {
  await withServer((req, res) => { /* 永不响应 */ }, async (base) => {
    const started = Date.now();
    const result = await safeFetch(`${base}/hang`, { timeoutMs: 300, allowPrivate: true });
    assert.equal(result.reason, "timeout");
    assert.ok(Date.now() - started < 1500);
  });
});

test("响应体超过上限即中止", async () => {
  await withServer((req, res) => { res.writeHead(200); res.end("x".repeat(2_000_000)); }, async (base) => {
    const result = await safeFetch(`${base}/big`, { maxBytes: 1024, allowPrivate: true });
    assert.equal(result.reason, "too_large");
  });
});

test("跨可注册域的重定向被拒绝", async () => {
  await withServer((req, res) => { res.writeHead(302, { location: "https://evil.example/" }).end(); }, async (base) => {
    const result = await safeFetch(`${base}/r`, { allowPrivate: true });
    assert.equal(result.reason, "cross_domain_redirect");
  });
});

test("同可注册域的重定向被跟随（apex → www 的真实形态）", async () => {
  await withServer((req, res) => {
    if (req.url === "/start") { res.writeHead(302, { location: "/end" }).end(); return; }
    res.writeHead(200, { "content-type": "text/html" }).end("<p>ok</p>");
  }, async (base) => {
    const result = await safeFetch(`${base}/start`, { allowPrivate: true });
    assert.equal(result.ok, true);
    assert.match(result.body, /ok/);
  });
});

test("重定向超过 5 跳即中止", async () => {
  await withServer((req, res) => {
    const n = Number(req.url.slice(1)) || 0;
    res.writeHead(302, { location: `/${n + 1}` }).end();
  }, async (base) => {
    assert.equal((await safeFetch(`${base}/0`, { allowPrivate: true })).reason, "too_many_redirects");
  });
});

test("重定向到私网地址被拒绝", async () => {
  await withServer((req, res) => { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end(); }, async (base) => {
    assert.equal((await safeFetch(`${base}/ssrf`, { allowPrivate: true })).reason, "private_address");
  });
});

// `allowPrivate: true` 只是测试开关，让本地 127.0.0.1 的模拟服务器能被访问；
// 生产调用绝不传这个参数。重定向目标的私网检查不受该开关影响——
// 上面最后一条测试就是守这个的；下面这些是计划文本之外，本文件补充的测试，
// 覆盖计划要点里明确点名、但没有给出逐字用例的行为。

test("非 429/503 的 4xx/5xx 归为 http_error，不归为 throttled", async () => {
  await withServer((req, res) => { res.writeHead(404).end(); }, async (base) => {
    const result = await safeFetch(`${base}/missing`, { allowPrivate: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "http_error");
    assert.equal(result.status, 404);
  });
});

test("headers 必须在返回值里，键统一小写（canonicalChecks 靠它读 X-Robots-Tag）", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", "X-Robots-Tag": "noindex" }).end("<p>hi</p>");
  }, async (base) => {
    const result = await safeFetch(`${base}/page`, { allowPrivate: true });
    assert.equal(result.ok, true);
    assert.equal(result.headers["x-robots-tag"], "noindex");
    assert.equal(result.headers["content-type"], "text/html");
    // 键必须是小写——大写形式的键不应该出现
    assert.equal(result.headers["X-Robots-Tag"], undefined);
  });
});

test("出站请求携带约定的 UA，标明来意", async () => {
  let seenUA = null;
  await withServer((req, res) => { seenUA = req.headers["user-agent"]; res.writeHead(200).end("ok"); }, async (base) => {
    await safeFetch(`${base}/ua`, { allowPrivate: true });
    assert.equal(seenUA, OUTBOUND_USER_AGENT);
  });
});

test("连接不上（对方端口未监听）归为 network，而不是 timeout", async () => {
  // 先起一个服务器拿到一个空闲端口，立刻关掉，制造一个"连接被拒绝"的目标。
  const probe = createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const result = await safeFetch(`http://127.0.0.1:${port}/`, { allowPrivate: true, timeoutMs: 3000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network");
});

test("同源节流：相邻请求到达服务器的时刻至少间隔一个节流周期", async () => {
  resetThrottleState();
  const arrivals = [];
  await withServer((req, res) => { arrivals.push(Date.now()); res.writeHead(200).end("ok"); }, async (base) => {
    await safeFetch(`${base}/1`, { allowPrivate: true });
    await safeFetch(`${base}/2`, { allowPrivate: true });
    assert.equal(arrivals.length, 2);
    const gap = arrivals[1] - arrivals[0];
    assert.ok(gap >= DEFAULT_THROTTLE_INTERVAL_MS - 20, `相邻请求间隔应 ≥ ${DEFAULT_THROTTLE_INTERVAL_MS}ms，实测 ${gap}ms`);
  });
});

/**
 * C2（reviewer 生产环境实测复现）：设计文档要求同一次审计的五个子请求并行
 * 发起，节流完全靠 throttleHost 兜底。旧实现是"读 Map → await 等待 → 写 Map"，
 * 并发调用会在 await 之前全部读到同一个 last、算出同一个等待时长，然后一起
 * 醒来同时放行——reviewer 实测 5 个并发请求在 9ms 内全部打到目标服务器，
 * 而设计要求相邻请求 ≥300ms。这里直接并发发起多个 safeFetch，断言服务器
 * 观测到的到达时刻两两间隔都不小于一个节流周期。
 */
test("C2：同一主机的并发 safeFetch 调用必须真正错开节流间隔，而不是一起放行", async () => {
  resetThrottleState();
  const arrivals = [];
  await withServer((req, res) => { arrivals.push(Date.now()); res.writeHead(200).end("ok"); }, async (base) => {
    const started = Date.now();
    const N = 5;
    await Promise.all(Array.from({ length: N }, (_, i) => safeFetch(`${base}/${i}`, { allowPrivate: true })));
    assert.equal(arrivals.length, N);
    const offsets = arrivals.map((t) => t - started).sort((a, b) => a - b);
    for (let i = 1; i < offsets.length; i += 1) {
      const gap = offsets[i] - offsets[i - 1];
      assert.ok(
        gap >= DEFAULT_THROTTLE_INTERVAL_MS - 20,
        `并发请求的到达间隔应 ≥ ${DEFAULT_THROTTLE_INTERVAL_MS}ms，实测顺序 ${offsets.join(",")}ms，第 ${i} 个间隔仅 ${gap}ms`,
      );
    }
  });
});

test("同源节流：重定向的每一跳也计入节流间隔", async () => {
  resetThrottleState();
  const arrivals = [];
  await withServer((req, res) => {
    arrivals.push(Date.now());
    if (req.url === "/start") { res.writeHead(302, { location: "/end" }).end(); return; }
    res.writeHead(200).end("ok");
  }, async (base) => {
    await safeFetch(`${base}/start`, { allowPrivate: true });
    assert.equal(arrivals.length, 2, "重定向的两跳都应该真正发出请求");
    const gap = arrivals[1] - arrivals[0];
    assert.ok(gap >= DEFAULT_THROTTLE_INTERVAL_MS - 20, `重定向的第二跳也要遵守节流间隔，实测 ${gap}ms`);
  });
});

test("resetThrottleState 让下一次请求不必等待历史节流窗口", async () => {
  resetThrottleState();
  await withServer((req, res) => { res.writeHead(200).end("ok"); }, async (base) => {
    const started = Date.now();
    await safeFetch(`${base}/fresh`, { allowPrivate: true });
    // 重置之后是这台服务器收到的第一个请求，不应该因为历史节流记录被延迟。
    assert.ok(Date.now() - started < 150, "reset 之后的首个请求不应被节流延迟");
  });
});

test("节流间隔可被覆盖（CLI 提高间隔时不必改调用方代码）", async () => {
  resetThrottleState();
  const arrivals = [];
  try {
    setDefaultThrottleIntervalMs(500);
    await withServer((req, res) => { arrivals.push(Date.now()); res.writeHead(200).end("ok"); }, async (base) => {
      await safeFetch(`${base}/1`, { allowPrivate: true });
      await safeFetch(`${base}/2`, { allowPrivate: true });
      const gap = arrivals[1] - arrivals[0];
      assert.ok(gap >= 480, `覆盖为 500ms 后，间隔应随之变化，实测 ${gap}ms`);
    });
  } finally {
    setDefaultThrottleIntervalMs(DEFAULT_THROTTLE_INTERVAL_MS);
  }
});

test("非 http/https 协议一律拒绝：起始 URL 本身就是别的协议", async () => {
  const result = await safeFetch("ftp://127.0.0.1/x", { allowPrivate: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network");
});

test("非 http/https 协议一律拒绝：重定向切到别的协议（同主机也挡）", async () => {
  await withServer((req, res) => {
    // 重定向目标与起始请求同主机同端口，只是把协议换成了 ftp——
    // 可注册域比较（字符串层面）会认为"同域"，必须靠单独的协议检查才能挡住
    // 这种"同主机、换协议"的花招。
    const port = req.socket.localPort;
    res.writeHead(302, { location: `ftp://127.0.0.1:${port}/x` }).end();
  }, async (base) => {
    const result = await safeFetch(`${base}/start`, { allowPrivate: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
  });
});

test("超时覆盖整条重定向链，而不是每跳独立重新计时", async () => {
  resetThrottleState();
  await withServer((req, res) => {
    if (req.url === "/start") {
      setTimeout(() => { res.writeHead(302, { location: "/hang" }).end(); }, 150);
      return;
    }
    /* /hang：永不响应 */
  }, async (base) => {
    const started = Date.now();
    const result = await safeFetch(`${base}/start`, { timeoutMs: 300, allowPrivate: true });
    const elapsed = Date.now() - started;
    assert.equal(result.reason, "timeout");
    // 若每跳独立计时（错误实现），第一跳耗时 ~150ms 后，第二跳会拿到全新的 300ms，
    // 总耗时会逼近 450ms 甚至更多；链路共用同一个 signal 时，总耗时应贴近 300ms。
    assert.ok(elapsed < 420, `超时应覆盖整条链（~300ms），而不是每跳重新计时，实测 ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// I1：resolve 注入通道——之前 guardHop 无参数调用 resolveAndGuard(bare)，
// net-guard 为测试留的 resolve seam 从 safe-fetch 完全够不到。下面三条测试
// 各自钉死 reviewer 点名的一个 mutation：
//   1. sameRegistrableDomain(bare, baseHost) → bare === baseHost
//   2. 删掉 assertNotOwnPublicIp(...) 调用
//   3. 删掉整个 resolveAndGuard 调用
// ---------------------------------------------------------------------------

test("I1-1：跨子域重定向在可注册域相同时应放行（apex → www，真实覆盖 sameRegistrableDomain 而非字符串相等）", async () => {
  resetThrottleState();
  // C3 已闭合后，guardHop 校验通过的地址会被钉死、真的用于建连（见
  // safe-fetch.mjs 的 performRequest）。这个测试要覆盖的是"跨子域重定向、
  // 且 resolveAndGuard 真的对新主机名执行了一次"——但 resolveAndGuard 对
  // 非起始主机名的私网地址永远拒绝（不受 allowPrivate 影响），127.0.0.1
  // 绕不开，没法只用本地服务器复现。因此这里换用 options.transport（仅供
  // 测试的整跳替身，见 safeFetch 的文档注释）模拟两跳的响应，不发起真实连接。
  const resolveCalls = [];
  const resolve = async (hostname) => {
    resolveCalls.push(hostname);
    return [{ address: "93.184.216.34", family: 4 }]; // 占位公网地址
  };
  const transport = async (targetUrl) => {
    if (targetUrl.hostname === "example.com") {
      return fakeResponse(302, { location: "http://www.example.com/end" });
    }
    if (targetUrl.hostname === "www.example.com") {
      return fakeResponse(200, { "content-type": "text/html" }, "<p>ok</p>");
    }
    throw new Error(`测试桩未预期的请求目标：${targetUrl.href}`);
  };
  const result = await safeFetch("http://example.com/start", { allowPrivate: true, resolve, transport });
  assert.equal(result.ok, true, `期望放行并跟随到 www 子域，实际 reason=${result.reason}`);
  assert.match(result.body, /ok/);
  assert.ok(
    resolveCalls.includes("www.example.com"),
    "www.example.com 必须真的走到 resolveAndGuard（说明可注册域比较放行了它），而不是被裸字符串相等挡在门外",
  );
});

test("I1-2：resolve 命中私网地址时必须拒绝（覆盖 resolveAndGuard 调用本身，而不仅是字面量 IP 检查）", async () => {
  resetThrottleState();
  const resolve = async () => [{ address: "10.0.0.1", family: 4 }];
  const result = await safeFetch("http://name-resolves-to-private.example/", { resolve });
  assert.equal(result.reason, "private_address", `域名解析到私网地址应拒绝，实际 reason=${result.reason}`);
});

test("I1-3：resolve 命中本实例自身公网 IP 时必须拒绝（覆盖 assertNotOwnPublicIp 的接线）", async () => {
  resetThrottleState();
  const originalOwnIp = process.env.MIAOWA_AUDIT_OWN_PUBLIC_IP;
  process.env.MIAOWA_AUDIT_OWN_PUBLIC_IP = "203.0.113.9";
  try {
    const resolve = async () => [{ address: "203.0.113.9", family: 4 }];
    const result = await safeFetch("http://name-resolves-to-own-ip.example/", { resolve });
    assert.equal(result.reason, "private_address", `解析到本实例自身公网 IP 应拒绝，实际 reason=${result.reason}`);
  } finally {
    if (originalOwnIp === undefined) delete process.env.MIAOWA_AUDIT_OWN_PUBLIC_IP;
    else process.env.MIAOWA_AUDIT_OWN_PUBLIC_IP = originalOwnIp;
  }
});

// ---------------------------------------------------------------------------
// C3：连接钉死（connection pinning）
//
// 这四条测试的存在理由，是一次实测的变异存活：C3 修复提交前，把
// `options.lookup = makePinnedLookup(pinnedAddress)` 整行删掉，或者让
// `pinnedAddress` 恒为 undefined（即"校验做了、结果丢弃"——正是 C3 的原始
// 缺陷本身），safe-fetch 的 24 条测试**全部照旧通过**。
//
// 原因是钉死没有可观测输出：它生效与否，safeFetch 的返回值一模一样。
// 这与 AGENTS.md 记的那条模式同形——"守卫本身正确，在集成处失效，而集成
// 测试断言的结果无论守卫是否运行都成立"。要让它可测，只能绕开 safeFetch
// 的返回值，直接对两个接缝断言：地址有没有被传下去（C3-1），
// 以及传下去之后有没有真的用于建连（C3-2）。
// ---------------------------------------------------------------------------

test("C3-1：resolveAndGuard 校验过的地址被原样交给下一层做钉死，而不是丢弃", async () => {
  resetThrottleState();
  // 杀掉的变异：`[pinnedAddress] = addresses` → `pinnedAddress = undefined`。
  // 那正是 C3 缺陷的原始形态：私网校验照跑，校验结果却没有用于建连。
  const pinnedSeen = [];
  const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
  const transport = async (_targetUrl, { pinnedAddress }) => {
    pinnedSeen.push(pinnedAddress);
    return fakeResponse(200, { "content-type": "text/html" }, "<p>ok</p>");
  };
  const result = await safeFetch("http://pin-handoff.example/x", { resolve, transport });
  assert.equal(result.ok, true, `期望正常返回，实际 reason=${result.reason}`);
  assert.deepEqual(
    pinnedSeen,
    ["93.184.216.34"],
    "校验通过的地址必须原样传给发起请求的那一层；传 undefined 等于把校验结果丢掉，DNS-rebinding 窗口重新打开",
  );
});

test("C3-2：performRequest 真的连到钉死的地址——主机名保证永不解析也能连通", async () => {
  // 杀掉的变异：删掉 performRequest 里 `options.lookup = makePinnedLookup(...)`。
  // `.invalid` 是 RFC 2606 保留的顶级域，DNS 保证它永不解析。因此这次请求
  // 唯一可能连通的路径就是钉死生效；一旦 Node 退回按主机名解析，必然
  // ENOTFOUND。这是"钉死没生效"能变成一个红测试的唯一形态。
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`host=${req.headers.host}`);
  }, async (base) => {
    const { port } = new URL(base);
    const target = new URL(`http://pinned-target.invalid:${port}/probe`);
    const res = await performRequest(target, { pinnedAddress: "127.0.0.1", signal: AbortSignal.timeout(3000) });
    assert.equal(res.statusCode, 200);

    let body = "";
    for await (const chunk of res) body += chunk;
    // 第二重断言，守 C3 文档里的第 2 点：钉死的是**连接目标**，Host 头必须
    // 仍是真实主机名。若把 hostname 也换成 IP，虚拟主机分发会拿错站点，
    // 而 HTTPS 下 TLS 证书校验会直接失败——一个只在生产才暴露的错误。
    assert.equal(
      body,
      `host=pinned-target.invalid:${port}`,
      "Host 头必须是真实主机名，不能被替换成钉死的 IP",
    );
  });
});

test("C3-3：makePinnedLookup 无视传入的主机名，恒返回钉死地址（两种回调形状都要对）", () => {
  const lookup = makePinnedLookup("198.51.100.7");

  // happy-eyeballs 路径：net 内部以 { all: true } 调用，期望拿到数组。
  // 形状传错会在 net 内部炸成 ERR_INVALID_IP_ADDRESS——源码注释记录了实测复现。
  const all = [];
  lookup("whatever.example", { all: true }, (err, result) => all.push([err, result]));
  assert.deepEqual(all, [[null, [{ address: "198.51.100.7", family: 4 }]]]);

  // 传统三参回调路径。
  const single = [];
  lookup("whatever.example", {}, (err, address, family) => single.push([err, address, family]));
  assert.deepEqual(single, [[null, "198.51.100.7", 4]]);

  // options 位置直接传函数的两参形态（dns.lookup 的历史签名，Node 内部仍会用）。
  const legacy = [];
  lookup("whatever.example", (err, address, family) => legacy.push([err, address, family]));
  assert.deepEqual(legacy, [[null, "198.51.100.7", 4]]);
});

test("C3-4：钉死 IPv6 地址时 family 报 6，不是硬编码的 4", () => {
  // family 报错会让 net 用错的地址族去建连。isIP() 返回 4/6，直接用它。
  const lookup = makePinnedLookup("2606:2800:220:1:248:1893:25c8:1946");
  const seen = [];
  lookup("v6.example", { all: true }, (err, result) => seen.push([err, result]));
  assert.deepEqual(seen, [[null, [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]]]);
});
