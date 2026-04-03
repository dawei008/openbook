#!/usr/bin/env python3
"""
OpenBook Cover Generator — Neural Cartography aesthetic
Museum-quality book cover: dark field, precise geometric elements,
concentric orbital layers around a central neural core.
"""

from PIL import Image, ImageDraw, ImageFont
import math
import os

W, H = 1600, 2240
FONTS_DIR = os.path.expanduser("~/.claude/skills/canvas-design/canvas-fonts")

# === COLOR PALETTE (strictly limited) ===
BG       = (245, 245, 248)
CYAN     = (0, 140, 180)
ORANGE   = (220, 90, 30)
DIM      = (200, 205, 215)
MUTED    = (120, 130, 150)
TEXT     = (25, 30, 40)
FAINT    = (230, 232, 238)

def alpha_color(base, alpha):
    """Return RGBA tuple."""
    return (*base, alpha)

def load_font(name, size):
    path = os.path.join(FONTS_DIR, name)
    if os.path.exists(path):
        return ImageFont.truetype(path, size)
    return ImageFont.load_default()

# === LOAD FONTS ===
font_title_large  = load_font("BigShoulders-Bold.ttf", 148)
font_title_sub    = load_font("Tektur-Medium.ttf", 54)
font_equation     = load_font("JetBrainsMono-Bold.ttf", 36)
font_label        = load_font("JetBrainsMono-Regular.ttf", 17)
font_label_bold   = load_font("JetBrainsMono-Bold.ttf", 17)
font_small        = load_font("GeistMono-Regular.ttf", 13)
font_tiny         = load_font("GeistMono-Regular.ttf", 11)
font_tag          = load_font("GeistMono-Regular.ttf", 14)
font_meta         = load_font("DMMono-Regular.ttf", 15)
font_badge        = load_font("GeistMono-Bold.ttf", 13)
font_chinese      = load_font("Tektur-Medium.ttf", 48)

# Try to load a CJK font for Chinese characters
CJK_FONT_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
]

font_cjk_large = None
font_cjk_medium = None
font_cjk_small = None

for p in CJK_FONT_PATHS:
    if os.path.exists(p):
        font_cjk_large = ImageFont.truetype(p, 68)
        font_cjk_medium = ImageFont.truetype(p, 28)
        font_cjk_small = ImageFont.truetype(p, 22)
        break

if font_cjk_large is None:
    # Try to find any CJK font
    import subprocess
    try:
        result = subprocess.run(['fc-list', ':lang=zh', 'file'], capture_output=True, text=True)
        for line in result.stdout.strip().split('\n'):
            if line.strip():
                fp = line.split(':')[0].strip()
                if os.path.exists(fp):
                    font_cjk_large = ImageFont.truetype(fp, 68)
                    font_cjk_medium = ImageFont.truetype(fp, 28)
                    font_cjk_small = ImageFont.truetype(fp, 22)
                    break
    except:
        pass

# Fallback
if font_cjk_large is None:
    font_cjk_large = font_title_sub
    font_cjk_medium = font_label
    font_cjk_small = font_small

# === CREATE IMAGE ===
img = Image.new('RGBA', (W, H), BG + (255,))
draw = ImageDraw.Draw(img, 'RGBA')

# === BACKGROUND: Clean (no grid) ===

# === BACKGROUND: Radial vignette (darken edges) ===
vignette = Image.new('RGBA', (W, H), (0, 0, 0, 0))
vdraw = ImageDraw.Draw(vignette, 'RGBA')
cx, cy = W // 2, H // 2 - 60
for r in range(max(W, H), 0, -2):
    alpha = max(0, min(255, int(100 * (r / max(W, H)) ** 2.0)))
    vdraw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(220, 222, 230, alpha))
img = Image.alpha_composite(img, vignette)
draw = ImageDraw.Draw(img, 'RGBA')

# === CIRCUIT TRACES (sparse, precise) ===
traces = [
    # Horizontal traces
    ((0, 340), (350, 340)),
    ((420, 340), (580, 340)),
    ((0, 1860), (280, 1860)),
    ((1320, 1860), (1600, 1860)),
    # Vertical traces
    ((350, 340), (350, 480)),
    ((1400, 600), (1400, 820)),
    ((200, 1700), (200, 1860)),
]

for (x1, y1), (x2, y2) in traces:
    draw.line([(x1, y1), (x2, y2)], fill=alpha_color(CYAN, 50), width=1)

# Trace nodes (small circles at junctions)
trace_nodes = [(350, 340), (350, 480), (580, 340), (1400, 600), (1400, 820), (200, 1700), (280, 1860)]
for nx, ny in trace_nodes:
    draw.ellipse([nx-4, ny-4, nx+4, ny+4], outline=alpha_color(CYAN, 70), width=1)
    draw.ellipse([nx-2, ny-2, nx+2, ny+2], fill=alpha_color(CYAN, 50))

# === CENTRAL HARNESS VISUALIZATION ===
center_x, center_y = W // 2, H // 2 - 40

# Concentric rings (orbital layers)
rings = [
    (420, CYAN, 30, False, "EXTENSION"),
    (360, ORANGE, 40, True, "SECURITY"),
    (300, CYAN, 50, False, "TOOL"),
    (240, ORANGE, 35, True, ""),
]

for radius, color, alpha, dashed, label in rings:
    if dashed:
        # Draw dashed circle
        segments = 72
        for i in range(segments):
            if i % 2 == 0:
                a1 = (2 * math.pi * i) / segments
                a2 = (2 * math.pi * (i + 1)) / segments
                x1 = center_x + radius * math.cos(a1)
                y1 = center_y + radius * math.sin(a1)
                x2 = center_x + radius * math.cos(a2)
                y2 = center_y + radius * math.sin(a2)
                draw.line([(x1, y1), (x2, y2)], fill=alpha_color(color, alpha), width=1)
    else:
        draw.ellipse(
            [center_x - radius, center_y - radius, center_x + radius, center_y + radius],
            outline=alpha_color(color, alpha), width=1
        )

    # Ring label (top)
    if label:
        bbox = draw.textbbox((0, 0), label, font=font_tiny)
        tw = bbox[2] - bbox[0]
        draw.text(
            (center_x - tw // 2, center_y - radius - 18),
            label, fill=alpha_color(color, 120), font=font_tiny
        )

# === CONNECTOR NODES (8 positions around the rings) ===
connectors = [
    (0,    "TOOLS",        CYAN),
    (45,   "PERMISSIONS",  ORANGE),
    (90,   "MEMORY",       CYAN),
    (135,  "MULTI-AGENT",  ORANGE),
    (180,  "MCP / SKILLS", CYAN),
    (225,  "CONTEXT",      ORANGE),
    (270,  "PROMPT",       CYAN),
    (315,  "HOOKS",        ORANGE),
]

node_radius = 370
for angle_deg, label, color in connectors:
    angle = math.radians(angle_deg - 90)  # Start from top
    nx = center_x + node_radius * math.cos(angle)
    ny = center_y + node_radius * math.sin(angle)

    # Node dot
    draw.ellipse([nx-6, ny-6, nx+6, ny+6], outline=alpha_color(color, 180), width=2)
    draw.ellipse([nx-3, ny-3, nx+3, ny+3], fill=alpha_color(color, 220))

    # Thin line from ring to node
    inner_r = 240
    ix = center_x + inner_r * math.cos(angle)
    iy = center_y + inner_r * math.sin(angle)
    draw.line([(ix, iy), (nx, ny)], fill=alpha_color(color, 18), width=1)

    # Label
    bbox = draw.textbbox((0, 0), label, font=font_label)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    # Position label outside the node
    lx = nx + 18 * math.cos(angle)
    ly = ny + 18 * math.sin(angle)

    # Adjust anchor based on position
    if angle_deg in [0]:
        lx = nx - tw // 2
        ly = ny - th - 14
    elif angle_deg in [180]:
        lx = nx - tw // 2
        ly = ny + 14
    elif angle_deg < 180:
        lx = nx + 14
        ly = ny - th // 2
    else:
        lx = nx - tw - 14
        ly = ny - th // 2

    draw.text((lx, ly), label, fill=alpha_color(color, 220), font=font_label)

# === CENTRAL CORE (LLM) ===
core_r = 120

# Very faint glow halo
for gr in range(160, core_r, -5):
    alpha = max(0, int(3 * (1 - (gr - core_r) / (160 - core_r))))
    draw.ellipse(
        [center_x - gr, center_y - gr, center_x + gr, center_y + gr],
        outline=alpha_color(CYAN, alpha), width=1
    )

# Core circle - thin, precise
draw.ellipse(
    [center_x - core_r, center_y - core_r, center_x + core_r, center_y + core_r],
    outline=alpha_color(CYAN, 180), width=2
)

# Inner concentric rings (precision, not mass)
for ir, a in [(110, 40), (90, 30), (65, 22), (40, 16)]:
    draw.ellipse(
        [center_x - ir, center_y - ir, center_x + ir, center_y + ir],
        outline=alpha_color(CYAN, a), width=1
    )

# Cross-hair in center
ch = 20
draw.line([(center_x - ch, center_y), (center_x + ch, center_y)], fill=alpha_color(CYAN, 30), width=1)
draw.line([(center_x, center_y - ch), (center_x, center_y + ch)], fill=alpha_color(CYAN, 30), width=1)

# Small dot at exact center
draw.ellipse([center_x-3, center_y-3, center_x+3, center_y+3], fill=alpha_color(CYAN, 50))

# "LLM" text in center
llm_text = "LLM"
bbox = draw.textbbox((0, 0), llm_text, font=font_equation)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
draw.text(
    (center_x - tw // 2, center_y - th // 2 - 10),
    llm_text, fill=alpha_color(CYAN, 200), font=font_equation
)

# "reasoning core" subtitle
sub = "reasoning core"
bbox = draw.textbbox((0, 0), sub, font=font_small)
tw = bbox[2] - bbox[0]
draw.text(
    (center_x - tw // 2, center_y + 22),
    sub, fill=alpha_color(MUTED, 160), font=font_small
)

# === TOP SECTION ===

# Badge
badge_text = "TECHNICAL DEEP DIVE"
badge_x, badge_y = 100, 100
bbox = draw.textbbox((0, 0), badge_text, font=font_badge)
bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
pad_x, pad_y = 18, 10
draw.rectangle(
    [badge_x, badge_y, badge_x + bw + pad_x * 2, badge_y + bh + pad_y * 2],
    outline=alpha_color(ORANGE, 80), width=1
)
draw.text(
    (badge_x + pad_x, badge_y + pad_y),
    badge_text, fill=alpha_color(ORANGE, 180), font=font_badge
)

# Title "OPENBOOK"
title_y = 180
draw.text((96, title_y), "OPENBOOK", fill=alpha_color(TEXT, 240), font=font_title_large)

# Chinese subtitle
cn_y = title_y + 160
cn_line1 = "构建 AI Agent 的"
cn_line2 = "Harness 工程学"

draw.text((100, cn_y), cn_line1, fill=alpha_color(TEXT, 200), font=font_cjk_large)

# "Harness" in cyan, rest in white
harness_text = "Harness"
rest_text = " 工程学"

# Draw Harness in accent color
bbox_h = draw.textbbox((0, 0), harness_text, font=font_cjk_large)
hw = bbox_h[2] - bbox_h[0]
draw.text((100, cn_y + 80), harness_text, fill=alpha_color(CYAN, 240), font=font_cjk_large)

# Draw rest
draw.text((100 + hw, cn_y + 80), rest_text, fill=alpha_color(TEXT, 200), font=font_cjk_large)

# Underline beneath "Harness"
draw.rectangle([100, cn_y + 80 + 72, 100 + hw, cn_y + 80 + 75], fill=alpha_color(CYAN, 60))

# === EQUATION BAR ===
eq_y = H - 520

# Subtle background bar
draw.line([(0, eq_y), (W, eq_y)], fill=alpha_color(CYAN, 15), width=1)
draw.line([(0, eq_y + 70), (W, eq_y + 70)], fill=alpha_color(CYAN, 15), width=1)

# AGENT = LLM + HARNESS
eq_parts = [
    ("AGENT", CYAN, False),
    ("=", MUTED, False),
    ("LLM", MUTED, False),
    ("+", MUTED, False),
    ("HARNESS", ORANGE, True),
]

eq_total_w = 0
eq_widths = []
for text, _, _ in eq_parts:
    bbox = draw.textbbox((0, 0), text, font=font_equation)
    w = bbox[2] - bbox[0]
    eq_widths.append(w)
    eq_total_w += w

gap = 32
eq_total_w += gap * (len(eq_parts) - 1)
eq_start_x = (W - eq_total_w) // 2

pad = 12
for i, (text, color, highlight) in enumerate(eq_parts):
    bbox = draw.textbbox((0, 0), text, font=font_equation)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    tx = eq_start_x
    ty = eq_y + 16

    if text in ["=", "+"]:
        draw.text((tx, ty), text, fill=alpha_color(color, 220), font=font_equation)
    else:
        # Box around text
        box_color = color
        box_alpha = 140 if not highlight else 180
        draw.rectangle(
            [tx - pad, ty - pad//2, tx + tw + pad, ty + th + pad],
            outline=alpha_color(box_color, box_alpha), width=2
        )
        if highlight:
            draw.rectangle(
                [tx - pad + 1, ty - pad//2 + 1, tx + tw + pad - 1, ty + th + pad - 1],
                fill=alpha_color(ORANGE, 20)
            )
        draw.text((tx, ty), text, fill=(*color, 255), font=font_equation)

    eq_start_x += tw + gap

# === BOTTOM SECTION ===

# Subtitle text
sub_y = H - 400
sub_line1 = "LLM 提供推理能力"
sub_line2 = "Harness 提供工具、权限、记忆、编排"
sub_line3 = "这本书讲的就是 Harness 怎么造"

if font_cjk_medium:
    draw.text((100, sub_y), sub_line1, fill=(*TEXT, 255), font=font_cjk_medium)

    # "Harness" in orange
    draw.text((100, sub_y + 44), "Harness", fill=(*ORANGE, 255), font=font_meta)
    bbox = draw.textbbox((0, 0), "Harness", font=font_meta)
    hw2 = bbox[2] - bbox[0]
    draw.text((100 + hw2, sub_y + 44), " 提供工具、权限、记忆、编排", fill=(*TEXT, 220), font=font_cjk_small)

    draw.text((100, sub_y + 86), sub_line3, fill=(*MUTED, 255), font=font_cjk_small)

# Divider
div_y = H - 280
draw.line([(100, div_y), (W - 100, div_y)], fill=alpha_color(MUTED, 60), width=1)

# Tags
tags = ["AGENT LOOP", "TOOL SYSTEM", "PERMISSIONS", "MULTI-AGENT", "MCP", "DREAM", "MEMORY"]
tag_x = 100
tag_y = div_y + 24

for tag in tags:
    bbox = draw.textbbox((0, 0), tag, font=font_tag)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    pad_tx, pad_ty = 12, 7
    draw.rectangle(
        [tag_x, tag_y, tag_x + tw + pad_tx * 2, tag_y + th + pad_ty * 2],
        outline=alpha_color(CYAN, 120), width=1
    )
    draw.text((tag_x + pad_tx, tag_y + pad_ty), tag, fill=(*CYAN, 255), font=font_tag)

    tag_x += tw + pad_tx * 2 + 12
    if tag_x > W - 200:
        tag_x = 100
        tag_y += th + pad_ty * 2 + 10

# Meta info (bottom right)
meta_y = div_y + 30
meta_lines = [
    "22 chapters + 4 appendices",
    "8 parts · Harness Architecture",
]
for i, line in enumerate(meta_lines):
    bbox = draw.textbbox((0, 0), line, font=font_meta)
    tw = bbox[2] - bbox[0]
    draw.text((W - 100 - tw, meta_y + i * 28), line, fill=(*MUTED, 255), font=font_meta)

# === CORNER MARKS ===
corner_size = 36
corner_alpha = 30
corners = [
    (44, 44, 44 + corner_size, 44, 44, 44 + corner_size),          # TL
    (W - 44, 44, W - 44 - corner_size, 44, W - 44, 44 + corner_size),  # TR
    (44, H - 44, 44 + corner_size, H - 44, 44, H - 44 - corner_size),  # BL
    (W - 44, H - 44, W - 44 - corner_size, H - 44, W - 44, H - 44 - corner_size),  # BR
]

for x, y, x2, y2, x3, y3 in corners:
    draw.line([(x2, y2), (x, y), (x3, y3)], fill=alpha_color(CYAN, corner_alpha), width=2)

# === SIDE TEXT (vertical) ===
# We'll skip vertical text as PIL doesn't handle rotation of text well in RGBA
# Instead add small horizontal markers on the sides

# === (side text removed for clean layout) ===

# === (scanlines removed for clean light theme) ===

# === SAVE ===
final = img.convert('RGB')
output_path = "/home/ubuntu/workspace/openbook/cover.png"
final.save(output_path, "PNG", quality=95)
print(f"Cover saved to {output_path}")
print(f"Size: {final.size}")
