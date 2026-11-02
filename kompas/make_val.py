# Генерация чертежа "Сечения" (вариант 3) в DXF для открытия в КОМПАС-3D
import math, ezdxf
from shapely.geometry import Point, box, Polygon
from shapely.ops import unary_union

doc = ezdxf.new("R2010", units=4)  # мм
doc.header["$LWDISPLAY"] = 1
doc.linetypes.add("HIDDEN_GOST", pattern=[5.5, 4.0, -1.5], description="Штриховая __ __ __")
doc.linetypes.add("CENTER_GOST", pattern=[18.0, 15.0, -1.5, 0.0, -1.5], description="Штрихпунктирная ___ . ___")
doc.styles.add("GOST", font="isocpeur.ttf")
L = doc.layers
L.add("Основная", color=7, lineweight=50)
L.add("Тонкая", color=7, lineweight=25)
L.add("Невидимая", color=7, lineweight=25, linetype="HIDDEN_GOST")
L.add("Осевая", color=7, lineweight=25, linetype="CENTER_GOST")
L.add("Штриховка", color=8, lineweight=18)
L.add("Обозначения", color=7, lineweight=25)
msp = doc.modelspace()

def line(a, b, layer="Основная"): msp.add_line(a, b, dxfattribs={"layer": layer})
def pline(pts, layer="Основная"): msp.add_lwpolyline(pts, dxfattribs={"layer": layer})
def arc(c, r, a1, a2, layer="Основная"): msp.add_arc(c, r, a1, a2, dxfattribs={"layer": layer})
def circle(c, r, layer="Основная"): msp.add_circle(c, r, dxfattribs={"layer": layer})
def text(s, p, h=5, align="MIDDLE_CENTER"):
    t = msp.add_text(s, height=h, dxfattribs={"layer": "Обозначения", "style": "GOST"})
    t.set_placement(p, align=ezdxf.enums.TextEntityAlignment[align])
def hatch(geom, ox, oy):
    h = msp.add_hatch(dxfattribs={"layer": "Штриховка"})
    h.set_pattern_fill("ANSI31", scale=0.8)
    polys = geom.geoms if hasattr(geom, "geoms") else [geom]
    for p in polys:
        h.paths.add_polyline_path([(x+ox, y+oy) for x, y in p.exterior.coords[:-1]], is_closed=True, flags=1)
        for i in p.interiors:
            h.paths.add_polyline_path([(x+ox, y+oy) for x, y in i.coords[:-1]], is_closed=True, flags=0)
def C(r): return Point(0, 0).buffer(r, 256)
def deg(x, y): return math.degrees(math.atan2(y, x))

# ---------------- ГЛАВНЫЙ ВИД (ось вала y=0) ----------------
# Размеры (мм) оценены по фото: Ø40x45, Ø50x58 (лыска 19 от оси), Ø36x47, фаска 5x45°
top = [(0, 20), (45, 20), (45, 25), (53, 25), (53, 19), (95, 19), (95, 25), (103, 25), (103, 18), (118, 18)]
pline(top)
pline([(134, 18), (145, 18), (150, 13), (150, -13), (145, -18), (103, -18), (103, -25), (45, -25), (45, -20), (0, -20), (0, 20)])
line((145, 18), (145, 6)); line((145, -6), (145, -18))          # линия фаски
# Линия пересечения конического углубления с цилиндром (видимая)
pts = []
for i in range(41):
    y = 16.7047 + (18 - 16.7047) * (i / 40) ** 2
    z = math.sqrt(max(324 - y*y, 0)); dx = math.sqrt(max((y-10)**2 - z*z, 0))
    pts.append((126 - dx, y))
pts = pts[::-1] + [(126 + x0 - 126 if False else 252 - x, y) for x, y in pts[1:]]
msp.add_spline(pts, dxfattribs={"layer": "Основная"})
# Коническое углубление 90° Ø16 (невидимые)
pline([(118, 18), (126, 10), (134, 18)], "Невидимая")
line((126, 6), (126, 24), "Осевая")
# Шпоночный паз 12, глуб. 5 (на передней стороне)
arc((115, 0), 6, 90, 270)
line((115, 6), (150, 6)); line((115, -6), (150, -6))
# Глухое осевое отверстие Ø14, глуб. 34, конус 120°
pline([(0, 7), (34, 7), (38.04, 0), (34, -7), (0, -7)], "Невидимая")
line((34, 7), (34, -7), "Невидимая")
# Поперечное отверстие Ø10 снизу в осевое
line((11, -19.365), (11, -4.9), "Невидимая"); line((21, -19.365), (21, -4.9), "Невидимая")
line((16, -24), (16, 2), "Осевая")
# Два перекрёстных отверстия Ø10 в средней части
for x in (64, 84):
    circle((x, 0), 5)
    line((x-5, 19), (x-5, -24.5), "Невидимая"); line((x+5, 19), (x+5, -24.5), "Невидимая")
    line((x, 23), (x, -29), "Осевая")
line((-5, 0), (155, 0), "Осевая")
# Выноска "Глуб. h5"
line((136, -3), (156, -14), "Тонкая"); line((156, -14), (176, -14), "Тонкая")
circle((136, -3), 0.5, "Тонкая")
text("Глуб. 5", (157, -13), 3.5, "BOTTOM_LEFT")

# ---------------- Линии сечений ----------------
def cut(x, r, letter):
    for s in (1, -1):
        y1, y2 = s*(r+2), s*(r+12)
        msp.add_line((x, y1), (x, y2), dxfattribs={"layer": "Основная", "lineweight": 70})
        ya = y2 - s*1.5
        line((x, ya), (x+9, ya), "Тонкая")
        msp.add_solid([(x+9, ya+1), (x+9, ya-1), (x+13, ya)], dxfattribs={"layer": "Тонкая"})
        text(letter, (x+8, ya + s*4.5), 5)
cut(16, 20, "А"); cut(64, 25, "Б"); cut(126, 18, "В")

# ---------------- ВЫНЕСЕННЫЕ СЕЧЕНИЯ ----------------
SY = -85
def axes(cx, cy, r):
    line((cx-r-4, cy), (cx+r+4, cy), "Осевая"); line((cx, cy-r-4), (cx, cy+r+4), "Осевая")

# А-А: Ø40, осевое Ø14, поперечное Ø10 снизу
cx = 20
g = C(20).difference(C(7)).difference(box(-5, -21, 5, -4))
hatch(g, cx, SY)
arc((cx, SY), 20, deg(5, -19.365), deg(-5, -19.365) + 360)
arc((cx, SY), 7, deg(5, -4.899), deg(-5, -4.899) + 360)
line((cx+5, SY-19.365), (cx+5, SY-4.899)); line((cx-5, SY-19.365), (cx-5, SY-4.899))
axes(cx, SY, 20); text("А-А", (cx, SY+32), 5)

# Б-Б: Ø50 с лыской 19 от оси, перекрёстные отверстия Ø10
cx = 82
g = C(25).intersection(box(-30, -30, 30, 19)).difference(box(-30, -5, 30, 5)).difference(box(-5, -30, 5, 30))
hatch(g, cx, SY)
a = 24.495; f = 16.248
for s in (1, -1):
    # верхние четверти
    arc((cx, SY), 25, *sorted([deg(s*a, 5), deg(s*f, 19)]))
    pline([(cx+s*f, SY+19), (cx+s*5, SY+19), (cx+s*5, SY+5), (cx+s*a, SY+5)])
    # нижние четверти
    a1, a2 = deg(s*a, -5) % 360, deg(s*5, -a) % 360
    arc((cx, SY), 25, min(a1, a2), max(a1, a2))
    pline([(cx+s*a, SY-5), (cx+s*5, SY-5), (cx+s*5, SY-a)])
axes(cx, SY, 25); text("Б-Б", (cx, SY+32), 5)

# В-В: Ø36, коническое углубление сверху, шпоночный паз 12x5 справа
cx = 145
k = 6.705; zs = math.sqrt(324-36)
g = C(18).difference(Polygon([(0, 10), (20, 30), (-20, 30)])).difference(box(13, -6, 20, 6))
hatch(g, cx, SY)
arc((cx, SY), 18, deg(zs, 6), deg(k, 10+k))
arc((cx, SY), 18, deg(-k, 10+k), deg(zs, -6) + 360)
pline([(cx+k, SY+10+k), (cx, SY+10), (cx-k, SY+10+k)])
pline([(cx+zs, SY+6), (cx+13, SY+6), (cx+13, SY-6), (cx+zs, SY-6)])
axes(cx, SY, 18); line((cx, SY+10), (cx, SY+24), "Осевая")
text("В-В", (cx, SY+32), 5)

out = "/home/user/Test/kompas/secheniya_var3.dxf"
doc.saveas(out); print("saved", out)

from ezdxf.addons.drawing import matplotlib as dm
dm.qsave(msp, "/home/user/Test/kompas/secheniya_var3_preview.png", bg="#FFFFFF", dpi=200)
