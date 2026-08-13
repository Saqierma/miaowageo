import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";

import { createRequestListener, startServer, MAX_CONCURRENCY, AUDIT_TIMEOUT_MS, assertDeepCheckConfig, assertTlsConfig } from "../src/server.mjs";
import {
  PREFLIGHT_TIMEOUT_MS,
  ROBOTS_TIMEOUT_MS,
  TARGET_TIMEOUT_MS,
  TARGET_STAGGER_COUNT,
} from "../src/orchestrate-light.mjs";
import { DEFAULT_THROTTLE_INTERVAL_MS } from "../src/fetchers/safe-fetch.mjs";

/**
 * server.mjs 只做 HTTP 边界：Bearer 鉴权、并发池、硬超时、序列化。
 * 判断逻辑（robots / 可读性 / 结构化数据……）不在这里测，那是各 checks/*.mjs
 * 和 orchestrate-light.mjs 自己的职责——这里全程注入假的 runLightAudit，不联网。
 *
 * 重点覆盖调用方特别点出的坑：并发计数必须在**真实工作完成**时才释放，
 * 而不是在响应发出的那一刻——否则 8 秒超时和并发池上限会互相打架，
 * 20 的上限在超时高发时形同虚设。
 */

const TOKEN = "test-token-123";

const fakeSafeFetch = async () => ({ ok: true, status: 200, headers: {}, body: "", finalUrl: "http://x.example/", reason: null });

/**
 * startServer() 能起来所需的最小环境。
 *
 * 它比以前长了两项，两项都是刻意的：
 *   MIAOWA_AUDIT_OWN_PUBLIC_IP  D2——缺失时「拒绝连回本机公网 IP」整条防线静默消失
 *   MIAOWA_AUDIT_DEEP_ENABLED   D3——不给默认值，逼部署方明确回答这台机器跑不跑深检查
 *   MIAOWA_AUDIT_TLS            同理——默认明文会让 Bearer token 在跨境链路上裸奔，
 *                               这种降级必须是有人明确选的，不能是忘了配的副产品
 *
 * 测试里把它抽成常量，是为了让「启动需要哪些必填项」只有一处定义：
 * 下次再加必填项时，改这里，所有启动路径的测试一起跟上。
 */
const MINIMAL_ENV = Object.freeze({
  MIAOWA_AUDIT_OWN_PUBLIC_IP: "203.0.113.9",
  MIAOWA_AUDIT_DEEP_ENABLED: "0",
  MIAOWA_AUDIT_TLS: "0",
});

function withTestServer(deps, run) {
  return new Promise((resolve, reject) => {
    let server;
    try {
      server = createHttpServer(createRequestListener({ token: TOKEN, safeFetch: fakeSafeFetch, ...deps }));
    } catch (err) {
      reject(err);
      return;
    }
    server.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        await run(base);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

async function post(base, { headers = {}, body } = {}) {
  const res = await fetch(`${base}/audit/light`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}


/**
 * 断言 startServer() 因配置问题**同步**拒绝启动，并保证即使断言失败
 * （比如做变异测试时防线被摘掉、服务意外起来了）也不会漏一个监听中的
 * server 出去把 node --test 挂死。
 */
function assertStartupRejected(env, expected) {
  let started;
  try {
    started = startServer({
      env,
      token: TOKEN,
      port: 0,
      safeFetch: fakeSafeFetch,
      runLightAudit: async () => ({ baseUrl: "x", finalUrl: "x", robotsAllowedPage: true, results: [] }),
    });
  } catch (err) {
    assert.match(String(err.message), expected);
    return;
  }
  // 走到这里说明该拒绝的没拒绝。先把可能已经监听的端口收干净，再报错。
  Promise.resolve(started).then((server) => server?.close?.()).catch(() => {});
  assert.fail(`startServer 本应因配置问题拒绝启动（期望错误匹配 ${expected}），却启动成功了`);
}

/** 造一个不会自己完成的 runLightAudit：外部通过 releaseAll() 统一放行，用来钉住并发场景。 */
function pendingAudit() {
  const releasers = [];
  let started = 0;
  const runLightAudit = async () => {
    started += 1;
    await new Promise((resolve) => releasers.push(resolve));
    return { baseUrl: "http://x.example/", finalUrl: "http://x.example/", robotsAllowedPage: true, results: [] };
  };
  return {
    runLightAudit,
    get started() { return started; },
    releaseAll() { for (const r of releasers.splice(0)) r(); },
  };
}

async function waitUntil(cond, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

test("缺少 Authorization → 401", async () => {
  await withTestServer({}, async (base) => {
    const { status, json } = await post(base, { body: { url: "http://x.example/" } });
    assert.equal(status, 401);
    assert.equal(json.ok, false);
  });
});

test("token 错误 → 401", async () => {
  await withTestServer({}, async (base) => {
    const { status, json } = await post(base, {
      headers: { authorization: "Bearer wrong-token" },
      body: { url: "http://x.example/" },
    });
    assert.equal(status, 401);
    assert.equal(json.ok, false);
  });
});

test("token 正确才放行（先决条件，后续测试都靠它）", async () => {
  const runLightAudit = async () => ({ baseUrl: "http://x.example/", finalUrl: "http://x.example/", robotsAllowedPage: true, results: [] });
  await withTestServer({ runLightAudit }, async (base) => {
    const { status } = await post(base, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "http://x.example/" },
    });
    assert.equal(status, 200);
  });
});

// ---------------------------------------------------------------------------
// 并发池：满 20 立即 503，不排队
// ---------------------------------------------------------------------------

test("并发池满 20 → 立即 503，不排队", async () => {
  const audit = pendingAudit();
  await withTestServer({ runLightAudit: audit.runLightAudit }, async (base) => {
    const inflight = Array.from({ length: MAX_CONCURRENCY }, () =>
      post(base, { headers: { authorization: `Bearer ${TOKEN}` }, body: { url: "http://x.example/" } }),
    );
    await waitUntil(() => audit.started === MAX_CONCURRENCY);

    const overflowStart = Date.now();
    const { status: overflowStatus } = await post(base, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "http://x.example/" },
    });
    const overflowElapsed = Date.now() - overflowStart;
    assert.equal(overflowStatus, 503, "第 21 个请求应立即拿到 503，而不是排队等待前面的完成");
    assert.ok(overflowElapsed < 500, `503 应立即返回，不应有排队等待，实测 ${overflowElapsed}ms`);

    audit.releaseAll();
    const settled = await Promise.all(inflight);
    for (const r of settled) assert.equal(r.status, 200, "被放行进池子的 20 个请求应正常完成");
  });
});

// ---------------------------------------------------------------------------
// 正常请求
// ---------------------------------------------------------------------------

test("正常请求返回 { results: [...] }", async () => {
  const oneResult = { id: "readability.static-text", group: "readability", scored: true, state: "ready", verdict: "pass", observation: "o", evidence: { url: "http://x.example/" }, limitation: null };
  const runLightAudit = async (url) => ({ baseUrl: url, finalUrl: url, robotsAllowedPage: true, results: [oneResult] });

  await withTestServer({ runLightAudit }, async (base) => {
    const { status, json } = await post(base, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "http://x.example/" },
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.results), "响应必须带 results 数组");
    assert.equal(json.results.length, 1);
    assert.equal(json.results[0].id, "readability.static-text");
    assert.equal(json.baseUrl, "http://x.example/");
  });
});

test("请求体不是合法 JSON → 400，且不占用并发槽位", async () => {
  const runLightAudit = async () => ({ baseUrl: "x", finalUrl: "x", robotsAllowedPage: true, results: [] });
  await withTestServer({ runLightAudit, maxConcurrency: 1 }, async (base) => {
    const bad = await fetch(`${base}/audit/light`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "这不是 JSON",
    });
    assert.equal(bad.status, 400);

    // 上一个请求在拿到并发槽位之后、真正开始审计之前就失败了；
    // 若槽位没被正确 release，maxConcurrency:1 时这一条会立刻拿到 503。
    const { status } = await post(base, { headers: { authorization: `Bearer ${TOKEN}` }, body: { url: "http://x.example/" } });
    assert.equal(status, 200, "非法请求体不应占住唯一的并发槽位");
  });
});

test("runLightAudit 抛错 → 500，且释放槽位（每一条退出路径都要 release）", async () => {
  let calls = 0;
  const runLightAudit = async () => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return { baseUrl: "x", finalUrl: "x", robotsAllowedPage: true, results: [] };
  };
  await withTestServer({ runLightAudit, maxConcurrency: 1 }, async (base) => {
    const first = await post(base, { headers: { authorization: `Bearer ${TOKEN}` }, body: { url: "http://x.example/" } });
    assert.equal(first.status, 500);
    assert.equal(first.json.ok, false);
    assert.equal(first.json.reason, "worker_error");

    const second = await post(base, { headers: { authorization: `Bearer ${TOKEN}` }, body: { url: "http://x.example/" } });
    assert.equal(second.status, 200, "上一个请求抛错后应释放槽位，不应卡在 503");
  });
});

// ---------------------------------------------------------------------------
// 8 秒硬超时（用注入的小 timeoutMs 验证同一条路径，不真的等 8 秒）
// ---------------------------------------------------------------------------

test("硬超时到点即返回 JSON，不让连接挂着等 runLightAudit 真正完成", async () => {
  let resolveLate;
  const runLightAudit = () => new Promise((resolve) => { resolveLate = resolve; });

  await withTestServer({ runLightAudit, timeoutMs: 30 }, async (base) => {
    const startedAt = Date.now();
    const { status, json } = await post(base, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: { url: "http://x.example/" },
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.reason, "worker_error");
    assert.deepEqual(json.results, []);
    assert.ok(elapsed < 500, `应在超时预算附近返回，而不是等真正完成，实测 ${elapsed}ms`);

    resolveLate({ baseUrl: "x", finalUrl: "x", robotsAllowedPage: true, results: [] }); // 收尾，避免留下悬空 promise
  });
});

test("超时响应发出后，并发槽位仍被占用，直到 runLightAudit 真正结束才释放", async () => {
  let resolveLate;
  const runLightAudit = () => new Promise((resolve) => { resolveLate = resolve; });

  await withTestServer({ runLightAudit, maxConcurrency: 1, timeoutMs: 30 }, async (base) => {
    const first = await post(base, { headers: { authorization: `Bearer ${TOKEN}` }, body: { url: "http://x.example/" } });
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, false, "第一个请求应先收到超时形态的响应");

    // 此时后台的 runLightAudit 仍未 resolve：槽位理应仍被占用。
    const { status: stillFull } = await post(base, { headers: { authorization: `Bearer ${TOKEN}` }, body: { url: "http://x.example/" } });
    assert.equal(stillFull, 503, "响应已经发出不代表工作已经结束，槽位不该提前释放");

    resolveLate({ baseUrl: "x", finalUrl: "x", robotsAllowedPage: true, results: [] });

    let freed = false;
    for (let i = 0; i < 40 && !freed; i += 1) {
      const { status } = await post(base, { headers: { authorization: `Bearer ${TOKEN}` }, body: { url: "http://x.example/" } });
      if (status !== 503) freed = true;
      else await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(freed, "runLightAudit 真正 resolve 之后，槽位应被释放，20（这里是 1）的上限不该永久卡死");
  });
});

// ---------------------------------------------------------------------------
// 启动时的代理环境守卫
// ---------------------------------------------------------------------------

test("启动时若环境里存在代理变量则拒绝启动，不监听任何端口", () => {
  assert.throws(
    () => startServer({ env: { HTTP_PROXY: "http://127.0.0.1:7890" }, token: TOKEN, port: 0 }),
    /代理/,
    "assertNoProxyEnv 必须在创建/监听端口之前同步抛出",
  );
  assert.throws(
    () => startServer({ env: { https_proxy: "http://127.0.0.1:7890" }, token: TOKEN, port: 0 }),
    /代理/,
  );
});

test("无代理变量且必填项齐全时可以正常启动并监听", async () => {
  const server = await startServer({
    env: { ...MINIMAL_ENV },
    token: TOKEN,
    port: 0,
    runLightAudit: async () => ({ baseUrl: "x", finalUrl: "x", robotsAllowedPage: true, results: [] }),
    safeFetch: fakeSafeFetch,
  });
  try {
    assert.ok(server.address().port > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("缺少 MIAOWA_AUDIT_WORKER_TOKEN 时也拒绝启动", () => {
  let started;
  try {
    started = startServer({ env: { ...MINIMAL_ENV }, port: 0 });
  } catch (err) {
    assert.match(String(err.message), /TOKEN/);
    return;
  }
  Promise.resolve(started).then((server) => server?.close?.()).catch(() => {});
  assert.fail("缺 token 时本应拒绝启动");
});

// ---------------------------------------------------------------------------
// M6：启动时校验 MIAOWA_AUDIT_OWN_PUBLIC_IP 的格式
// ---------------------------------------------------------------------------

test("M6：MIAOWA_AUDIT_OWN_PUBLIC_IP 配成非法值时拒绝启动，不监听任何端口", () => {
  // 走 assertStartupRejected 而不是裸 assert.throws：见该函数的注释——
  // 变异测试时防线被摘掉，startServer 会意外成功并监听端口，
  // 裸 throws 会让 node --test 挂死而不是变红。
  assertStartupRejected(
    { ...MINIMAL_ENV, MIAOWA_AUDIT_OWN_PUBLIC_IP: "not-an-ip" },
    /MIAOWA_AUDIT_OWN_PUBLIC_IP/,
  );
  assertStartupRejected(
    { ...MINIMAL_ENV, MIAOWA_AUDIT_OWN_PUBLIC_IP: "203.0.113.9/32" },
    /MIAOWA_AUDIT_OWN_PUBLIC_IP/,
  );
});

// D2 之前这条的标题是「是合法 IP **或未配置**时正常启动」——「或未配置」那半句
// 断言的正是被 D2 判定为缺陷的行为（未配置则静默跳过整条防线）。
// 修 D2 时必须同时改掉它，否则测试会替旧缺陷背书。
test("M6：MIAOWA_AUDIT_OWN_PUBLIC_IP 是合法 IP 时正常启动", async () => {
  const server = await startServer({
    env: { ...MINIMAL_ENV },
    token: TOKEN,
    port: 0,
    runLightAudit: async () => ({ baseUrl: "x", finalUrl: "x", robotsAllowedPage: true, results: [] }),
    safeFetch: fakeSafeFetch,
  });
  try {
    assert.ok(server.address().port > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// D1：硬超时必须覆盖真实最坏路径
//
// 这条断言的写法本身就是修复的一部分。旧实现里 AUDIT_TIMEOUT_MS = 8000，
// 而真实最坏是 10.7 s——差额来自预飞的 3 s，设计文档假设它不占预算，
// 实现却把它放在 runLightAudit 内部、被硬超时一并包住。
//
// **必须真的做这道加法，不能硬编码 11000 去比对。** 硬编码的断言在下次有人
// 调 PREFLIGHT_TIMEOUT_MS / ROBOTS_TIMEOUT_MS / TARGET_TIMEOUT_MS /
// DEFAULT_THROTTLE_INTERVAL_MS 中任意一个时都不会变红——那正是这个缺陷
// 一路活到首次真实部署才被发现的机制。测试要守的是「预算闭合」这个不变式，
// 不是「这个数等于 11000」这个快照。
// ---------------------------------------------------------------------------

test("D1：AUDIT_TIMEOUT_MS 必须覆盖 预飞 + robots + 子请求错开 + 最后一个子请求", () => {
  const worstCase =
    PREFLIGHT_TIMEOUT_MS +
    ROBOTS_TIMEOUT_MS +
    TARGET_STAGGER_COUNT * DEFAULT_THROTTLE_INTERVAL_MS +
    TARGET_TIMEOUT_MS;

  assert.equal(worstCase, 10_700, "最坏路径的算式变了，先确认是有意改动，再更新本断言与 server.mjs 的注释");
  assert.ok(
    AUDIT_TIMEOUT_MS >= worstCase,
    `硬超时 ${AUDIT_TIMEOUT_MS}ms 覆盖不住最坏路径 ${worstCase}ms：` +
      `撞上硬超时的审计会变成 worker_error → 全部 not_wired，` +
      `把对方站点的问题（机器人防护掐连接、DNS 慢）记成我方失败`,
  );
});

test("D1：预飞确实在 runLightAudit 内部，因此必须计入硬超时预算", async () => {
  // 这条守的是上一条断言的**前提**。如果哪天有人把预飞挪到 runLightAudit 外面
  // （那样设计文档「预飞不占预算」的说法就成立了，硬超时可以调回 8 s），
  // 这条测试会变红，提醒他连带更新上一条的算式——而不是让两处各说各话。
  const calls = [];
  const { runLightAudit } = await import("../src/orchestrate-light.mjs");
  await runLightAudit("https://x.example/", {
    safeFetch: async (url, options) => {
      calls.push({ url, timeoutMs: options?.timeoutMs });
      return { ok: true, status: 200, headers: {}, body: "", finalUrl: url, reason: null };
    },
  });
  assert.equal(
    calls[0]?.timeoutMs,
    PREFLIGHT_TIMEOUT_MS,
    "runLightAudit 的第一次出网应当是预飞（用 PREFLIGHT_TIMEOUT_MS）——" +
      "它在函数内部，就必然被 server.mjs 的硬超时包住",
  );
});

// ---------------------------------------------------------------------------
// D3：深检查的配置缺失，绝不允许伪装成别的故障
//
// 无密钥调用 PSI 会拿到 429（2026-08-06 在服务器上实测过）。若不在启动期
// 拦下，performance 组会一片 not_wired，运维看到的现象是「PSI 配额耗尽」——
// 处置方向是"等配额恢复"，而真相是"变量名写错了"，处置方向是"改配置"。
// 这两件事必须在最早的时刻分开。
// ---------------------------------------------------------------------------

const DEEP_ENV = {
  MIAOWA_AUDIT_DEEP_ENABLED: "1",
  GOOGLE_PSI_API_KEY: "fake-key",
  MIAOWA_AUDIT_CHROME_PATH: "/opt/chrome/chrome",
};

test("D3：MIAOWA_AUDIT_DEEP_ENABLED 未显式设置时拒绝启动（不给默认值是刻意的）", () => {
  assert.throws(() => assertDeepCheckConfig({}), /必须显式设为/);
  assert.throws(() => assertDeepCheckConfig({ MIAOWA_AUDIT_DEEP_ENABLED: "" }), /必须显式设为/);
  assert.throws(() => assertDeepCheckConfig({ MIAOWA_AUDIT_DEEP_ENABLED: "true" }), /必须显式设为/);
  assert.throws(() => assertDeepCheckConfig({ MIAOWA_AUDIT_DEEP_ENABLED: "yes" }), /必须显式设为/);
});

test("D3：显式关闭时放行，且不要求任何深检查配置", () => {
  assert.deepEqual(assertDeepCheckConfig({ MIAOWA_AUDIT_DEEP_ENABLED: "0" }), { deepEnabled: false });
});

test("D3：启用但缺 GOOGLE_PSI_API_KEY 时拒绝启动，且错误信息点名大小写陷阱", () => {
  const { GOOGLE_PSI_API_KEY, ...withoutKey } = DEEP_ENV;
  assert.throws(
    () => assertDeepCheckConfig(withoutKey),
    (err) => /GOOGLE_PSI_API_KEY/.test(err.message) && /Google_PSI_API_key/.test(err.message),
    "错误信息必须点名密钥文件里的实际变量名 Google_PSI_API_key——" +
      "这个大小写不匹配正是 D3 本身，不写出来下一个人还会再踩",
  );
});

test("D3：启用但缺 MIAOWA_AUDIT_CHROME_PATH 时拒绝启动", () => {
  const { MIAOWA_AUDIT_CHROME_PATH, ...withoutChrome } = DEEP_ENV;
  assert.throws(() => assertDeepCheckConfig(withoutChrome), /MIAOWA_AUDIT_CHROME_PATH/);
});

test("D3：配齐时放行", () => {
  assert.deepEqual(assertDeepCheckConfig(DEEP_ENV), { deepEnabled: true });
});

test("D2+D3：startServer 会真的调用这两条断言（接线，不只是函数本身正确）", () => {
  // 这条守的是"接线"，不是断言逻辑——本仓库反复出现的形态正是
  // "守卫本身正确，在集成处失效"。把断言函数从 startServer 里摘掉，
  // 这条必须变红。
  // startServer() 对这类配置问题是**同步**抛错（它在 listen 之前就把关），
  // 所以用 assert.throws 而不是 assert.rejects——这也顺带钉住了
  // 「拒绝启动发生在监听任何端口之前」这个性质。
  //
  // assertStartupRejected 里那个「万一真启动了就关掉」的分支不是防御性冗余：
  // 做变异测试（把断言从 startServer 里摘掉）时，startServer 会**意外成功**
  // 并监听一个端口。裸用 assert.throws 的话，那个 server 没人关，
  // node --test 会一直等事件循环耗尽——测试不是变红，而是**挂死**。
  // 挂死的变异测试等于没有变异测试：跑的人只会以为是自己环境慢。
  assertStartupRejected(
    { MIAOWA_AUDIT_DEEP_ENABLED: "0" }, // 缺 OWN_PUBLIC_IP
    /MIAOWA_AUDIT_OWN_PUBLIC_IP/,
  );
  assertStartupRejected(
    { MIAOWA_AUDIT_OWN_PUBLIC_IP: "203.0.113.9" }, // 缺 DEEP_ENABLED
    /MIAOWA_AUDIT_DEEP_ENABLED/,
  );
});

// ---------------------------------------------------------------------------
// /audit/deep
// ---------------------------------------------------------------------------

const deepOk = { results: [{ id: "agent.cls", group: "agent", scored: true, state: "ready", verdict: "pass", observation: "o", evidence: { url: "u" }, limitation: null }] };

function postDeep(base, body, { auth = true } = {}) {
  return fetch(`${base}/audit/deep`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));
}

test("深检查未启用 → 503 deep_disabled，而不是 404", async () => {
  // 404 是「地址打错了」，deep_disabled 是「地址对，这台机器没开这个能力」。
  // 排障时含义完全不同，不能混。
  await withTestServer({ deepEnabled: false, runLightAudit: async () => ({ results: [] }) }, async (base) => {
    const { status, json } = await postDeep(base, { url: "https://x.example/", robotsAllowedPage: true });
    assert.equal(status, 503);
    assert.equal(json.reason, "deep_disabled");
  });
});

test("未鉴权时 /audit/deep 先回 401——不能靠状态码探出本机开了哪些能力", async () => {
  await withTestServer({ deepEnabled: false, runLightAudit: async () => ({ results: [] }) }, async (base) => {
    const { status, json } = await postDeep(base, { url: "https://x.example/", robotsAllowedPage: true }, { auth: false });
    assert.equal(status, 401, "鉴权必须排在 deep_disabled 之前");
    assert.equal(json.reason, "unauthorized");
  });
});

test("缺 robotsAllowedPage → 400，绝不默认放行也不默认禁止", async () => {
  let called = 0;
  await withTestServer(
    { deepEnabled: true, runDeepAudit: async () => { called += 1; return deepOk; }, runLightAudit: async () => ({ results: [] }) },
    async (base) => {
      const { status, json } = await postDeep(base, { url: "https://x.example/" });
      assert.equal(status, 400);
      assert.equal(json.reason, "bad_request");
      assert.equal(called, 0, "字段不合法时绝不能已经跑起来");
    },
  );
});

test("robotsAllowedPage 必须是布尔，字符串 \"true\" 也不认", async () => {
  await withTestServer(
    { deepEnabled: true, runDeepAudit: async () => deepOk, runLightAudit: async () => ({ results: [] }) },
    async (base) => {
      const { status } = await postDeep(base, { url: "https://x.example/", robotsAllowedPage: "true" });
      assert.equal(status, 400);
    },
  );
});

test("正常深检查 → 200，且 robotsAllowedPage 被透传给编排层", async () => {
  const seen = [];
  await withTestServer(
    {
      deepEnabled: true,
      runDeepAudit: async (url, opts) => { seen.push({ url, robotsAllowedPage: opts.robotsAllowedPage }); return deepOk; },
      runLightAudit: async () => ({ results: [] }),
    },
    async (base) => {
      const { status, json } = await postDeep(base, { url: "https://x.example/", robotsAllowedPage: true });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.results.length, 1);
      assert.deepEqual(seen, [{ url: "https://x.example/", robotsAllowedPage: true }]);
    },
  );
});

test("robots 禁止 → 200 + skipped_robots，不是 500 worker_error", async () => {
  // 设计文档第六节：skipped_robots 在呈现层按 no_data 渲染——那是对方侧的
  // 事实，不是我方失败。走 500/worker_error 会把它错记成我们没测成。
  const { RobotsDisallowedError } = await import("../src/orchestrate-deep.mjs");
  await withTestServer(
    {
      deepEnabled: true,
      runDeepAudit: async () => { throw new RobotsDisallowedError("https://x.example/"); },
      runLightAudit: async () => ({ results: [] }),
    },
    async (base) => {
      const { status, json } = await postDeep(base, { url: "https://x.example/", robotsAllowedPage: false });
      assert.equal(status, 200);
      assert.equal(json.reason, "skipped_robots");
      assert.notEqual(json.reason, "worker_error", "对方侧的正常事实不得记成我方失败");
    },
  );
});

test("深检查用的是 90 s 硬超时，不是轻检查的 11 s", async () => {
  const { DEEP_TIMEOUT_MS } = await import("../src/orchestrate-deep.mjs");
  assert.equal(DEEP_TIMEOUT_MS, 90_000);
  assert.ok(DEEP_TIMEOUT_MS > AUDIT_TIMEOUT_MS, "深检查预算必须远大于轻检查");

  // 接线断言：给一个很小的 deepTimeoutMs，深检查必须按**它**超时。
  //
  // **必须断言耗时，不能只断言「超时了」。** 变异实验证实过：把
  // `timeoutAfter(isDeep ? deepTimeoutMs : timeoutMs)` 改成
  // `timeoutAfter(timeoutMs)`，这条测试照样通过——因为 runDeepAudit
  // 永不 resolve，用轻检查的 11 s 预算最终也会超时，只是慢了 370 倍。
  // 断言「超时了」守不住「用的是哪个预算」，只有断言耗时才守得住。
  await withTestServer(
    {
      deepEnabled: true,
      deepTimeoutMs: 30,
      runDeepAudit: () => new Promise(() => {}),
      runLightAudit: async () => ({ results: [] }),
    },
    async (base) => {
      const startedAt = Date.now();
      const { status, json } = await postDeep(base, { url: "https://x.example/", robotsAllowedPage: true });
      const elapsed = Date.now() - startedAt;
      assert.equal(status, 200);
      assert.equal(json.reason, "worker_error");
      assert.ok(
        elapsed < 2000,
        `深检查必须按 deepTimeoutMs(30ms) 超时，实测 ${elapsed}ms——` +
          `接近 ${AUDIT_TIMEOUT_MS}ms 说明它错用了轻检查的预算`,
      );
    },
  );
});

test("深检查占用并发槽位，且完成后释放", async () => {
  let release;
  await withTestServer(
    {
      deepEnabled: true,
      maxConcurrency: 1,
      runDeepAudit: () => new Promise((r) => { release = () => r(deepOk); }),
      runLightAudit: async () => ({ baseUrl: "x", finalUrl: "x", robotsAllowedPage: true, results: [] }),
    },
    async (base) => {
      const first = postDeep(base, { url: "https://a.example/", robotsAllowedPage: true });
      await waitUntil(() => typeof release === "function");
      const overflow = await post(base, { headers: { authorization: `Bearer ${TOKEN}` }, body: { url: "http://b.example/" } });
      assert.equal(overflow.status, 503, "深检查占着唯一槽位时，轻检查也该拿到 503");
      release();
      assert.equal((await first).status, 200);
      const after = await post(base, { headers: { authorization: `Bearer ${TOKEN}` }, body: { url: "http://c.example/" } });
      assert.equal(after.status, 200, "深检查完成后必须释放槽位");
    },
  );
});

// ---------------------------------------------------------------------------
// 接线：深检查启用时必须真的把 allowlist 代理起起来
//
// 这条测试的来历：代理模块写完、13 条测试全绿之后，才发现**没有任何地方
// 调用 startAllowlistProxy()**。Chrome 会去连一个不存在的 127.0.0.1:4320。
// 那不会静默放行（Chrome 连不上代理就报错），但故障现象会变成
// 「所有深检查都失败」，而真正的原因是「代理压根没启动」——
// 又一次「守卫本身正确，在集成处失效」。
// ---------------------------------------------------------------------------

test("深检查启用时启动 allowlist 代理，并把**实际监听端口**交给 Lighthouse", async () => {
  const calls = [];
  const seenDeepDeps = [];
  let closed = 0;
  const fakeProxy = async (opts) => {
    calls.push(opts);
    return { port: 54321, close: async () => { closed += 1; }, stats: () => ({}) };
  };

  const server = await startServer({
    env: {
      ...MINIMAL_ENV,
      MIAOWA_AUDIT_DEEP_ENABLED: "1",
      GOOGLE_PSI_API_KEY: "k",
      MIAOWA_AUDIT_CHROME_PATH: "/c",
      MIAOWA_AUDIT_PROXY_PORT: "4320",
    },
    token: TOKEN,
    port: 0,
    safeFetch: fakeSafeFetch,
    runLightAudit: async () => ({ results: [] }),
    startAllowlistProxy: fakeProxy,
    runDeepAudit: async (url, deps) => { seenDeepDeps.push(deps); return { results: [] }; },
  });

  try {
    assert.equal(calls.length, 1, "深检查启用时必须启动代理");
    assert.equal(calls[0].port, 4320);
    assert.equal(
      calls[0].ownPublicIp,
      MINIMAL_ENV.MIAOWA_AUDIT_OWN_PUBLIC_IP,
      "本机公网 IP 必须传给代理，否则「拒绝连回本机」这条防线在代理侧不存在",
    );
    assert.equal(server.deepProxyPort, 54321, "对外暴露的是代理**实际监听**的端口");

    // 关键：断言**真正交给 Lighthouse 的那个端口**，而不只是 server 上的
    // 附属字段。变异实验证实过——只断言 server.deepProxyPort 时，
    // 把 deepConfig.proxyPort 改回读配置文件（4320）不会被发现，
    // 而那正是「代理监听 54321、Chrome 却去连 4320」的线上故障形态。
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/audit/deep`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ url: "https://x.example/", robotsAllowedPage: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      seenDeepDeps[0]?.proxyPort,
      54321,
      `Lighthouse 拿到的必须是代理实际监听的端口，实测 ${seenDeepDeps[0]?.proxyPort}——` +
        "拿成配置里写的那个，Chrome 会去连一个没人监听的端口，而配置文件看起来完全正常",
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(closed, 1, "关服务时必须把代理一起关掉，否则漏一个监听中的 socket");
});

test("深检查未启用时不启动代理（不白占一个端口）", async () => {
  let started = 0;
  const server = await startServer({
    env: { ...MINIMAL_ENV },
    token: TOKEN,
    port: 0,
    safeFetch: fakeSafeFetch,
    runLightAudit: async () => ({ results: [] }),
    startAllowlistProxy: async () => { started += 1; return { port: 1, close: async () => {}, stats: () => ({}) }; },
  });
  try {
    assert.equal(started, 0);
    assert.equal(server.deepProxyPort, null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("配置问题仍然是同步抛错——不能因为要 await 代理就退化成 rejected promise", () => {
  // startServer 的调用方（isMain 分支与上面若干测试）依赖
  // 「配置问题以同步异常呈现、且发生在监听任何端口之前」这个性质。
  // 把 startServer 整个改成 async 会把这些同步抛错统统变成 rejection，
  // 「拒绝启动」就会晚于 listen 发生。
  assert.throws(
    () => startServer({ env: { HTTP_PROXY: "http://x" }, token: TOKEN, port: 0 }),
    /代理环境变量/,
  );
  assert.throws(
    () => startServer({ env: { ...MINIMAL_ENV, MIAOWA_AUDIT_DEEP_ENABLED: "1" }, token: TOKEN, port: 0 }),
    /GOOGLE_PSI_API_KEY/,
  );
});

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

test("MIAOWA_AUDIT_TLS 未显式设置时拒绝启动（默认明文 = Bearer token 裸奔）", () => {
  const { MIAOWA_AUDIT_TLS, ...withoutTls } = MINIMAL_ENV;
  assert.throws(() => assertTlsConfig(withoutTls), /必须显式设为/);
  assert.throws(() => assertTlsConfig({ ...withoutTls, MIAOWA_AUDIT_TLS: "" }), /必须显式设为/);
  assert.throws(() => assertTlsConfig({ ...withoutTls, MIAOWA_AUDIT_TLS: "true" }), /必须显式设为/);
});

test("TLS=1 但缺证书路径 → 拒绝启动", () => {
  assert.throws(() => assertTlsConfig({ MIAOWA_AUDIT_TLS: "1" }), /CERT_PATH/);
  assert.throws(
    () => assertTlsConfig({ MIAOWA_AUDIT_TLS: "1", MIAOWA_AUDIT_TLS_CERT_PATH: "/c" }),
    /KEY_PATH/,
  );
});

test("证书读不出来时**拒绝启动**，绝不退回明文", () => {
  // 退回明文是最坏的处置：服务看起来好好的，主站那边的指纹校验会失败
  // 并把它记成「Worker 挂了」，而真正的原因（证书文件权限错了）没人看得见。
  const boom = () => { throw new Error("EACCES: permission denied"); };
  assert.throws(
    () => assertTlsConfig(
      { MIAOWA_AUDIT_TLS: "1", MIAOWA_AUDIT_TLS_CERT_PATH: "/c", MIAOWA_AUDIT_TLS_KEY_PATH: "/k" },
      boom,
    ),
    /拒绝启动——绝不退回明文/,
  );
});

test("TLS=0 时明确返回不启用（本机自测的唯一正当场景）", () => {
  assert.deepEqual(assertTlsConfig({ MIAOWA_AUDIT_TLS: "0" }), { tls: null });
});

test("TLS=1 且证书可读时把证书内容带出来", () => {
  const fake = (p) => `content-of-${p}`;
  const { tls } = assertTlsConfig(
    { MIAOWA_AUDIT_TLS: "1", MIAOWA_AUDIT_TLS_CERT_PATH: "/c.crt", MIAOWA_AUDIT_TLS_KEY_PATH: "/k.key" },
    fake,
  );
  assert.equal(tls.cert, "content-of-/c.crt");
  assert.equal(tls.key, "content-of-/k.key");
});

test("startServer 真的调用了 TLS 断言（接线）", () => {
  const { MIAOWA_AUDIT_TLS, ...withoutTls } = MINIMAL_ENV;
  assertStartupRejected(withoutTls, /MIAOWA_AUDIT_TLS/);
});

// ---------------------------------------------------------------------------
// /audit/probe：UA 差分矩阵阶段
// ---------------------------------------------------------------------------

async function postTo(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("/audit/probe 返回矩阵与厂商", async () => {
  await withTestServer(
    { runProbeAudit: async () => ({ results: [{ id: "access.ua-matrix" }], matrix: [{ id: "chrome", status: 200 }], vendor: { id: "cloudflare" } }) },
    async (base) => {
      const { status, json } = await postTo(base, "/audit/probe", { url: "https://x.example/" });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.matrix[0].status, 200);
      assert.equal(json.vendor.id, "cloudflare");
    },
  );
});

test("/audit/probe 同样要鉴权", async () => {
  await withTestServer({ runProbeAudit: async () => ({ results: [] }) }, async (base) => {
    const res = await fetch(`${base}/audit/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.example/" }),
    });
    assert.equal(res.status, 401);
  });
});

test("**/audit/probe 不需要传 robotsAllowedPage**——它自己读规则", async () => {
  // 深检查要求调用方传，是因为浏览器 UA 不受我们控制；
  // 而探针的每一个 UA 都是我们自己选的，可以自己先读 robots。
  await withTestServer({ runProbeAudit: async () => ({ results: [], matrix: [] }) }, async (base) => {
    const { status, json } = await postTo(base, "/audit/probe", { url: "https://x.example/" });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });
});

test("**探针有独立并发池，不与轻检查抢槽位**", async () => {
  // 便宜且高价值的东西排在昂贵的东西后面没有道理。
  // 把轻检查的池压到 1 并占满，探针仍然要能进来。
  let releaseLight;
  const lightBlocker = new Promise((r) => { releaseLight = r; });
  await withTestServer(
    {
      maxConcurrency: 1,
      runLightAudit: async () => { await lightBlocker; return { results: [] }; },
      runProbeAudit: async () => ({ results: [], matrix: [{ id: "chrome", status: 200 }] }),
    },
    async (base) => {
      const light = postTo(base, "/audit/light", { url: "https://x.example/" });
      await new Promise((r) => setTimeout(r, 30)); // 让轻检查先占住那唯一的槽位
      const probe = await postTo(base, "/audit/probe", { url: "https://x.example/" });
      assert.equal(probe.status, 200, "轻检查池满不该挡住探针");
      assert.equal(probe.json.ok, true);
      releaseLight();
      await light;
    },
  );
});

test("**探针用自己的 15s 预算，不是轻检查的 11s**", async () => {
  // 七个探针串行 + 300ms 同源节流，最坏路径约 6.4s；轻检查的预算是按
  // 「用户同步等待」定的 11s，两者本来就不该共用一个数。
  // 用一个「比轻检查预算长、比探针预算短」的耗时来分辨：
  // 若探针误用了轻检查的超时，这次会被截断成 worker_error。
  await withTestServer(
    {
      timeoutMs: 40,          // 轻检查预算：很短
      probeTimeoutMs: 400,    // 探针预算：长得多
      runProbeAudit: async () => {
        await new Promise((r) => setTimeout(r, 150)); // 夹在两者之间
        return { results: [], matrix: [{ id: "chrome", status: 200 }] };
      },
    },
    async (base) => {
      const { status, json } = await postTo(base, "/audit/probe", { url: "https://x.example/" });
      assert.equal(status, 200);
      assert.equal(json.ok, true, "探针被轻检查的短预算截断了——说明超时选错了那一个");
      assert.equal(json.matrix[0].status, 200);
    },
  );
});
