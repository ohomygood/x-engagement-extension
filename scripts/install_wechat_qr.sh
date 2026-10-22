#!/usr/bin/env bash
# Copy the owner's WeChat Pay QR into static/ as a LOCAL, gitignored file (CONFIG.WECHAT.QR). `npm run build`
# then packages it into dist/ (so the Chrome Web Store zip DOES contain it: it's shown to buyers).
set -euo pipefail
SRC="${1:-/workspace/payment/wechat_pay_qr.jpg}"
DST="$(cd "$(dirname "$0")/.." && pwd)/static/wechat_pay_qr.jpg"
[ -f "$SRC" ] || { echo "QR not found: $SRC" >&2; exit 1; }
cp "$SRC" "$DST" && echo "copied -> $DST (gitignored)"
