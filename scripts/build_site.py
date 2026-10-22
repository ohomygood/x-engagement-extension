"""Build the public site (bilingual landing page + terms/refund policy + privacy policy) into site/ for Cloudflare Pages.

    python3 scripts/build_site.py            # then: wrangler pages deploy site --project-name xeng-site

Stripe only, no WeChat. The release check (scripts/check_release.mjs) runs on site/ and fails the build on any
payment QR, unexpected image or WeChat copy.
"""
import html, pathlib, shutil, subprocess, sys
import markdown

# One-line switch: show the "Buy Pro" Stripe link on the site. Off until the extension is in the Chrome Web Store
# (a plain-link purchase works: the key is tied to the Checkout Session, not to an install).
BUY_ENABLED = False

PAYMENT_LINK = "https://buy.stripe.com/8x2bJ2gbY8bLfiC2hT0Ny03"
CONTACT = "go_with_prob@mail.grokbot.com"
SITE_URL = "https://xeng.aiseenlab.com"   # custom domain (Pages project xeng-site); old host below 301-redirects here
OLD_HOST = "xeng-site.pages.dev"
# Refund policy: keep in sync with REFUND_POLICY in worker/src/index.ts (license server /paid page)
NOTIFY = f"mailto:{CONTACT}?subject=Notify%20me%3A%20X%20Engagement%20List&body=Please%20email%20me%20when%20the%20extension%20is%20in%20the%20Chrome%20Web%20Store."
SHOTS = {"en": [("en-1-leaderboard.png", "Top commenters"), ("en-2-pending.png", "Replies you haven't answered"),
                ("en-3-not-following-back.png", "Not following back")],
         "zh": [("zh-1-leaderboard.png", "评论排行"), ("zh-2-pending.png", "待回复"), ("zh-4-unfollowers.png", "取关名单")]}

root = pathlib.Path(__file__).resolve().parents[1]
out = root / "site"
shutil.rmtree(out, ignore_errors=True)
(out / "screenshots").mkdir(parents=True)
for lang in SHOTS:
    for f, _ in SHOTS[lang]:
        shutil.copyfile(root / "store" / "screenshots" / f, out / "screenshots" / f)

CSS = """body{font:16px/1.65 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;color:#0f1419;background:#fff}
main{max-width:980px;margin:0 auto;padding:0 20px 48px}header{display:flex;justify-content:space-between;align-items:center;max-width:980px;margin:0 auto;padding:16px 20px}
.brand{font-weight:700;font-size:18px}.lang button{border:1px solid #cfd9de;background:#fff;border-radius:999px;padding:4px 12px;cursor:pointer;font:inherit;font-size:14px}
h1{font-size:34px;line-height:1.25;margin:28px 0 12px}h2{font-size:24px;margin:44px 0 14px}.lead{font-size:19px;color:#36454f;max-width:760px}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0}.btn{display:inline-block;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:600}
.primary{background:#1d9bf0;color:#fff}.ghost{border:1px solid #cfd9de;color:#0f1419}.disabled{background:#eff3f4;color:#536471;cursor:not-allowed}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}.shots figure{margin:0}.shots img{width:100%;border:1px solid #e1e8ed;border-radius:10px}
figcaption{font-size:14px;color:#536471;margin-top:6px}ul.points{padding-left:20px}ul.points li{margin:6px 0}
table{border-collapse:collapse;width:100%;max-width:760px}th,td{border-bottom:1px solid #e1e8ed;padding:10px;text-align:left;vertical-align:top}th{background:#f7f9f9}
.price{font-size:20px;font-weight:700}.muted{color:#536471;font-size:14px}footer{border-top:1px solid #e1e8ed;margin-top:48px;padding-top:18px}
a{color:#1d9bf0}[data-lang]{display:none}html[lang=en] [data-lang=en],html[lang=zh-CN] [data-lang=zh]{display:block}"""

T = {
 "en": dict(title="X Engagement List — see who engages with your X posts",
   h1="See who engages with your X posts, without sending your data anywhere.",
   lead="A Chrome extension that turns the X pages you already visit into simple lists: your top commenters, the replies you haven't answered, and the accounts that don't follow you back. Everything is stored locally in your browser.",
   install="Install from Chrome Web Store (coming soon)", notify="Notify me when it's available", buy="Buy Pro — $4.99 one-off",
   shots="Screenshots", shots_note="Screenshots use sample data.",
   what="What it does", points=["<b>Top commenters</b> (7 / 30 / 90 days): who replies to your posts most often, with a link to their latest reply.",
     "<b>To reply</b>: comments on your posts that you haven't answered yet.",
     "<b>Not following back</b>: open your own Following page and start a snapshot; the extension scrolls slowly (you can stop any time) and lists who doesn't follow you back.",
     "<b>Unfollowers</b>: compare two complete snapshots of your Followers page to see who left."],
   how="How it works", how_p="The extension reads the X pages you open in your own browser and stores what it sees in your browser's local database. It doesn't use the X API, doesn't ask for your password, and never follows, unfollows, likes, replies or messages. The only network request it makes is the Pro license check.",
   plans="Free vs Pro", feat="Feature", free="Free", pro="Pro", rows=[("History window", "Last 7 days", "7 / 30 / 90 days"), ("Rows per list", "Top 20", "All rows"),
     ("CSV export", "—", "✓"), ("X accounts", "1", "Multiple"), ("Price", "$0", "$4.99 USD one-off, no subscription")],
   price_note="Pro is paid by card through Stripe and charged in USD; Stripe checkout may show your local currency. After paying you get a license key to enter in the extension's Settings. Refunds: full refund on request within 7 days of purchase, once per customer (see Terms).",
   privacy="Privacy policy", terms="Terms & refunds", contact="Contact", disclaimer="Not affiliated with or endorsed by X Corp. “X” is used only to describe the website the extension works with."),
 "zh": dict(title="X 互动名单助手 — 看清谁在和你互动",
   h1="看清谁在和你的 X 帖子互动，数据不离开你的浏览器。",
   lead="一个 Chrome 扩展：把你平时浏览的 X 页面整理成清单——评论最多的人、还没回复的评论、没有回关你的账号。所有数据只保存在你自己的浏览器里。",
   install="从 Chrome 应用商店安装（即将上架）", notify="上架后通知我", buy="购买 Pro：$4.99 一次性",
   shots="截图", shots_note="截图中为示例数据。",
   what="功能", points=["<b>评论排行</b>（近 7 / 30 / 90 天）：谁最常回复你的帖子，并附最近一条回复的链接。",
     "<b>待回复</b>：你还没有回复的评论。",
     "<b>未回关</b>：打开你自己的「正在关注」页面并开始快照，扩展会慢慢滚动（随时可以停止），列出没有回关你的账号。",
     "<b>取关名单</b>：对比两次完整的粉丝列表快照，看谁取关了你。"],
   how="工作方式", how_p="扩展只读取你在自己浏览器里打开的 X 页面，并把看到的内容存进浏览器的本地数据库。不调用 X 的 API，不需要你的密码，也不会替你关注、取关、点赞、回复或私信。唯一的网络请求是 Pro 授权校验。",
   plans="免费版 vs Pro", feat="功能", free="免费版", pro="Pro", rows=[("历史范围", "近 7 天", "7 / 30 / 90 天"), ("每个清单行数", "前 20 行", "全部"),
     ("CSV 导出", "—", "✓"), ("X 账号数", "1 个", "多个"), ("价格", "$0", "$4.99 美元一次性，不订阅")],
   price_note="Pro：$4.99 美元，通过 Stripe 用银行卡支付，按美元收费，结账页可能显示本地货币金额。付款后获得授权码，在扩展的「设置与授权」里输入即可。退款：购买后 7 天内可申请全额退款，每位客户限一次（详见服务条款）。",
   privacy="隐私政策", terms="服务条款与退款", contact="联系", disclaimer="本扩展与 X Corp. 无任何关联，也未获其认可。“X”仅用于说明扩展所适用的网站。"),
}

TERMS = {
 "en": ("Terms of Service and Refund Policy", [
   ("Product", "X Engagement List is a Chrome extension. The Free plan costs nothing. Pro is a $4.99 USD one-off purchase (no subscription), paid by card through Stripe; Stripe checkout may show your local currency."),
   ("License", "After paying you get a license key for your own use on up to 3 devices. Don't share or resell it."),
   ("Refund policy", "Full refund on request within 7 days of purchase, once per customer. To ask for one, email " + CONTACT + " with your license key or the Stripe receipt. The refund goes back to your original payment method through Stripe, and the license key is revoked."),
   ("Your data", "The extension stores what it reads only in your browser. See the privacy policy."),
   ("No warranty", "The extension is provided as is. It depends on how x.com pages look, and may stop working if X changes them."),
   ("Not affiliated", "Not affiliated with or endorsed by X Corp."),
   ("Contact", "Questions or refunds: " + CONTACT + ".")]),
 "zh": ("服务条款与退款政策", [
   ("产品", "X 互动名单助手是一个 Chrome 扩展。免费版不收费；Pro 为 $4.99 美元一次性购买（不订阅），通过 Stripe 用银行卡支付，结账页可能显示本地货币金额。"),
   ("授权", "付款后你会获得一个激活码，供你本人在最多 3 台设备上使用，请勿分享或转售。"),
   ("退款政策", "购买后 7 天内可申请全额退款，每位客户限一次。申请请发邮件至 " + CONTACT + "，附上激活码或 Stripe 收据。退款通过 Stripe 原路退回，激活码随之失效。"),
   ("你的数据", "扩展读取的内容只保存在你的浏览器里，详见隐私政策。"),
   ("免责声明", "扩展按现状提供。它依赖 x.com 的页面结构，X 改版后可能暂时无法使用。"),
   ("无关联", "本扩展与 X Corp. 无任何关联，也未获其认可。"),
   ("联系", "问题或退款：" + CONTACT + "。")]),
}

def terms_section(lang):
    title, items = TERMS[lang]; e = html.escape
    body = "".join(f"<h2>{e(h)}</h2><p>{e(p)}</p>" for h, p in items)
    back = "← X 互动名单助手" if lang == "zh" else "← X Engagement List"
    privacy = T[lang]["privacy"]
    return f"""<div data-lang="{lang}"><p><a href="/">{e(back)}</a></p><h1>{e(title)}</h1>{body}
<footer><p><a href="/privacy">{e(privacy)}</a> · <a href="mailto:{CONTACT}">{CONTACT}</a></p><p class="muted">{e(T[lang]['disclaimer'])}</p></footer></div>"""

LANG_JS = """<script>(function(){var q=new URLSearchParams(location.search).get("lang");var zh=q?q==="zh":/^zh/i.test(navigator.language||"");
document.documentElement.lang=zh?"zh-CN":"en";})();</script>"""

def section(lang):
    t = T[lang]; e = html.escape
    buy = f'<a class="btn ghost" href="{PAYMENT_LINK}">{e(t["buy"])}</a>' if BUY_ENABLED else ""
    shots = "".join(f'<figure><a href="screenshots/{f}"><img src="screenshots/{f}" alt="{e(c)}" loading="lazy"></a><figcaption>{e(c)}</figcaption></figure>' for f, c in SHOTS[lang])
    rows = "".join(f"<tr><td>{e(a)}</td><td>{e(b)}</td><td>{e(c)}</td></tr>" for a, b, c in t["rows"])
    return f"""<div data-lang="{lang}"><h1>{e(t['h1'])}</h1><p class="lead">{e(t['lead'])}</p>
<div class="btns"><span class="btn disabled" aria-disabled="true">{e(t['install'])}</span><a class="btn primary" href="{NOTIFY}">{e(t['notify'])}</a>{buy}</div>
<h2>{e(t['shots'])}</h2><div class="shots">{shots}</div><p class="muted">{e(t['shots_note'])}</p>
<h2>{e(t['what'])}</h2><ul class="points">{''.join(f'<li>{p}</li>' for p in t['points'])}</ul>
<h2>{e(t['how'])}</h2><p>{e(t['how_p'])}</p>
<h2>{e(t['plans'])}</h2><table><tr><th>{e(t['feat'])}</th><th>{e(t['free'])}</th><th>{e(t['pro'])}</th></tr>{rows}</table>
<p class="muted">{e(t['price_note'])}</p>
<footer><p><a href="/terms">{e(t['terms'])}</a> · <a href="/privacy">{e(t['privacy'])}</a> · {e(t['contact'])}: <a href="mailto:{CONTACT}">{CONTACT}</a></p><p class="muted">{e(t['disclaimer'])}</p></footer></div>"""

index = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X Engagement List / X 互动名单助手</title><link rel="canonical" href="{SITE_URL}/"><meta name="description" content="{html.escape(T['en']['lead'])}">
<style>{CSS}</style><script>(function(){{var q=new URLSearchParams(location.search).get("lang");var zh=q?q==="zh":/^zh/i.test(navigator.language||"");
document.documentElement.lang=zh?"zh-CN":"en";}})();</script></head><body>
<header><div class="brand">X Engagement List · X 互动名单助手</div><div class="lang"><button type="button" id="lang">中 / EN</button></div></header>
<main>{section('en')}{section('zh')}</main>
<script>document.getElementById("lang").onclick=function(){{var h=document.documentElement;h.lang=h.lang==="en"?"zh-CN":"en";}};</script>
</body></html>"""
(out / "index.html").write_text(index, encoding="utf-8")

terms_html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terms &amp; Refund Policy — X Engagement List / 服务条款与退款政策</title><link rel="canonical" href="{SITE_URL}/terms"><style>{CSS}</style>{LANG_JS}</head><body>
<header><div class="brand">X Engagement List · X 互动名单助手</div><div class="lang"><button type="button" id="lang">中 / EN</button></div></header>
<main>{terms_section('en')}{terms_section('zh')}</main>
<script>document.getElementById("lang").onclick=function(){{var h=document.documentElement;h.lang=h.lang==="en"?"zh-CN":"en";}};</script>
</body></html>"""
(out / "terms.html").write_text(terms_html, encoding="utf-8")

body = markdown.markdown((root / "store" / "privacy-policy.md").read_text(encoding="utf-8"))
(out / "privacy.html").write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy — X Engagement List</title><link rel="canonical" href="{SITE_URL}/privacy"><style>body{{font:16px/1.65 system-ui,-apple-system,"PingFang SC",sans-serif;max-width:760px;margin:40px auto;padding:0 18px;color:#0f1419}}h1{{font-size:24px}}a{{color:#1d9bf0}}</style></head>
<body><p><a href="/">← X Engagement List</a></p>{body}</body></html>""", encoding="utf-8")
(out / "_headers").write_text("/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n", encoding="utf-8")
# Pages advanced-mode worker: the old production pages.dev host 301-redirects to the custom domain (path + query kept);
# preview hosts (<hash>.xeng-site.pages.dev) and the custom domain are served from the static assets.
(out / "_worker.js").write_text(f"""const CANONICAL = "{SITE_URL.split('://')[1]}", OLD = "{OLD_HOST}";
export default {{
  async fetch(req, env) {{
    const u = new URL(req.url);
    if (u.hostname === OLD) {{ u.protocol = "https:"; u.hostname = CANONICAL; u.port = ""; return Response.redirect(u.toString(), 301); }}
    return env.ASSETS.fetch(req);
  }},
}};
""", encoding="utf-8")
r = subprocess.run(["node", str(root / "scripts" / "check_release.mjs"), str(out)])
if r.returncode:
    sys.exit("site/ failed the release check (QR / WeChat)")
print("site/ ready:", sorted(p.name for p in out.iterdir()))
