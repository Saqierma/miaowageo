#!/bin/bash
# 生成检测 Worker 的自签证书，并打印主站要固定的指纹。
#
# 用法：sudo bash deploy/gen-worker-cert.sh <Worker 的公网 IP>
#
# 为什么是自签而不是 Let's Encrypt：主站按 **IP** 调用 Worker
# （`https://<静态IP>:4319/`），公共 CA 不给裸 IP 签证书；而且这条链路
# 只有一个调用方，认证靠指纹固定比靠 PKI 更直接也更强。
#
# 有效期 3650 天是刻意的：证书过期会让主站的调用**全部失败**，而这条链路
# 没有自动续期机制。与其一年踩一次坑，不如一次签长的，把轮换写进流程——
# 换证书时主站的 MIAOWA_AUDIT_WORKER_FINGERPRINT 必须同步更新，
# 否则指纹校验会**正确地**拒绝新证书（那是它该做的事，不是故障）。
set -euo pipefail

IP="${1:?用法: $0 <Worker 的公网 IP>}"
DIR=/etc/miaowa-site-audit/tls

mkdir -p "$DIR"

# CA:TRUE 是必需的，不是多余的：主站把这张自签证书当作它自己的 CA 交给
# Node（`ca: [workerCertPem]`），链校验才可能通过；链校验通过，Node 才会
# 调用 checkServerIdentity——而指纹比对就在那里面。
# 少了 CA:TRUE，主站侧会以「证书链无效」失败，而不是以「指纹不符」失败，
# 排障时会往完全错误的方向找。
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$DIR/worker.key" -out "$DIR/worker.crt" \
  -subj "/CN=miaowa-site-audit-worker" \
  -addext "subjectAltName=IP:$IP" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign" 2>/dev/null

chown root:miaowageo "$DIR/worker.key" "$DIR/worker.crt"
chmod 640 "$DIR/worker.key"
chmod 644 "$DIR/worker.crt"

echo "证书已生成："
ls -l "$DIR"
echo
echo "===== 主站要配的两项 ====="
echo "MIAOWA_AUDIT_WORKER_FINGERPRINT=$(openssl x509 -in "$DIR/worker.crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-Z' 'a-z')"
echo
echo "证书 PEM（主站需要它做链校验；**不是机密**，可以明文传递）："
cat "$DIR/worker.crt"
