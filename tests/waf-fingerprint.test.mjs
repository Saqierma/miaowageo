import assert from "node:assert/strict";
import test from "node:test";

import {
  FINGERPRINTS,
  identifyVendor,
  identifyFromMatrix,
  VENDOR_GUIDE,
  guideFor,
  GENERIC_GUIDE,
} from "../src/probe/waf-fingerprint.mjs";

/**
 * WAF / CDN 指纹。
 *
 * 这一组守两件事：
 *   1. 认得出的要认对——认错厂商，用户会去一个他根本没有的控制台里
 *      找一个不存在的开关；
 *   2. **认不出时必须说「未能识别」，不许猜。**
 */

test("认得出常见厂商", () => {
  const cases = [
    [{ "cf-ray": "8a1b2c3d" }, "cloudflare"],
    [{ server: "cloudflare" }, "cloudflare"],
    [{ "x-akamai-request-id": "abc" }, "akamai"],
    [{ server: "AkamaiGHost" }, "akamai"],
    [{ eagleid: "1234" }, "aliyun"],
    [{ server: "Tengine" }, "aliyun"],
    [{ "x-nws-log-uuid": "xyz" }, "tencent"],
    [{ "x-amz-cf-id": "id" }, "cloudfront"],
    [{ "x-fastly-request-id": "id" }, "fastly"],
    [{ "x-sucuri-id": "id" }, "sucuri"],
  ];
  for (const [headers, expected] of cases) {
    const v = identifyVendor(headers);
    assert.ok(v, `${JSON.stringify(headers)} 应当认得出`);
    assert.equal(v.id, expected, JSON.stringify(headers));
  }
});

/**
 * 真实抓到的响应头，来自生产环境对 www.nytimes.com 的一次探测。
 *
 * **这两组是这个文件里最有价值的用例**，因为漏认 Fastly 这个 bug 不是靠
 * 想出来的——手写的 fixture 和实现共享同一个误解，测试全绿而功能是死的。
 * 是拿真实站点验收、逐字读响应头才发现的。所以这里保留真值，不简化。
 */
const NYT_ALLOWED = {
  server: "envoy",
  "x-timer": "S1786615939.570354,VS0,VE103",
  "x-served-by": "cache-lga21933-LGA, cache-icn1450079-ICN",
  "x-cache": "HIT, HIT",
  "x-cache-hits": "8, 1",
  vary: "Accept-Encoding, Fastly-SSL",
  "fastly-restarts": "1",
  "content-type": "text/html; charset=utf-8",
};
const NYT_BLOCKED = {
  server: "Varnish",
  trace: "fastly_error_code=663",
  "x-served-by": "cache-icn1450058-ICN",
  "x-cache": "MISS",
  "retry-after": "0",
  "cache-control": "private, no-store",
};

test("**真实 Fastly 响应要认得出来**（放行页与拦截页各一份）", () => {
  const allowed = identifyVendor(NYT_ALLOWED);
  assert.equal(allowed?.id, "fastly", "放行的那一行认不出 Fastly");
  assert.equal(allowed.confidence, "strong");

  const blocked = identifyVendor(NYT_BLOCKED);
  assert.equal(blocked?.id, "fastly", "被拦的那一行认不出 Fastly");
  assert.equal(blocked.confidence, "strong");
});

test("**x-timer 与 x-served-by 必须成对出现才判 Fastly**", () => {
  // 成对是签名；单独一个 x-timer 自建 Varnish 也可能有，不足以定案。
  assert.equal(identifyVendor({ "x-timer": "S1.1,VS0,VE1" }), null, "只有 x-timer 就不该定案");
  assert.equal(identifyVendor({ "x-served-by": "cache-abc" }), null, "只有 x-served-by 就不该定案");
  assert.equal(
    identifyVendor({ "x-timer": "S1.1,VS0,VE1", "x-served-by": "cache-abc" })?.id,
    "fastly",
    "两个都在就该判 Fastly",
  );
});

test("**tengine 只是弱信号，不能当确证说出来**", () => {
  // Tengine 是开源可自建的。按确证处理，就会把自建用户送进一个他没有的控制台。
  const v = identifyVendor({ server: "Tengine" });
  assert.equal(v.id, "aliyun");
  assert.equal(v.confidence, "weak", "tengine 被当成了确证");
  assert.match(v.caveat ?? "", /自建/, "弱信号必须说清楚它为什么不可靠");

  // 同一家的强特征仍然是强的。
  assert.equal(identifyVendor({ eagleid: "1234" }).confidence, "strong");
});

test("**强特征永远压过弱特征，不管谁排在前面**", () => {
  // aliyun 在指纹表里排在 fastly 前面。单轮循环会让弱的 tengine
  // 盖掉强的 Fastly 确证——所以扫描必须分两轮。
  const v = identifyVendor({ server: "Tengine", trace: "fastly_error_code=663" });
  assert.equal(v.id, "fastly", "弱信号盖掉了强特征");
  assert.equal(v.confidence, "strong");

  const v2 = identifyVendor({ server: "Tengine", "cf-ray": "8a1b" });
  assert.equal(v2.id, "cloudflare");
});

test("**矩阵层同样是强特征优先**", () => {
  // 第一个探针上的弱信号不该盖掉第三个探针上的确证。
  const rows = [
    { id: "chrome", status: 200, headers: { server: "Tengine" } },
    { id: "curl", status: 200, headers: { server: "nginx" } },
    { id: "claudebot", status: 403, headers: { "cf-ray": "8a1b" } },
  ];
  const v = identifyFromMatrix(rows);
  assert.equal(v.id, "cloudflare", "弱信号在矩阵层盖掉了确证");
  assert.equal(v.seenOn, "claudebot");

  // 整张表只有弱信号时，弱的照样要用上——有总比没有强，只是措辞不同。
  const weakOnly = identifyFromMatrix([{ id: "chrome", status: 200, headers: { server: "Tengine" } }]);
  assert.equal(weakOnly.id, "aliyun");
  assert.equal(weakOnly.confidence, "weak");
  assert.equal(weakOnly.seenOn, "chrome");
});

test("**认不出时返回 null，绝不猜**", () => {
  // 没命中可能是：没用 CDN、用了但关了标识头、或者是我们不认识的厂商。
  // 这三种情况分不开，所以只能说「未能识别」。
  for (const headers of [{}, { server: "nginx" }, { server: "Apache/2.4" }, { "x-powered-by": "PHP" }, null, undefined]) {
    assert.equal(identifyVendor(headers), null, JSON.stringify(headers));
  }
});

test("**不拿通用值当指纹**", () => {
  // 用 server: nginx 这种值做指纹，会把一半互联网认成同一家。
  for (const fp of FINGERPRINTS) {
    for (const needle of fp.serverIncludes) {
      assert.ok(
        !["nginx", "apache", "iis", "openresty"].includes(needle.toLowerCase()),
        `${fp.id} 用了通用 server 值 ${needle} 当指纹`,
      );
    }
    for (const h of fp.headers) {
      assert.ok(
        !["server", "via", "x-powered-by", "date", "content-type"].includes(h),
        `${fp.id} 用了通用响应头 ${h} 当指纹`,
      );
    }
    // 成对匹配放宽了「键本身要够特异」的要求，但**不能放宽到通用头**——
    // 拿 date + content-type 成对，能把整个互联网认成一家。
    for (const pair of fp.headerPairs ?? []) {
      assert.ok(pair.length >= 2, `${fp.id} 的 headerPairs 只有一个键，那就不是成对`);
      for (const h of pair) {
        assert.ok(
          !["server", "date", "content-type", "content-length", "cache-control", "connection"].includes(h),
          `${fp.id} 拿通用响应头 ${h} 凑成对`,
        );
      }
    }
    // 值匹配同理：子串太短会命中一堆不相干的值。
    for (const { includes } of fp.headerValues ?? []) {
      assert.ok(includes.length >= 5, `${fp.id} 的值匹配子串「${includes}」太短，容易误命中`);
    }
  }
});

test("**弱信号必须自带说明它为什么不可靠**", () => {
  // 弱信号的全部风险在于被当成确证。没有 caveat，措辞层就没有材料把话说软。
  for (const fp of FINGERPRINTS) {
    for (const w of fp.weakServerIncludes ?? []) {
      assert.ok(w.needle, `${fp.id} 的弱信号没有 needle`);
      assert.ok(w.caveat && w.caveat.length > 10, `${fp.id} 的弱信号 ${w.needle} 没有说明为什么不可靠`);
    }
  }
});

test("响应头大小写不敏感", () => {
  assert.equal(identifyVendor({ "CF-Ray": "x" })?.id, "cloudflare");
  assert.equal(identifyVendor({ Server: "AkamaiGHost" })?.id, "akamai");
});

test("**在整张矩阵里找，不只看第一个探针**", () => {
  // 被拦截的那个探针拿到的往往正是 WAF 自己生成的拦截页，
  // 厂商标识头反而最全；放行的响应可能走的是源站直出。
  const rows = [
    { id: "chrome", role: "baseline", status: 200, headers: { server: "nginx" } },
    { id: "claudebot", role: "ai", status: 403, headers: { "cf-ray": "8a1b" } },
  ];
  const v = identifyFromMatrix(rows);
  assert.equal(v.id, "cloudflare");
  assert.equal(v.seenOn, "claudebot", "要记录是在哪个探针上看到的");
});

test("每个厂商都有专属的修复路径，且**不承诺结果**", () => {
  const promises = /(就能|即可|保证|一定)[^。；]{0,12}(被收录|被引用|收录|引用|提升排名)/;
  // 走 guideFor：没写专属指引的厂商会拿到诚实兜底，那也是一条合格的指引。
  for (const fp of FINGERPRINTS) {
    const guide = guideFor(fp.id);
    assert.ok(guide && guide.length > 20, `${fp.id} 拿不到任何指引`);
    assert.doesNotMatch(guide, promises, `${fp.id} 的指引承诺了结果`);
  }
  assert.doesNotMatch(GENERIC_GUIDE, promises, "通用指引也不得承诺结果");
});

test("**写了指引就必须给出具体菜单路径；没核实过的宁可不写**", () => {
  // 这一层存在的全部意义，是把「要找开发」变成「点这三下」。
  // 但编一个没核实过的路径，会把用户送进一个不存在的菜单——比说不知道更糟。
  // 所以契约是二选一：要么给出真实路径，要么明说没核实过。
  let withPath = 0;
  for (const fp of FINGERPRINTS) {
    const guide = VENDOR_GUIDE[fp.id];
    if (guide) {
      assert.match(guide, /→/, `${fp.id} 写了指引却没有菜单路径`);
      withPath += 1;
    } else {
      assert.match(guideFor(fp.id), /没有核实|不在这里编/, `${fp.id} 没有指引时要如实说明`);
    }
  }
  assert.ok(withPath >= 6, `只有 ${withPath} 家给出了菜单路径，这一层就没什么价值了`);
});

test("通用指引要如实说明「分辨不出是哪种情况」", () => {
  assert.match(GENERIC_GUIDE, /未能.*识别|没有使用|分辨不出/);
});
