import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createTlsServer } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  callWorker,
  buildTlsOptions,
  normalizeFingerprint,
  fingerprintFromPem,
  FingerprintMismatchError,
} from "../src/client/pinned-client.mjs";

/**
 * 主站侧的指纹固定。
 *
 * 这些测试用**真实的 TLS 服务器和真实的自签证书**跑，不是替身——
 * 因为这块防护的失效方式恰恰藏在 Node 的 TLS 语义里：
 * `rejectUnauthorized: false` 时 Node **根本不会调用** checkServerIdentity，
 * 指纹比对会静默失效，而代码看起来仍然「有在校验」。
 * 只有让真的握手发生，才测得出这一点。
 */

// 用 openssl 现场签两张不同的自签证书：一张是「我们认识的 Worker」，
// 另一张是「冒充者」。两张都合法、都能完成握手——区别只在指纹。
function makeCert(dir, name, ip = "127.0.0.1") {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes",
    "-keyout", key, "-out", crt,
    "-subj", `/CN=${name}`,
    "-addext", `subjectAltName=IP:${ip}`,
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
  ], { stdio: "ignore" });
  const pem = readFileSync(crt, "utf8");
  return { key: readFileSync(key, "utf8"), pem, fingerprint: fingerprintFromPem(pem) };
}

let dir;
let real;
let impostor;

test.before(() => {
  dir = mkdtempSync(join(tmpdir(), "miaowa-pin-"));
  real = makeCert(dir, "real-worker");
  impostor = makeCert(dir, "impostor");
});
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** 起一个 TLS 服务器，用给定证书，永远回同一份 JSON。 */
async function withTlsServer(certBundle, run) {
  const server = createTlsServer({ cert: certBundle.pem, key: certBundle.key }, (socket) => {
    socket.on("data", () => {
      const body = JSON.stringify({ ok: true, results: [] });
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const call = (port, overrides = {}) =>
  callWorker({
    host: "127.0.0.1",
    port,
    path: "/audit/light",
    body: { url: "https://x.example/" },
    token: "t",
    fingerprint256: real.fingerprint,
    caPem: real.pem,
    timeoutMs: 8000,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// 正路
// ---------------------------------------------------------------------------

test("指纹匹配时正常拿到响应", async () => {
  await withTlsServer(real, async (port) => {
    const res = await call(port);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });
});

test("fingerprintFromPem 与 openssl 算出来的一致", () => {
  const viaOpenssl = execFileSync("openssl", ["x509", "-in", join(dir, "real-worker.crt"), "-noout", "-fingerprint", "-sha256"])
    .toString().split("=")[1].replace(/:/g, "").trim().toLowerCase();
  assert.equal(fingerprintFromPem(real.pem), viaOpenssl, "部署脚本打印的指纹与客户端算的必须是同一个");
});

test("指纹写成大写带冒号也认（运维会直接粘 openssl 的输出）", async () => {
  const withColons = real.fingerprint.toUpperCase().match(/.{2}/g).join(":");
  await withTlsServer(real, async (port) => {
    const res = await call(port, { fingerprint256: withColons });
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// 这块防护真正要挡的事
// ---------------------------------------------------------------------------

test("连到指纹不对的服务器 → 握手就被拒，且**一个字节的请求数据都没发出去**", async () => {
  // 冒充者的证书本身完全合法，握手在 TLS 层面能完成——唯一的破绽是指纹。
  // 这正是「加密但不认证」会放过的场景。
  let receivedBytes = 0;
  const server = createTlsServer({ cert: impostor.pem, key: impostor.key }, (socket) => {
    socket.on("data", (chunk) => { receivedBytes += chunk.length; });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    await assert.rejects(
      () => call(port),
      (err) => /指纹不匹配|certificate|self-signed|unable to verify/i.test(String(err.message)),
      "连到冒充者必须失败",
    );
    assert.equal(
      receivedBytes,
      0,
      "校验必须发生在握手阶段。收到任何字节都说明 Authorization: Bearer 已经发给冒充者了——" +
        "那种「先发再校验」的实现等于没校验",
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});


/**
 * 用 `real` 这张证书（CA:TRUE）签发一张**子证书**。
 *
 * 这是本文件里唯一能把「链校验」和「指纹固定」分开的场景：
 * 子证书的链能一路验到 `real`，`ca: [real.pem]` 因此会放行它——
 * **只有指纹比对拦得住**。
 *
 * 为什么这个场景值得测：`ca` 里放一张 CA:TRUE 的证书，等于承认它
 * 有权签发任意证书。哪天有人往 `ca` 里再塞一组公共 CA、或者 `ca` 配丢了
 * 让 Node 回落到系统根证书，链校验就会开始放行本不该放行的东西，
 * 而指纹是那时唯一还站着的那道。
 */
function makeSubCert(dir, name, ca) {
  const key = join(dir, `${name}.key`);
  const csr = join(dir, `${name}.csr`);
  const crt = join(dir, `${name}.crt`);
  const extFile = join(dir, `${name}.ext`);
  writeFileSync(extFile, "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${name}`], { stdio: "ignore" });
  execFileSync("openssl", [
    "x509", "-req", "-in", csr, "-days", "2", "-sha256",
    "-CA", join(dir, "real-worker.crt"), "-CAkey", join(dir, "real-worker.key"), "-CAcreateserial",
    "-extfile", extFile, "-out", crt,
  ], { stdio: "ignore" });
  void ca;
  const pem = readFileSync(crt, "utf8");
  return { key: readFileSync(key, "utf8"), pem, fingerprint: fingerprintFromPem(pem) };
}

test("链校验放行但指纹不符 → 仍然必须拒绝（这条证明指纹固定确实在做事）", async () => {
  // 变异实验的产物：早先「连到冒充者」那条测试在删掉指纹比对后**照样通过**——
  // 它其实测的是链校验（冒充者的证书不由 real 签发，链本来就不通）。
  // 换成由 real 签发的子证书，链校验会放行，指纹是唯一还站着的那道。
  const sub = makeSubCert(dir, "sub-of-real", real);
  assert.notEqual(sub.fingerprint, real.fingerprint);

  let receivedBytes = 0;
  const server = createTlsServer({ cert: sub.pem + real.pem, key: sub.key }, (socket) => {
    socket.on("data", (chunk) => { receivedBytes += chunk.length; });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      () => call(server.address().port),
      (err) => err instanceof FingerprintMismatchError,
      "由同一张 CA 签发、链完全合法的证书，指纹不符时必须被拒——" +
        "这里报的必须是 FingerprintMismatchError，不是链校验错误",
    );
    assert.equal(receivedBytes, 0, "仍然是握手阶段就拒绝，一个字节都不发");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("同一个服务器上先成功再用错指纹 → 必须仍然被拒（连接不得复用）", async () => {
  // 2026-08-07 从北京跨境实测抓到的缺陷，本文件此前**测不出来**：
  // 每条测试都用全新的服务器和端口，永远命中不到 Node 全局 Agent 的连接复用。
  //
  // 真实调用模式恰恰相反——主站会反复调用同一个 host:port。第一次用正确
  // 指纹建好连接后，Agent 会把那条 socket 缓存起来（缓存键**不包含**
  // checkServerIdentity），后续拿错误指纹的调用直接复用它，没有新握手，
  // 指纹比对根本不会被调用。实测现象：指纹改一个字符，调用仍然返回 200。
  await withTlsServer(real, async (port) => {
    const first = await call(port);
    assert.equal(first.status, 200, "先用正确指纹成功一次，把连接池预热起来");

    const wrong = real.fingerprint.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    await assert.rejects(
      () => call(port, { fingerprint256: wrong }),
      (err) => err instanceof FingerprintMismatchError,
      "第二次用错误指纹必须被拒——复用上一次握手的结论等于没有校验",
    );

    const third = await call(port);
    assert.equal(third.status, 200, "拒绝一次之后，正确指纹应当仍然可用");
  });
});

test("不传 fingerprint256 → 直接拒绝，绝不「没配就跳过」", async () => {
  await withTlsServer(real, async (port) => {
    await assert.rejects(() => call(port, { fingerprint256: undefined }), /必须传 fingerprint256/);
    await assert.rejects(() => call(port, { fingerprint256: "" }), /必须传 fingerprint256/);
  });
});

test("不传 caPem → 直接拒绝（没有它 checkServerIdentity 根本不会被调用）", async () => {
  await withTlsServer(real, async (port) => {
    await assert.rejects(() => call(port, { caPem: undefined }), /必须传 caPem/);
  });
});

test("不传 token → 直接拒绝", async () => {
  await withTlsServer(real, async (port) => {
    await assert.rejects(() => call(port, { token: "" }), /必须传 token/);
  });
});

// ---------------------------------------------------------------------------
// TLS 选项本身：三个字段没有可观测输出，只能直接断言
// ---------------------------------------------------------------------------

test("rejectUnauthorized 必须是 true——false 会让 checkServerIdentity 不被调用", () => {
  // 这是本文件最反直觉的一条。自签证书场景下人们习惯写
  // rejectUnauthorized: false，而那会让 Node **跳过** checkServerIdentity，
  // 指纹比对静默失效，代码却看起来仍然「有在校验」。
  const opts = buildTlsOptions({ caPem: real.pem, fingerprint256: real.fingerprint });
  assert.equal(opts.rejectUnauthorized, true);
});

test("ca 必须带上 Worker 自己的证书（自签证书当自己的 CA）", () => {
  const opts = buildTlsOptions({ caPem: real.pem, fingerprint256: real.fingerprint });
  assert.deepEqual(opts.ca, [real.pem]);
});

test("agent 必须是 false——连接复用会让指纹校验被整个跳过", () => {
  const opts = buildTlsOptions({ caPem: real.pem, fingerprint256: real.fingerprint });
  assert.equal(
    opts.agent,
    false,
    "Node 全局 Agent 的连接缓存键不含 checkServerIdentity；复用连接 = 复用上一次的校验结论",
  );
});

test("checkServerIdentity 匹配返回 undefined、不匹配返回 Error（不是抛错，Node 只认返回值）", () => {
  const opts = buildTlsOptions({ caPem: real.pem, fingerprint256: real.fingerprint });
  assert.equal(opts.checkServerIdentity("whatever", { fingerprint256: real.fingerprint }), undefined);
  const err = opts.checkServerIdentity("whatever", { fingerprint256: impostor.fingerprint });
  assert.ok(err instanceof FingerprintMismatchError, "必须**返回** Error 对象；抛出去 Node 不会当成校验失败");
});

test("checkServerIdentity 刻意不做主机名校验（按 IP 连接，认证全靠指纹）", () => {
  const opts = buildTlsOptions({ caPem: real.pem, fingerprint256: real.fingerprint });
  // 主机名给什么都不影响结论——这是有意的，不是漏了。
  for (const host of ["127.0.0.1", "evil.example", ""]) {
    assert.equal(opts.checkServerIdentity(host, { fingerprint256: real.fingerprint }), undefined);
  }
});

test("拿不到证书时也要判为不匹配，不能当成通过", () => {
  const opts = buildTlsOptions({ caPem: real.pem, fingerprint256: real.fingerprint });
  for (const cert of [undefined, null, {}, { fingerprint256: undefined }]) {
    assert.ok(opts.checkServerIdentity("h", cert) instanceof FingerprintMismatchError);
  }
});

test("normalizeFingerprint 抹平大小写与冒号", () => {
  assert.equal(normalizeFingerprint("AA:BB:cc"), "aabbcc");
  assert.equal(normalizeFingerprint(" aabbcc "), "aabbcc");
  assert.equal(normalizeFingerprint(undefined), "");
});
