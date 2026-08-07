import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * 出网守卫（SSRF 防线）。
 *
 * **这个文件比一般的「别打内网」检查更严格，因为威胁模型不一样。**
 * 本 Worker 的接口是匿名公开的：任何人都能提交任意 URL，而我们会真的去连它。
 * 这等于把一个「代我发起 HTTP 请求」的能力免费送给整个互联网。
 *
 * 一台云主机上通常不只跑着这一个服务——还可能有内部管理端口、数据库、
 * 代理、别的项目的进程。一次精心构造的重定向，只要落到 127.0.0.1、
 * 本机的公网 IP、或者某个容易被漏掉的特殊网段，就能让陌生人借我们的手
 * 摸到那些东西。云厂商的元数据端点（169.254.169.254）更是经典目标：
 * 它在实例上永远可达，且直接吐出临时凭证。
 *
 * 现成的「私网检查」库不够用，实测中反复见到这三类坑：
 *   1. 检测到代理环境变量时**整个跳过**私网检查（为了兼容开发者本机挂代理
 *      调试）。那个「容忍」在生产上正好是一个洞。本文件的做法相反：
 *      启动时断言环境里根本不存在代理变量（assertNoProxyEnv），宁可起不来。
 *   2. 对裸 IP 提交只做私网判断就放行——一个公网 IP 字面量
 *      （**包括本机自己的公网 IP**）会长驱直入。见 assertNotOwnPublicIp()。
 *   3. 漏掉 CGNAT（100.64/10）、基准测试网段（198.18/15）、未指定地址（::）
 *      这些不那么显眼、却同样能打到本机或内网的地址。
 *
 * 还有一条比网段表更要紧：**判定过的地址必须就是实际连接的地址**。
 * 「先解析、判定通过、再交给 http 模块自己重新解析」中间那道缝，
 * 就是 DNS rebinding。见 safe-fetch.mjs 的连接钉死。
 */

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

// M4：`Number("")` 在 JS 里是 0，不是 NaN。"1.2.3.".split(".") 会得到
// ["1","2","3",""]，四段都能通过下面的范围检查（空串变成 0），于是
// "1.2.3." 被悄悄解析成 1.2.3.0。这里先逐段用 /^\d{1,3}$/ 卡掉空串、
// 前导 `+`、小数、指数记法（"1e2"）这类 Number() 会“好心”帮你转换的花活，
// 再进入范围检查。
const IPV4_PART_RE = /^\d{1,3}$/;

function parseIPv4(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  if (parts.some((part) => !IPV4_PART_RE.test(part))) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => n > 255)) return null;
  return octets;
}

function ipv4ToNumber([a, b, c, d]) {
  return a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
}

// 用算术除法而不是位运算判断前缀匹配：位运算在 JS 里按 32 位有符号整数
// 计算，178.x.x.x 这类高位字节会让 `<<`/`&` 产生负数，算术除法没有这个坑。
function ipv4InCidr(octets, baseOctets, prefixLength) {
  if (prefixLength === 0) return true;
  const divisor = 2 ** (32 - prefixLength);
  return Math.floor(ipv4ToNumber(octets) / divisor) === Math.floor(ipv4ToNumber(baseOctets) / divisor);
}

// 198.18/15 是 RFC 2544 基准测试网段——多种代理/透明代理软件拿它做 fake-DNS，
// 一个域名解析到这一段就意味着流量会被本机的代理接管。
// 100.64/10 是运营商级 NAT（CGNAT）。两者都容易被现成的“私网检查”库遗漏。
const IPV4_PRIVATE_RANGES = [
  { base: [0, 0, 0, 0], prefix: 8 }, // 0/8：本网络
  { base: [10, 0, 0, 0], prefix: 8 }, // 10/8
  { base: [100, 64, 0, 0], prefix: 10 }, // 100.64/10：CGNAT
  { base: [127, 0, 0, 0], prefix: 8 }, // 127/8：环回
  { base: [169, 254, 0, 0], prefix: 16 }, // 169.254/16：链路本地，含云元数据 169.254.169.254
  { base: [172, 16, 0, 0], prefix: 12 }, // 172.16/12
  { base: [192, 168, 0, 0], prefix: 16 }, // 192.168/16
  { base: [198, 18, 0, 0], prefix: 15 }, // 198.18/15：基准测试网段，也是常见的代理 fake-DNS 段
  { base: [224, 0, 0, 0], prefix: 4 }, // 224/4：组播
  { base: [255, 255, 255, 255], prefix: 32 }, // 受限广播地址
];

function isPrivateIPv4Octets(octets) {
  if (!octets) return false;
  return IPV4_PRIVATE_RANGES.some((range) => ipv4InCidr(octets, range.base, range.prefix));
}

function isPrivateIPv4(address) {
  return isPrivateIPv4Octets(parseIPv4(address));
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

/**
 * 把文本形式的 IPv6 地址展开成 8 个 16 位分组（数值数组）。
 * 支持 `::` 压缩、区域 ID（`fe80::1%eth0`）、以及尾部内嵌 IPv4
 * （`::ffff:127.0.0.1`、`::127.0.0.1`）。解析失败返回 null。
 */
function parseIPv6Groups(address) {
  let text = address;
  const zoneIndex = text.indexOf("%");
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);

  let embeddedIPv4 = null;
  const ipv4TailMatch = text.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4TailMatch) {
    embeddedIPv4 = parseIPv4(ipv4TailMatch[1]);
    if (!embeddedIPv4) return null;
    // 用占位分组替换内嵌的 IPv4 文本，剩下的按标准 IPv6 分组解析规则处理，
    // 最后再把内嵌地址换算回两个 16 位分组填回去。
    text = text.slice(0, text.length - ipv4TailMatch[1].length) + "0:0";
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] === "" ? [] : halves[0].split(":");
  let groups;
  if (halves.length === 1) {
    groups = head;
    if (groups.length !== 8) return null;
  } else {
    const tail = halves[1] === "" ? [] : halves[1].split(":");
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  const numbers = groups.map((group) => (group === "" ? NaN : parseInt(group, 16)));
  if (numbers.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;

  if (embeddedIPv4) {
    numbers[6] = embeddedIPv4[0] * 256 + embeddedIPv4[1];
    numbers[7] = embeddedIPv4[2] * 256 + embeddedIPv4[3];
  }
  return numbers;
}

function groupsInPrefix(groups, prefixGroups, prefixBits) {
  let bitsLeft = prefixBits;
  for (let i = 0; i < 8 && bitsLeft > 0; i += 1) {
    const bits = Math.min(16, bitsLeft);
    const shift = 16 - bits;
    if (groups[i] >> shift !== prefixGroups[i] >> shift) return false;
    bitsLeft -= bits;
  }
  return true;
}

// `::`（未指定地址）此前不在这张表里，`isPrivateAddress("::")` 因此判为公网。
// 而 connect() 到 `::` 在内核层面等同于连本机——大量服务的默认绑定形态
// 正是 `::` 或 `::1`。一旦域名或重定向目标解析到 `::`，本文件此前会放行，
// 陌生人就能连上本机上任何一个监听服务。
const IPV6_PRIVATE_RANGES = [
  { prefix: [0, 0, 0, 0, 0, 0, 0, 0], bits: 128 }, // :: 未指定地址：connect() 到它等同于连本机
  { prefix: [0, 0, 0, 0, 0, 0, 0, 1], bits: 128 }, // ::1 环回
  { prefix: [0xfc00, 0, 0, 0, 0, 0, 0, 0], bits: 7 }, // fc00::/7 唯一本地地址（ULA）
  { prefix: [0xfe80, 0, 0, 0, 0, 0, 0, 0], bits: 10 }, // fe80::/10 链路本地
  { prefix: [0xff00, 0, 0, 0, 0, 0, 0, 0], bits: 8 }, // ff00::/8 组播
];

function isPrivateIPv6(address) {
  const groups = parseIPv6Groups(address);
  if (!groups) return false;
  const headZero = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0;
  // IPv4 映射地址（::ffff:a.b.c.d，即 ::ffff:0:0/96）：按内嵌的 IPv4 规则判断，
  // 否则 `::ffff:127.0.0.1` 这种典型的 SSRF 绕过写法会被漏判为“公网”。
  const isMapped = headZero && groups[5] === 0xffff;
  if (isMapped) {
    return isPrivateIPv4Octets([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  // C1 的另一半（源自 M1）：IPv4 兼容地址（已废弃的 ::a.b.c.d 形式，即 ::a.b.c.d/96，
  // group[5] 是 0 而不是 0xffff）。`::127.0.0.1` 会展开成 `::7f00:1`，如果这里只处理
  // 上面的映射地址分支，这个更古老的兼容地址形态会被漏判为“公网”——本文件旧版注释
  // 曾经声称两种内嵌形式都覆盖到了，但校验逻辑其实只处理了映射地址那一种。
  // 整段 ::/96（除了上面已经单列的 ::/128 和 ::1/128）在 RFC 4291 里都属于这个形态，
  // 所以只要头 5 组和第 6 组都是 0，就统一按内嵌 IPv4 规则判断，不必再单独判断格式。
  const isCompat = headZero && groups[5] === 0;
  if (isCompat) {
    return isPrivateIPv4Octets([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return IPV6_PRIVATE_RANGES.some((range) => groupsInPrefix(groups, range.prefix, range.bits));
}

// ---------------------------------------------------------------------------
// 对外导出
// ---------------------------------------------------------------------------

/**
 * 判断一个「字面量 IP 地址」是否落在私网/保留/环回/链路本地/组播等
 * 不应被本 Worker 出网访问的网段里。
 *
 * 只对字面量 IP 有效——`isPrivateAddress("internal.corp.example")` 恒为
 * false，因为这里根本没有做 DNS 解析。域名必须先经过 resolveAndGuard()
 * 解析出真实 IP 之后，再逐个交给这个函数校验；否则「域名指向私网」这种
 * 形态会长驱直入（这是姊妹项目之外，本文件测试专门补的一个用例）。
 */
export function isPrivateAddress(address) {
  const family = isIP(String(address));
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return false;
}

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];

/**
 * 启动时断言运行环境里不存在任何代理变量。
 *
 * 常见做法是「检测到代理变量就容忍私网地址」，专门为了兼容开发者本机挂代理
 * 调试。但经代理出网时，真正发起连接的是代理进程，本文件判定过的地址
 * 根本不是最终连的地址——那个「容忍」等于把整条防线关掉。
 * 所以这里选更简单也更安全的方案：压根不允许代理变量存在，宁可拒绝启动。
 */
export function assertNoProxyEnv(env) {
  const present = PROXY_ENV_KEYS.filter((key) => Boolean(env?.[key]));
  if (present.length > 0) {
    throw new Error(`检测到代理环境变量（${present.join(", ")}），拒绝启动：经代理出网会绕过本文件的地址判定，SSRF 防线将失效`);
  }
}

/**
 * 启动时校验 `MIAOWA_AUDIT_OWN_PUBLIC_IP` 存在，且是一个合法的 IP 字面量。
 *
 * M6：assertNotOwnPublicIp() 的整条防线完全依赖这个环境变量确实是「一个
 * IP 字面量」——它内部只是简单的 `address === ownIp` 字符串比较。运维一次
 * 手滑（多一个空格、写成域名、写成带掩码的 CIDR）就会让这条比较永远不命中，
 * 防线因此静默失效，不会有任何报错提示。宁可现在拒绝启动，也不要带着一条
 * 打了折却看起来正常的防线上线。
 *
 * D2（2026-08-06 修正）：这里原本是 `if (!raw) return;`——**未配置就直接放行**。
 * 那让整条防线有两种失效方式，而这个函数只挡住了其中一种：
 *
 *   配错格式  → 抛错，拒绝启动          ← 本函数原本挡住的
 *   压根没配  → 静默跳过，启动成功       ← 本函数原本放过的
 *
 * 两种的最终表现完全一样：`assertNotOwnPublicIp()` 永远不命中，
 * 「拒绝连回本机公网 IP」这条防线不存在。而后者更危险，因为它连一次
 * 手滑都不需要——新机器上忘了写这一行就够了，且启动日志毫无异样。
 *
 * 用 M6 自己的逻辑推到底：既然「配错了要拒绝启动」，那「没配」必须同样拒绝。
 * 这条防线在深检查里保护的资产更多（Chrome 会自己跟随重定向），不能是可选的。
 */
export function assertValidOwnPublicIp(env) {
  const raw = env?.MIAOWA_AUDIT_OWN_PUBLIC_IP;
  if (!raw) {
    throw new Error(
      "缺少环境变量 MIAOWA_AUDIT_OWN_PUBLIC_IP，拒绝启动：" +
        "没有它，assertNotOwnPublicIp() 的字符串比较永远不命中，" +
        "「拒绝连回本机公网 IP」这条防线会完全不存在，且没有任何迹象",
    );
  }
  if (isIP(raw) === 0) {
    throw new Error(
      `环境变量 MIAOWA_AUDIT_OWN_PUBLIC_IP 不是合法的 IP 字面量（${JSON.stringify(raw)}），拒绝启动：` +
        `这会让"拒绝连回本机公网 IP"这条防线在不知不觉中失效`,
    );
  }
}

/**
 * 拒绝以裸 IP 字面量提交的目标 URL（无论该 IP 是私网还是公网）。
 *
 * 裸 IP 对本工具的域名级检查（robots、sitemap、canonical 等按域名匹配的
 * 逻辑）没有意义，却是绕开这些防护、直接探测任意主机的入口——包括探测
 * 本机自己的公网 IP。姊妹项目的对应函数只对裸 IP 做了私网判断就放行，
 * 公网 IP 字面量会漏网；这里统一拒绝所有裸 IP 提交，只接受域名。
 */
export function rejectBareIp(url) {
  const { hostname } = new URL(url);
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) {
    throw new Error(`拒绝裸 IP 提交（${hostname}）：请使用域名`);
  }
}

// 常见的多级公共后缀（第二级即注册单位，如 co.uk 下的 example.co.uk）。
// 刻意保持短表、不引入 `psl` 依赖：V1 只需覆盖常见形态。
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.kr", "or.kr", "ne.kr",
  "com.br", "com.tw", "com.hk", "com.sg", "com.mx",
  "co.nz", "co.in", "co.za", "co.id", "co.th",
]);

// 常见「可以直接在这个后缀下注册二级域」的 TLD（多为 gTLD，以及少数以
// 直接注册为主流形态的两字母国家代码，如 .cn/.de/.io）。命中这里的，
// 取最后两段就是可注册域。
//
// 这张表存在的意义：短表最危险的失败方向不是「把同域误判为不同域」，
// 而是反过来——某个复合后缀（比如 com.ua）没被收进 MULTI_PART_SUFFIXES，
// 若默认统一取最后两段，会把两个毫不相关、只是恰好同为 xxx.com.ua 的站点
// 误判成「同一个可注册域」。所以未被两张表识别的两字母国家代码，一律走
// 下面 registrableDomain() 的保守兜底（多取一段再比较），宁可把同一个
// 域名的 apex 和 www 误判为不同域，也不要把两个不相关站点误判为同域。
//
// 已知残留缺口：像 github.io、vercel.app 这类「多租户 PaaS 域名」——
// 后缀本身（io、app）绝大多数场景下确实是直接注册，只有极少数场景下
// 被平台方当成公共后缀分给互不相关的租户。要精确处理这种情况需要
// PSL 的 private 分区（即 `psl` 依赖里的内容），本文件明确不引入，
// 所以 v1 会把 a.github.io 和 b.github.io 误判为同域。这是短表相对
// 完整 PSL 的已知代价，不是 bug。
const DIRECT_REGISTRATION_TLDS = new Set([
  "com", "net", "org", "info", "biz", "name", "xyz", "dev", "app",
  "io", "ai", "co", "me", "tv", "cc",
  "cn", "jp", "kr", "tw", "hk", "sg", "in", "nz",
  "de", "fr", "es", "it", "nl", "ru", "se", "no", "dk", "fi", "pl",
  "be", "at", "ch", "ie", "eu", "us", "ca", "uk",
]);

function registrableDomain(hostname) {
  const labels = String(hostname)
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastLabel = labels[labels.length - 1];
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  if (DIRECT_REGISTRATION_TLDS.has(lastLabel)) return lastTwo;
  // 未收录的后缀（通常是没听说过的两字母国家代码，可能采用 co.xx 这类
  // 分类式二级域）：保守地多取一段再比较，见上面表注释里的方向说明。
  return labels.slice(-3).join(".");
}

/**
 * 判断两个主机名是否属于同一个「可注册域」（apex + 公共后缀）。
 * `example.com` 与 `www.example.com`/`m.example.com` 视为同域；
 * `example.com` 与 `evil.example` 不是——不能只看是否共享后缀标签。
 */
export function sameRegistrableDomain(a, b) {
  return registrableDomain(a) === registrableDomain(b);
}

/**
 * I3：出网守卫抛出的错误统一携带一个封闭的 `code`，供 safe-fetch.mjs 分类映射到
 * 它自己的 `reason`。
 *
 * 改动前，safe-fetch.mjs 是用 `/私网|保留/.test(err.message)` 这种正则去匹配
 * 本文件构造的中文错误文案，来判断"是我们主动拒绝的私网地址"还是"对方 DNS
 * 出了问题"。这个耦合很脆：本文件的文案随便一次措辞调整（哪怕只是把"私网"
 * 换成同义词），safe-fetch 那边的正则会静默匹配失败，把一次安全拦截错误地
 * 归类成"network"（对方的问题），而不是"private_address"（我们主动挡下来的）——
 * 这类错误不会在测试里显式报错，只会在生产里悄悄失效。改成 `code` 字段后，
 * 两个文件之间的契约是显式的类型字段，不再依赖措辞。
 */
export const GUARD_ERROR_CODES = Object.freeze({
  PRIVATE_ADDRESS: "PRIVATE_ADDRESS", // 解析结果落在私网/保留网段
  RESOLUTION_FAILED: "RESOLUTION_FAILED", // 域名压根解析不出地址——对方站点的问题
  OWN_PUBLIC_IP: "OWN_PUBLIC_IP", // 解析结果命中本实例自身公网 IP
});

export class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GuardError";
    this.code = code;
  }
}

/**
 * 拒绝解析目标落在本实例自身公网 IP 上的请求。
 *
 * **本机的公网 IP 不落在任何私网网段里**，所以它能通过上面所有检查——
 * 而一次指向 `http://<本机公网IP>:<某端口>/` 的重定向，打到的正是本机上
 * 那些「只对内网开放」的服务。这是私网网段表天然盖不住的一格。
 * 本机公网 IP 由环境变量 `MIAOWA_AUDIT_OWN_PUBLIC_IP` 注入，
 * 调用方（safe-fetch）负责读取该变量并传入 ownIp；未配置时视为不做该项
 * 检查（例如本地开发环境没有公网 IP 可言）。
 */
export function assertNotOwnPublicIp(addresses, ownIp) {
  if (!ownIp) return;
  const list = Array.isArray(addresses) ? addresses : [addresses];
  for (const entry of list) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (address === ownIp) {
      throw new GuardError(GUARD_ERROR_CODES.OWN_PUBLIC_IP, `目标解析到本实例自身公网 IP（${ownIp}），拒绝访问：会打到本机依赖的代理服务上`);
    }
  }
}

async function defaultResolve(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/**
 * 解析主机名并校验每一个返回地址：先 DNS 解析，再逐个交给 isPrivateAddress。
 *
 * 这是最容易漏掉的一条：`isPrivateAddress(hostname)` 只对字面量 IP 有效，
 * `internal.corp.example → 10.0.0.1` 这种「域名指向私网」的形态如果只做
 * 字面量检查会长驱直入。resolve 可以注入（默认用 node:dns/promises 的
 * lookup），测试用假的 resolve 函数模拟“域名解析到私网”而不依赖真实 DNS。
 *
 * 返回值是解析出的 IP 字符串数组。**C3（已闭合）：** 调用方
 * （`safe-fetch.mjs` 的 `guardHop`）现在会把这批地址里的第一个原样带出去，
 * 传给 `performRequest()` 当作连接钉死（connection pinning）的目标——
 * 实际建连时把这个已校验地址通过 `node:http`/`node:https` 的 `lookup`
 * 选项直接交给 socket，不再触发任何独立的第二次 DNS 解析。这里做的校验
 * 和实际建连用的地址因此是同一个，教科书式的 DNS-rebinding（权威 DNS
 * 对两次查询给出不同答案）不再有可乘之机——因为压根只查了一次。
 *
 * 早期实现里，这里返回的地址会被 `safe-fetch.mjs` 丢弃，转手调用
 * `fetch(url.href)`，Node 全局 fetch（底层是 undici）会针对同一个主机名
 * 重新做一次完全独立的 DNS 解析，两次解析之间存在攻击者可利用的窗口。
 * 当时评估过、也在本仓库验证过：`undici` 的 `Agent`（自定义 `connect`
 * 直连已校验 IP）在这台机器上不可 import（既没有 `node:undici`，也没有把
 * `undici` 声明成 npm 依赖），与“零第三方依赖”的约定冲突，所以没有走这条
 * 路。最终选择的路径是 `node:http`/`node:https` 内建的 `lookup` 选项——
 * 与 `dns.lookup` 同签名，注入后 socket 直接连到已校验地址，同时显式设置
 * `servername`（TLS SNI）和 `Host` 头为真实主机名，证书校验和虚拟主机分发
 * 都不受影响；响应体的 gzip/deflate/br 解压改由 `node:zlib` 显式处理
 * （`createGunzip`/`createInflate`/`createBrotliDecompress`），补上放弃
 * `fetch()` 自动解压后的缺口。两者都是 Node 22+ 的内建模块，没有引入新依赖。
 */
export async function resolveAndGuard(hostname, { resolve = defaultResolve } = {}) {
  const records = await resolve(hostname);
  const addresses = (records ?? []).map((entry) => (typeof entry === "string" ? entry : entry.address));
  if (addresses.length === 0) {
    // 解析不出地址是对方站点的 DNS 问题，不是我们主动拦截——两者必须映到
    // 不同的 code，否则调用方会把"对方 DNS 挂了"错误地记成"我们的安全拦截"。
    throw new GuardError(GUARD_ERROR_CODES.RESOLUTION_FAILED, `域名 ${hostname} 无法解析`);
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new GuardError(GUARD_ERROR_CODES.PRIVATE_ADDRESS, `域名 ${hostname} 解析到私网/保留地址 ${address}，拒绝访问`);
    }
  }
  return addresses;
}
