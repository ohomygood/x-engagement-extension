"""Generate simple extension icons (blue rounded square, white ranked bars)."""
from PIL import Image, ImageDraw
for size in (16, 48, 128, 440):
    s = 4 * size
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s // 5, fill=(29, 155, 240, 255))
    m = s * 0.2
    bars = [0.85, 0.62, 0.42]
    h = (s - 2 * m) / 5
    for i, w in enumerate(bars):
        y = m + i * h * 1.7
        d.rounded_rectangle([m, y, m + (s - 2 * m) * w, y + h], radius=h / 2, fill=(255, 255, 255, 255))
    im = im.resize((size, size), Image.LANCZOS)
    name = f"static/icons/icon{size}.png" if size != 440 else "store/promo-icon-440.png"
    im.save(name)
print("icons ok")
