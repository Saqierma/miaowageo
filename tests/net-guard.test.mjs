import assert from "node:assert/strict";
import test from "node:test";

import { isPrivateAddress, assertNoProxyEnv, rejectBareIp, sameRegistrableDomain, assertValidOwnPublicIp } from "../src/fetchers/net-guard.mjs";

/**
 * 出网守卫。这个文件里的每条规则都对应一个真实的攻击面：
 *
 * - 本 Worker 的接口匿名公开，一次指向 127.0.0.1 或本机公网 IP 的重定向
 *   就能打到管理员依赖的代理服务上；
 * - 常见的现成实现会在检测到代理环境变量时**整个跳过私网检查**，
 *   而 198.18/15 正是多种代理软件的 fake-DNS 段。
 *   本服务刻意不复用它，并在启动时断言环境里没有代理变量。
 * - 裸 IP 提交对本工具没有意义，却是绕过全部域名级防护的入口。
 */

test("私网与保留地址一律拒绝", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "198.18.0.1", "::1", "fc00::1", "fe80::1"]) {
    assert.equal(isPrivateAddress(address), true, `${address} 应判为私网`);
  }
});

/**
 * C1（reviewer 生产环境实测复现）：`::`（IPv6 未指定地址）此前不在
 * IPV6_PRIVATE_RANGES 里，`isPrivateAddress("::")` 返回 false；而内核层面
 * connect() 到 `::` 等同于连本机——大量服务的默认绑定形态正是 `::`/`::1`。
 * 同一次修复里，M1 指出的 `::127.0.0.1`（IPv4 兼容地址，展开为 `::7f00:1`）
 * 也一并补上，此前旧注释声称这个内嵌形式已被覆盖，其实只覆盖了
 * `::ffff:` 映射地址那一种。
 */
test("C1：IPv6 未指定地址 :: 与 IPv4 兼容地址 ::127.0.0.1 必须判为私网", () => {
  for (const address of ["::", "::127.0.0.1", "::0.0.0.0"]) {
    assert.equal(isPrivateAddress(address), true, `${address} 应判为私网`);
  }
  // 内嵌一个真实公网 IPv4 地址的兼容形式，应该按内嵌地址本身的公网/私网性质判断，
  // 而不是被兼容形式这个"外壳"整体误伤。
  assert.equal(isPrivateAddress("::1.1.1.1"), false, "::1.1.1.1 内嵌的是公网地址，应放行");
});

test("公网地址放行", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, `${address} 应判为公网`);
  }
});

test("存在代理环境变量时启动即失败", () => {
  assert.throws(() => assertNoProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:7890" }), /代理/);
  assert.doesNotThrow(() => assertNoProxyEnv({}));
});

test("裸 IP 提交被拒绝", () => {
  assert.throws(() => rejectBareIp("http://1.2.3.4:8080/"), /IP/);
  assert.throws(() => rejectBareIp("https://[2606:4700::1111]/"), /IP/);
  assert.doesNotThrow(() => rejectBareIp("https://example.com/"));
});

test("可注册域比较：apex 与 www 视为同域", () => {
  assert.equal(sameRegistrableDomain("example.com", "www.example.com"), true);
  assert.equal(sameRegistrableDomain("m.example.com", "www.example.com"), true);
  assert.equal(sameRegistrableDomain("example.com", "evil.example"), false);
  assert.equal(sameRegistrableDomain("example.co.uk", "www.example.co.uk"), true);
});

/**
 * 以下测试为本文件补充（计划文本未给出逐字代码），覆盖计划要点中
 * 明确点名「最容易漏」的一条：isPrivateAddress 只认字面量 IP，
 * `internal.corp.example → 10.0.0.1` 这种域名指向私网的形态必须在
 * DNS 解析之后再校验，否则会长驱直入。用注入的 resolve 函数保持测试
 * 无需真实 DNS（hermetic）。
 */

import { assertNotOwnPublicIp, resolveAndGuard } from "../src/fetchers/net-guard.mjs";

test("域名解析到私网地址时，resolveAndGuard 必须拒绝（而不仅仅是字面量 IP）", async () => {
  // 关键：hostname 本身不是 IP，isPrivateAddress(hostname) 会直接放行；
  // 必须先解析、再逐个校验，这条测试专门验证「先解析再校验」这条路径真的被执行了。
  const resolvesToPrivate = async () => [{ address: "10.0.0.1", family: 4 }];
  await assert.rejects(() => resolveAndGuard("internal.corp.example", { resolve: resolvesToPrivate }), /私网|保留/);
});

test("域名解析到公网地址时，resolveAndGuard 放行并返回地址列表", async () => {
  const resolvesToPublic = async () => [{ address: "1.1.1.1", family: 4 }];
  const addresses = await resolveAndGuard("public.example", { resolve: resolvesToPublic });
  assert.deepEqual(addresses, ["1.1.1.1"]);
});

test("域名解析出的地址只要有一个落入私网，就整体拒绝", async () => {
  // 混合结果：第一个地址公网、第二个私网。必须逐个校验而不是只看第一个。
  const resolvesToMixed = async () => [
    { address: "1.1.1.1", family: 4 },
    { address: "192.168.1.5", family: 4 },
  ];
  await assert.rejects(() => resolveAndGuard("mixed.example", { resolve: resolvesToMixed }), /私网|保留/);
});

test("resolveAndGuard 对无法解析的域名报错", async () => {
  const resolvesToNothing = async () => [];
  await assert.rejects(() => resolveAndGuard("nowhere.example", { resolve: resolvesToNothing }), /解析/);
});

test("目标解析到本实例自身公网 IP 时拒绝：重定向到本机代理端口的攻击面", () => {
  assert.throws(() => assertNotOwnPublicIp(["203.0.113.9"], "203.0.113.9"), /自身|本实例/);
  assert.doesNotThrow(() => assertNotOwnPublicIp(["1.1.1.1"], "203.0.113.9"));
  assert.doesNotThrow(() => assertNotOwnPublicIp(["203.0.113.9"], undefined), "未配置 ownIp 时不应误伤");
});

// ---------------------------------------------------------------------------
// D2：MIAOWA_AUDIT_OWN_PUBLIC_IP 缺失必须拒绝启动，不是静默跳过
//
// 这条防线有两种失效方式，旧实现只挡住了一种：
//   配错格式 → 抛错（挡住了）      压根没配 → 静默 return（放过了）
// 两种的最终表现完全一样——assertNotOwnPublicIp() 的字符串比较永远不命中。
// 而"没配"更危险：新机器上少写一行就够了，启动日志毫无异样。
// ---------------------------------------------------------------------------

test("D2：缺少 MIAOWA_AUDIT_OWN_PUBLIC_IP 时必须抛错，而不是静默放行", () => {
  assert.throws(
    () => assertValidOwnPublicIp({}),
    /缺少环境变量 MIAOWA_AUDIT_OWN_PUBLIC_IP/,
    "未配置时静默 return 会让「拒绝连回本机公网 IP」整条防线不存在，且没有任何迹象",
  );
  assert.throws(() => assertValidOwnPublicIp({ MIAOWA_AUDIT_OWN_PUBLIC_IP: "" }), /缺少环境变量/);
  assert.throws(() => assertValidOwnPublicIp(undefined), /缺少环境变量/);
});

test("D2：配了合法 IP 才放行（IPv4 与 IPv6 都要认）", () => {
  assert.doesNotThrow(() => assertValidOwnPublicIp({ MIAOWA_AUDIT_OWN_PUBLIC_IP: "203.0.113.10" }));
  assert.doesNotThrow(() => assertValidOwnPublicIp({ MIAOWA_AUDIT_OWN_PUBLIC_IP: "2606:2800:220:1:248:1893:25c8:1946" }));
});

test("D2：配成域名/带掩码/带空格一律拒绝（M6 原有语义不能退化）", () => {
  for (const bad of ["example.com", "203.0.113.10/32", " 203.0.113.10", "203.0.113"]) {
    assert.throws(
      () => assertValidOwnPublicIp({ MIAOWA_AUDIT_OWN_PUBLIC_IP: bad }),
      /不是合法的 IP 字面量/,
      `${JSON.stringify(bad)} 不是 IP 字面量，字符串比较永远不会命中它`,
    );
  }
});
