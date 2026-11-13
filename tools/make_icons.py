"""앱 아이콘(안경 쓴 모찌)을 그려 icons/ 에 저장한다. 사용: python3 tools/make_icons.py"""
import os
from PIL import Image, ImageDraw

SS = 4  # 크게 그린 뒤 줄여서 가장자리를 부드럽게
SKY = (166, 219, 246, 255)
LINE = (59, 42, 30, 255)
BODY = (255, 244, 222, 255)
BLUSH = (255, 198, 186, 255)
GLASS = (83, 91, 104, 255)


def bez3(p0, p1, p2, p3, n=24):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
    return out


def bez2(p0, p1, p2, n=16):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


def draw_icon(size, maskable):
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, s, s], fill=SKY)
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=SKY)
    k = s * (0.58 if maskable else 0.72) / 32
    ox, oy = s / 2 - 16 * k, s / 2 - 15.2 * k

    def pt(x, y):
        return (ox + x * k, oy + y * k)

    def circle(x, y, r, **kw):
        cx, cy = pt(x, y)
        d.ellipse([cx - r * k, cy - r * k, cx + r * k, cy + r * k], **kw)

    def stroke(points, w, color):
        pts = [pt(*p) for p in points]
        d.line(pts, fill=color, width=max(1, int(w * k)), joint='curve')
        r = w * k / 2
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x - r, y - r, x + r, y + r], fill=color)

    stroke(bez3((15, 5.2), (14, 2.2), (16, 0.6), (18.3, 1.3)), 2.0, LINE)
    circle(16, 17.5, 12.5, fill=BODY, outline=LINE, width=max(1, int(2.2 * k)))
    for bx in (8.6, 23.4):
        cx, cy = pt(bx, 20.8)
        d.ellipse([cx - 1.9 * k, cy - 1.1 * k, cx + 1.9 * k, cy + 1.1 * k], fill=BLUSH)
    for gx in (12, 20):
        circle(gx, 16.5, 3.7, outline=GLASS, width=max(1, int(1.4 * k)))
    stroke([(15.6, 16.1), (16.4, 16.1)], 1.3, GLASS)
    for gx in (12, 20):
        circle(gx, 16.5, 1.4, fill=LINE)
    stroke(bez2((14.3, 21.5), (16, 22.8), (17.7, 21.5)), 1.6, LINE)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
    os.makedirs(out, exist_ok=True)
    draw_icon(192, False).save(os.path.join(out, 'icon-192.png'))
    draw_icon(512, False).save(os.path.join(out, 'icon-512.png'))
    draw_icon(512, True).save(os.path.join(out, 'maskable-512.png'))
    print('icons written to', out)
