import * as THREE from 'three';
import { h, info, estNonPublie, NON_PUBLIE } from './util.js';
import { chargerJSON } from './donnees.js';
import { centroide, pointDansPolygone } from './geo.js';

// Toitures détaillées par ensembles : Hôtel de Ville (data/toits/hotel-de-ville.json), îlot Saint-Vincent
// (data/toits/ilot-saint-vincent.json), îlot rue de la Commune – rue Saint-Vincent (ilot-commune-saint-vincent), îlot rue Fanny Peccot – rue Saint-Vincent (ilot-fanny-peccot), parcelles EO 26 (hotel-de-charette : une photo, façade sur cour), EO 195, EO 49 et 162 (moulin-23-27, fenelon-flechier : sans photo)… Liste ENSEMBLES (ou config.json > toits.ensembles) ; chaque ensemble a
// son fichier de toits data/toits/<id>.json et, facultatifs, ses photos data/facades/<id>.json + data/facades/<id>/*.jpg.
// Le premier (hotel-de-ville) reste « la mairie » : remarquable « mairie » de config.json, centre(), fiche « mairie » ;
// les autres déclarent leur « remarquable » ({ id, fiche, nom }) dans leur fichier de toits.
// - Chaque « corps » du fichier (emprise en mètres dans le repère de l'atlas, type de toit, faîtage,
//   hauteurs d'égout et de faîtage, matériaux) devient des murs extrudés jusqu'à l'égout et des pans
//   de toit réels, avec couleurs par sommet (tuffeau, ardoise, zinc…) et lignes d'étages.
//   Depuis le 13/10/2026 : « emprise » = emprise réelle (bâtiment OSM découpé), « gabarit » = quadrilatère
//   relevé qui porte le toit ; voir geometrieDecoupee. Coordonnées relatives à « origine » (recaler).
// - construireBatiments (maquette.js) appelle assigner() : un corps va au bâtiment (OSM ou BD TOPO)
//   situé dans le périmètre de la mairie qui contient son centre. Ce bâtiment garde son emprise et sa
//   clé (démolition, coupes, soleil, vent, export DXF utilisent l'emprise et la hauteur maximale).
// - Représentation à 4 choix (onglet Bâtiments > Bâti) : simple, détaillé, détaillé avec photos (défaut au démarrage), détaillé blanc.

const ENSEMBLES = ['hotel-de-ville', 'ilot-saint-vincent', 'ilot-commune-saint-vincent', 'ilot-fanny-peccot', 'hotel-de-charette', 'moulin-23-27', 'fenelon-flechier'];
const dossierFacades = (id) => `data/facades/${id}/`;

// Palette sobre, accordée au blanc de la maquette
export const TEINTES = {
  tuffeau: 0xe6dcc4,
  pierre: 0xdcd6c8,
  enduit: 0xebe6da,
  ardoise: 0x88919b,
  zinc: 0xb8bfc3,
  terrasse: 0xbdbab2,
  verriere: 0xa8c3cb,
  tuile: 0xc99a7c,
};

const LIBELLES_TOIT = {
  'deux-pans': 'deux pans',
  croupe: 'deux pans à croupe',
  pavillon: 'pavillon (quatre pans, faîtage court)',
  mansarde: 'comble brisé (mansarde)',
  terrasse: 'toit-terrasse',
  verriere: 'pans autour d\'une verrière centrale',
  tour: 'tourelle, toit conique',
  'comble-brise': 'comble brisé sur tout le pourtour (brisis, terrasson)',
};

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

export function creerToits(app) {
  // ensembles chargés : [{ id, donnees, facades }] ; donnees / facades = ceux de la mairie (hotel-de-ville)
  let ensembles = [];
  let donnees = null;
  let facades = null;
  const ensembleDe = new Map(); // corps -> ensemble
  const ensembleFacade = new Map(); // façade -> ensemble
  const ui = {};
  const etat = {
    // au démarrage : toujours « détaillé avec photos » (le choix n'est plus gardé d'une visite à l'autre)
    mode: 'detaille', photos: true, blanc: false,
  };
  // représentation à 4 choix : simple | detaille | photos (détaillé avec photos) | blanc (maquette blanche détaillée)
  const representation = () => (etat.mode === 'simple' ? 'simple' : etat.blanc ? 'blanc' : etat.photos ? 'photos' : 'detaille');

  async function charger() {
    const ids = app.config?.toits?.ensembles || ENSEMBLES;
    const lus = await Promise.all(ids.map(async (id) => {
      const [d, f] = await Promise.all([chargerJSON(`data/toits/${id}.json`, null), chargerJSON(`data/facades/${id}.json`, null)]);
      return { id, donnees: d, facades: f };
    }));
    ensembles = [];
    for (const e of lus) {
      if (!e.donnees?.corps?.length) continue;
      recaler(e.donnees);
      if (e.facades?.facades?.length) recalerFacades(e.facades); else e.facades = null;
      for (const c of e.donnees.corps) ensembleDe.set(c, e);
      for (const f of e.facades?.facades || []) ensembleFacade.set(f, e);
      ensembles.push(e);
    }
    const mairie = ensembles.find((e) => e.id === 'hotel-de-ville');
    donnees = mairie?.donnees || null;
    facades = mairie?.facades || null;
    return donnees;
  }
  const toutesFacades = () => ensembles.flatMap((e) => e.facades?.facades || []);
  const tousCorps = () => ensembles.flatMap((e) => e.donnees.corps);
  // fiche d'un ensemble : « mairie » pour l'Hôtel de Ville, sinon remarquable.fiche de son fichier de toits
  const ficheDe = (e) => (e.id === 'hotel-de-ville' ? 'mairie' : e.donnees.remarquable?.fiche || e.id);

  // même recalage que les toitures : segments des façades en mètres relatifs à facades.origine
  function recalerFacades(d) {
    const o = d.origine, c = app.config.origine;
    if (!o || (o.lat === c.lat && o.lon === c.lon)) return;
    const { x: dx, z: dz } = app.proj.versLocal(o.lat, o.lon);
    for (const f of d.facades) { f.gauche = [f.gauche[0] + dx, f.gauche[1] + dz]; f.droite = [f.droite[0] + dx, f.droite[1] + dz]; }
    d.origine = { lat: c.lat, lon: c.lon };
  }

  // Coordonnées du fichier en mètres locaux, relatives à donnees.origine : si le centre de l'atlas
  // diffère (config.origine changée, centre choisi dans ce navigateur), on translate tout le fichier
  // (même principe que la grille d'altitudes de js/topo.js).
  function recaler(d) {
    const o = d.origine, c = app.config.origine;
    if (!o || (o.lat === c.lat && o.lon === c.lon)) return;
    const { x: dx, z: dz } = app.proj.versLocal(o.lat, o.lon);
    const t = ([x, z]) => [x + dx, z + dz];
    if (d.perimetre?.polygone) d.perimetre.polygone = d.perimetre.polygone.map(t);
    for (const cour of d.cours || []) if (cour.polygone) cour.polygone = cour.polygone.map(t);
    for (const corps of d.corps || []) {
      if (corps.emprise) corps.emprise = corps.emprise.map(t);
      if (corps.gabarit) corps.gabarit = corps.gabarit.map(t);
      if (corps.trous) corps.trous = corps.trous.map((r) => r.map(t));
      if (corps.toit?.faitage) corps.toit.faitage = corps.toit.faitage.map(t);
      if (corps.toit?.centre) corps.toit.centre = t(corps.toit.centre);
    }
    d.origine = { lat: c.lat, lon: c.lon };
  }

  // Centre de la mairie (centroïde surfacique du périmètre, parcelle EY 64), en mètres locaux ; null sans données
  function centre() {
    const p = donnees?.perimetre?.polygone;
    if (!p || p.length < 3) return null;
    let a = 0, sx = 0, sz = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, z1] = p[i], [x2, z2] = p[(i + 1) % p.length];
      const k = x1 * z2 - x2 * z1;
      a += k; sx += (x1 + x2) * k; sz += (z1 + z2) * k;
    }
    return Math.abs(a) > 1e-6 ? [sx / (3 * a), sz / (3 * a)] : centroide(p);
  }

  // --------------------------------------------------------------
  // Affectation des corps aux bâtiments chargés
  // lots : [{ polys }] (polygones locaux de chaque bâtiment) ; renvoie Map(lot -> corps[])
  // --------------------------------------------------------------
  function assigner(lots) {
    const res = new Map();
    if (!ensembles.length || etat.mode !== 'detaille') return res;
    for (const e of ensembles) assignerEnsemble(e.donnees, lots, res);
    return res;
  }
  function assignerEnsemble(donnees, lots, res) {
    const perim = donnees.perimetre?.polygone;
    const candidats = lots.filter((l) => {
      if (!l.polys?.length || l.polys[0][0].length < 3) return false;
      const [cx, cz] = centroide(l.polys[0][0]);
      return !perim || pointDansPolygone(cx, cz, perim);
    });
    for (const c of donnees.corps) {
      const [x, z] = centreCorps(c);
      let lot = candidats.find((l) => l.polys.some(([ext]) => pointDansPolygone(x, z, ext)));
      if (!lot) {
        let best = 8;
        for (const l of candidats) {
          const [cx, cz] = centroide(l.polys[0][0]);
          const d = Math.hypot(cx - x, cz - z);
          if (d < best) { best = d; lot = l; }
        }
      }
      if (!lot) continue;
      if (!res.has(lot)) res.set(lot, []);
      res.get(lot).push(c);
    }
  }
  // remarquable d'un bâtiment détaillé hors mairie ({ id, fiche, nom, etiquette } du fichier de toits) ; null pour la mairie
  function remarquable(liste) {
    const e = ensembleDe.get(liste?.[0]);
    if (!e || e.id === 'hotel-de-ville') return null;
    const r = e.donnees.remarquable || {};
    return { etiquette: null, nom: e.donnees.titre, ...r, id: r.id || e.id, fiche: ficheDe(e) };
  }

  // point intérieur d'un corps (centre du plus grand triangle de l'emprise si son centroïde tombe dehors, emprise en L ou en U)
  const centreCorps = (c) => {
    if (!c.emprise) return c.toit.centre;
    const g = centroide(c.emprise);
    if (pointDansPolygone(g[0], g[1], c.emprise)) return g;
    let best = g, amax = 0;
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(c.emprise.map(([x, z]) => new THREE.Vector2(x, z)), [])) {
      const [a, b, d] = [c.emprise[i], c.emprise[j], c.emprise[k]];
      const s = Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1]));
      if (s > amax) { amax = s; best = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3]; }
    }
    return best;
  };
  const hauteurMax = (liste) => Math.max(...liste.map((c) => c.toit.h_faitage ?? c.toit.h_egout));

  // --------------------------------------------------------------
  // Géométrie
  // --------------------------------------------------------------
  // Accumulateur de triangles non indexés (position, normal, uv, color), au format des ExtrudeGeometry
  function tampon() {
    const pos = [], col = [];
    const pieces = []; // murs [{ p, q, hp, hq, out }] pour les photos de façade (facadesPhoto)
    const c = new THREE.Color();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
    // ref : direction « extérieure » attendue de la normale (le sens du triangle est corrigé d'après elle)
    function tri(p1, p2, p3, teinte, ref) {
      a.set(...p1); b.set(...p2); d.set(...p3);
      n.subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
      if (n.lengthSq() < 1e-8) return;
      if (n.dot(ref) < 0) [p2, p3] = [p3, p2];
      c.set(teinte);
      for (const p of [p1, p2, p3]) { pos.push(...p); col.push(c.r, c.g, c.b); }
    }
    function facette(pts, teinte, ref) {
      for (let i = 1; i < pts.length - 1; i++) tri(pts[0], pts[i], pts[i + 1], teinte, ref);
    }
    // mur vertical de p à q (points [x, z]), du sol aux hauteurs hp et hq ; out : normale extérieure
    function mur(p, q, hp, hq, teinte, out) {
      facette([P(p, 0), P(q, 0), P(q, hq), P(p, hp)], teinte, out);
      pieces.push({ p, q, hp, hq, out: [out.x, out.z] });
    }
    function geometrie() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals(); // non indexée : normales plates
      g.userData.murs = pieces;
      return g;
    }
    return { tri, facette, mur, geometrie };
  }

  const P = (xz, y) => [xz[0], y, xz[1]];
  const sortant = (pts, cx, cz) => {
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, mz = pts.reduce((s, p) => s + p[2], 0) / pts.length;
    const v = new THREE.Vector3(mx - cx, 0, mz - cz);
    return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3(0, 1, 0);
  };
  const HAUT = new THREE.Vector3(0, 1, 0);

  // Décalage d'un anneau quelconque (convexe ou non) de d mètres vers l'extérieur du bâti (sens = 1 contour, -1 trou), angles en onglet borné
  function decaler(anneau, d, sens = 1) {
    const s = Math.sign(aire2(anneau)) * sens, n = anneau.length;
    const nor = anneau.map((a, i) => { const b = anneau[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [((b[1] - a[1]) / l) * s, (-(b[0] - a[0]) / l) * s]; });
    return anneau.map((p, i) => {
      const n1 = nor[(i - 1 + n) % n], n2 = nor[i];
      let mx = n1[0] + n2[0], mz = n1[1] + n2[1];
      const l = Math.hypot(mx, mz);
      if (l < 1e-6) return [p[0] + n2[0] * d, p[1] + n2[1] * d];
      mx /= l; mz /= l;
      const k = Math.min(d / Math.max(mx * n2[0] + mz * n2[1], 0.25), 4 * d);
      return [p[0] + mx * k, p[1] + mz * k];
    });
  }

  // Retrait d'un polygone convexe vers l'intérieur
  function retrait(poly, d) {
    const [cx, cz] = centroide(poly);
    const n = poly.length;
    const lignes = poly.map((a, i) => {
      const b = poly[(i + 1) % n];
      let nx = -(b[1] - a[1]), nz = b[0] - a[0];
      const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if ((cx - mx) * nx + (cz - mz) * nz < 0) { nx = -nx; nz = -nz; }
      return { p: [a[0] + nx * d, a[1] + nz * d], v: [b[0] - a[0], b[1] - a[1]] };
    });
    return poly.map((_, i) => {
      const L1 = lignes[(i - 1 + n) % n], L2 = lignes[i];
      const det = L1.v[0] * L2.v[1] - L1.v[1] * L2.v[0];
      if (Math.abs(det) < 1e-9) return L2.p;
      const t = ((L2.p[0] - L1.p[0]) * L2.v[1] - (L2.p[1] - L1.p[1]) * L2.v[0]) / det;
      return [L1.p[0] + L1.v[0] * t, L1.p[1] + L1.v[1] * t];
    });
  }

  // Faîtage par défaut : milieux des deux côtés opposés les plus courts
  function faitageAuto(q) {
    const l = (i) => Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]);
    const m = (i) => [(q[i][0] + q[(i + 1) % 4][0]) / 2, (q[i][1] + q[(i + 1) % 4][1]) / 2];
    return l(0) + l(2) <= l(1) + l(3) ? [m(0), m(2)] : [m(1), m(3)];
  }

  // Pans d'un toit sur un quadrilatère : chaque sommet rejoint l'extrémité du faîtage la plus proche ;
  // un côté dont les deux sommets vont au même point donne une croupe (ou un pignon vertical si le point est sur le côté)
  function pans(t, q, y0, faitage, y1, teinte, teinteMur, cx, cz) {
    const [Pf, Qf] = faitage;
    const r = q.map((v) => (Math.hypot(v[0] - Pf[0], v[1] - Pf[1]) <= Math.hypot(v[0] - Qf[0], v[1] - Qf[1]) ? Pf : Qf));
    for (let i = 0; i < q.length; i++) {
      const j = (i + 1) % q.length;
      const pts = r[i] === r[j] ? [P(q[i], y0), P(q[j], y0), P(r[i], y1)] : [P(q[i], y0), P(q[j], y0), P(r[j], y1), P(r[i], y1)];
      const out = sortant(pts, cx, cz);
      // pignon vertical : teinte du mur
      const vertical = r[i] === r[j] && distanceAuSegment(r[i], q[i], q[j]) < 0.3;
      t.facette(pts, vertical ? teinteMur : teinte, vertical ? out : out.clone().multiplyScalar(0.5).add(HAUT));
    }
  }
  function distanceAuSegment(p, a, b) {
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / (vx * vx + vz * vz || 1)));
    return Math.hypot(a[0] + vx * u - p[0], a[1] + vz * u - p[1]);
  }

  function dessus(t, poly, y, teinte) {
    const tris = THREE.ShapeUtils.triangulateShape(poly.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const [a, b, c] of tris) t.tri(P(poly[a], y), P(poly[b], y), P(poly[c], y), teinte, HAUT);
  }

  function murs(t, poly, y0, y1, teinte, cx, cz) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const pts = [P(a, y0), P(b, y0), P(b, y1), P(a, y1)];
      if (y0 === 0) t.mur(a, b, y1, y1, teinte, sortant(pts, cx, cz));
      else t.facette(pts, teinte, sortant(pts, cx, cz));
    }
  }

  // --------------------------------------------------------------
  // Corps découpé dans l'emprise réelle (champ « gabarit ») : le toit est une fonction hauteur
  // y = H(x, z) définie par les plans du toit relevé sur le gabarit (quadrilatère), prolongés au-delà,
  // jamais sous l'égout ; murs et toit suivent l'emprise réelle (bâtiment OSM découpé), sans débord
  // ni recouvrement entre corps. H est un arbre min/max de fonctions affines (plans, constantes).
  // --------------------------------------------------------------
  const cst = (v, teinte) => ({ k: 'f', a: 0, b: 0, c: v, teinte });
  const MIN = (...f) => ({ k: 'min', f: f.flat() });
  const MAX = (...f) => ({ k: 'max', f: f.flat() });
  // plan y = a x + b z + c par trois points [x, y, z] ; null s'il est vertical
  function plan(p1, p2, p3, teinte) {
    const [x1, y1, z1] = p1, [x2, y2, z2] = p2, [x3, y3, z3] = p3;
    const det = (x2 - x1) * (z3 - z1) - (x3 - x1) * (z2 - z1);
    if (Math.abs(det) < 1e-6) return null;
    const a = ((y2 - y1) * (z3 - z1) - (y3 - y1) * (z2 - z1)) / det;
    const b = ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) / det;
    return { k: 'f', a, b, c: y1 - a * x1 - b * z1, teinte };
  }
  // plans des pans d'un quadrilatère (même règle que pans() : chaque sommet rejoint l'extrémité de faîtage la plus proche)
  function plansPans(q, y0, faitage, y1, teinte) {
    const [Pf, Qf] = faitage;
    const r = q.map((v) => (Math.hypot(v[0] - Pf[0], v[1] - Pf[1]) <= Math.hypot(v[0] - Qf[0], v[1] - Qf[1]) ? Pf : Qf));
    const res = [];
    for (let i = 0; i < q.length; i++) {
      const j = (i + 1) % q.length;
      if (r[i] === r[j] && distanceAuSegment(r[i], q[i], q[j]) < 0.3) continue; // pignon vertical
      const p = plan(P(q[i], y0), P(q[j], y0), P(r[j], y1), teinte);
      if (p) res.push(p);
    }
    return res;
  }
  function fonctionToit(c, couv) {
    const T = c.toit, q = c.gabarit, e = T.h_egout, f = T.h_faitage ?? T.h_egout;
    if (T.type === 'comble-brise' && q?.length >= 3 && f > e) return combleBrise(q, T, couv);
    if (T.type === 'terrasse' || !q || q.length !== 4 || f <= e) return cst(e, couv);
    if (T.type === 'mansarde') {
      const int = retrait(q, T.retrait ?? 2);
      const brisis = q.map((_, i) => plan(P(q[i], e), P(q[(i + 1) % 4], e), P(int[(i + 1) % 4], T.h_brisis), couv)).filter(Boolean);
      const terrasson = plansPans(int, T.h_brisis, T.faitage || faitageAuto(int), f, TEINTES[T.toit_terrasson] ?? TEINTES.zinc);
      return MAX(cst(e, couv), MIN(cst(f, couv), brisis, terrasson));
    }
    if (T.type === 'verriere') {
      const r1 = retrait(q, T.retrait_faitage ?? 3), r2 = retrait(q, T.retrait_verriere ?? 5);
      const ext = q.map((_, i) => plan(P(q[i], e), P(q[(i + 1) % 4], e), P(r1[(i + 1) % 4], f), couv)).filter(Boolean);
      const int = q.map((_, i) => plan(P(r1[i], f), P(r1[(i + 1) % 4], f), P(r2[(i + 1) % 4], T.h_verriere), couv)).filter(Boolean);
      return MAX(cst(e, couv), MIN(cst(f, couv), ext, MAX(cst(T.h_verriere, TEINTES.verriere), int)));
    }
    return MAX(cst(e, couv), MIN(cst(f, couv), plansPans(q, e, T.faitage || faitageAuto(q), f, couv)));
  }
  // Comble brisé sur tout le pourtour d'un gabarit convexe à n côtés : chaque côté porte un brisis (de l'égout
  // à h_brisis sur « retrait » m) puis un terrasson (jusqu'à h_faitage, atteint à « retrait_faitage » m du bord) ;
  // au-delà, dessus plat à h_faitage. Sur un polygone convexe, le minimum des plans donne les arêtiers.
  function combleBrise(q, T, couv) {
    const e = T.h_egout, f = T.h_faitage, hb = Math.min(Math.max(T.h_brisis ?? e, e), f);
    const r = Math.max(T.retrait ?? 1, 0.1), rf = Math.max(T.retrait_faitage ?? r + 3, r + 0.1);
    const terr = TEINTES[T.toit_terrasson] ?? TEINTES.zinc;
    const [gx, gz] = centroide(q);
    const kb = (hb - e) / r, kt = (f - hb) / (rf - r);
    const brisis = [], terrasson = [];
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-3) continue;
      let nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L; // normale intérieure
      if (nx * (gx - a[0]) + nz * (gz - a[1]) < 0) { nx = -nx; nz = -nz; }
      const d0 = nx * a[0] + nz * a[1]; // distance au côté : nx x + nz z - d0
      if (kb > 0) brisis.push({ k: 'f', a: kb * nx, b: kb * nz, c: e - kb * d0, teinte: couv });
      terrasson.push({ k: 'f', a: kt * nx, b: kt * nz, c: hb - kt * r - kt * d0, teinte: terr });
    }
    return MAX(cst(e, couv), MIN(cst(f, terr), brisis, terrasson));
  }
  const valeur = (n, x, z) => (n.k === 'f' ? n.a * x + n.b * z + n.c : n.f.reduce((m, g) => (n.k === 'min' ? Math.min : Math.max)(m, valeur(g, x, z)), n.k === 'min' ? Infinity : -Infinity));
  const feuilles = (n) => (n.k === 'f' ? [n] : n.f.flatMap(feuilles));
  // coupe d'un polygone convexe [[x, z]…] par d(x, z) = A - B : [partie d <= 0, partie d >= 0]
  function couper(poly, A, B) {
    const d = (p) => (A.a - B.a) * p[0] + (A.b - B.b) * p[1] + (A.c - B.c);
    const neg = [], pos = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], s = poly[(i + 1) % poly.length], dp = d(p), ds = d(s);
      if (dp <= 0) neg.push(p);
      if (dp >= 0) pos.push(p);
      if ((dp < 0 && ds > 0) || (dp > 0 && ds < 0)) {
        const u = dp / (dp - ds), m = [p[0] + (s[0] - p[0]) * u, p[1] + (s[1] - p[1]) * u];
        neg.push(m); pos.push(m);
      }
    }
    return [neg, pos];
  }
  const aire2 = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], s = poly[(i + 1) % poly.length]; a += p[0] * s[1] - s[0] * p[1]; } return a / 2; };
  // morceaux convexes [poly, fonction affine active] de H sur un polygone convexe
  function decouper(poly, n) {
    if (n.k === 'f') return [[poly, n]];
    let res = decouper(poly, n.f[0]);
    for (const g of n.f.slice(1)) {
      const suite = [];
      for (const [p, A] of res) {
        for (const [p2, B] of decouper(p, g)) {
          const [infA, supA] = couper(p2, A, B); // A <= B, A >= B
          const garder = n.k === 'min' ? [[infA, A], [supA, B]] : [[infA, B], [supA, A]];
          for (const [m, F] of garder) if (m.length >= 3 && Math.abs(aire2(m)) > 1e-4) suite.push([m, F]);
        }
      }
      res = suite;
    }
    return res;
  }

  function geometrieDecoupee(c, mur, couv) {
    const t = tampon();
    const H = fonctionToit(c, couv);
    const ext = c.emprise, trous = c.trous || [];
    // toit : triangles de l'emprise réelle, découpés selon les plans actifs
    const v2 = (r) => r.map(([x, z]) => new THREE.Vector2(x, z));
    const tous = [ext, ...trous].flat();
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(v2(ext), trous.map(v2))) {
      for (const [m, F] of decouper([tous[i], tous[j], tous[k]], H)) {
        const y = (p) => F.a * p[0] + F.b * p[1] + F.c;
        t.facette(m.map((p) => [p[0], y(p), p[1]]), F.teinte, HAUT);
      }
    }
    // murs : chaque côté de l'emprise monte jusqu'au toit (points de rupture exacts entre plans)
    const fs = feuilles(H);
    const anneaux = [[ext, 1], ...trous.map((r) => [r, -1])];
    for (const [anneau, sens] of anneaux) {
      const s = Math.sign(aire2(anneau)) * sens;
      for (let i = 0; i < anneau.length; i++) {
        const A = anneau[i], B = anneau[(i + 1) % anneau.length];
        const dx = B[0] - A[0], dz = B[1] - A[1];
        const ts = [0, 1];
        for (let u = 0; u < fs.length; u++) {
          for (let w = u + 1; w < fs.length; w++) {
            const F = fs[u], G = fs[w];
            const k = (F.a - G.a) * dx + (F.b - G.b) * dz;
            if (Math.abs(k) < 1e-9) continue;
            const tt = -((F.a - G.a) * A[0] + (F.b - G.b) * A[1] + (F.c - G.c)) / k;
            if (tt > 1e-4 && tt < 1 - 1e-4) ts.push(tt);
          }
        }
        ts.sort((a, b) => a - b);
        const out = new THREE.Vector3(dz * s, 0, -dx * s);
        for (let n = 0; n < ts.length - 1; n++) {
          if (ts[n + 1] - ts[n] < 1e-5) continue;
          const p = [A[0] + dx * ts[n], A[1] + dz * ts[n]], q = [A[0] + dx * ts[n + 1], A[1] + dz * ts[n + 1]];
          t.mur(p, q, valeur(H, ...p), valeur(H, ...q), mur, out);
        }
      }
    }
    return t.geometrie();
  }

  function geometrieCorps(c) {
    const t = tampon();
    const T = c.toit;
    const mur = TEINTES[c.materiaux?.murs] ?? TEINTES.tuffeau;
    const couv = TEINTES[c.materiaux?.toit] ?? TEINTES.ardoise;
    if (c.gabarit || (c.emprise && T.type === 'terrasse')) return geometrieDecoupee(c, mur, couv);
    if (T.type === 'tour') {
      const [x, z] = T.centre, r = T.rayon, n = 24;
      const cercle = Array.from({ length: n }, (_, i) => [x + r * Math.cos((i / n) * Math.PI * 2), z + r * Math.sin((i / n) * Math.PI * 2)]);
      murs(t, cercle, 0, T.h_egout, mur, x, z);
      for (let i = 0; i < n; i++) {
        const pts = [P(cercle[i], T.h_egout), P(cercle[(i + 1) % n], T.h_egout), [x, T.h_faitage, z]];
        t.facette(pts, couv, sortant(pts, x, z).multiplyScalar(0.5).add(HAUT));
      }
      return t.geometrie();
    }
    const q = c.emprise;
    const [cx, cz] = centroide(q);
    murs(t, q, 0, T.h_egout, mur, cx, cz);
    if (T.type === 'terrasse' || q.length !== 4) {
      // terrasse (ou emprise qui n'est pas un quadrilatère) : dessus plat à la hauteur d'égout
      dessus(t, q, T.h_egout, couv);
    } else if (T.type === 'mansarde') {
      const int = retrait(q, T.retrait ?? 2);
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const pts = [P(q[i], T.h_egout), P(q[j], T.h_egout), P(int[j], T.h_brisis), P(int[i], T.h_brisis)];
        t.facette(pts, couv, sortant(pts, cx, cz).add(HAUT));
      }
      const terrasson = TEINTES[T.toit_terrasson] ?? TEINTES.zinc;
      pans(t, int, T.h_brisis, T.faitage || faitageAuto(int), T.h_faitage, terrasson, mur, cx, cz);
    } else if (T.type === 'verriere') {
      const r1 = retrait(q, T.retrait_faitage ?? 3);
      const r2 = retrait(q, T.retrait_verriere ?? 5);
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const ext = [P(q[i], T.h_egout), P(q[j], T.h_egout), P(r1[j], T.h_faitage), P(r1[i], T.h_faitage)];
        t.facette(ext, couv, sortant(ext, cx, cz).add(HAUT));
        const int = [P(r1[i], T.h_faitage), P(r1[j], T.h_faitage), P(r2[j], T.h_verriere), P(r2[i], T.h_verriere)];
        t.facette(int, couv, sortant(int, cx, cz).negate().add(HAUT));
      }
      dessus(t, r2, T.h_verriere, TEINTES.verriere);
    } else {
      pans(t, q, T.h_egout, T.faitage || faitageAuto(q), T.h_faitage ?? T.h_egout, couv, mur, cx, cz);
    }
    return t.geometrie();
  }

  function geometries(liste) {
    return liste.map(geometrieCorps);
  }

  // Hauteur du toit au point (x, z), lue sur les pans des géométries (avant fusion et relief) ;
  // null hors des corps. Utilisée par le poché des coupes (js/coupes.js : empreinte.hauteurEn).
  function fonctionHauteur(geos) {
    const tris = [];
    for (const g of geos) {
      const p = g.getAttribute('position').array, n = g.getAttribute('normal').array;
      for (let i = 0; i < p.length; i += 9) if (n[i + 1] > 0.05) tris.push(p.slice(i, i + 9));
    }
    return (x, z) => {
      let best = null;
      for (const t of tris) {
        const [x1, y1, z1, x2, y2, z2, x3, y3, z3] = t;
        const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
        if (Math.abs(d) < 1e-9) continue;
        const l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d;
        const l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        const y = l1 * y1 + l2 * y2 + l3 * y3;
        if (best === null || y > best) best = y;
      }
      return best;
    };
  }

  // Lignes d'étages sur les façades (nombre d'étages de la BD TOPO s'il est plausible, sinon estimation)
  const objetBdtopo = (c) => ensembleDe.get(c)?.donnees.objets_bdtopo?.find((o) => o.cleabs === c.objet_bdtopo);
  function etagesCorps(c) {
    if (c.etages?.n > 0) return { n: c.etages.n, source: c.etages.source || 'relevé' };
    const objet = objetBdtopo(c);
    const bd = objet?.nombre_d_etages;
    return Number.isFinite(bd) && bd > 1 ? { n: bd, source: 'BD TOPO' } : { n: c.etages_estimes || 1, source: 'estimation (égout / 3,8 m)' };
  }
  function lignesEtages(liste) {
    const pos = [];
    for (const c of liste) {
      const { n } = etagesCorps(c);
      if (n < 2) continue;
      const pas = c.toit.h_egout / n;
      let anneaux;
      if (c.emprise) anneaux = [decaler(c.emprise, 0.06, 1), ...(c.trous || []).map((r) => decaler(r, 0.06, -1))];
      else {
        const [x, z] = c.toit.centre, r = c.toit.rayon + 0.06;
        anneaux = [Array.from({ length: 24 }, (_, i) => [x + r * Math.cos((i / 24) * Math.PI * 2), z + r * Math.sin((i / 24) * Math.PI * 2)])];
      }
      for (let k = 1; k < n; k++) {
        const y = k * pas;
        for (const anneau of anneaux) {
          for (let i = 0; i < anneau.length; i++) {
            const a = anneau[i], b = anneau[(i + 1) % anneau.length];
            pos.push(a[0], y, a[1], b[0], y, b[1]);
          }
        }
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2f3b45, transparent: true, opacity: 0.38 }));
    l.raycast = () => {};
    l.name = 'etages';
    l.userData.blocRelief = true; // suit le bâtiment d'un bloc sur le relief (js/relief.js)
    return l;
  }

  // Arêtes des toits (seuil d'angle bas, pour lire les faîtages de faible pente)
  function aretesDetail(geo) {
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 8), new THREE.LineBasicMaterial({ color: 0x2f3b45, transparent: true, opacity: 0.5 }));
    l.raycast = () => {};
    return l;
  }

  // --------------------------------------------------------------
  // Photos de façade (data/facades/<ensemble>.json + images JPEG de data/facades/<ensemble>/)
  // Les murs des géométries détaillées (userData.murs, enregistrés par tampon().mur) proches d'une façade
  // décrite (moins de 2 m de son segment, parallèles, tournés vers la rue) reçoivent un calque texturé :
  // mêmes sommets que le mur (le relief les décale avec le bâtiment), u le long de la façade, v en mètres
  // jusqu'à hauteur_m (au-dessus, le mur garde sa teinte). Matériau éclairé (ombres et ombrage conservés),
  // décalé en profondeur pour passer devant le mur ; non cliquable (le clic touche le bâtiment dessous).
  // --------------------------------------------------------------
  const textures = new Map(); // chemin de l'image -> { texture, ok }
  const calques = new Set(); // meshes de photos de façade construits (pour la bascule)
  const cheminImage = (f) => dossierFacades(ensembleFacade.get(f)?.id || 'hotel-de-ville') + f.image;
  const etatImage = (f) => textures.get(cheminImage(f));
  function texture(f) {
    const chemin = cheminImage(f);
    if (!textures.has(chemin)) {
      const e = { texture: null, ok: null };
      e.texture = new THREE.TextureLoader().load(chemin,
        () => { e.ok = true; },
        undefined,
        () => {
          e.ok = false;
          majFacades();
          console.info(`Photo de façade absente : ${chemin} (à déposer dans le dossier de l'atlas)`);
        });
      e.texture.colorSpace = THREE.SRGBColorSpace;
      e.texture.anisotropy = 4;
      textures.set(chemin, e);
    }
    return textures.get(chemin);
  }
  const PARALLELE = Math.cos(THREE.MathUtils.degToRad(25));
  function facadesPhoto(geos) {
    const liste = toutesFacades();
    if (!liste.length) return [];
    const pieces = geos.flatMap((g) => g.userData.murs || []);
    const res = [];
    for (const f of liste) {
      const [gx, gz] = f.gauche, [dx0, dz0] = f.droite;
      const L = Math.hypot(dx0 - gx, dz0 - gz);
      if (!(L > 0.5) || !(f.hauteur_m > 0)) continue;
      const ux = (dx0 - gx) / L, uz = (dz0 - gz) / L;
      const az = THREE.MathUtils.degToRad(f.normale_az);
      const nx = Math.sin(az), nz = -Math.cos(az); // nord = -z
      const abs = (p) => (p[0] - gx) * ux + (p[1] - gz) * uz; // abscisse le long de la façade
      const ecart = (p) => Math.abs((p[0] - gx) * uz - (p[1] - gz) * ux); // distance à la ligne
      const pos = [], uv = [], nor = [];
      for (const m of pieces) {
        const lm = Math.hypot(m.q[0] - m.p[0], m.q[1] - m.p[1]);
        if (lm < 0.05) continue;
        const ol = Math.hypot(m.out[0], m.out[1]) || 1;
        if ((m.out[0] * nx + m.out[1] * nz) / ol < 0.5) continue; // mur tourné vers la rue
        if (Math.abs(((m.q[0] - m.p[0]) * ux + (m.q[1] - m.p[1]) * uz) / lm) < PARALLELE) continue;
        if (ecart(m.p) > 2 || ecart(m.q) > 2) continue;
        // découpe du mur à l'étendue de la façade [0, L] (prolongée de 0,3 m)
        let t0 = abs(m.p), t1 = abs(m.q);
        const a = Math.max(Math.min(t0, t1), -0.3), b = Math.min(Math.max(t0, t1), L + 0.3);
        if (b - a < 0.05) continue;
        const pt = (t) => { const k = (t - t0) / (t1 - t0); return { x: m.p[0] + (m.q[0] - m.p[0]) * k, z: m.p[1] + (m.q[1] - m.p[1]) * k, h: m.hp + (m.hq - m.hp) * k }; };
        const A = pt(a), B = pt(b);
        // polygone du mur (bas, puis haut) coupé à y <= hauteur_m
        const poly = [];
        const H = f.hauteur_m;
        const sommets = [[A, 0], [B, 0], [B, B.h], [A, A.h]];
        for (let i = 0; i < 4; i++) {
          const [P1, y1] = sommets[i], [P2, y2] = sommets[(i + 1) % 4];
          if (y1 <= H) poly.push([P1.x, y1, P1.z]);
          if ((y1 < H && y2 > H) || (y1 > H && y2 < H)) {
            const k = (H - y1) / (y2 - y1);
            poly.push([P1.x + (P2.x - P1.x) * k, H, P1.z + (P2.z - P1.z) * k]);
          }
        }
        if (poly.length < 3) continue;
        const o = new THREE.Vector3(m.out[0], 0, m.out[1]).normalize();
        for (let i = 1; i < poly.length - 1; i++) {
          let tri = [poly[0], poly[i], poly[i + 1]];
          const e1 = new THREE.Vector3(tri[1][0] - tri[0][0], tri[1][1] - tri[0][1], tri[1][2] - tri[0][2]);
          const e2 = new THREE.Vector3(tri[2][0] - tri[0][0], tri[2][1] - tri[0][1], tri[2][2] - tri[0][2]);
          if (e1.cross(e2).dot(o) < 0) tri = [tri[0], tri[2], tri[1]];
          for (const v of tri) {
            pos.push(...v);
            nor.push(o.x, 0, o.z);
            uv.push(Math.min(Math.max(abs([v[0], v[2]]) / L, 0), 1), v[1] / H);
          }
        }
      }
      if (!pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const tx = texture(f);
      const mat = new THREE.MeshStandardMaterial({
        name: `Facade ${f.id}`, map: tx.texture, roughness: 0.9, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = `facade-photo-${f.id}`;
      mesh.raycast = () => {};
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData.facadePhoto = f.id;
      mesh.userData.blocRelief = true; // suit le bâtiment sur le relief (js/relief.js)
      // suit la transparence du bâti (js/bati.js règle le matériau des bâtiments remarquables)
      mesh.onBeforeRender = () => {
        const r = app.materiaux?.remarquable;
        if (!r) return;
        if (mat.transparent !== r.transparent) { mat.transparent = r.transparent; mat.needsUpdate = true; }
        mat.opacity = r.opacity; mat.depthWrite = r.depthWrite;
      };
      mesh.userData.cree = performance.now();
      calques.add(mesh);
      res.push(mesh);
    }
    majFacades();
    return res;
  }
  // visibles si la bascule est active, l'image chargée et les couleurs PSMV du bâti masquées
  function majFacades() {
    // calques d'un bâti reconstruit (démolition, mode) : retirés de la liste et libérés
    for (const m of calques) {
      let r = m; while (r.parent) r = r.parent;
      if (r !== app.scene && performance.now() - m.userData.cree > 5000) { calques.delete(m); m.geometry.dispose(); m.material.dispose(); }
    }
    const liste = toutesFacades();
    for (const m of calques) {
      const f = liste.find((x) => x.id === m.userData.facadePhoto);
      const ok = f ? etatImage(f)?.ok !== false : false;
      m.visible = etat.photos && !etat.blanc && ok && !app.couches?.batimentsPSMV;
    }
    if (ui.etatPhotos) {
      const manquantes = liste.filter((f) => etatImage(f)?.ok === false);
      ui.etatPhotos.textContent = manquantes.length
        ? `Images absentes : ${manquantes.map((f) => cheminImage(f)).join(', ')} (les déposer dans ces dossiers de l'atlas).`
        : '';
    }
  }
  function definirPhotos(v) {
    etat.photos = !!v;
    majFacades();
    app.emettre?.('facades');
  }
  app.on?.('couches', majFacades);
  // crédits des photos de façade (fiche, légende, panneau)
  // libellé d'un ensemble de photos : « Hôtel de Ville », « Îlot Saint-Vincent »…
  const libelleEnsemble = (e) => (e.id === 'hotel-de-ville' ? 'Hôtel de Ville' : e.donnees.titre || e.id);
  function creditsFacades() {
    const parties = [];
    for (const e of ensembles) {
      if (!e.facades) continue;
      const parSource = new Map();
      for (const f of e.facades.facades) {
        const cle = `${f.source} (${f.auteur}, ${f.licence})`;
        if (!parSource.has(cle)) parSource.set(cle, []);
        parSource.get(cle).push(f.nom.split(',')[0]);
      }
      parties.push(`${libelleEnsemble(e)} : ${[...parSource].map(([k, v]) => `${v.join(', ')} : ${k}`).join(' ; ')}`);
    }
    return parties.length ? `Photos de façade. ${parties.join('. ')}.` : '';
  }
  function blocPhotos(c, ens) {
    const facades = ens?.facades;
    if (!facades) return null;
    const liste = h('ul', { style: { fontSize: '13px', paddingLeft: '18px', margin: '4px 0' } }, ...facades.facades.map((f) => {
      const enCours = c && f.corps?.includes(c.id);
      return h('li', { style: enCours ? { fontWeight: '600' } : {} },
        `${f.nom} : ${f.source}, ${f.auteur}, ${f.licence}, prise le ${f.date_prise.split('-').reverse().join('/')} ; confiance ${f.confiance}. `,
        estNonPublie(f.lien || f.photo) ? `photo d'origine (PSMV) : ${NON_PUBLIE}` : f.lien ? h('a', { href: f.lien, target: '_blank', rel: 'noopener' }, 'photo d\'origine') : f.photo);
    }));
    return h('details', { open: !!(c && facades.facades.some((f) => f.corps?.includes(c.id))) },
      h('summary', {}, `Photos de façade (${facades.facades.length}, ${facades.facades.map((f) => f.rue).filter((v, i, a) => v && a.indexOf(v) === i).join(', ')})`),
      liste,
      h('p', { class: 'note' }, `Photos redressées et plaquées sur les murs sur rue (onglet Bâtiments > Bâti, « Photos de façade »). Les autres façades restent en teinte.${facades.sans_photo ? ` ${facades.sans_photo}` : ''}`));
  }

  // --------------------------------------------------------------
  // Fiche du bâtiment
  // --------------------------------------------------------------
  function corpsSous(x, z) {
    return tousCorps().find((c) => (c.emprise ? pointDansPolygone(x, z, c.emprise) : Math.hypot(x - c.toit.centre[0], z - c.toit.centre[1]) <= c.toit.rayon)) || null;
  }

  // corps de l'ensemble dont l'emprise passe à moins de 1 m du point (clic sur une façade)
  function corpsProche(x, z, ens) {
    let best = null, dmin = 1;
    for (const c of ens.donnees.corps) {
      if (!c.emprise) continue;
      for (let i = 0; i < c.emprise.length; i++) {
        const d = distanceAuSegment([x, z], c.emprise[i], c.emprise[(i + 1) % c.emprise.length]);
        if (d < dmin) { dmin = d; best = c; }
      }
    }
    return best;
  }

  // styles en ligne : pas de feuille de style supplémentaire
  const STYLE_DL = { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: '8px 0', fontSize: '13.5px', lineHeight: '1.4' };
  function ligne(dt, dd) { return [h('dt', { style: { color: 'var(--ardoise-doux)' } }, dt), h('dd', { style: { margin: '0' } }, dd)]; }

  function blocFiche(fiche, contexte) {
    const ens = ensembles.find((e) => ficheDe(e) === fiche?.id);
    if (!ens) return null;
    const donnees = ens.donnees;
    const p = contexte?.point;
    let c = p ? corpsSous(p.x, p.z) : null;
    if (!c && p) c = corpsProche(p.x, p.z, ens); // clic sur un mur : corps de l'ensemble à moins de 1 m
    if (c && ensembleDe.get(c) !== ens) c = null;
    if (!c && donnees.corps.length === 1) c = donnees.corps[0]; // ensemble d'un seul bâtiment : détail d'office (clic sur un mur)
    const bloc = h('div', { class: 'fiche-batiment' });
    bloc.append(h('h3', { style: { margin: '18px 0 4px', fontSize: '15px' } }, c ? `Bâtiment : ${c.nom}` : (ens.id === 'hotel-de-ville' ? 'Bâtiments de l\'Hôtel de Ville' : `Bâtiments : ${donnees.titre}`)));
    if (c) {
      const T = c.toit;
      const o = objetBdtopo(c);
      const et = etagesCorps(c);
      bloc.append(h('dl', { class: 'donnees-batiment', style: STYLE_DL },
        ...ligne('Toit', `${LIBELLES_TOIT[T.type] || T.type}${T.type === 'mansarde' || T.type === 'comble-brise' ? ` (brisis jusqu'à ${fmt(T.h_brisis)} m)` : ''}${T.type === 'verriere' ? ` (verrière à ${fmt(T.h_verriere)} m)` : ''}`),
        ...ligne('Égout / faîtage', T.h_faitage != null ? `${fmt(T.h_egout)} m / ${fmt(T.h_faitage)} m au-dessus du sol (LiDAR HD)` : `${fmt(T.h_egout)} m (LiDAR HD)`),
        ...ligne('Étages', `${et.n} niveaux (${et.source})${o ? ` ; BD TOPO : ${o.nombre_d_etages ?? 'non renseigné'}` : ''}`),
        ...ligne('Matériaux', `murs : ${c.materiaux?.murs || '—'}, toit : ${c.materiaux?.toit || '—'}${T.toit_terrasson ? ` (terrasson : ${T.toit_terrasson})` : ''} ; ${c.materiaux?.source || ''}`),
        ...ligne('Lecture', c.observation || '—'),
        ...ligne('Confiance', `${c.confiance} (${donnees.confiance?.[c.confiance] || ''})`),
        ...(o ? [
          ...ligne('BD TOPO', `${o.cleabs}, RNB ${o.identifiants_rnb || '—'} ; hauteur ${fmt(o.hauteur)} m ; sol ${fmt(o.altitude_minimale_sol)} à ${fmt(o.altitude_maximale_sol)} m NGF ; toit ${fmt(o.altitude_minimale_toit)} à ${fmt(o.altitude_maximale_toit)} m NGF ; ${o.usage_1 || ''}${o.date_d_apparition ? ` ; apparition ${String(o.date_d_apparition).slice(0, 4)}` : ''}`),
          ...ligne('Matériaux BD TOPO', `murs : ${o.materiaux_des_murs ?? 'non renseigné'}, toiture : ${o.materiaux_de_la_toiture ?? 'non renseigné'}`),
        ] : []),
      ));
    } else {
      bloc.append(h('p', { class: 'note' }, 'Cliquer un corps de bâtiment sur la maquette pour son détail.'));
    }
    const photos = blocPhotos(c, ens);
    if (photos) bloc.append(photos);
    bloc.append(h('details', {}, h('summary', {}, `Les ${donnees.corps.length} corps de bâtiment`),
      h('ul', { class: 'liste-corps', style: { fontSize: '13px', paddingLeft: '18px' } }, ...donnees.corps.map((k) => h('li', {}, `${k.nom} : ${LIBELLES_TOIT[k.toit.type] || k.toit.type}, ${fmt(k.toit.h_egout)}${k.toit.h_faitage != null ? ` / ${fmt(k.toit.h_faitage)}` : ''} m (${k.confiance})`)))));
    bloc.append(h('p', { class: 'source' }, `Sources : ${Object.values(donnees.sources || {}).join(' ; ')}. ${donnees.methode || ''}`));
    return bloc;
  }

  // --------------------------------------------------------------
  // Réglage (onglet Bâtiments > Bâti)
  // --------------------------------------------------------------
  function definirMode(m) {
    if (m === etat.mode) return;
    etat.mode = m;
    app.reconstruireBatiments();
    app.emettre('bati');
  }

  // Représentation du bâti : Simple, Détaillé, Détaillé avec photos, Détaillé blanc
  function definirRepresentation(r) {
    const blancAvant = etat.blanc;
    etat.blanc = r === 'blanc';
    etat.photos = r === 'photos';
    if (r === 'simple') definirMode('simple');
    else if (etat.mode !== 'detaille') definirMode('detaille');
    else if (blancAvant !== etat.blanc) app.cadastre?.majBatiments(true);
    majFacades();
    app.emettre?.('facades');
    if (ui.representation?.isConnected) ui.representation.querySelectorAll('input').forEach((i) => { i.checked = i.value === representation(); });
  }

  function construireCommandes(conteneur) {
    if (!ensembles.length) return;
    const noms = ensembles.map((e) => (e.id === 'hotel-de-ville' ? 'Hôtel de Ville' : e.donnees.titre || e.id));
    const fichiers = ensembles.map((e) => `data/toits/${e.id}.json`).join(', ');
    const choix = [['simple', 'Simple'], ['detaille', 'Détaillé'], ['photos', 'Détaillé avec photos'], ['blanc', 'Détaillé blanc']]
      .filter(([v]) => v !== 'photos' || toutesFacades().length);
    ui.representation = h('div', { class: 'choix', role: 'radiogroup', 'aria-label': 'Représentation du bâti' },
      ...choix.map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'representation-bati', value: v, checked: representation() === v, onchange: () => definirRepresentation(v) }), l)));
    ui.etatPhotos = h('p', { class: 'note', role: 'status' });
    conteneur.append(
      h('div', { class: 'titre-info' }, h('h3', {}, 'Représentation'),
        info(`Détaillé : pans de toit, faîtages, lignes d'étages et teintes (tuffeau, ardoise, zinc) des ensembles relevés (${noms.join(', ')}), d'après la BD TOPO, l'orthophoto et le LiDAR HD de l'IGN (${fichiers}). Simple : volumes extrudés.`,
          'Détaillé avec photos : photos de façade redressées plaquées sur les murs sur rue. Détaillé blanc : même géométrie, en maquette blanche (ni teintes ni photos).',
          creditsFacades() || null)),
      ui.representation,
      ui.etatPhotos,
    );
    majFacades();
  }

  return {
    charger, assigner, geometries, fonctionHauteur, lignesEtages, aretesDetail, hauteurMax, blocFiche, construireCommandes, definirMode, definirRepresentation, representation, corpsSous, centre,
    facadesPhoto, definirPhotos, creditsFacades, remarquable,
    etat, get donnees() { return donnees; }, get facades() { return facades; }, get ensembles() { return ensembles; },
    get detaille() { return etat.mode === 'detaille' && ensembles.length > 0; },
  };
}
