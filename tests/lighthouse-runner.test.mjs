import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runLighthouse,
  buildChromeFlags,
  buildLighthouseArgs,
  resetLighthouseSemaphore,
  isLighthouseBusy,
  LighthouseBusyError,
  RUNNER_REASONS,
  LIGHTHOUSE_TIMEOUT_MS,
} from "../src/lighthouse-runner.mjs";

/**
 * Lighthouse runner。
 *
 * 这里最要紧的一类断言是**对 Chrome 启动参数本身**的：
 * `--proxy-server` / `--proxy-bypass-list=<-loopback>` /
 * `--force-webrtc-ip-handling-policy` 三个开关**没有任何可观测输出**——
 * 缺了任何一个，Lighthouse 照样跑通、报告照样生成，只是 allowlist-proxy
 * 被绕开了。这与 safe-fetch 的连接钉死是同一种形态（C3 的四个变异全部存活），
 * 唯一守得住的办法就是直接断言参数。
 */

// 造一个假的子进程：可控地触发 exit / error，并记录 spawn 收到的参数。
function fakeSpawn({ exitCode = 0, delayMs = 0, emitError = false } = {}) {
  const calls = [];
  const killed = [];
  const originalKill = process.kill;

  const spawnFn = (cmd, args, options) => {
    const child = new EventEmitter();
    child.pid = 999_000 + calls.length;
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = new EventEmitter();
    calls.push({ cmd, args, options });
    if (emitError) {
      setTimeout(() => child.emit("error", new Error("spawn 失败")), delayMs);
    } else if (delayMs >= 0 && exitCode !== null) {
      setTimeout(() => {
        child.exitCode = exitCode;
        child.emit("exit", exitCode);
      }, delayMs);
    }
    return child;
  };
  return { spawnFn, calls, killed, restoreKill: () => { process.kill = originalKill; } };
}

const BASE_DEPS = {
  nodePath: "/opt/node22/bin/node",
  lighthouseBin: "/opt/lh/lighthouse.js",
  chromePath: "/opt/chrome/chrome-linux64/chrome",
  proxyPort: 45671,
};

test.beforeEach(() => resetLighthouseSemaphore());

// ---------------------------------------------------------------------------
// Chrome 参数：三个没有可观测输出的安全开关
// ---------------------------------------------------------------------------

test("必须带 --proxy-server 指向本地 allowlist-proxy", () => {
  const flags = buildChromeFlags({ proxyPort: 45671, userDataDir: "/tmp/x" });
  assert.ok(
    flags.includes("--proxy-server=127.0.0.1:45671"),
    "不经代理的 Chrome 会自己解析 DNS、自己跟随重定向，整条 SSRF 防线形同虚设",
  );
});

test("必须带 --proxy-bypass-list=<-loopback>——缺这一行整个代理白写", () => {
  // Chrome **默认绕过代理直连 localhost / 127.0.0.1 / [::1]**。
  // 不加这个开关，一次指向 http://127.0.0.1:<端口>/ 的重定向或子资源
  // 会完全绕开 allowlist-proxy，解析/判定/钉死三步做得再对也拦不住。
  // 这是整块防御里最容易漏、漏了最致命的一行，因此单独一条测试守它。
  const flags = buildChromeFlags({ proxyPort: 1, userDataDir: "/tmp/x" });
  assert.ok(
    flags.includes("--proxy-bypass-list=<-loopback>"),
    "Chrome 默认绕过代理直连 localhost；不显式取消这个默认，代理拦不住指向本机的重定向",
  );
});

test("必须关掉 WebRTC 的非代理 UDP——那是绕过 HTTP 代理的另一条通道", () => {
  const flags = buildChromeFlags({ proxyPort: 1, userDataDir: "/tmp/x" });
  assert.ok(flags.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
});

test("绝不能出现 --no-sandbox（设计文档第三节的决定）", () => {
  const flags = buildChromeFlags({ proxyPort: 1, userDataDir: "/tmp/x" });
  assert.ok(
    !flags.some((f) => f.includes("--no-sandbox")),
    "沙箱必须保留。24.04 上沙箱起不来的正确解法是给 Chrome 二进制配 AppArmor profile 授予 userns，" +
      "不是关沙箱，也不是全局关掉那条内核加固",
  );
});

test("必须带 --disable-dev-shm-usage（/dev/shm 默认只有 64 MB）", () => {
  assert.ok(buildChromeFlags({ proxyPort: 1, userDataDir: "/tmp/x" }).includes("--disable-dev-shm-usage"));
});

test("--only-audits 只跑两项 agentic 审计", () => {
  const args = buildLighthouseArgs({ targetUrl: "https://x.example/", outputPath: "/tmp/r.json", chromeFlags: [] });
  assert.ok(args.includes("--only-audits=agent-accessibility-tree,cumulative-layout-shift"));
  assert.ok(args.includes("--output=json"));
  assert.ok(args[0] === "https://x.example/", "目标 URL 必须是第一个位置参数");
});

// ---------------------------------------------------------------------------
// 子进程与进程树回收
// ---------------------------------------------------------------------------

test("以 detached 方式 spawn——否则 kill 不掉 Chrome 的子进程树", () => {
  const { spawnFn, calls } = fakeSpawn({ exitCode: 1, delayMs: 0 });
  return runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn }).then(() => {
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].options.detached,
      true,
      "Chrome 是多进程；不 detached 就没有独立进程组，超时后只能杀掉 Lighthouse 的 node 进程，" +
        "留下的孤儿 renderer 每个占几百 MB",
    );
  });
});

test("子进程环境里代理变量被显式清空", () => {
  const { spawnFn, calls } = fakeSpawn({ exitCode: 1, delayMs: 0 });
  return runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn }).then(() => {
    const env = calls[0].options.env;
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      assert.equal(env[key], "", `${key} 必须显式置空——任何代理变量都会让 Chrome 绕开 allowlist-proxy`);
    }
    assert.equal(env.CHROME_PATH, BASE_DEPS.chromePath, "Chrome 路径通过 CHROME_PATH 传给 Lighthouse");
  });
});

test("子进程非零退出 → crashed，不是超时", async () => {
  const { spawnFn } = fakeSpawn({ exitCode: 1, delayMs: 5 });
  const out = await runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn });
  assert.equal(out.reason, RUNNER_REASONS.CRASHED);
  assert.equal(out.report, null);
});

test("spawn 本身出错 → crashed", async () => {
  const { spawnFn } = fakeSpawn({ emitError: true, delayMs: 5 });
  const out = await runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn });
  assert.equal(out.reason, RUNNER_REASONS.CRASHED);
});

/**
 * 找到 runLighthouse 刚建的那个临时工作目录，并往里写一份报告——
 * 用来模拟「Lighthouse 已经把报告写出来了，但以非零码退出」。
 */
function writeReportIntoLatestWorkDir(report) {
  const dirs = readdirSync(tmpdir()).filter((d) => d.startsWith("miaowa-lh-"));
  const latest = dirs.sort().at(-1);
  writeFileSync(join(tmpdir(), latest, "report.json"), JSON.stringify(report));
}

test("非零退出但报告已生成 → 以报告为准，绝不报成 crashed", async () => {
  // 2026-08-06 用 miaowageo.com 实测撞到的归因缺陷。该站托管在北京，
  // 从首尔的检测机连不通，Lighthouse 以 NO_FCP 结束并**非零退出**，
  // 但报告已经写出来了，里面写着 runtimeError.code = "NO_FCP"——
  // 那是**对方侧**（页面没渲染出内容）。旧实现一看退出码非 0 就返回
  // crashed，报告连读都不读，于是「目标站加载不出来」被记成
  // 「我们的 Lighthouse 崩了」，两者的处置方向完全相反。
  const spawnFn = (cmd, args, options) => {
    const child = new EventEmitter();
    child.pid = 7777;
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = new EventEmitter();
    setTimeout(() => {
      writeReportIntoLatestWorkDir({ runtimeError: { code: "NO_FCP", message: "did not paint" }, audits: {} });
      child.exitCode = 1;
      child.emit("exit", 1);
    }, 10);
    return child;
  };
  const out = await runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn });
  assert.equal(out.reason, null, "有报告就不该报 crashed——归因交给 lighthouse-map 的分类表");
  assert.equal(out.report?.runtimeError?.code, "NO_FCP");
});

test("超时是例外：即使有报告也不采信（那是被我们中途掐断的运行）", async () => {
  const originalKill = process.kill;
  let child = null;
  process.kill = (pid, signal) => {
    if (signal === "SIGTERM") setTimeout(() => child?.emit("exit", null), 3);
    return true;
  };
  const spawnFn = () => {
    child = new EventEmitter();
    child.pid = 8888;
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = new EventEmitter();
    setTimeout(() => writeReportIntoLatestWorkDir({ audits: {} }), 5);
    return child;
  };
  try {
    const out = await runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn, timeoutMs: 40 });
    assert.equal(out.reason, RUNNER_REASONS.TIMEOUT, "被掐断的运行产出的报告不完整、不可信，必须按我方侧处理");
    assert.equal(out.report, null);
  } finally {
    process.kill = originalKill;
  }
});

test("退出码为 0 但报告读不出来 → bad_report，不冒充成功", async () => {
  const { spawnFn } = fakeSpawn({ exitCode: 0, delayMs: 5 });
  const out = await runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn });
  assert.equal(out.reason, RUNNER_REASONS.BAD_REPORT, "假 spawn 不会真的写报告文件，这里正好覆盖这条路径");
  assert.equal(out.report, null);
});

test("超时 → timeout，并尝试回收整棵进程树", async () => {
  const killSignals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    killSignals.push({ pid, signal });
    // 模拟进程组收到 SIGTERM 后正常退出
    if (signal === "SIGTERM") setTimeout(() => currentChild?.emit("exit", null), 5);
    return true;
  };

  let currentChild = null;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = new EventEmitter();
    currentChild = child;
    return child; // 永不自行退出 → 必然走超时路径
  };

  try {
    const out = await runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn, timeoutMs: 30 });
    assert.equal(out.reason, RUNNER_REASONS.TIMEOUT);
    assert.equal(out.killConfirmed, true, "回收结果必须被确认，不能假装清理成功");
    assert.deepEqual(
      killSignals.map((k) => k.pid),
      [-4242],
      "必须用负 pid 杀整个进程组；只杀 pid 会留下孤儿 Chrome 进程",
    );
    assert.equal(killSignals[0].signal, "SIGTERM", "先给它收尾的机会，宽限期后才 SIGKILL");
  } finally {
    process.kill = originalKill;
  }
});

// ---------------------------------------------------------------------------
// 信号量：全局并发 1，不排队
// ---------------------------------------------------------------------------

test("占用中再调用立即抛 LighthouseBusyError，不排队", async () => {
  let release;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.pid = 5555;
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = new EventEmitter();
    release = () => { child.exitCode = 1; child.emit("exit", 1); };
    return child;
  };

  const first = runLighthouse("https://a.example/", { ...BASE_DEPS, spawnFn, timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(isLighthouseBusy(), true);

  await assert.rejects(
    () => runLighthouse("https://b.example/", { ...BASE_DEPS, spawnFn }),
    (err) => err instanceof LighthouseBusyError && err.reason === RUNNER_REASONS.BUSY,
    "全局并发 1，占用中必须立即拒绝而不是排队——排队会让请求堆在一台 4 GB 机器上",
  );

  release();
  await first;
  assert.equal(isLighthouseBusy(), false, "跑完必须放开信号量");
});

test("每一条退出路径都放开信号量——漏放一次深检查就永久 503", async () => {
  // 而且不会有任何报错，只会表现成「深检查总是容量不足」。
  for (const opts of [{ exitCode: 0, delayMs: 3 }, { exitCode: 1, delayMs: 3 }, { emitError: true, delayMs: 3 }]) {
    const { spawnFn } = fakeSpawn(opts);
    await runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn });
    assert.equal(isLighthouseBusy(), false, `${JSON.stringify(opts)} 之后信号量必须是空闲的`);
  }
});

test("超时路径也放开信号量", async () => {
  const originalKill = process.kill;
  let child = null;
  process.kill = (pid, signal) => {
    if (signal === "SIGTERM") setTimeout(() => child?.emit("exit", null), 3);
    return true;
  };
  const spawnFn = () => {
    child = new EventEmitter();
    child.pid = 6666;
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = new EventEmitter();
    return child;
  };
  try {
    await runLighthouse("https://x.example/", { ...BASE_DEPS, spawnFn, timeoutMs: 20 });
    assert.equal(isLighthouseBusy(), false);
  } finally {
    process.kill = originalKill;
  }
});

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

test("默认超时是 75 s，覆盖 2026-08-06 实测的最坏值 61.3 s", () => {
  assert.equal(LIGHTHOUSE_TIMEOUT_MS, 75_000);
  assert.ok(
    LIGHTHOUSE_TIMEOUT_MS > 61_300,
    "设计文档原来的 45 s 预算在 globalsources.com 上实测超了（61.3 s）；" +
      "下调这个数必须附新的实测数字",
  );
});
