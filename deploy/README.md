# 检测 Worker 部署

从一台全新的云主机到跑通深检查的完整步骤。每一步都在真实实例
（4 GB / 2 vCPU，Ubuntu 24.04）上实际执行过，不是照着文档抄的。

## 0. 实例规格

| 项 | 取值 | 理由 |
| --- | --- | --- |
| 内存 | **≥ 4 GB** | Lighthouse 实测峰值 1073 MB（`globalsources.com`）。2 GB 档实测放不下：可用内存只剩约 104 MB |
| vCPU | 2 | 实测 CPU 不是瓶颈（20 并发轻检查时进程 CPU 只占墙钟 9–16%） |
| 系统 | Ubuntu 22.04 或 24.04 | **24.04 需要额外配 AppArmor profile**，见第 4 步 |
| 磁盘 | ≥ 20 GB | Chrome + Lighthouse 约 500 MB |
| 静态 IP | 必须分配 | 要写进调用方配置、Chrome 代理的拒绝名单，以及证书的 SAN |

> ⚠️ **分配到静态 IP 后，第一件事是从调用方那台机器测一下能不能连上。**
> 云厂商的静态 IP 是回收再分配的，**可能带着上一任租户留下的阻断记录**。
> 真的踩过：整台机器从调用方所在地区完全连不上（22/80/443 全断），
> 而同一个 /16 里别的 IP 都通——换一个静态 IP 即解决。
> **在确认这一步之前不要往下做**，否则会把时间花在排查端口和防火墙上，
> 而问题根本不在你的机器里。

> **区域**：选哪个海外区域影响都很窄——PSI 与 CrUX 在 Google 自己的机器上跑，
> 可访问性树查的是 DOM 结构，都与观测点无关。**真正要避免的是从中国大陆测**：
> 那样量到的是跨境链路，不是海外访问者与 AI 爬虫看到的东西。

## 1. swap（必须，即使内存够）

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-miaowa-swappiness.conf
sudo sysctl -p /etc/sysctl.d/99-miaowa-swappiness.conf
```

`swappiness=10`：swap 是内存尖峰的安全垫，不是让常驻进程日常换出去。

## 2. 隔离的 Node 22（**不要装系统 Node**）

```bash
V=v22.23.2; TAR=node-$V-linux-x64.tar.xz
cd /tmp && curl -fsSL -O "https://nodejs.org/dist/$V/$TAR" \
        && curl -fsSL -O "https://nodejs.org/dist/$V/SHASUMS256.txt"
grep " $TAR\$" SHASUMS256.txt | sha256sum -c -      # 校验必做
sudo mkdir -p /opt/node22 && sudo tar -xJf "$TAR" -C /opt/node22 --strip-components=1
/opt/node22/bin/node -v
```

为什么不用系统包：机器上的系统 Node 往往被别的常驻进程用着，整机升级会波及
无关业务。独立解压到 `/opt/node22` 只由本服务的单元引用，系统 Node 原样不动。

## 3. 服务账号与目录

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin miaowageo
sudo mkdir -p /opt/miaowa-site-audit/current /etc/miaowa-site-audit \
              /var/lib/miaowa-site-audit /opt/chrome
sudo chown miaowageo:miaowageo /var/lib/miaowa-site-audit
```

## 4. Chrome for Testing + 沙箱

```bash
# 运行依赖（24.04 最小镜像不带）
sudo apt-get install -y libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libnss3 libnspr4 \
  libatspi2.0-0t64 libx11-xcb1 fonts-liberation xdg-utils

# 二进制（版本号从 chrome-for-testing 的 last-known-good-versions 取）
sudo unzip -q chrome-linux64.zip -d /opt/chrome
sudo chmod -R a+rX /opt/chrome
/opt/chrome/chrome-linux64/chrome --version
```

**Ubuntu 24.04 必须再做这一步**，否则 Chrome 起不来：

```bash
sudo cp deploy/apparmor-miaowa-chrome /etc/apparmor.d/miaowa-chrome
sudo apparmor_parser -r /etc/apparmor.d/miaowa-chrome
```

验证（这是个**对照实验**，两边都要看）：

```bash
# 装了 profile：应当正常启动，stderr 里没有 sandbox 字样
sudo -u miaowageo /opt/chrome/chrome-linux64/chrome --headless=new \
  --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/probe \
  --dump-dom about:blank

# 卸掉 profile：应当立刻 FATAL: No usable sandbox! 并 SIGABRT
sudo apparmor_parser -R /etc/apparmor.d/miaowa-chrome
# …重跑上面那条…
sudo apparmor_parser -r /etc/apparmor.d/miaowa-chrome   # 记得装回去
```

> 只看「装了 profile 能跑」是不够的——它可能本来就能跑，profile 根本没生效。
> **必须看到卸掉之后失败**，才能确认沙箱确实是靠它起来的。

## 5. 代码与依赖

```bash
sudo rsync -a --delete --exclude .git ./ /opt/miaowa-site-audit/current/
cd /opt/miaowa-site-audit/current
sudo /opt/node22/bin/npm install --omit=dev --no-audit --no-fund  # 只装 lighthouse
sudo chown -R root:root /opt/miaowa-site-audit
sudo find /opt/miaowa-site-audit -type d -exec chmod 755 {} \;
sudo find /opt/miaowa-site-audit -type f -exec chmod 644 {} \;
sudo chmod +x /opt/miaowa-site-audit/current/node_modules/.bin/lighthouse
```

## 6. 环境文件

```bash
sudo tee /etc/miaowa-site-audit/audit-worker.env >/dev/null <<EOF
MIAOWA_AUDIT_WORKER_TOKEN=$(openssl rand -hex 32)
MIAOWA_AUDIT_OWN_PUBLIC_IP=<本实例静态公网 IP>
MIAOWA_AUDIT_DEEP_ENABLED=1
GOOGLE_PSI_API_KEY=<密钥>
MIAOWA_AUDIT_PROXY_PORT=4320
EOF
sudo chown root:miaowageo /etc/miaowa-site-audit/audit-worker.env
sudo chmod 640 /etc/miaowa-site-audit/audit-worker.env
```

四个必填项，缺任何一个**服务会拒绝启动**（这是刻意的，见 `assertDeepCheckConfig`）：

| 变量 | 缺失时的后果（如果不拦） |
| --- | --- |
| `MIAOWA_AUDIT_WORKER_TOKEN` | 无鉴权 |
| `MIAOWA_AUDIT_OWN_PUBLIC_IP` | 「拒绝连回本机公网 IP」整条防线静默消失 |
| `MIAOWA_AUDIT_DEEP_ENABLED` | 「忘了配」与「深检查坏了」在外部无法区分 |
| `GOOGLE_PSI_API_KEY` | 无密钥调 PSI 返回 429，伪装成「配额耗尽」 |

> **密钥文件里的变量名可能是 `Google_PSI_API_key`**（`seo+geo工具/.env.local.txt`）。
> 大小写必须改成 `GOOGLE_PSI_API_KEY`，这是 2026-08-06 实测发现的 D3。

## 6.5 TLS（跨境调用必须开）

```bash
sudo bash deploy/gen-worker-cert.sh <本机公网 IP>     # 打印指纹与证书 PEM
```

然后往 env 文件里加三行：

```
MIAOWA_AUDIT_TLS=1
MIAOWA_AUDIT_TLS_CERT_PATH=/etc/miaowa-site-audit/tls/worker.crt
MIAOWA_AUDIT_TLS_KEY_PATH=/etc/miaowa-site-audit/tls/worker.key
```

`MIAOWA_AUDIT_TLS` 同样没有默认值。`"0"`（明文）**只允许用于本机自测**；
跨境部署必须是 `"1"`，否则 Bearer token 在网上裸奔。
证书读不出来时服务**拒绝启动**，绝不退回明文——退回明文时主站的指纹校验
会失败并把它记成「Worker 挂了」，而真正的原因（文件权限）没人看得见。

主站侧要两样东西，都由上面的脚本打印：

| 配置项 | 是不是机密 |
| --- | --- |
| `MIAOWA_AUDIT_WORKER_FINGERPRINT`（证书 SHA-256 指纹） | 否 |
| Worker 的证书 PEM（主站做链校验用） | 否 |

主站用 `src/client/pinned-client.mjs` 的 `callWorker()` 调用。
**换证书时这两项必须同步更新**，否则指纹校验会正确地拒绝新证书——
那是它该做的事，不是故障。

## 7. 防火墙（云防火墙之外再加一层）

```bash
sudo cp deploy/nftables-miaowa-audit.conf /etc/nftables-miaowa-audit.conf
sudo cp deploy/miaowa-audit-fw.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now miaowa-audit-fw
sudo nft list table inet miaowa_audit_fw
```

**不要**把规则写进 `/etc/nftables.conf`：那个文件开头通常是 `flush ruleset`，
如果机器上还有别的服务单独加载 nftables 规则，开机时会被整个冲掉。

## 8. systemd

```bash
sudo cp deploy/miaowa-site-audit.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now miaowa-site-audit
systemctl status miaowa-site-audit --no-pager
```

## 9. 验收（逐条做，不要跳）

开了 TLS 之后本机自测要用 `--cacert` 加 `--resolve`（证书的 SAN 是公网 IP，
不是 127.0.0.1），或者临时把 `MIAOWA_AUDIT_TLS` 设成 `0` 重启。
**真正的验收应当从调用方那台机器用 `src/client/pinned-client.mjs` 做**——
那才是实际走的路径，也顺带验了指纹固定。

```bash
TOKEN=$(sudo grep '^MIAOWA_AUDIT_WORKER_TOKEN=' /etc/miaowa-site-audit/audit-worker.env | cut -d= -f2)

# 轻检查（TLS=0 时）
curl -s -X POST http://127.0.0.1:4319/audit/light \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://www.globalsources.com/"}' | head -c 300

# 深检查（必须带 robotsAllowedPage，缺了会 400）
curl -s -X POST http://127.0.0.1:4319/audit/deep \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://www.made-in-china.com/","robotsAllowedPage":true}'

# 无 token 必须 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4319/audit/deep \
  -H 'content-type: application/json' -d '{"url":"https://x.com/","robotsAllowedPage":true}'
```

**端口可达性必须从调用方那台机器验，不要从开发机验。** 真实教训：
开发机挂着透明代理（Clash TUN 之类）时，`nc -z` 对**任何**端口都报 succeeded，
据此差点得出「服务暴露到公网」的错误结论。诊断网络问题时，
第一步永远是先确认自己的包真的离开了这台机器。

```bash
# 在调用方那台机器上跑
timeout 8 bash -c "</dev/tcp/<worker-ip>/4319" && echo 可达 || echo 不可达
```

### 从调用方的完整验收（TLS + 指纹固定）

```bash
node -e '
import("/tmp/pinned-client.mjs").then(async ({ callWorker, FingerprintMismatchError }) => {
  const fs = await import("node:fs");
  const base = { host: "<worker-ip>", port: 4319, token: process.env.TOKEN,
                 caPem: fs.readFileSync("/tmp/worker.crt", "utf8"),
                 fingerprint256: process.env.FP };
  const r = await callWorker({ ...base, path: "/audit/light", body: { url: "https://www.globalsources.com/" } });
  console.log(r.status, r.json.results.length);
  // 指纹改一个字符必须被拒——**注意要在成功调用之后再测**，
  // 那才覆盖得到「连接复用绕过指纹校验」这条实测踩过的坑
  try { await callWorker({ ...base, fingerprint256: process.env.FP.replace(/.$/, "0"),
        path: "/audit/light", body: { url: "https://x.example/" } }); console.log("✗ 指纹固定没生效"); }
  catch (e) { console.log("✓", e.name); }
});'
```

必须看到的四件事：轻检查 200、深检查四项全 `ready`、
错误指纹被 `FingerprintMismatchError` 拒绝、之后正确指纹仍然可用。
