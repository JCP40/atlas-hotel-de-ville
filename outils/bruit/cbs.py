"""Cartes de bruit stratégiques de l'État (CBS 2022, Loire-Atlantique) -> data/bruit.geojson.

Usage : python3 -I cbs.py <archive .zip ou dossier décompressé> <data/config.json> <sortie bruit.geojson> [rayon_m]

Source : « Cartes de bruit stratégiques des réseaux routiers et ferroviaires non concédés » (directive 2002/49/CE),
4e échéance 2022, département 044, DDTM de Loire-Atlantique / Cerema, Licence Ouverte 2.0 :
https://static.data.gouv.fr/resources/cartes-de-bruit-strategiques-des-reseaux-routiers-et-ferroviaires-non-concedes-directive-europeenne-2002-49-ce/20250409-133602/cbs2022-departement-044.zip

Huit couches lues (shapefiles Lambert-93, polygones) : N_BRUIT_ZBR_INFRA_<R|F>_<A|C>_<LD|LN>_S_044
  R = routes, F = voies ferrées ; A = zones exposées par classes de 5 dB(A) (LEGENDE = borne basse),
  C = secteurs où les valeurs limites sont dépassées (LEGENDE = valeur limite : routes 68 / 62, fer 73 / 65) ;
  LD = Lden, LN = Ln (nuit).
Traitement (sans dépendance : lecture .shp / .dbf, projection, découpe faites ici) :
  - découpe au polygone régulier de 128 côtés circonscrit au cercle de rayon R autour de config.origine
    (R = max(800 m, config.rayonEtude), découpe de Sutherland-Hodgman anneau par anneau, région convexe) ;
  - simplification légère : sommets alignés retirés (écart < 0,15 m), aucun déplacement de sommet ;
  - Lambert-93 -> WGS84 (formules de l'IGN, GRS80 ; RGF93 = WGS84 au mètre près, comme js/donnees.js) ;
  - coordonnées arrondies à 6 décimales (≈ 0,1 m).
Propriétés : indicateur (Lden|Ln), db_lo, source (routes|voies ferrées), type (A|C), annee, producteur, id.
"""
import io, json, math, os, re, struct, sys, zipfile

COUCHE = re.compile(r'N_BRUIT_ZBR_INFRA_([RF])_([AC])_(LD|LN)_S_\d{3}\.(shp|dbf)$', re.I)

# ---------- Lambert-93 (IGN, ALG0001 / ALG0004) ----------
E = 0.0818191910428158
N = 0.7256077650532670
C = 11754255.426096
XS, YS = 700000.0, 12655612.049876
L0 = math.radians(3.0)


def vers_l93(lat, lon):
    p = math.radians(lat)
    L = math.log(math.tan(math.pi / 4 + p / 2) * ((1 - E * math.sin(p)) / (1 + E * math.sin(p))) ** (E / 2))
    R = C * math.exp(-N * L)
    g = N * (math.radians(lon) - L0)
    return XS + R * math.sin(g), YS - R * math.cos(g)


def depuis_l93(X, Y):
    dx, dy = X - XS, Y - YS
    R = math.hypot(dx, dy)
    g = math.atan2(dx, -dy)
    L = -math.log(abs(R / C)) / N
    phi = 2 * math.atan(math.exp(L)) - math.pi / 2
    for _ in range(12):
        phi = 2 * math.atan(((1 + E * math.sin(phi)) / (1 - E * math.sin(phi))) ** (E / 2) * math.exp(L)) - math.pi / 2
    return math.degrees(L0 + g / N), math.degrees(phi)


# ---------- lecture des fichiers ----------
def fichiers(entree):
    """{ (src, type, indic): {'shp': bytes, 'dbf': bytes} }"""
    res = {}
    if os.path.isdir(entree):
        for racine, _, noms in os.walk(entree):
            for nom in noms:
                m = COUCHE.search(nom)
                if m:
                    with open(os.path.join(racine, nom), 'rb') as f:
                        res.setdefault(m.group(1, 2, 3), {})[m.group(4).lower()] = f.read()
    else:
        with zipfile.ZipFile(entree) as z:
            for nom in z.namelist():
                m = COUCHE.search(nom.replace('\\', '/').split('/')[-1])
                if m:
                    res.setdefault(m.group(1, 2, 3), {})[m.group(4).lower()] = z.read(nom)
    return res


def lire_dbf(d):
    n, hl, rl = struct.unpack('<IHH', d[4:12])
    champs, o = [], 32
    while d[o] != 0x0d:
        champs.append((d[o:o + 11].split(b'\0')[0].decode('ascii'), d[o + 16]))
        o += 32
    lignes = []
    for i in range(n):
        rec = d[hl + i * rl + 1: hl + (i + 1) * rl]
        off, r = 0, {}
        for nom, L in champs:
            r[nom] = rec[off:off + L].decode('latin-1').strip()
            off += L
        lignes.append(r)
    return lignes


def lire_shp(d):
    """liste de (bbox, [anneaux]) ; anneau = [(x, y), ...]"""
    pos, res = 100, []
    while pos < len(d):
        lg = struct.unpack('>i', d[pos + 4:pos + 8])[0] * 2
        b = d[pos + 8: pos + 8 + lg]
        pos += 8 + lg
        t = struct.unpack('<i', b[:4])[0]
        if t not in (5, 15, 25):
            res.append((None, []))
            continue
        bbox = struct.unpack('<4d', b[4:36])
        np_, npt = struct.unpack('<2i', b[36:44])
        parts = list(struct.unpack(f'<{np_}i', b[44:44 + 4 * np_])) + [npt]
        o = 44 + 4 * np_
        xy = struct.unpack(f'<{2 * npt}d', b[o:o + 16 * npt])
        anneaux = [[(xy[2 * k], xy[2 * k + 1]) for k in range(parts[i], parts[i + 1])] for i in range(np_)]
        res.append((bbox, anneaux))
    return res


# ---------- géométrie ----------
def aire(a):
    s = 0.0
    for i in range(len(a)):
        x1, y1 = a[i]
        x2, y2 = a[(i + 1) % len(a)]
        s += x1 * y2 - x2 * y1
    return s / 2


def dans(p, a):
    x, y = p
    c = False
    j = len(a) - 1
    for i in range(len(a)):
        xi, yi = a[i]
        xj, yj = a[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def decouper(anneau, fenetre):
    """Sutherland-Hodgman : anneau (ouvert) découpé par une fenêtre convexe (sens trigonométrique)."""
    sortie = anneau
    for i in range(len(fenetre)):
        if not sortie:
            break
        ax, ay = fenetre[i]
        bx, by = fenetre[(i + 1) % len(fenetre)]
        cote = lambda p: (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax)
        entree, sortie = sortie, []
        for k in range(len(entree)):
            P, Q = entree[k], entree[(k + 1) % len(entree)]
            cp, cq = cote(P), cote(Q)
            if cp >= 0:
                sortie.append(P)
            if (cp >= 0) != (cq >= 0):
                t = cp / (cp - cq)
                sortie.append((P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t))
    return sortie


def alignes(a, tol=0.15):
    """retire les sommets alignés (distance à la corde de leurs voisins < tol) et les doublons"""
    pts = [p for i, p in enumerate(a) if i == 0 or (abs(p[0] - a[i - 1][0]) > 1e-6 or abs(p[1] - a[i - 1][1]) > 1e-6)]
    if len(pts) > 1 and abs(pts[0][0] - pts[-1][0]) < 1e-6 and abs(pts[0][1] - pts[-1][1]) < 1e-6:
        pts.pop()
    # un passage : un sommet est retiré s'il est aligné avec le dernier sommet gardé et le suivant
    for _ in range(2):
        if len(pts) <= 3:
            break
        res = [pts[0]]
        n = len(pts)
        for i in range(1, n):
            p0, p1, p2 = res[-1], pts[i], pts[(i + 1) % n]
            L = math.hypot(p2[0] - p0[0], p2[1] - p0[1])
            d = abs((p2[0] - p0[0]) * (p1[1] - p0[1]) - (p2[1] - p0[1]) * (p1[0] - p0[0])) / L if L > 1e-9 else 0
            if d >= tol:
                res.append(p1)
        pts = res[1:] + res[:1]  # le premier sommet est réexaminé au second passage
    return pts


def grouper(anneaux):
    """anneaux d'un enregistrement shapefile -> polygones [ext, trous...] (extérieurs en sens horaire dans le .shp)"""
    ext = [a for a in anneaux if aire(a) < 0]
    trous = [a for a in anneaux if aire(a) > 0]
    if not ext:  # sens non conforme : le plus grand est l'extérieur
        ext, trous = [max(anneaux, key=lambda a: abs(aire(a)))], [a for a in anneaux if a is not max(anneaux, key=lambda a: abs(aire(a)))]
    polys = [[e] for e in ext]
    for t in trous:
        for p in polys:
            if dans(t[0], p[0]):
                p.append(t)
                break
    return polys


def main():
    entree, chemin_config, sortie = sys.argv[1:4]
    with open(chemin_config, encoding='utf-8') as f:
        config = json.load(f)
    o = config['origine']
    rayon = float(sys.argv[4]) if len(sys.argv) > 4 else max(800.0, float(config.get('rayonEtude', 0)))
    X0, Y0 = vers_l93(o['lat'], o['lon'])
    nf = 128
    Rf = rayon / math.cos(math.pi / nf)  # polygone circonscrit au cercle
    fenetre = [(X0 + Rf * math.cos(2 * math.pi * i / nf), Y0 + Rf * math.sin(2 * math.pi * i / nf)) for i in range(nf)]

    couches = fichiers(entree)
    if len(couches) != 8:
        print(f'attention : {len(couches)} couches trouvées sur 8', file=sys.stderr)
    features, compte = [], {}
    ordre = sorted(couches, key=lambda k: (k[1], k[0] != 'R', k[2]))
    for cle in ordre:
        src, typ, ind = cle
        shp, dbf = couches[cle].get('shp'), couches[cle].get('dbf')
        if not shp or not dbf:
            continue
        lignes = lire_dbf(dbf)
        geoms = lire_shp(shp)
        for attr, (bbox, anneaux) in zip(lignes, geoms):
            if not bbox or bbox[2] < X0 - rayon or bbox[0] > X0 + rayon or bbox[3] < Y0 - rayon or bbox[1] > Y0 + rayon:
                continue
            polys = []
            for p in grouper(anneaux):
                res = []
                for k, a in enumerate(p):
                    a = a[:-1] if a[0] == a[-1] else a
                    a = alignes(decouper(a, fenetre))
                    if len(a) < 3 or abs(aire(a)) < 0.5:
                        if k == 0:
                            break
                        continue
                    # GeoJSON (RFC 7946) : extérieur trigonométrique, trous horaires
                    if (k == 0) != (aire(a) > 0):
                        a = a[::-1]
                    res.append(a)
                if res:
                    polys.append(res)
            if not polys:
                continue
            niveau = int(attr['LEGENDE']) if attr.get('LEGENDE', '').isdigit() else None
            if niveau is None:
                continue
            coords = [[[[round(v, 6) for v in depuis_l93(*pt)] for pt in a + [a[0]]] for a in p] for p in polys]
            features.append({
                'type': 'Feature',
                'properties': {
                    'indicateur': 'Lden' if ind == 'LD' else 'Ln',
                    'db_lo': niveau,
                    'source': 'routes' if src == 'R' else 'voies ferrées',
                    'type': typ,
                    'annee': int(attr['ANNEE']) if attr.get('ANNEE', '').isdigit() else None,
                    'producteur': 'DDTM 44',
                    'id': attr.get('IDZONBRUIT') or None,
                },
                'geometry': {'type': 'MultiPolygon', 'coordinates': coords},
            })
            compte[cle] = compte.get(cle, 0) + 1
    fc = {
        'type': 'FeatureCollection',
        'source': ("Cartes de bruit stratégiques de l'État en Loire-Atlantique (DDTM 44), 4e échéance 2022 : réseaux routiers "
                   "et ferroviaires non concédés, zones de type A (classes de 5 dB(A)) et C (dépassement des valeurs limites), "
                   "Lden et Ln ; Licence Ouverte 2.0 (data.gouv.fr, cbs2022-departement-044.zip)"),
        'traitement': (f"outils/bruit/cbs.py : découpe à {rayon:.0f} m autour de config.origine ({o['lat']}, {o['lon']}), "
                       "sommets alignés retirés (< 0,15 m), Lambert-93 -> WGS84, 6 décimales"),
        'origine': {'lat': o['lat'], 'lon': o['lon']},
        'rayon_m': rayon,
        'features': features,
    }
    txt = json.dumps(fc, ensure_ascii=False, separators=(',', ':'))
    with open(sortie, 'w', encoding='utf-8') as f:
        f.write(txt)
    for k in ordre:
        print('-'.join(k), compte.get(k, 0))
    print(len(features), 'entités,', len(txt.encode('utf-8')), 'octets')


if __name__ == '__main__':
    main()
