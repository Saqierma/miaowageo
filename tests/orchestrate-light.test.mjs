import assert from "node:assert/strict";
import test from "node:test";

import { runLightAudit } from "../src/orchestrate-light.mjs";

/**
 * 轻检查编排是网络层和纯检查函数之间的缝合层，这些测试守三条最容易做错的事：
 *
 *   1. 产品令牌必须是 "MiaowaGEO-Audit"，不能偷懒用 "*"——否则一个明确屏蔽本工具、
 *      却放行 "*" 的站点会被误判为允许，故障矩阵里「该站禁止本工具抓取」就成了假话。
 *   2. Disallow 是按路径求值的，不是按站点：页面路径被禁不代表 sitemap.xml 也被禁。
 *   3. 被禁的路径不发真实请求，但仍要产出结果——通过构造
 *      `{ ok:false, reason:"robots_disallowed" }` 交给对应 check，让文案走
 *      fetch-outcome 的统一映射，而不是编排层自己写一句话。
 *
 * 所有测试注入一个假的 safeFetch，不联网、不依赖 safe-fetch.mjs 自己的节流——
 * 节流是 safe-fetch 内部的职责，这里只验证编排层「并行发起、按路径求值」对不对。
 */

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/**
 * 造一个记录调用时刻（相对起点的毫秒数）与调用参数的假 safeFetch。
 * `delayMs` 模拟网络延迟：真正验证「并行」全靠它——如果编排层串行 await，
 * N 次调用的总耗时会是 N × delayMs；并行发起的一批调用应几乎同时开始。
 */
function makeMockSafeFetch(handler, { delayMs = 0 } = {}) {
  const calls = [];
  const start = performance.now();
  const safeFetch = async (url, options) => {
    calls.push({ url, options, startedAt: performance.now() - start });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return handler(url, options);
  };
  return { safeFetch, calls };
}

function ok(url, body, extra = {}) {
  return { ok: true, status: 200, headers: {}, body, finalUrl: url, reason: null, ...extra };
}

function notFound(url) {
  return { ok: false, status: 404, headers: {}, body: null, finalUrl: url, reason: "http_error" };
}

const HTML_PAGE = '<html><head><link rel="canonical" href="__URL__"></head><body>hi</body></html>';

// ---------------------------------------------------------------------------
// 1. 预飞规范化
// ---------------------------------------------------------------------------

test("预飞：提交根路径经 302 落地到新主机的 /landing 后，后续所有子请求都基于新主机构建", async () => {
  const submitted = "http://host.example/";
  const { safeFetch, calls } = makeMockSafeFetch((url) => {
    if (url === submitted) {
      // safeFetch 内部已经跟完重定向链，编排层只看得到这一个最终结果。
      return ok(url, "<html>landing</html>", { finalUrl: "http://www.host.example/landing" });
    }
    if (url.endsWith("/robots.txt")) return ok(url, "User-agent: *\nAllow: /\n");
    return notFound(url);
  });

  const result = await runLightAudit(submitted, { safeFetch });

  assert.equal(result.baseUrl, "http://www.host.example");
  assert.equal(result.finalUrl, "http://www.host.example/landing");

  const requested = calls.map((c) => c.url);
  assert.ok(requested.includes("http://www.host.example/robots.txt"), "robots.txt 应基于最终落地主机构建");
  assert.ok(requested.includes("http://www.host.example/sitemap.xml"));
  assert.ok(requested.includes("http://www.host.example/llms.txt"));
  assert.ok(requested.includes("http://www.host.example/agents.md"));
  assert.ok(requested.includes("http://www.host.example/.well-known/ucp"));
  assert.ok(requested.includes("http://www.host.example/landing"), "页面检查应针对落地页 URL，而不是提交时的旧路径");

  const staleHostCalls = requested.filter((u) => u.startsWith("http://host.example/") && u !== submitted);
  assert.deepEqual(staleHostCalls, [], "预飞调用之外，不应再有任何请求用旧主机构造");
});

// ---------------------------------------------------------------------------
// 2. 产品令牌——本任务存在的第一个理由
// ---------------------------------------------------------------------------

test("必须优先匹配 MiaowaGEO-Audit 专属分组，不能回落到 *（RFC 9309 §2.2.1）", async () => {
  const robotsBody = ["User-agent: *", "Allow: /", "", "User-agent: MiaowaGEO-Audit", "Disallow: /", ""].join("\n");
  const { safeFetch } = makeMockSafeFetch((url) => {
    if (url.endsWith("/robots.txt")) return ok(url, robotsBody);
    return ok(url, HTML_PAGE.replace("__URL__", url));
  });

  const result = await runLightAudit("http://host.example/", { safeFetch });

  assert.equal(
    result.robotsAllowedPage,
    false,
    "站点明确屏蔽了 MiaowaGEO-Audit；若编排层用 * 组求值会误判为允许，这条测试就是钉住这一点",
  );
});

// ---------------------------------------------------------------------------
// 3. 按路径独立求值——本任务存在的第二个理由
// ---------------------------------------------------------------------------

test("页面路径被 Disallow 时，sitemap.xml/llms.txt/agents.md/ucp 仍照常抓取，只有页面 HTML 被跳过", async () => {
  const robotsBody = [
    "User-agent: MiaowaGEO-Audit",
    "Disallow: /",
    "Allow: /sitemap.xml",
    "Allow: /llms.txt",
    "Allow: /agents.md",
    "Allow: /.well-known/ucp",
    "",
  ].join("\n");
  const { safeFetch, calls } = makeMockSafeFetch((url) => {
    if (url.endsWith("/robots.txt")) return ok(url, robotsBody);
    return ok(url, HTML_PAGE.replace("__URL__", url));
  });

  const result = await runLightAudit("http://host.example/", { safeFetch });

  assert.equal(result.robotsAllowedPage, false);

  // 页面只应在预飞阶段被抓取一次；robots 判定禁止之后不应该再重新抓一次页面 HTML。
  const pageFetchCount = calls.filter((c) => c.url === "http://host.example/").length;
  assert.equal(pageFetchCount, 1, "预飞抓了一次页面；robots 禁止后不应再发第二次页面请求");

  for (const suffix of ["/sitemap.xml", "/llms.txt", "/agents.md", "/.well-known/ucp"]) {
    assert.ok(
      calls.some((c) => c.url === `http://host.example${suffix}`),
      `${suffix} 应照常发起真实请求，不受页面路径被 Disallow 影响`,
    );
  }

  const sitemapResult = result.results.find((r) => r.id === "access.sitemap");
  assert.equal(sitemapResult.state, "ready", "sitemap.xml 抓取成功，不应因页面被禁而坍缩成 no_data");
});

test("按路径独立求值的反面：只 Disallow /sitemap.xml 时，页面等其余路径仍正常抓取", async () => {
  const robotsBody = "User-agent: MiaowaGEO-Audit\nDisallow: /sitemap.xml\n";
  const { safeFetch, calls } = makeMockSafeFetch((url) => {
    if (url.endsWith("/robots.txt")) return ok(url, robotsBody);
    return ok(url, HTML_PAGE.replace("__URL__", url));
  });

  const result = await runLightAudit("http://host.example/", { safeFetch });

  assert.equal(result.robotsAllowedPage, true);
  assert.ok(
    !calls.some((c) => c.url === "http://host.example/sitemap.xml"),
    "sitemap.xml 应被跳过，不应发起真实请求",
  );

  const sitemapResult = result.results.find((r) => r.id === "access.sitemap");
  assert.equal(sitemapResult.state, "no_data");

  const readabilityResult = result.results.find((r) => r.id === "readability.static-text");
  assert.equal(readabilityResult.state, "ready", "页面路径未被禁止，应正常测出结果");
});

// ---------------------------------------------------------------------------
// 4. 被禁路径仍产出结果——走 fetch-outcome 的统一映射
// ---------------------------------------------------------------------------

test("被 Disallow 的路径构造 { ok:false, reason:'robots_disallowed' }，文案来自 fetch-outcome 的统一映射", async () => {
  const robotsBody = "User-agent: MiaowaGEO-Audit\nDisallow: /\n";
  const { safeFetch } = makeMockSafeFetch((url) => {
    if (url.endsWith("/robots.txt")) return ok(url, robotsBody);
    if (url.endsWith("/sitemap.xml")) return ok(url, "<urlset><url><loc>http://host.example/a</loc></url></urlset>");
    return notFound(url);
  });

  const result = await runLightAudit("http://host.example/", { safeFetch });

  const canonicalResult = result.results.find((r) => r.id === "access.canonical");
  assert.equal(canonicalResult.state, "no_data");
  assert.match(
    canonicalResult.observation,
    /robots\.txt 禁止本工具抓取/,
    "文案必须来自 fetch-outcome.mjs 的统一映射，而不是编排层自己写一句话",
  );

  const readabilityResult = result.results.find((r) => r.id === "readability.static-text");
  assert.match(readabilityResult.observation, /robots\.txt 禁止本工具抓取/);
});

// ---------------------------------------------------------------------------
// 5. 页面被 Disallow 时的分组归零
// ---------------------------------------------------------------------------

test("页面被 Disallow 时：readability/structured 的 scored 项全部 no_data，access 组的 9 个爬虫项仍是 ready", async () => {
  const robotsBody = "User-agent: MiaowaGEO-Audit\nDisallow: /\n";
  const { safeFetch } = makeMockSafeFetch((url) => {
    if (url.endsWith("/robots.txt")) return ok(url, robotsBody);
    if (url.endsWith("/sitemap.xml")) return ok(url, "<urlset><url><loc>http://host.example/a</loc></url></urlset>");
    return notFound(url);
  });

  const result = await runLightAudit("http://host.example/", { safeFetch });

  const readabilityScored = result.results.filter((r) => r.group === "readability" && r.scored);
  assert.ok(readabilityScored.length > 0, "测试前提：readability 组确实存在 scored 项");
  for (const item of readabilityScored) assert.equal(item.state, "no_data", `${item.id} 应为 no_data`);

  const structuredScored = result.results.filter((r) => r.group === "structured" && r.scored);
  assert.ok(structuredScored.length > 0, "测试前提：structured 组确实存在 scored 项");
  for (const item of structuredScored) assert.equal(item.state, "no_data", `${item.id} 应为 no_data`);

  const crawlerItems = result.results.filter((r) => r.id.startsWith("robots.") && r.scored);
  assert.equal(crawlerItems.length, 9, "V1 爬虫清单里 scored 的应恰好 9 个");
  for (const item of crawlerItems) {
    assert.equal(item.state, "ready", `${item.id} 应仍是 ready —— robots.txt 本身抓取成功，与页面是否被禁无关`);
  }
});

// ---------------------------------------------------------------------------
// 6. 并行
// ---------------------------------------------------------------------------

test("请求并行发起、并行等待：模拟每次响应延迟 500ms，总耗时远低于串行之和", async () => {
  const { safeFetch, calls } = makeMockSafeFetch(
    (url) => {
      if (url.endsWith("/robots.txt")) return ok(url, "User-agent: *\nAllow: /\n");
      return ok(url, HTML_PAGE.replace("__URL__", url));
    },
    { delayMs: 500 },
  );

  const startedAt = performance.now();
  await runLightAudit("http://host.example/", { safeFetch });
  const elapsed = performance.now() - startedAt;

  // 7 次调用（预飞 + robots.txt + 5 个目标路径）串行会是 3500ms；
  // 预飞与 robots.txt 各自依赖上一步的结果，天然串行，但 5 个目标路径必须并行。
  // 三段之和 ≈ 1500ms，留足冗余断言 < 2500ms（而不是接近甚至超过 3000ms）。
  assert.ok(elapsed < 2500, `全流程耗时应远低于 7×500ms=3500ms 的串行值，实测 ${elapsed.toFixed(0)}ms`);

  // 只看总耗时可能因为别的原因侥幸通过（例如某一步被误跳过）。
  // 更硬的证据：调用记录严格按「预飞 → robots.txt → 5 个目标路径」的顺序压入数组
  // （每次调用在 await 延迟之前就同步 push），5 个目标路径应几乎同时发起。
  assert.equal(calls.length, 7, "应有 7 次抓取：预飞 + robots.txt + 5 个目标路径");
  const [, , ...targetCalls] = calls;
  assert.equal(targetCalls.length, 5);
  const starts = targetCalls.map((c) => c.startedAt);
  const spread = Math.max(...starts) - Math.min(...starts);
  assert.ok(spread < 100, `5 个目标路径应几乎同时发起，实测跨度 ${spread.toFixed(1)}ms（串行会有 ~2000ms 跨度）`);
});

// ---------------------------------------------------------------------------
// 7. 超时预算（设计文档明确写了具体数字，容易在重构中悄悄改错）
// ---------------------------------------------------------------------------

test("各阶段使用规定的超时预算：预飞 3s、robots.txt 3s、5 个目标路径各 3.5s", async () => {
  const { safeFetch, calls } = makeMockSafeFetch((url) => {
    if (url.endsWith("/robots.txt")) return ok(url, "User-agent: *\nAllow: /\n");
    return ok(url, HTML_PAGE.replace("__URL__", url));
  });

  await runLightAudit("http://host.example/", { safeFetch });

  const [preflightCall, robotsCall, ...targetCalls] = calls;
  assert.equal(preflightCall.options?.timeoutMs, 3000, "预飞使用 3s 超时，不占用 8s 轻量预算");
  assert.equal(robotsCall.options?.timeoutMs, 3000, "robots.txt 使用 3s 超时");
  assert.equal(targetCalls.length, 5);
  for (const call of targetCalls) assert.equal(call.options?.timeoutMs, 3500, `${call.url} 应使用 3.5s 超时`);
});

// ---------------------------------------------------------------------------
// 8. 依赖注入 & 返回形状
// ---------------------------------------------------------------------------

test("缺少 deps.safeFetch 时明确报错，而不是静默调用真实网络", async () => {
  await assert.rejects(() => runLightAudit("http://host.example/", {}), /safeFetch/);
});

test("正常站点：七个 check 模块都参与拼装，返回形状完整", async () => {
  const { safeFetch } = makeMockSafeFetch((url) => {
    if (url.endsWith("/robots.txt")) return ok(url, "User-agent: *\nAllow: /\n");
    if (url.endsWith("/sitemap.xml")) return ok(url, "<urlset><url><loc>http://host.example/a</loc></url></urlset>");
    if (url.endsWith("/llms.txt") || url.endsWith("/agents.md") || url.endsWith("/.well-known/ucp")) return notFound(url);
    return ok(
      url,
      `<html><head><link rel="canonical" href="${url}"><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></head><body>${"内容 ".repeat(200)}</body></html>`,
    );
  });

  const result = await runLightAudit("http://host.example/", { safeFetch });

  assert.equal(result.baseUrl, "http://host.example");
  assert.equal(result.finalUrl, "http://host.example/");
  assert.equal(result.robotsAllowedPage, true);
  // 13(robots) + 1(readability) + 2(structured) + 2(canonical)
  // + 8(metadata) + 1(sitemap) + 3(agent) = 30
  //
  // metadata 那 8 项是 2026-08-07 加的：title / description / h1 / lang /
  // hreflang / viewport / og / img-alt，全部从**已经抓到的** page HTML 判定，
  // 不多发一次请求。加它们的理由见 src/checks/html-meta.mjs 顶部。
  assert.equal(result.results.length, 30);

  const groups = new Set(result.results.map((r) => r.group));
  for (const g of ["access", "metadata", "readability", "structured", "agent"]) {
    assert.ok(groups.has(g), `拼装结果里缺少 ${g} 分组`);
  }
});
