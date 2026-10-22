"""Build the extension's public site (privacy policy for the Chrome Web Store) into site/ for Cloudflare Pages."""
import html, pathlib, markdown
root = pathlib.Path(__file__).resolve().parents[1]
out = root / "site"; out.mkdir(exist_ok=True)
body = markdown.markdown((root / "store" / "privacy-policy.md").read_text(encoding="utf-8"))
page = lambda title, inner: f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title><style>body{{font:16px/1.65 system-ui,-apple-system,"PingFang SC",sans-serif;max-width:760px;margin:40px auto;padding:0 18px;color:#0f1419}}h1{{font-size:24px}}a{{color:#1d9bf0}}</style></head><body>{inner}</body></html>"""
(out / "privacy.html").write_text(page("Privacy Policy — X Engagement List", body), encoding="utf-8")
(out / "index.html").write_text(page("X Engagement List / X 互动名单助手", """<h1>X Engagement List / X 互动名单助手</h1>
<p>A local-only Chrome extension: commenter leaderboard, pending replies, and not-following-back lists from the X pages you visit. Your data stays in your browser.</p>
<p>本地运行的 Chrome 扩展：评论排行、待回复清单、未回关名单。数据只保存在你的浏览器里。</p>
<p><a href="privacy.html">Privacy Policy / 隐私政策</a> · Contact: go_with_prob@mail.grokbot.com</p>"""), encoding="utf-8")
(out / "_headers").write_text("/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n", encoding="utf-8")
print("site/ ready:", sorted(p.name for p in out.iterdir()))
