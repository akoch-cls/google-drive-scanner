#!/usr/bin/env python3
"""
Generates synthetic webcam frames with known page corners, for dev/eval/run.js.

Each page is a real 8.5x11 in (US Letter) rectangle projected through a pinhole
camera (focal length 0.75 x image width, like a laptop webcam), so the true
aspect ratio can be recovered and checked. Scenes cover the hard cases from the
SmartDoc 2015 findings and our own camera frames: hands over the edges, a
covered corner, light backgrounds, a screen-lit face, an overexposed ceiling
light, strong tilt, a page partly out of frame, and no page at all.

Needs Python 3 with Pillow and NumPy. Writes dev/eval/fixtures/*.png and
dev/eval/fixtures/truth.json.
"""
import json, math, os, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1280, 720
F = 0.75 * W
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')

def font(size):
    for path in ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Helvetica.ttc', 'C:/Windows/Fonts/arial.ttf'):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()

def page_texture(tone, title):
    pw, ph = 850, 1100
    img = Image.new('RGB', (pw, ph), tone)
    d = ImageDraw.Draw(img)
    d.text((70, 60), title, fill=(20, 20, 30), font=font(36))
    small = font(22)
    for i in range(24):
        d.text((70, 140 + i * 36), '%d. Explain your reasoning for part %s.  ________' % (i + 1, 'abcd'[i % 4]), fill=(40, 40, 55), font=small)
    d.line([(120, 1000), (760, 1000)], fill=(30, 30, 40), width=3)
    return img

def project(cx, cy, z, yaw, pitch, roll, size_in=(8.5, 11.0), scale=34.0):
    """Corners (TL, TR, BR, BL) of a page centred at image point (cx, cy), distance z, rotated in 3D."""
    w, h = size_in[0] * scale, size_in[1] * scale
    pts = np.array([[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]], float)
    a, b, c = map(math.radians, (yaw, pitch, roll))
    Ry = np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])
    Rx = np.array([[1, 0, 0], [0, math.cos(b), -math.sin(b)], [0, math.sin(b), math.cos(b)]])
    Rz = np.array([[math.cos(c), -math.sin(c), 0], [math.sin(c), math.cos(c), 0], [0, 0, 1]])
    P = pts @ (Rz @ Rx @ Ry).T
    # place the centre so it projects to (cx, cy)
    X0 = (cx - W / 2) * z / F
    Y0 = (cy - H / 2) * z / F
    P = P + np.array([X0, Y0, z])
    return [(F * p[0] / p[2] + W / 2, F * p[1] / p[2] + H / 2) for p in P]

def homography(src, dst):
    A, B = [], []
    for (x, y), (X, Y) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -X * x, -X * y]); B.append(X)
        A.append([0, 0, 0, x, y, 1, -Y * x, -Y * y]); B.append(Y)
    return np.linalg.solve(np.array(A, float), np.array(B, float))

def paste_page(frame, tex, quad):
    pw, ph = tex.size
    coeffs = homography(quad, [(0, 0), (pw, 0), (pw, ph), (0, ph)])
    warped = tex.transform((W, H), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC)
    mask = Image.new('L', tex.size, 255).transform((W, H), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC)
    frame.paste(warped, (0, 0), mask)

def thumb(frame, cx, cy, angle, skin, size=(36, 66)):
    t = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    rx, ry = size
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=skin + (255,))
    d.ellipse([cx - rx * 0.6, cy - ry * 0.9, cx + rx * 0.5, cy - ry * 0.3], fill=tuple(min(255, v + 22) for v in skin) + (255,))
    t = t.rotate(angle, center=(cx, cy)).filter(ImageFilter.GaussianBlur(2))
    frame.paste(t, (0, 0), t)

def room(wall, face=None, light=False, shelf=True, window=True):
    im = Image.new('RGB', (W, H), wall)
    d = ImageDraw.Draw(im)
    if light:
        d.polygon([(130, 150), (420, 120), (450, 240), (160, 270)], fill=(255, 255, 255))
        im = Image.composite(Image.new('RGB', (W, H), (255, 252, 240)), im, Image.new('L', (W, H), 0).filter(ImageFilter.GaussianBlur(1)))
    if shelf:
        d.rectangle([0, 300, 260, 720], fill=(60, 48, 40))
        rng = random.Random(3)
        for top in (320, 470, 620):
            x = 10
            while x < 250:
                bw = rng.randint(14, 28)
                d.rectangle([x, top + 130 - rng.randint(80, 125), x + bw, top + 130], fill=tuple(rng.randint(40, 220) for _ in range(3)))
                x += bw + 3
    if window:
        d.rectangle([1010, 60, 1240, 360], fill=(225, 230, 234))
        d.line([1125, 60, 1125, 360], fill=(120, 110, 100), width=8)
        d.line([1010, 210, 1240, 210], fill=(120, 110, 100), width=8)
    if face:
        d.ellipse([360, 520, 920, 1100], fill=(150, 150, 150))           # shirt
        d.rectangle([590, 420, 690, 560], fill=face)                      # neck
        d.ellipse([520, 110, 760, 450], fill=face)                        # face
        d.ellipse([505, 75, 775, 250], fill=(55, 40, 30))                 # hair
        d.ellipse([520, 150, 760, 300], fill=face)
        for ex in (580, 680):
            d.ellipse([ex - 15, 268, ex + 15, 286], fill=(50, 35, 25))
    return im

def finish(im, blur=0.6, noise=3.0, haze=0.0, seed=0):
    im = im.filter(ImageFilter.GaussianBlur(blur))
    a = np.array(im).astype(float)
    if haze:
        yy, xx = np.mgrid[0:H, 0:W]
        g = np.exp(-(((xx - 280) / 500.0) ** 2 + ((yy - 180) / 380.0) ** 2))
        a = a * (1 - haze * g[..., None]) + 255 * haze * g[..., None]
    a += np.random.default_rng(seed).normal(0, noise, a.shape)
    return Image.fromarray(a.clip(0, 255).astype(np.uint8))

SKIN_LIGHT, SKIN_MED, SKIN_DARK = (214, 166, 138), (190, 140, 108), (125, 85, 62)

def scene(name):
    """Returns (image, truth) where truth is {'corners': [...]} or {'expect': 'none'|'cut', ...}."""
    tex_white = page_texture((238, 236, 228), 'Unit Quiz')
    if name == 'dark-desk-thumbs':
        im = Image.new('RGB', (W, H), (62, 54, 50))
        q = project(640, 365, 900, 8, -10, -4)
        paste_page(im, tex_white, q)
        thumb(im, int((q[0][0] + q[3][0]) / 2) - 4, int((q[0][1] + q[3][1]) / 2) + 30, -6, SKIN_LIGHT)
        thumb(im, int((q[1][0] + q[2][0]) / 2) + 4, int((q[1][1] + q[2][1]) / 2) - 20, 8, SKIN_DARK)
        return finish(im), {'corners': q}
    if name == 'classroom-person':
        im = room((176, 168, 156), face=SKIN_LIGHT)
        q = project(640, 500, 1150, -6, 8, 2)
        paste_page(im, tex_white, q)
        thumb(im, int((q[0][0] + q[3][0]) / 2) - 6, int((q[0][1] + q[3][1]) / 2) + 20, -6, SKIN_LIGHT)
        thumb(im, int((q[1][0] + q[2][0]) / 2) + 6, int((q[1][1] + q[2][1]) / 2) - 10, 6, SKIN_LIGHT)
        return finish(im), {'corners': q}
    if name == 'ceiling-light-midgray-page':
        # Like our real frames: exposure set for the ceiling light, page comes out mid-grey, cream wall brighter.
        im = room((205, 192, 165), face=(150, 105, 85), light=True)
        q = project(700, 420, 760, -14, 4, 4)
        paste_page(im, page_texture((150, 152, 155), 'Model Application Assessment'), q)
        thumb(im, int(q[1][0] + 10), int((q[1][1] + q[2][1]) / 2 - 40), 10, (150, 105, 85), size=(55, 95))
        return finish(im, haze=0.35), {'corners': q}
    if name == 'light-wall-low-contrast':
        im = room((214, 210, 200), shelf=False, window=False)
        q = project(640, 360, 820, 18, -6, 35)
        paste_page(im, tex_white, q)
        return finish(im), {'corners': q}
    if name == 'corner-covered':
        im = Image.new('RGB', (W, H), (80, 75, 72))
        q = project(640, 360, 860, 4, 6, 3)
        paste_page(im, tex_white, q)
        thumb(im, int(q[2][0]) - 5, int(q[2][1]) - 10, 35, SKIN_MED, size=(48, 80))   # thumb over bottom-right corner
        return finish(im), {'corners': q}
    if name == 'strong-tilt':
        im = Image.new('RGB', (W, H), (70, 66, 64))
        q = project(640, 360, 900, 38, 12, 0)
        paste_page(im, tex_white, q)
        return finish(im), {'corners': q, 'aspect': 11 / 8.5}
    if name == 'rotated-45':
        im = Image.new('RGB', (W, H), (66, 70, 76))
        q = project(640, 360, 1100, 0, 0, 45)
        paste_page(im, tex_white, q)
        return finish(im), {'corners': q}
    if name == 'page-cut-off':
        im = room((176, 168, 156), face=SKIN_LIGHT)
        q = project(640, 560, 640, 0, 6, 2)
        paste_page(im, tex_white, q)
        return finish(im), {'expect': 'cut'}
    if name == 'page-top-off-frame':
        # Held so close the top runs off the frame: a line of text must not pass for the top edge.
        im = room((214, 206, 190), face=SKIN_LIGHT, shelf=False)
        q = project(640, 250, 560, 4, -4, 2)
        paste_page(im, page_texture((236, 234, 228), 'Scenario 1: The Math Test'), q)
        thumb(im, int(q[3][0] + 14), int((q[0][1] + q[3][1]) / 2 + 120), -6, SKIN_LIGHT)
        return finish(im), {'expect': 'cut'}
    if name == 'screen-lit-face-no-page':
        im = room((110, 102, 96), face=(238, 208, 192))
        return finish(im), {'expect': 'none'}
    if name == 'ceiling-light-no-page':
        im = room((205, 192, 165), face=(150, 105, 85), light=True)
        return finish(im, haze=0.35), {'expect': 'none'}
    raise KeyError(name)

SCENES = ['dark-desk-thumbs', 'classroom-person', 'ceiling-light-midgray-page', 'light-wall-low-contrast',
          'corner-covered', 'strong-tilt', 'rotated-45', 'page-cut-off', 'page-top-off-frame', 'screen-lit-face-no-page',
          'ceiling-light-no-page']

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    truth = {}
    for name in SCENES:
        im, t = scene(name)
        im.save(os.path.join(OUT, name + '.png'))
        if 'corners' in t:
            t['corners'] = [[round(x, 2), round(y, 2)] for x, y in t['corners']]
        t['size'] = [W, H]
        truth[name + '.png'] = t
        print('wrote', name)
    with open(os.path.join(OUT, 'truth.json'), 'w') as f:
        json.dump(truth, f, indent=1)
