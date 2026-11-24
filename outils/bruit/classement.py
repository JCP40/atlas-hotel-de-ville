"""Classement sonore des infrastructures de transports terrestres (Loire-Atlantique, révision 2020) -> data/classement-sonore.geojson.

Usage : python3 -I classement.py <data/config.json> <sortie classement-sonore.geojson> <archive routes .zip> [archive fer .zip] [rayon_m]

Sources (DDTM de Loire-Atlantique, arrêtés préfectoraux de 2020, Licence Ouverte 2.0, data.gouv.fr) :
  - « Classement sonore des infrastructures routières révisé en 2020 en Loire-Atlantique » : archive Atom
    https://atom.geo-ide.developpement-durable.gouv.fr/atomArchive/GetResource?id=e6cb14ce-3d1f-4832-840a-31adc2ad4893&dataType=dataset
    (shapefile N_CLASS_SONORE_RTE_L_044, polylignes Lambert-93) ;
  - « Classement sonore du réseau ferré révisé en 2020 en Loire-Atlantique » : même adresse, id=cfb6480a-679f-429f-8365-63ddf19c7669
    (N_CLASS_SONORE_FER_L_044).
  Le service WFS de Géo-IDE (ms:N_CLASS_SONORE_RTE_L_044) donne les attributs mais pas la géométrie (« Cannot write geometry »,
  essai du 20/11/2026) : seules les archives donnent les tracés.
Traitement (sans dépendance ; lecture .shp / .dbf et projection de cbs.py) :
  - tronçons gardés s'ils approchent le cercle de rayon R + marge autour de config.origine
    (R = max(800 m, config.rayonEtude), marge = plus grande largeur de secteur affecté rencontrée, 300 m au plus) ;
    chaque polyligne est coupée exactement au cercle de rayon R + marge (segments recoupés analytiquement) ;
  - sommets alignés retirés (écart < 0,1 m) ; Lambert-93 -> WGS84 (IGN), 6 décimales.
Propriétés normalisées : categorie (1-5), largeur_m (secteur affecté de part et d'autre, depuis le bord de la chaussée),
  largeur_chaussee_m (routes : champ largeurCha), nom, troncon, debut, fin, commune, gestionnaire, vitesse_vl, vitesse_pl,
  tmja, tissu, ancienne_categorie, source (routes|voies ferrées), annee (2020), producteur (DDTM 44), id.
"""
import json, math, os, re, sys, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cbs import vers_l93, depuis_l93  # noqa: E402

COUCHE = re.compile(r'N_CLASS_SONORE_(RTE|FER)_L_\d{3}\.(shp|dbf|cpg)$', re.I)


def lire_dbf(d, encodage):
    import struct
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
            r[nom] = rec[off:off + L].decode(encodage, errors='replace').strip()
            off += L
        lignes.append(r)
    return lignes


def lire_shp(d):
    """polylignes (types 3, 13, 23) : liste de (bbox, [parties]) ; partie = [(x, y), ...]"""
    import struct
    pos, res = 100, []
    while pos + 8 <= len(d):
        lg = struct.unpack('>i', d[pos + 4:pos + 8])[0] * 2
        b = d[pos + 8: pos + 8 + lg]
        pos += 8 + lg
        t = struct.unpack('<i', b[:4])[0]
        if t not in (3, 13, 23):
            res.append((None, []))
            continue
        bbox = struct.unpack('<4d', b[4:36])
        np_, npt = struct.unpack('<2i', b[36:44])
        parts = list(struct.unpack(f'<{np_}i', b[44:44 + 4 * np_])) + [npt]
        o = 44 + 4 * np_
        xy = struct.unpack(f'<{2 * npt}d', b[o:o + 16 * npt])
        res.append((bbox, [[(xy[2 * k], xy[2 * k + 1]) for k in range(parts[i], parts[i + 1])] for i in range(np_)]))
    return res


def couches(archives):
    res = {}
    for a in archives:
        with zipfile.ZipFile(a) as z:
            for nom in z.namelist():
                m = COUCHE.search(nom.replace('\\', '/').split('/')[-1])
                if m:
                    res.setdefault(m.group(1).upper(), {})[m.group(2).lower()] = z.read(nom)
    return res


def couper(ligne, X0, Y0, R):
    """polyligne [(x, y)] -> morceaux à l'intérieur du cercle (centre X0, Y0, rayon R)"""
    dedans = lambda p: (p[0] - X0) ** 2 + (p[1] - Y0) ** 2 <= R * R
    morceaux, cour = [], []
    for i in range(len(ligne) - 1):
        P, Q = ligne[i], ligne[i + 1]
        dx, dy = Q[0] - P[0], Q[1] - P[1]
        fx, fy = P[0] - X0, P[1] - Y0
        a = dx * dx + dy * dy
        if a < 1e-12:
            continue
        b = 2 * (fx * dx + fy * dy)
        c = fx * fx + fy * fy - R * R
        disc = b * b - 4 * a * c
        if disc <= 0:
            if cour:
                morceaux.append(cour); cour = []
            continue
        s = math.sqrt(disc)
        t0, t1 = max(0.0, (-b - s) / (2 * a)), min(1.0, (-b + s) / (2 * a))
        if t0 >= t1:
            if cour:
                morceaux.append(cour); cour = []
            continue
        A = (P[0] + dx * t0, P[1] + dy * t0)
        B = (P[0] + dx * t1, P[1] + dy * t1)
        if not cour:
            cour = [A]
        cour.append(B)
        if t1 < 1.0:
            morceaux.append(cour); cour = []
    if cour:
        morceaux.append(cour)
    return [m for m in morceaux if len(m) >= 2]


def alignes(l, tol=0.1):
    if len(l) <= 2:
        return l
    res = [l[0]]
    for i in range(1, len(l) - 1):
        p0, p1, p2 = res[-1], l[i], l[i + 1]
        L = math.hypot(p2[0] - p0[0], p2[1] - p0[1])
        d = abs((p2[0] - p0[0]) * (p1[1] - p0[1]) - (p2[1] - p0[1]) * (p1[0] - p0[0])) / L if L > 1e-9 else 0
        if d >= tol:
            res.append(p1)
    res.append(l[-1])
    return res


def entier(v):
    try:
        return int(float(str(v).replace(',', '.')))
    except (TypeError, ValueError):
        return None


def main():
    chemin_config, sortie = sys.argv[1:3]
    archives = [a for a in sys.argv[3:] if a.lower().endswith('.zip')]
    autres = [a for a in sys.argv[3:] if not a.lower().endswith('.zip')]
    with open(chemin_config, encoding='utf-8') as f:
        config = json.load(f)
    o = config['origine']
    rayon = float(autres[0]) if autres else max(800.0, float(config.get('rayonEtude', 0)))
    X0, Y0 = vers_l93(o['lat'], o['lon'])
    C = couches(archives)
    # 1er passage : marge = plus grande largeur des tronçons qui approchent le cercle de R + 300 m
    lus = []
    for typ, fic in C.items():
        enc = (fic.get('cpg') or b'latin-1').decode('ascii', 'ignore').strip() or 'latin-1'
        enc = 'utf-8' if enc.upper().replace('-', '') == 'UTF8' else enc
        for attr, (bbox, parties) in zip(lire_dbf(fic['dbf'], enc), lire_shp(fic['shp'])):
            if not bbox or bbox[2] < X0 - rayon - 300 or bbox[0] > X0 + rayon + 300 or bbox[3] < Y0 - rayon - 300 or bbox[1] > Y0 + rayon + 300:
                continue
            lus.append((typ, attr, parties))
    marge = 0
    for typ, attr, parties in lus:
        if any(couper(p, X0, Y0, rayon) for p in parties):
            marge = max(marge, entier(attr.get('LARGEUR')) or 0)
    Rc = rayon + marge
    features, compte = [], {}
    for typ, attr, parties in lus:
        morceaux = [alignes(m) for p in parties for m in couper(p, X0, Y0, Rc)]
        if not morceaux:
            continue
        cat = entier(attr.get('CATEGORIE'))
        if cat not in (1, 2, 3, 4, 5):
            continue
        route = typ == 'RTE'
        coords = [[[round(v, 6) for v in depuis_l93(*pt)] for pt in m] for m in morceaux]
        lc = entier(attr.get('largeurCha')) if route else None
        props = {
            'categorie': cat,
            'largeur_m': entier(attr.get('LARGEUR')),
            'largeur_chaussee_m': lc if lc and lc > 0 else None,
            'nom': (attr.get('NOMROUTE') or '').strip() or None,
            'troncon': attr.get('NOMTRONCON') or None,
            'debut': attr.get('DEBUTANT') or None,
            'fin': attr.get('FINISSANT') or None,
            'commune': attr.get('Commune') or None,
            'gestionnaire': attr.get('Gestion') or None,
            'vitesse_vl': entier(attr.get('Vit_VL')),
            'vitesse_pl': entier(attr.get('Vit_PL')),
            'tmja': entier(attr.get('tmjaTV')),
            'tissu': attr.get('TISSU') or None,
            'ancienne_categorie': entier(attr.get('Anc_Cat')),
            'source': 'routes' if route else 'voies ferrées',
            'annee': 2020,
            'producteur': 'DDTM 44',
            'id': attr.get('ID') or None,
        }
        features.append({'type': 'Feature', 'properties': props,
                         'geometry': {'type': 'MultiLineString', 'coordinates': coords} if len(coords) > 1 else {'type': 'LineString', 'coordinates': coords[0]}})
        compte[(typ, cat)] = compte.get((typ, cat), 0) + 1
    features.sort(key=lambda f: (f['properties']['source'] != 'routes', f['properties']['categorie'], f['properties']['nom'] or ''))
    fc = {
        'type': 'FeatureCollection',
        'source': ("Classement sonore des infrastructures de transports terrestres de Loire-Atlantique, révision 2020 (arrêtés préfectoraux, "
                   "DDTM 44) : « Classement sonore des infrastructures routières révisé en 2020 » et « du réseau ferré révisé en 2020 », "
                   "Licence Ouverte 2.0 (data.gouv.fr, archives Atom Géo-IDE)"),
        'traitement': (f"outils/bruit/classement.py : tronçons coupés au cercle de {Rc:.0f} m (rayon {rayon:.0f} m + plus grande largeur "
                       f"de secteur {marge} m) autour de config.origine ({o['lat']}, {o['lon']}), sommets alignés retirés (< 0,1 m), "
                       "Lambert-93 -> WGS84, 6 décimales"),
        'origine': {'lat': o['lat'], 'lon': o['lon']},
        'rayon_m': rayon, 'marge_m': marge,
        'features': features,
    }
    txt = json.dumps(fc, ensure_ascii=False, separators=(',', ':'))
    with open(sortie, 'w', encoding='utf-8') as f:
        f.write(txt)
    for k in sorted(compte):
        print(k[0], 'catégorie', k[1], ':', compte[k])
    print(len(features), 'tronçons,', len(txt.encode('utf-8')), 'octets ; marge', marge, 'm')


if __name__ == '__main__':
    main()
