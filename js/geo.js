// Géographie de l'atlas.
// À l'échelle d'un quartier (moins d'un kilomètre), la courbure terrestre est négligeable :
// on travaille dans un repère plan local, en mètres, centré sur l'origine choisie (la mairie).
// x = vers l'est, z = vers le sud, y = vers le haut (convention Three.js).

const R = 6378137; // rayon terrestre (m), celui de la projection Web Mercator
const RAD = Math.PI / 180;

export function creerProjection(lat0, lon0) {
  const cos0 = Math.cos(lat0 * RAD);
  return {
    lat0, lon0,
    versLocal(lat, lon) {
      return { x: (lon - lon0) * RAD * R * cos0, z: -(lat - lat0) * RAD * R };
    },
    versGeo(x, z) {
      return { lat: lat0 - z / (RAD * R), lon: lon0 + x / (RAD * R * cos0) };
    },
    // [lon, lat] GeoJSON -> [x, z]
    pt(coord) {
      const p = this.versLocal(coord[1], coord[0]);
      return [p.x, p.z];
    },
  };
}

export function empriseAutour(lat0, lon0, rayon) {
  const dLat = rayon / (RAD * R);
  const dLon = rayon / (RAD * R * Math.cos(lat0 * RAD));
  return { sud: lat0 - dLat, ouest: lon0 - dLon, nord: lat0 + dLat, est: lon0 + dLon };
}

// ---------- polygones ----------

export function aireSignee(anneau) {
  let a = 0;
  for (let i = 0, n = anneau.length; i < n; i++) {
    const [x1, y1] = anneau[i];
    const [x2, y2] = anneau[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function centroide(anneau) {
  let sx = 0, sz = 0;
  const n = anneau.length;
  for (const [x, z] of anneau) { sx += x; sz += z; }
  return [sx / n, sz / n];
}

export function pointDansPolygone(x, z, anneau) {
  let dedans = false;
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const [xi, zi] = anneau[i];
    const [xj, zj] = anneau[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) dedans = !dedans;
  }
  return dedans;
}

// Retire le point de fermeture en double et les points confondus.
export function nettoyerAnneau(anneau) {
  const res = [];
  for (const p of anneau) {
    const d = res[res.length - 1];
    if (!d || Math.hypot(p[0] - d[0], p[1] - d[1]) > 0.01) res.push(p);
  }
  if (res.length > 1) {
    const a = res[0], b = res[res.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01) res.pop();
  }
  return res;
}

// Liste de polygones [ [anneauExt, trou1, ...], ... ] en coordonnées locales depuis une géométrie GeoJSON.
export function polygonesLocaux(geometrie, proj) {
  if (!geometrie) return [];
  const conv = (anneau) => nettoyerAnneau(anneau.map((c) => proj.pt(c)));
  if (geometrie.type === 'Polygon') return [geometrie.coordinates.map(conv)];
  if (geometrie.type === 'MultiPolygon') return geometrie.coordinates.map((p) => p.map(conv));
  return [];
}

export function lignesLocales(geometrie, proj) {
  if (!geometrie) return [];
  const conv = (l) => l.map((c) => proj.pt(c));
  if (geometrie.type === 'LineString') return [conv(geometrie.coordinates)];
  if (geometrie.type === 'MultiLineString') return geometrie.coordinates.map(conv);
  return [];
}

// ---------- calage affine à partir de 3 couples de points ----------
// src : [[x,y]x3] (pixels de l'image), dst : [[X,Z]x3] (mètres locaux)
// Renvoie {a,b,c,d,e,f} tel que X = a*x + b*y + c ; Z = d*x + e*y + f
export function affineDepuis3Points(src, dst) {
  const M = src.map(([x, y]) => [x, y, 1]);
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M);
  if (Math.abs(D) < 1e-9) throw new Error('Les trois points de l\'image sont alignés : choisissez des points plus écartés.');
  const resoudre = (v) => {
    const col = (k) => M.map((ligne, i) => ligne.map((val, j) => (j === k ? v[i] : val)));
    return [det3(col(0)) / D, det3(col(1)) / D, det3(col(2)) / D];
  };
  const [a, b, c] = resoudre(dst.map((p) => p[0]));
  const [d, e, f] = resoudre(dst.map((p) => p[1]));
  return { a, b, c, d, e, f };
}

export function appliquerAffine(t, x, y) {
  return [t.a * x + t.b * y + t.c, t.d * x + t.e * y + t.f];
}

// ---------- divers ----------

export function longueurLigne(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

export function distance2D(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Date/heure légale de Paris -> Date UTC (règle européenne de l'heure d'été).
export function dateParis(annee, mois, jour, heureDecimale) {
  const dernierDimanche = (m) => {
    const d = new Date(Date.UTC(annee, m + 1, 0));
    return d.getUTCDate() - d.getUTCDay();
  };
  const debutEte = Date.UTC(annee, 2, dernierDimanche(2), 1);
  const finEte = Date.UTC(annee, 9, dernierDimanche(9), 1);
  const h = Math.floor(heureDecimale);
  const mn = Math.round((heureDecimale - h) * 60);
  const approx = Date.UTC(annee, mois, jour, h - 1, mn);
  const decalage = approx >= debutEte && approx < finEte ? 2 : 1;
  return new Date(Date.UTC(annee, mois, jour, h - decalage, mn));
}

export function formaterHeure(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh} h ${String(mm).padStart(2, '0')}`;
}
