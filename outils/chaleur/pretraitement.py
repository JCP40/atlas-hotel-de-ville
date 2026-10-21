"""Outil Chaleur (onglet Ambiance) : préparation hors ligne des matériaux de toiture et de la grille de l'orthophoto.

Usage (données téléchargées = non fiables : les ranger dans un dossier à part, lancer avec python3 -I) :
  python3 -I pretraitement.py bdtopo.json ortho.jpg "sud,ouest,nord,est" batiments.geojson voirie.geojson surfaces.geojson dossier_sortie

- bdtopo.json : WFS BDTOPO_V3:batiment (Géoplateforme IGN, EPSG:4326, champ materiaux_de_la_toiture) ;
- ortho.jpg   : WMS ORTHOIMAGERY.ORTHOPHOTOS (BD ORTHO IGN) sur l'emprise sud,ouest,nord,est (CRS EPSG:4326) ;
- batiments / voirie / surfaces : data/osm/*.geojson de l'atlas (préparés par preparer.html).
Écrit dans dossier_sortie : toitures.json (classe de toiture par bâtiment OSM et BD TOPO) et ortho.json
(grille de 4 m, codée par plages : v végétal, c minéral clair, . autre), puis affiche la vérification
des matériaux OSM du sol sur l'orthophoto (à reporter dans materiaux.json > verification).
"""
import sys, json, math, re, collections
from PIL import Image, ImageDraw

bd_f, ortho_f, bbox_s, bat_f, voi_f, surf_f, sortie = sys.argv[1:8]
S, W, N, E = map(float, bbox_s.split(','))
im = Image.open(ortho_f).convert('RGB')
WI, HI = im.size
px = im.load()
LAT0 = (S + N) / 2
MX = 111320 * math.cos(math.radians(LAT0))  # m par degré de longitude
MY = 111320

def pix(lon, lat):
    return (lon - W) / (E - W) * WI, (N - lat) / (N - S) * HI

def masque(anneaux):
    """pixels intérieurs d'un polygone (liste d'anneaux [lon, lat]) : liste de (r, g, b)"""
    pts = [[pix(*c[:2]) for c in a] for a in anneaux]
    xs = [p[0] for p in pts[0]]; ys = [p[1] for p in pts[0]]
    x0, y0 = max(0, int(min(xs))), max(0, int(min(ys)))
    x1, y1 = min(WI - 1, int(max(xs)) + 1), min(HI - 1, int(max(ys)) + 1)
    if x1 <= x0 or y1 <= y0:
        return []
    m = Image.new('L', (x1 - x0 + 1, y1 - y0 + 1), 0)
    d = ImageDraw.Draw(m)
    for k, a in enumerate(pts):
        if len(a) >= 3:
            d.polygon([(x - x0, y - y0) for x, y in a], fill=0 if k else 255)
    mp = m.load()
    return [px[x0 + i, y0 + j] for j in range(m.size[1]) for i in range(m.size[0]) if mp[i, j]]

def ecrire(chemin, d, cle):
    """JSON compact, une entrée de d[cle] par ligne (lisible, comparaisons faciles)"""
    tete = json.dumps({k: v for k, v in d.items() if k != cle}, ensure_ascii=False, separators=(',', ':'))[:-1]
    corps = ',\n'.join(json.dumps(x, ensure_ascii=False, separators=(',', ':')) for x in d[cle])
    with open(chemin, 'w', encoding='utf-8') as fh:
        fh.write(f'{tete},"{cle}":[\n{corps}\n]}}\n')

def lum(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

def classe_pixel(c):
    r, g, b = c
    L = lum(c)
    exg = 2 * g - r - b
    if exg > 18 and g > r:
        return 'v'
    if L < 62:
        return 'v' if exg > 10 else 'o'
    if L > 165:
        return 'c'
    if L > 115:
        return 'm'
    return 'f'

# ------------------------------------------------------------------
# 1. Toitures : BD TOPO (codes MAJIC), OSM roof:material, contrôle de couleur sur l'orthophoto
# ------------------------------------------------------------------
CODES = {'1': 'tuile', '2': 'ardoise', '3': 'zinc', '4': 'terrasse'}

def classe_ortho_toit(pixels):
    """couleur moyenne des pixels éclairés du toit -> classe probable"""
    ok = [p for p in pixels if lum(p) > 70]
    if len(ok) < 12:
        return None, None
    r = sum(p[0] for p in ok) / len(ok); g = sum(p[1] for p in ok) / len(ok); b = sum(p[2] for p in ok) / len(ok)
    L = lum((r, g, b))
    if r - b > 28 and r > g + 6:
        c = 'tuile'
    elif L < 128:
        c = 'ardoise'
    elif L < 175:
        c = 'zinc'
    else:
        c = 'terrasse'
    return c, [round(r), round(g), round(b)]

def anneaux_de(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates']]
    if geom['type'] == 'MultiPolygon':
        return geom['coordinates']
    return []

def centre(anneau):
    xs = [c[0] for c in anneau]; ys = [c[1] for c in anneau]
    return sum(ys) / len(ys), sum(xs) / len(xs)

def dans(lat, lon, anneau):
    x, y, ins = lon, lat, False
    j = len(anneau) - 1
    for i in range(len(anneau)):
        xi, yi = anneau[i][:2]; xj, yj = anneau[j][:2]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            ins = not ins
        j = i
    return ins

bd = json.load(open(bd_f, encoding='utf-8'))
bdl = []
for f in bd['features']:
    p = f.get('properties') or {}
    for poly in anneaux_de(f['geometry']):
        lat, lon = centre(poly[0])
        code = str(p.get('materiaux_de_la_toiture') or '')
        bdl.append({'id': p.get('cleabs') or f.get('id'), 'lat': lat, 'lon': lon, 'code': code, 'anneau': poly[0], 'poly': poly})
        break

OSM_MAT = {'slate': 'ardoise', 'zinc': 'zinc', 'metal': 'zinc', 'tile': 'tuile', 'roof_tiles': 'tuile', 'glass': 'verriere',
           'gravel': 'terrasse', 'concrete': 'terrasse', 'asphalt': 'terrasse', 'tar_paper': 'terrasse', 'eternit': 'zinc'}
sortie_toits, stats = [], collections.Counter()
osm = json.load(open(bat_f, encoding='utf-8'))
deja_bd = set()
for f in osm['features']:
    p = f.get('properties') or {}
    polys = anneaux_de(f['geometry'])
    if not polys:
        continue
    lat, lon = centre(polys[0][0])
    if not (S < lat < N and W < lon < E):
        continue
    pixels = [q for poly in polys for q in masque(poly)]
    c_ortho, rgb = classe_ortho_toit(pixels)
    tag = OSM_MAT.get(str(p.get('roof:material') or '').lower())
    # BD TOPO : bâtiment dont le centre tombe dans l'emprise OSM (ou l'inverse)
    b = next((b for b in bdl if dans(b['lat'], b['lon'], polys[0][0])), None) or next((b for b in bdl if dans(lat, lon, b['anneau'])), None)
    code = b['code'] if b else ''
    if b:
        deja_bd.add(b['id'])
    c_bd = CODES.get(code[:1]) if code and code[:1] in CODES else None
    if tag:
        cl, src = tag, 'OSM roof:material'
    elif c_bd and (c_ortho is None or c_bd == c_ortho or (c_bd == 'ardoise' and c_ortho == 'zinc') or (c_bd == 'zinc' and c_ortho in ('ardoise', 'terrasse'))):
        cl, src = c_bd, 'BD TOPO'
    elif c_bd and c_ortho:
        cl, src = c_ortho, f'orthophoto (BD TOPO : {c_bd}, démenti)'
    elif p.get('roof:shape') == 'flat' and c_ortho != 'tuile':
        cl, src = 'terrasse', 'OSM roof:shape=flat'
    elif c_ortho:
        cl, src = c_ortho, 'orthophoto'
    else:
        cl, src = 'ardoise', 'défaut (ardoise, majoritaire dans le secteur)'
    stats[src.split(' (')[0]] += 1
    stats['classe:' + cl] += 1
    e = {'osm': p.get('osm'), 'lat': round(lat, 7), 'lon': round(lon, 7), 'classe': cl, 'source': src}
    if b:
        e['ign'] = b['id']; e['bdtopo'] = code or None
    if rgb:
        e['ortho'] = rgb
    sortie_toits.append(e)
# bâtiments BD TOPO sans équivalent OSM (atlas lancé sur le bâti BD TOPO)
for b in bdl:
    if b['id'] in deja_bd or not (S < b['lat'] < N and W < b['lon'] < E):
        continue
    c_ortho, rgb = classe_ortho_toit(masque(b['poly']))
    c_bd = CODES.get(b['code'][:1]) if b['code'] else None
    cl = c_bd or c_ortho or 'ardoise'
    sortie_toits.append({'ign': b['id'], 'lat': round(b['lat'], 7), 'lon': round(b['lon'], 7), 'classe': cl,
                         'source': 'BD TOPO' if c_bd else 'orthophoto' if c_ortho else 'défaut', 'bdtopo': b['code'] or None, **({'ortho': rgb} if rgb else {})})

# format compact, bâtiments à moins de RAYON m du centre de l'atlas : [clé osm ou ign, classe, source, code BD TOPO, (lat, lon si BD TOPO seule)]
LAT_C, LON_C, RAYON = 47.218385, -1.55452, 320
SRC = {'OSM roof:material': 'o', 'BD TOPO': 'b', 'orthophoto': 'p', 'OSM roof:shape=flat': 'f'}
compact = []
for e in sortie_toits:
    if math.hypot((e['lon'] - LON_C) * MX, (e['lat'] - LAT_C) * MY) > RAYON:
        continue
    c = 'd' if 'démenti' in e['source'] else SRC.get(e['source'].split(' (')[0], 'x')
    ligne = [e.get('osm') or e.get('ign'), e['classe'], c, e.get('bdtopo') or '']
    if not e.get('osm'):
        ligne += [round(e['lat'], 5), round(e['lon'], 5)]  # bâtiment BD TOPO sans équivalent OSM : centre pour le retrouver
    compact.append(ligne)
ecrire(f'{sortie}/toitures.json', {
    'description': 'Matériau de toiture par bâtiment (outil Chaleur). Priorité : OSM roof:material, BD TOPO materiaux_de_la_toiture '
                   '(codes MAJIC, 1er chiffre : 1 tuiles, 2 ardoises, 3 zinc/aluminium, 4 béton) si la couleur du toit sur l\'orthophoto ne le dément pas, '
                   'sinon couleur moyenne du toit sur l\'orthophoto, sinon ardoise. Produit par outils/chaleur/pretraitement.py.',
    'def': 't = [[clé osm (way/…) ou cleabs BD TOPO, classe (materiaux.json), source, code BD TOPO, puis lat, lon du centre pour un bâtiment BD TOPO sans équivalent OSM]] ; source : o OSM roof:material, b BD TOPO, d orthophoto (BD TOPO démentie), p orthophoto, f OSM roof:shape=flat, x défaut',
    'sources': 'BD TOPO V3 et BD ORTHO (IGN, Géoplateforme, Licence Ouverte 2.0), OpenStreetMap (ODbL)',
    'date': '2026-10-16', 't': compact,
}, 't')
print('toitures', len(sortie_toits), dict(stats))

# ------------------------------------------------------------------
# 2. Grille de l'orthophoto (4 m) autour du centre
# ------------------------------------------------------------------
PAS, DEMI = 4.0, 300  # grille de 4 m sur ±300 m autour du centre de l'atlas
dLat, dLon = DEMI / MY, DEMI / MX
s0, w0, n0, e0 = LAT_C - dLat, LON_C - dLon, LAT_C + dLat, LON_C + dLon
nx = ny = int(2 * DEMI / PAS)
lignes, total = [], collections.Counter()
for j in range(ny):
    row = []
    for i in range(nx):
        lat_a, lat_b = n0 - j * (n0 - s0) / ny, n0 - (j + 1) * (n0 - s0) / ny
        lon_a, lon_b = w0 + i * (e0 - w0) / nx, w0 + (i + 1) * (e0 - w0) / nx
        xa, ya = pix(lon_a, lat_a); xb, yb = pix(lon_b, lat_b)
        cnt = collections.Counter(classe_pixel(px[x, y]) for y in range(int(ya), max(int(ya) + 1, int(yb))) for x in range(int(xa), max(int(xa) + 1, int(xb))))
        c = cnt.most_common(1)[0][0]
        row.append(c if c in 'vc' else '.')
    total.update(row)
    # codage par plages : « 12. » = 12 mailles « . »
    lignes.append(re.sub(r'(.)\1*', lambda m: (str(len(m.group(0))) if len(m.group(0)) > 1 else '') + m.group(1), ''.join(row)))
ecrire(f'{sortie}/ortho.json', {
    'description': 'Orthophoto IGN (BD ORTHO) résumée en grille de 4 m pour l\'outil Chaleur : v végétal (excès de vert), c sol minéral clair, '
                   '. autre (minéral moyen ou foncé, ombre portée). Lignes du nord au sud, colonnes d\'ouest en est, codées par plages (« 12. » = 12 mailles « . »).',
    'source': 'IGN, BD ORTHO (Géoplateforme, WMS ORTHOIMAGERY.ORTHOPHOTOS), Licence Ouverte 2.0', 'date': '2026-10-16',
    'emprise': {'sud': round(s0, 7), 'ouest': round(w0, 7), 'nord': round(n0, 7), 'est': round(e0, 7)}, 'nx': nx, 'ny': ny, 'lignes': lignes,
}, 'lignes')
print('ortho', nx, ny, total)

# ------------------------------------------------------------------
# 3. Vérification des revêtements OSM du sol sur l'orthophoto (pixels le long des voies)
# ------------------------------------------------------------------
def le_long(coords, pas_m=1.0):
    for a, b in zip(coords, coords[1:]):
        d = math.hypot((b[0] - a[0]) * MX, (b[1] - a[1]) * MY)
        n = max(1, int(d / pas_m))
        for k in range(n):
            t = k / n
            yield a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t

verif = collections.defaultdict(collections.Counter)
for f in json.load(open(voi_f, encoding='utf-8'))['features']:
    s = (f.get('properties') or {}).get('surface')
    if not s or f['geometry']['type'] != 'LineString':
        continue
    for lon, lat in le_long(f['geometry']['coordinates']):
        x, y = pix(lon, lat)
        if 0 <= x < WI and 0 <= y < HI:
            verif[s][classe_pixel(px[int(x), int(y)])] += 1
for f in json.load(open(surf_f, encoding='utf-8'))['features']:
    s = 'zone:' + str((f.get('properties') or {}).get('surface'))
    for poly in anneaux_de(f['geometry']):
        for q in masque(poly):
            verif[s][classe_pixel(q)] += 1
for s, c in sorted(verif.items(), key=lambda kv: -sum(kv[1].values())):
    n = sum(c.values())
    if n < 200:
        continue
    eclaires = n - c['o']
    print(f"{s:22s} n={n:6d} ombre {100*c['o']/n:4.0f} % | sur l'éclairé : végétal {100*c['v']/max(eclaires,1):3.0f} % clair {100*c['c']/max(eclaires,1):3.0f} % moyen {100*c['m']/max(eclaires,1):3.0f} % foncé {100*c['f']/max(eclaires,1):3.0f} %")
