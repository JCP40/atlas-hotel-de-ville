import * as THREE from 'three';
import { h, info, dateDepuisJour, jourDeLAnnee, MOIS } from './util.js';
import { pointDansPolygone, polygonesLocaux, lignesLocales } from './geo.js';
import { chargerJSON, enregistrerDonnees } from './donnees.js';
import { visibiliteBatiment } from './maquette.js';
import { chargerMeteo, horaire, journeesTypes, sourceEPW, libellePeriode } from './meteo.js';
import { preparerPoints, calculerSVF, positionsSoleil, calculerMasques, simulerJournee, temperatureA, temperatureReference, REFERENCE, PAS_INSTANTANE, NB_INSTANTANES } from './chaleur-modele.js';
import { creerPointsChauds } from './chaleur-points.js';

// Outil Chaleur (onglet Ambiance) : matériaux de surface, albédo, échauffement et points chauds au sol.
// ESTIMATION PÉDAGOGIQUE, pas une simulation certifiée (hypothèses et limites dans les boutons « i »).
// Lot 1 : carte des matériaux du sol (grille de 2 m) et des toitures, albédo, corrections au clic.
// Lot 2 : température de surface estimée (js/chaleur-modele.js : bilan d'énergie force-restore, ombres du bâti effectif et des arbres
//   par la grille des hauteurs de Soleil, ouverture au ciel, vent local de l'outil Vent s'il est calculé) au jour et à l'heure de la barre
//   Soleil ; météo : moyenne du mois (meteo_horaire.json) ou journées types data/chaleur/journees.json (outils/chaleur/journees.py).
// Lot 3 : points chauds et frais, comparaison existant / projet et variantes de matériaux, exports PNG, CSV, DXF (js/chaleur-points.js).
// - data/chaleur/materiaux.json : classes { libelle, type sol|toit, couleur, albedo, emissivite, effusivite, evaporation, transmission?, refs } + références ;
// - data/chaleur/toitures.json : classe de toiture par bâtiment (osm / ign / centre), outils/chaleur/pretraitement.py (BD TOPO + orthophoto) ;
// - data/chaleur/ortho.json : orthophoto IGN résumée en grille de 4 m (v végétal, c sol clair, . autre ; lignes codées par plages), même script ;
// - data/chaleur/corrections.json : { description, corrections: [{ id, type: 'element'|'disque'|'polygone'|'toit', cle?, lat?, lon?, rayon?, points?, classe, date }] }
//   (WGS84 : indépendant de config.origine), écrit par enregistrerDonnees (serveur.py), sinon téléchargé.
// Ordre de peinture du sol : orthophoto (fond) < surfaces OSM (verts, places, parkings, eau) < trottoirs < chemins < chaussées
// < sol sous les arbres < corrections ; le bâti effectif (app.batiEffectif) masque le sol.

const LARGEURS = { // comme maquette.js
  primary: 12, secondary: 10, tertiary: 8, residential: 6.5, unclassified: 6, living_street: 5.5,
  pedestrian: 6, service: 4, footway: 2.5, path: 2, cycleway: 2, steps: 2.5, busway: 7,
};
const LARGEUR_TROTTOIR = 2.5;
const SURFACE_OSM = {
  asphalt: 'enrobe', paved: 'enrobe', chipseal: 'enrobe', metal: 'enrobe',
  paving_stones: 'paves', sett: 'paves', cobblestone: 'paves', unhewn_cobblestone: 'paves', stone: 'paves', granite: 'paves',
  concrete: 'dalles', 'concrete:plates': 'dalles', 'concrete:lanes': 'dalles', marble: 'dalles', limestone: 'dalles',
  compacted: 'stabilise', fine_gravel: 'stabilise', gravel: 'stabilise', pebblestone: 'stabilise', dirt: 'stabilise', ground: 'stabilise', earth: 'stabilise', sand: 'stabilise',
  grass: 'pelouse', grass_paver: 'pelouse', wood: 'bois',
};
const HORS = 255, BATI = 254;

export function creerChaleur(app) {
  if (!document.querySelector('link[href$="css/chaleur.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/chaleur.css' }));
  const etat = {
    pret: null, mat: null, classes: [], idx: {}, toitures: null, ortho: null, corrections: [], modifie: false,
    grille: null, affichage: 'materiaux', calque: null, toitsColores: false,
    capture: null, classeChoisie: 'paves', modeCorrection: 'element', rayonDisque: 4, polygone: [],
    journees: null, temp: null, meteo: 'mois', vueTemp: 'heure', calcul: false, suspendu: false,
  };
  const ui = {};
  const rayon = () => Math.min(app.config.rayonConfort || app.config.rayonPlateau, 300);
  const note = (t) => { if (ui.etat) ui.etat.textContent = t; };
  const fmt = (v, d = 0) => v.toFixed(d).replace('.', ',');
  const r7 = (v) => Math.round(v * 1e7) / 1e7;

  // ------------------------------------------------------------
  // Données
  // ------------------------------------------------------------
  function charger() {
    if (etat.pret) return etat.pret;
    etat.pret = (async () => {
      const [mat, toitures, ortho, corr, journees] = await Promise.all([
        chargerJSON('data/chaleur/materiaux.json', null), chargerJSON('data/chaleur/toitures.json', null),
        chargerJSON('data/chaleur/ortho.json', null), chargerJSON('data/chaleur/corrections.json', null),
        chargerJSON('data/chaleur/journees.json', null),
      ]);
      etat.journees = journees?.profils ? journees : null;
      if (!mat?.classes) throw new Error('data/chaleur/materiaux.json absent');
      etat.mat = mat;
      etat.classes = Object.entries(mat.classes).map(([id, c]) => ({ id, ...c, rgb: hexRGB(c.couleur) }));
      etat.classes.forEach((c, i) => { etat.idx[c.id] = i; c.tref = temperatureReference(c); });
      const tr = etat.classes.map((c) => c.tref);
      etat.ech = { min: Math.floor(Math.min(...tr)), max: Math.ceil(Math.max(...tr)) };
      etat.toitures = indexerToitures(toitures);
      etat.ortho = decoderOrtho(ortho);
      etat.corrections = (corr?.corrections || []).filter((c) => c && etat.idx[c.classe] != null);
    })();
    etat.pret.catch(() => { etat.pret = null; });
    return etat.pret;
  }
  const hexRGB = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const classe = (id) => etat.classes[etat.idx[id]];

  const SOURCES_TOIT = { o: 'OSM (roof:material)', b: 'BD TOPO, confirmée par l\'orthophoto', d: 'orthophoto (BD TOPO démentie)', p: 'orthophoto (couleur du toit)', f: 'OSM (toit plat)', x: 'défaut' };
  function indexerToitures(d) {
    const parCle = new Map(), points = [];
    for (const [cle, cl, src, bdtopo, lat, lon] of d?.t || []) {
      const t = { cle, classe: cl, source: SOURCES_TOIT[src] || src, bdtopo: bdtopo || null, lat, lon };
      parCle.set(cle, t);
      if (lat != null) points.push(t); // bâtiments BD TOPO sans équivalent OSM : retrouvés par leur centre
    }
    return { parCle, points, source: d?.sources || '', description: d?.description || '' };
  }
  // orthophoto : lignes codées par plages (« 12. » = 12 mailles « . ») décodées une fois
  function decoderOrtho(o) {
    if (!o?.lignes) return null;
    const lignes = o.lignes.map((l) => l.replace(/(\d+)(\D)/g, (_, n, c) => c.repeat(+n)));
    return { ...o, lignes };
  }

  // orthophoto résumée : lettre de la maille sous (x, z)
  function orthoEn(x, z) {
    const o = etat.ortho;
    if (!o) return '';
    const g = app.proj.versGeo(x, z), E = o.emprise;
    const i = Math.floor(((g.lon - E.ouest) / (E.est - E.ouest)) * o.nx), j = Math.floor(((E.nord - g.lat) / (E.nord - E.sud)) * o.ny);
    return i < 0 || j < 0 || i >= o.nx || j >= o.ny ? '' : o.lignes[j][i];
  }

  // clé d'un bâtiment : OSM / IGN, sinon centre géographique (volumes du projet compris)
  function cleBatiment(e) {
    if (e.id) return String(e.id);
    const g = app.proj.versGeo(e.cx, e.cz);
    return `g${g.lat.toFixed(6)},${g.lon.toFixed(6)}`;
  }

  // matériau de toiture : correction > corps détaillés (data/toits) > toitures.json > terrasse (projet) > ardoise
  function classeToit(e, corrections) {
    const cle = cleBatiment(e);
    const c = corrections.find((k) => k.type === 'toit' && k.cle === cle);
    if (c) return { id: c.classe, source: 'correction' };
    const corps = e.detail?.corps ? [].concat(e.detail.corps) : [];
    if (corps.length) {
      const n = {};
      for (const k of corps) { const t = k?.materiaux?.toit; if (t && etat.idx[t] != null) n[t] = (n[t] || 0) + 1; }
      const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
      if (best) return { id: best[0], source: 'toitures détaillées de l\'atlas' };
    }
    if (e.projet) return { id: 'terrasse', source: 'volume du projet (terrasse par défaut)' };
    const t = etat.toitures?.parCle.get(cle) || etat.toitures?.points.find((p) => {
      const q = app.proj.versLocal(p.lat, p.lon);
      return Math.abs(q.x - e.cx) < 40 && Math.abs(q.z - e.cz) < 40 && e.polys.some(([ext]) => pointDansPolygone(q.x, q.z, ext));
    });
    if (t && etat.idx[t.classe] != null) return { id: t.classe, source: t.source, bdtopo: t.bdtopo, ortho: t.ortho };
    return { id: 'ardoise', source: 'défaut (ardoise, majoritaire dans le secteur)' };
  }

  // ------------------------------------------------------------
  // Grille des matériaux (maille de 2 m, 3 m au-delà de 150 m de rayon)
  // ------------------------------------------------------------
  function construireGrille({ corrections = etat.corrections, bati = null } = {}) {
    const r = rayon();
    const pas = r <= 150 ? 2 : 3;
    const n = Math.ceil((2 * r) / pas), x0 = -r, z0 = -r, N = n * n;
    const cls = new Uint8Array(N).fill(HORS), zone = new Int32Array(N).fill(-1), arbre = new Uint8Array(N), bat = new Int32Array(N).fill(-1);
    const zones = [{ type: 'ortho', nom: 'Sol non décrit par OSM (classé d\'après l\'orthophoto)' }];
    const I = etat.idx;
    const cx = (i) => x0 + (i + 0.5) * pas, cz = (j) => z0 + (j + 0.5) * pas;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = cx(i), z = cz(j);
      if (x * x + z * z > r * r) continue;
      const o = orthoEn(x, z);
      cls[j * n + i] = o === 'v' ? I.pelouse : o === 'c' ? I.dalles : I.enrobe;
      zone[j * n + i] = 0;
    }
    const plage = (a, b) => [Math.max(0, Math.floor((a - x0) / pas - 0.5)), Math.min(n - 1, Math.ceil((b - x0) / pas - 0.5))];
    function pourPolygone([ext, ...trous], fn) {
      let xa = Infinity, xb = -Infinity, za = Infinity, zb = -Infinity;
      for (const [x, z] of ext) { xa = Math.min(xa, x); xb = Math.max(xb, x); za = Math.min(za, z); zb = Math.max(zb, z); }
      const [i0, i1] = plage(xa, xb), [j0, j1] = plage(za, zb);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * n + i;
        if (cls[k] === HORS) continue;
        const x = cx(i), z = cz(j);
        if (pointDansPolygone(x, z, ext) && !trous.some((t) => pointDansPolygone(x, z, t))) fn(k, x, z);
      }
    }
    function pourRuban(pts, w, fn) {
      for (let s = 1; s < pts.length; s++) {
        const [ax, az] = pts[s - 1], [bx, bz] = pts[s];
        const [i0, i1] = plage(Math.min(ax, bx) - w, Math.max(ax, bx) + w), [j0, j1] = plage(Math.min(az, bz) - w, Math.max(az, bz) + w);
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const k = j * n + i;
          if (cls[k] === HORS) continue;
          const x = cx(i), z = cz(j);
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          if ((x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2 <= w * w) fn(k, x, z);
        }
      }
    }
    const parElement = new Map(corrections.filter((c) => c.type === 'element').map((c) => [c.cle, c.classe]));
    const peindre = (z, regle) => (k, x, zz) => { const c = parElement.get(zones[z].cle); cls[k] = c ? I[c] : regle(orthoEn(x, zz)); zone[k] = z; };
    const nouvelleZone = (o) => zones.push(o) - 1;

    // surfaces OSM (espaces verts, places piétonnes, parkings, voirie surfacique, eau)
    const regleSurface = {
      vegetal: (o) => (o === 'c' ? I.stabilise : I.pelouse),
      pietonne: (o) => (o === 'c' ? I.dalles : I.paves),
      parking: () => I.enrobe, voirie: () => I.enrobe, eau: () => I.eau,
    };
    const NOMS_SURF = { vegetal: 'Espace vert', pietonne: 'Place ou espace piéton', parking: 'Stationnement', voirie: 'Voirie', eau: 'Eau' };
    for (const f of app.donnees?.osm?.surfaces?.features || []) {
      const p = f.properties || {}, regle = regleSurface[p.surface];
      if (!regle) continue;
      const z = nouvelleZone({ type: 'surface', cle: p.osm || null, nom: p.name || NOMS_SURF[p.surface], osm: p.osm });
      for (const poly of polygonesLocaux(f.geometry, app.proj)) pourPolygone(poly, peindre(z, regle));
    }
    // voirie (rubans des voies, bande de trottoir de part et d'autre des chaussées)
    const chaussees = [], chemins = [];
    for (const f of app.donnees?.osm?.voirie?.features || []) {
      const p = f.properties || {}, hw = p.highway;
      if (!hw || p.tunnel === 'yes' || p.layer < 0) continue;
      const largeur = LARGEURS[hw] ?? 3;
      const lignes = lignesLocales(f.geometry, app.proj).filter((pts) => pts.some(([x, z]) => Math.abs(x) < r + 20 && Math.abs(z) < r + 20));
      if (!lignes.length) continue;
      (largeur >= 4 && hw !== 'pedestrian' ? chaussees : chemins).push({ p, hw, largeur, lignes });
    }
    const tag = (p) => SURFACE_OSM[String(p.surface || '').toLowerCase()];
    const regleTrottoir = (o) => (o === 'c' ? I.dalles : I.enrobe);
    for (const v of chaussees) {
      const z = nouvelleZone({ type: 'trottoir', cle: v.p.osm ? `${v.p.osm}#trottoir` : null, nom: `Trottoir${v.p.name ? `, ${v.p.name}` : ''}`, osm: v.p.osm });
      for (const pts of v.lignes) pourRuban(pts, v.largeur / 2 + LARGEUR_TROTTOIR, peindre(z, regleTrottoir));
    }
    for (const v of chemins) {
      const t = tag(v.p);
      const regle = t ? () => I[t] : v.hw === 'pedestrian' || v.hw === 'steps' ? (o) => (o === 'c' ? I.dalles : I.paves) : regleTrottoir;
      const z = nouvelleZone({ type: 'voie', cle: v.p.osm || null, nom: `${v.hw === 'steps' ? 'Escalier' : v.hw === 'pedestrian' ? 'Rue piétonne' : 'Cheminement'}${v.p.name ? `, ${v.p.name}` : ''}`, osm: v.p.osm, surface: v.p.surface });
      for (const pts of v.lignes) pourRuban(pts, v.largeur / 2, peindre(z, regle));
    }
    for (const v of chaussees) {
      const t = tag(v.p);
      const z = nouvelleZone({ type: 'voie', cle: v.p.osm || null, nom: `Chaussée${v.p.name ? `, ${v.p.name}` : ''}`, osm: v.p.osm, surface: v.p.surface });
      for (const pts of v.lignes) pourRuban(pts, v.largeur / 2, peindre(z, () => I[t || 'enrobe']));
    }
    // arbres : couronne au-dessus ; sol végétal ou stabilisé dessous -> « sol sous arbres »
    for (const liste of Object.values(app.arbres?.lots || {})) {
      for (const a of liste) {
        const rr = a.d / 2;
        if (Math.abs(a.x) > r + rr || Math.abs(a.z) > r + rr) continue;
        const cercle = [];
        for (let q = 0; q < 12; q++) cercle.push([a.x + rr * Math.cos((q / 12) * 2 * Math.PI), a.z + rr * Math.sin((q / 12) * 2 * Math.PI)]);
        pourPolygone([cercle], (k) => { arbre[k] = 1; if (cls[k] === I.pelouse || cls[k] === I.stabilise) cls[k] = I.sousArbres; });
      }
    }
    // corrections dessinées (disques, polygones)
    for (const c of corrections) {
      if (c.type !== 'disque' && c.type !== 'polygone') continue;
      const z = nouvelleZone({ type: 'correction', id: c.id, nom: 'Zone corrigée' });
      const pts = c.type === 'disque'
        ? Array.from({ length: 16 }, (_, q) => { const p = app.proj.versLocal(c.lat, c.lon); return [p.x + c.rayon * Math.cos((q / 16) * 2 * Math.PI), p.z + c.rayon * Math.sin((q / 16) * 2 * Math.PI)]; })
        : c.points.map(([la, lo]) => { const p = app.proj.versLocal(la, lo); return [p.x, p.z]; });
      if (pts.length >= 3) pourPolygone([pts], (k) => { cls[k] = I[c.classe]; zone[k] = z; });
    }
    // bâti effectif (existant non démoli + projet) : masque le sol, toitures à part
    const batiments = [];
    for (const e of bati || app.batiEffectif?.() || app.empreintes || []) {
      if (!visibiliteBatiment({ ...app, vueMaquette: false }, e.cle)) continue;
      if (Math.abs(e.cx) > r + 80 || Math.abs(e.cz) > r + 80) continue;
      const b = batiments.length;
      const t = classeToit(e, corrections);
      batiments.push({ e, toit: t.id, source: t.source, bdtopo: t.bdtopo, cellules: [] });
      for (const poly of e.polys) pourPolygone(poly, (k) => { cls[k] = BATI; bat[k] = b; batiments[b].cellules.push(k); });
    }
    return { r, pas, n, x0, z0, cls, zone, zones, arbre, bat, batiments };
  }

  function grille() {
    if (!etat.grille) etat.grille = construireGrille();
    return etat.grille;
  }
  function invalider() {
    etat.grille = null;
    const avaitTemp = !!etat.temp;
    etat.temp = null;
    if (etat.affichage === 'temperature') {
      if (avaitTemp && ui.temp?.isConnected) planifierCalcul(); else { effacerTout(); }
    } else if (etat.calque || etat.toitsColores) afficher();
  }

  // ------------------------------------------------------------
  // Affichage : texture au sol (comme Confort), toitures en couleurs par sommet
  // ------------------------------------------------------------
  function couleurCellule(G, k, mode, vals) {
    const c = G.cls[k];
    if (c === HORS || c === BATI) return null;
    if (mode === 'materiaux') return etat.classes[c].rgb;
    if (mode === 'albedo') return rampeAlbedo(etat.classes[c].albedo);
    if (mode === 'echauffement') return rampeEchauffement(etat.classes[c].tref);
    return vals ? (Number.isFinite(vals[k]) ? vals.couleur(vals[k]) : null) : null;
  }
  // albédo : dégradé continu sur une échelle fixe (plage de materiaux.json), du rouge (albédo faible : absorbe, plus chaud)
  // au bleu (albédo élevé : réfléchit, plus frais) en passant par une teinte claire neutre, comme la carte de température
  const ALB_MIN = 0.05, ALB_MAX = 0.5;
  const PALETTE_ALB = [[0, [165, 0, 38]], [0.25, [244, 109, 67]], [0.5, [255, 247, 214]], [0.75, [116, 173, 209]], [1, [49, 54, 149]]];
  const rampeAlbedo = (a) => {
    const t = Math.min(1, Math.max(0, (a - ALB_MIN) / (ALB_MAX - ALB_MIN)));
    for (let q = 1; q < PALETTE_ALB.length; q++) {
      if (t <= PALETTE_ALB[q][0]) { const [u0, c0] = PALETTE_ALB[q - 1], [u1, c1] = PALETTE_ALB[q], u = (t - u0) / (u1 - u0); return c0.map((v, i) => Math.round(v + (c1[i] - v) * u)); }
    }
    return PALETTE_ALB[PALETTE_ALB.length - 1][1];
  };
  const DEGRADE_ALB = `linear-gradient(90deg, ${PALETTE_ALB.map(([u, c]) => `rgb(${c.join(',')}) ${u * 100}%`).join(', ')})`;
  const GRADUATIONS_ALB = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5];
  // indice d'échauffement : température de surface de référence de chaque classe (temperatureReference, chaleur-modele.js),
  // du bleu (plus frais) au rouge (plus chaud) en passant par un blanc cassé, échelle sur la plage des valeurs des classes
  const PALETTE_ECH = [[0, [49, 54, 149]], [0.3, [69, 117, 180]], [0.5, [255, 247, 214]], [0.75, [244, 109, 67]], [1, [165, 0, 38]]];
  const interpoler = (P, t) => {
    t = Math.min(1, Math.max(0, t));
    for (let q = 1; q < P.length; q++) {
      if (t <= P[q][0]) { const [u0, c0] = P[q - 1], [u1, c1] = P[q], u = (t - u0) / (u1 - u0); return c0.map((v, i) => Math.round(v + (c1[i] - v) * u)); }
    }
    return P[P.length - 1][1];
  };
  const rampeEchauffement = (T) => interpoler(PALETTE_ECH, (T - etat.ech.min) / (etat.ech.max - etat.ech.min || 1));
  const graduationsEch = () => { const { min, max } = etat.ech, pas = max - min > 24 ? 10 : 5, L = [min]; for (let v = Math.ceil((min + 1) / pas) * pas; v < max; v += pas) L.push(v); L.push(max); return L; };
  // description du dégradé affiché (légende du panneau et export PNG de chaleur-points.js)
  function degradeActif() {
    if (etat.affichage === 'albedo') {
      return { palette: PALETTE_ALB, min: ALB_MIN, max: ALB_MAX, graduations: GRADUATIONS_ALB, texte: (a) => fmt(a, 2),
        gauche: '◀ plus chaud (albédo faible, absorbe)', droite: 'plus frais (albédo élevé, réfléchit) ▶' };
    }
    if (etat.affichage === 'echauffement' && etat.ech) {
      return { palette: PALETTE_ECH, min: etat.ech.min, max: etat.ech.max, graduations: graduationsEch(), texte: (t) => `${fmt(t)} °C`,
        gauche: '◀ plus frais', droite: 'plus chaud ▶' };
    }
    return null;
  }
  function legendeDegrade() {
    const D = degradeActif();
    if (!D) return null;
    return h('div', { class: 'legende-albedo' },
      h('div', { class: 'legende-albedo-barre', style: { background: `linear-gradient(90deg, ${D.palette.map(([u, c]) => `rgb(${c.join(',')}) ${u * 100}%`).join(', ')})` } }),
      h('div', { class: 'legende-albedo-graduations' }, ...D.graduations.map((a) => h('span', { style: { left: `${((a - D.min) / (D.max - D.min)) * 100}%` } }, D.texte(a)))),
      h('div', { class: 'legende-albedo-sens' }, h('span', {}, D.gauche), h('span', {}, D.droite)));
  }
  const couleurClasse = (c, mode) => (mode === 'albedo' ? rampeAlbedo(c.albedo) : mode === 'echauffement' ? rampeEchauffement(c.tref) : c.rgb);

  function poserTexture(G, couleurDe) {
    effacerCalque();
    const { n, x0, z0, pas } = G;
    const px = new Uint8Array(n * n * 4);
    for (let k = 0; k < n * n; k++) {
      const c = couleurDe(k);
      if (c) px.set([c[0], c[1], c[2], 225], k * 4);
    }
    const tex = new THREE.DataTexture(px, n, n, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(n * pas, n * pas).rotateX(-Math.PI / 2);
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -11, polygonOffsetUnits: -11 }));
    m.position.set(x0 + (n * pas) / 2, 0.33, z0 + (n * pas) / 2);
    m.name = 'chaleur-carte';
    m.renderOrder = 6;
    m.raycast = () => {};
    app.scene.add(m);
    etat.calque = m;
  }
  function effacerCalque() {
    if (!etat.calque) return;
    app.scene.remove(etat.calque);
    etat.calque.geometry.dispose();
    etat.calque.material.map.dispose();
    etat.calque.material.dispose();
    etat.calque = null;
  }

  // toits : couleur par bâtiment sur les sommets des pans (normale vers le haut), murs inchangés
  function colorierToits(G, couleurBat) {
    effacerToits(false);
    const col = new THREE.Color(), nrm = new THREE.Vector3();
    const modifies = new Set();
    for (let b = 0; b < G.batiments.length; b++) {
      const { e } = G.batiments[b];
      if (!e.mesh) continue;
      const c = couleurBat(b);
      if (!c) continue;
      const attr = e.mesh.geometry.getAttribute('color'), nor = e.mesh.geometry.getAttribute('normal');
      if (!attr || !nor) continue;
      col.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
      for (let v = e.debut; v < e.debut + e.nb; v++) {
        nrm.fromBufferAttribute(nor, v);
        if (nrm.y > 0.55) attr.setXYZ(v, col.r, col.g, col.b);
      }
      modifies.add(attr);
    }
    modifies.forEach((a) => { a.needsUpdate = true; });
    etat.toitsColores = true;
  }
  function effacerToits(restaurer = true) {
    if (!etat.toitsColores) return;
    etat.toitsColores = false;
    if (restaurer) app.cadastre?.majBatiments(true);
  }

  function afficher() {
    if (!etat.mat) return;
    if (etat.affichage === 'temperature') { if (etat.temp) afficherTemperature(); else lancerCalcul(); return; }
    const G = grille();
    const mode = etat.affichage;
    poserTexture(G, (k) => couleurCellule(G, k, mode));
    if (ui.toits?.checked) colorierToits(G, (b) => couleurClasse(classe(G.batiments[b].toit), mode));
    else effacerToits();
    majLegende(G);
  }
  function effacerTout() {
    effacerCalque();
    effacerToits();
    points?.effacer();
    if (ui.legende) ui.legende.replaceChildren();
  }

  // ------------------------------------------------------------
  // Légende et statistiques
  // ------------------------------------------------------------
  function statistiques(G) {
    const nb = new Map();
    let total = 0;
    for (let k = 0; k < G.cls.length; k++) { const c = G.cls[k]; if (c < BATI) { nb.set(c, (nb.get(c) || 0) + 1); total++; } }
    const toits = new Map();
    for (const b of G.batiments) toits.set(b.toit, (toits.get(b.toit) || 0) + b.cellules.length);
    return { nb, total, toits };
  }
  function majLegende(G) {
    if (!ui.legende) return;
    const s = statistiques(G);
    const m2 = G.pas * G.pas;
    let albMoy = 0;
    s.nb.forEach((v, c) => { albMoy += etat.classes[c].albedo * v; });
    albMoy /= Math.max(s.total, 1);
    const ech = etat.affichage === 'echauffement';
    const ligne = (c, nCell) => h('li', {}, h('i', { style: { background: etat.affichage === 'materiaux' ? c.couleur : `rgb(${couleurClasse(c, etat.affichage).join(',')})` } }),
      `${c.libelle} — ${ech ? `${fmt(c.tref)} °C de référence, ` : ''}albédo ${fmt(c.albedo, 2)}${nCell ? ` · ${Math.round((nCell * m2) / 10) * 10} m²` : ''}`);
    const sol = etat.classes.filter((c) => c.type === 'sol' && s.nb.get(etat.idx[c.id]));
    const toits = etat.classes.filter((c) => c.type === 'toit' && s.toits.get(c.id));
    ui.legende.replaceChildren(
      h('p', { class: 'resultat' }, `Sol libre du cercle d'analyse : ${Math.round((s.total * m2) / 100) * 100} m², albédo moyen ${fmt(albMoy, 2)} (maille de ${G.pas} m).`),
      h('p', { class: 'legende-titre' }, 'Sol'),
      h('ul', { class: 'legende legende-chaleur' }, ...sol.map((c) => ligne(c, s.nb.get(etat.idx[c.id])))),
      h('p', { class: 'legende-titre' }, ui.toits?.checked ? 'Toitures (colorées sur la maquette)' : 'Toitures (cocher « Colorer les toitures »)'),
      h('ul', { class: 'legende legende-chaleur' }, ...toits.map((c) => ligne(c, s.toits.get(c.id)))),
      legendeDegrade(),
      ech ? h('p', { class: 'note' }, `Couleur = température de surface d'équilibre de chaque matériau dans les mêmes conditions de référence (plein soleil ${REFERENCE.K} W/m², air ${REFERENCE.ta} °C, vent ${REFERENCE.v} m/s, ciel clair, sans ombre ; sol sous arbres : ${Math.round(REFERENCE.ombreArbres * 100)} % du rayonnement), d'après l'albédo, l'émissivité, l'évaporation et l'inertie de materiaux.json. L'herbe reste fraîche malgré un albédo moyen (${fmt(classe('pelouse')?.albedo ?? 0.23, 2)}) parce qu'elle évapore de l'eau (évapotranspiration) ; l'eau, par sa grande inertie ; le zinc chauffe faute d'émissivité et d'inertie.`) : null,
    );
  }

  // valeur sous le pointeur
  app.on('pointeurSol', ([x, z]) => {
    if (!ui.pointeur?.isConnected || !etat.grille || (!etat.calque && !etat.toitsColores)) return;
    ui.pointeur.textContent = decrire(x, z) || '';
  });
  function cellule(G, x, z) {
    const i = Math.floor((x - G.x0) / G.pas), j = Math.floor((z - G.z0) / G.pas);
    return i < 0 || j < 0 || i >= G.n || j >= G.n ? -1 : j * G.n + i;
  }
  function decrire(x, z) {
    const G = etat.grille, k = cellule(G, x, z);
    if (k < 0 || G.cls[k] === HORS) return '';
    if (G.cls[k] === BATI) {
      const b = G.batiments[G.bat[k]], c = classe(b.toit);
      return `${c.libelle} (albédo ${fmt(c.albedo, 2)}, émissivité ${fmt(c.emissivite, 2)}) — ${b.source}${b.bdtopo ? `, BD TOPO ${b.bdtopo}` : ''}`;
    }
    const c = etat.classes[G.cls[k]], zz = G.zones[G.zone[k]];
    const T = etat.affichage === 'temperature' && etat.temp?.G === G ? texteTemperature(k) : '';
    return `${T}${c.libelle} (albédo ${fmt(c.albedo, 2)}) — ${zz?.nom || ''}${zz?.surface ? ` (OSM surface=${zz.surface})` : ''}`;
  }

  // ------------------------------------------------------------
  // Corrections au clic
  // ------------------------------------------------------------
  const nouvelId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  function ajouterCorrection(c) {
    const liste = etat.corrections.filter((k) => !(k.type === c.type && c.cle && k.cle === c.cle));
    liste.push({ id: nouvelId(), ...c, date: new Date().toISOString().slice(0, 10) });
    etat.corrections = liste;
    etat.modifie = true;
    invalider();
    majCorrections();
  }
  function clic(p) {
    if (!p) return;
    const G = grille(), k = cellule(G, p[0], p[1]);
    if (k < 0 || G.cls[k] === HORS) { app.signaler('Hors du cercle d\'analyse.'); return; }
    const cl = classe(etat.classeChoisie);
    const g = app.proj.versGeo(p[0], p[1]);
    if (G.cls[k] === BATI) {
      if (cl.type !== 'toit') { app.signaler('Bâtiment : choisissez un matériau de toiture.'); return; }
      const b = G.batiments[G.bat[k]];
      ajouterCorrection({ type: 'toit', cle: cleBatiment(b.e), lat: r7(g.lat), lon: r7(g.lon), classe: cl.id });
      app.signaler(`Toiture corrigée : ${cl.libelle}.`);
      return;
    }
    if (cl.type !== 'sol') { app.signaler('Sol : choisissez un matériau de sol.'); return; }
    if (etat.modeCorrection === 'polygone') {
      etat.polygone.push([r7(g.lat), r7(g.lon)]);
      dessinerPolygone();
      majCorrections();
      return;
    }
    const zz = G.zones[G.zone[k]];
    if (etat.modeCorrection === 'element' && zz?.cle) {
      ajouterCorrection({ type: 'element', cle: zz.cle, nom: zz.nom, lat: r7(g.lat), lon: r7(g.lon), classe: cl.id });
      app.signaler(`${zz.nom} : ${cl.libelle}.`);
    } else {
      ajouterCorrection({ type: 'disque', lat: r7(g.lat), lon: r7(g.lon), rayon: etat.rayonDisque, classe: cl.id });
      app.signaler(`Disque de ${etat.rayonDisque} m : ${cl.libelle}.`);
    }
  }
  // tracé provisoire du polygone
  const ligneTrace = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xd4452a, depthTest: false }));
  ligneTrace.renderOrder = 9; ligneTrace.visible = false; ligneTrace.raycast = () => {}; ligneTrace.userData.pasDeRelief = true;
  app.scene.add(ligneTrace);
  function dessinerPolygone() {
    const pts = etat.polygone.map(([la, lo]) => { const q = app.proj.versLocal(la, lo); return new THREE.Vector3(q.x, (app.relief?.dz?.(q.x, q.z) || 0) + 0.6, q.z); });
    if (pts.length > 2) pts.push(pts[0].clone());
    ligneTrace.geometry.dispose();
    ligneTrace.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    ligneTrace.visible = pts.length > 1;
  }
  function terminerPolygone() {
    if (etat.polygone.length >= 3) {
      ajouterCorrection({ type: 'polygone', points: etat.polygone, classe: etat.classeChoisie });
      app.signaler(`Zone de ${etat.polygone.length} sommets : ${classe(etat.classeChoisie).libelle}.`);
    }
    etat.polygone = [];
    dessinerPolygone();
    majCorrections();
  }
  function commencerCapture() {
    if (!etat.calque) { etat.affichage = ['albedo', 'echauffement'].includes(etat.affichage) ? etat.affichage : 'materiaux'; afficher(); }
    const f = (p) => clic(p);
    app.captureSol = f;
    etat.capture = f;
    majCorrections();
  }
  function arreterCapture() {
    if (etat.capture && app.captureSol === etat.capture) app.captureSol = null;
    etat.capture = null;
    if (etat.polygone.length) { etat.polygone = []; dessinerPolygone(); }
    majCorrections();
  }
  async function enregistrer() {
    const d = { description: 'Corrections des matériaux de l\'outil Chaleur (onglet Ambiance) : type element (élément OSM, clé osm ou osm#trottoir), disque (centre lat/lon, rayon m), polygone (points lat/lon) ou toit (clé du bâtiment) ; classe = clé de materiaux.json.', corrections: etat.corrections };
    await enregistrerDonnees('chaleur/corrections.json', JSON.stringify(d, null, 1));
    etat.modifie = false;
    majCorrections();
  }
  function majCorrections() {
    if (!ui.corrections) return;
    ui.boutonCapture.textContent = etat.capture ? 'Arrêter la correction' : 'Corriger au clic';
    ui.boutonCapture.classList.toggle('actif', !!etat.capture);
    ui.terminer.hidden = !(etat.capture && etat.modeCorrection === 'polygone');
    ui.terminer.textContent = `Terminer la zone (${etat.polygone.length} points)`;
    ui.rayon.hidden = etat.modeCorrection === 'polygone';
    const L = etat.corrections;
    ui.corrections.replaceChildren(...(L.length ? L.map((c) => h('li', {},
      h('i', { style: { background: classe(c.classe)?.couleur } }),
      h('span', {}, `${classe(c.classe)?.libelle} — ${c.type === 'toit' ? 'toiture' : c.type === 'element' ? (c.nom || c.cle) : c.type === 'disque' ? `disque de ${c.rayon} m` : `zone de ${c.points.length} sommets`}`),
      h('button', { type: 'button', class: 'mini', title: 'Supprimer', 'aria-label': 'Supprimer la correction', onclick: () => { etat.corrections = etat.corrections.filter((k) => k !== c); etat.modifie = true; invalider(); majCorrections(); } }, '×')))
      : [h('li', { class: 'vide' }, 'Aucune correction.')]));
    ui.enregistrer.disabled = !etat.modifie;
    ui.enregistrer.textContent = etat.modifie ? 'Enregistrer les corrections' : 'Corrections enregistrées';
  }

  // ------------------------------------------------------------
  // Lot 2 : température de surface
  // ------------------------------------------------------------
  const PALETTE_T = [[15, [49, 54, 149]], [22, [69, 117, 180]], [28, [116, 173, 209]], [33, [171, 217, 233]], [38, [254, 224, 144]], [44, [253, 174, 97]], [50, [244, 109, 67]], [56, [215, 48, 39]], [63, [165, 0, 38]], [70, [103, 0, 31]]];
  function couleurT(t) {
    const P = PALETTE_T;
    if (t <= P[0][0]) return P[0][1];
    for (let q = 1; q < P.length; q++) {
      if (t <= P[q][0]) { const [a, ca] = P[q - 1], [b, cb] = P[q], u = (t - a) / (b - a); return ca.map((v, i) => Math.round(v + (cb[i] - v) * u)); }
    }
    return P[P.length - 1][1];
  }
  const DEGRADE_T = `linear-gradient(90deg, ${PALETTE_T.map(([t, c]) => `rgb(${c.join(',')}) ${Math.round(((t - 15) / 55) * 100)}%`).join(', ')})`;
  const fmtH = (t) => { const hh = Math.floor(t + 1e-6), mm = Math.round((t - hh) * 60); return `${hh} h${mm ? ` ${String(mm).padStart(2, '0')}` : ''}`; };

  // journées types : tirées de l'EPW actif (js/meteo.js), sinon data/chaleur/journees.json (Météo-France)
  const profils = () => journeesTypes()?.profils ?? etat.journees?.profils ?? {};
  function sourcesMeteo() {
    const L = [['mois', sourceEPW() ? `Moyenne du mois (EPW, ${libellePeriode()})` : 'Moyenne du mois (Météo-France 2016-2025)']];
    for (const [k, p] of Object.entries(profils())) L.push([k, p.libelle]);
    return L;
  }
  function jourSoleil() {
    const S = app.soleil.etat;
    return { ...dateDepuisJour(S.annee, S.jour), cle: `${S.annee}-${S.jour}` };
  }
  function heuresMeteo(source, d) {
    if (source !== 'mois' && profils()[source]) return profils()[source].heures;
    return horaire()?.moyennes?.[d.mois] || null;
  }

  // calcul complet (grille, ouverture au ciel, ombres, journée) au jour de la barre Soleil
  let minuterieCalcul = 0;
  function planifierCalcul() { clearTimeout(minuterieCalcul); minuterieCalcul = setTimeout(() => lancerCalcul(), 600); }
  async function lancerCalcul() {
    if (etat.calcul) { etat.relancer = true; return; }
    etat.calcul = true;
    points?.effacer();
    ui.boutonsTemp?.forEach((b) => { b.disabled = true; });
    try {
      do { etat.relancer = false; await calculerTemperature(); } while (etat.relancer);
      afficherTemperature();
      note('');
    } catch (e) { note(`Calcul impossible : ${e.message}`); console.warn(e); } finally {
      etat.calcul = false;
      ui.boutonsTemp?.forEach((b) => { b.disabled = false; });
    }
  }
  async function calculerTemperature({ grilleMat = null, garder = true } = {}) {
    await chargerMeteo();
    const d = jourSoleil();
    const heures = heuresMeteo(etat.meteo, d);
    if (!heures) throw new Error('météo horaire absente (data/meteo/meteo_horaire.json)');
    const G = grilleMat || grille();
    const S = app.soleil;
    const g = S.grilleHauteurs({ x0: -G.r, z0: -G.r, x1: G.r, z1: G.r });
    const P = preparerPoints(G, etat.classes, { HORS, BATI });
    // vent local : champ 2D de l'outil Vent s'il a été calculé, sinon vitesse réduite selon l'ouverture au ciel
    const V = app.vent?.etat, sv = V?.solveur, out = [0, 0];
    const champ = sv?.etat?.direction != null && V.vitesse > 0;
    await calculerSVF(P, g, S.hauteurEn, note);
    for (let i = 0; i < P.n; i++) P.fv[i] = champ && sv.echantillon(P.x[i], -P.z[i], out) ? Math.min(1.6, Math.hypot(out[0], out[1]) / V.vitesse) : 0.35 + 0.65 * P.svf[i];
    const { lat, lon } = app.config.soleil;
    const positions = positionsSoleil({ annee: d.annee, mois: d.mois, jour: d.jour, lat, lon });
    const M = await calculerMasques(P, g, S.hauteurEn, positions, note);
    note('Bilan d\'énergie de la journée…'); await new Promise((r) => setTimeout(r, 0));
    const R = simulerJournee(P, etat.classes, heures, positions, M);
    const idx = new Int32Array(G.n * G.n).fill(-1);
    for (let i = 0; i < P.nSol; i++) idx[P.k[i]] = i;
    const res = { G, P, R, M, positions, heures, d, source: etat.meteo, champ, idx, cle: d.cle, ta: (t) => heures[Math.min(23, Math.round(t))]?.ta };
    if (garder) etat.temp = res;
    return res;
  }

  // valeurs d'une carte : à l'heure t ou maximum du jour ; sol (par maille) et toits (moyenne par bâtiment)
  function valeursTemperature(res, t, mode) {
    const { G, P, R } = res;
    const sol = new Float32Array(G.n * G.n).fill(NaN);
    const toits = new Float64Array(G.batiments.length), nb = new Uint16Array(G.batiments.length);
    for (let i = 0; i < P.n; i++) {
      const v = mode === 'max' ? R.Tmax[i] : temperatureA(R, P.n, i, t);
      if (i < P.nSol) sol[P.k[i]] = v; else { toits[P.bat[i]] += v; nb[P.bat[i]]++; }
    }
    for (let b = 0; b < toits.length; b++) toits[b] = nb[b] ? toits[b] / nb[b] : NaN;
    return { sol, toits };
  }
  // part d'ombre d'une maille de 9 h à 19 h (points chauds en mode « maximum de la journée »)
  function partOmbreJour(res, i) {
    let o = 0, n = 0;
    for (let t = 9; t <= 19; t += PAS_INSTANTANE) { o += soleilA(res, i, t) < 0.5 ? 1 : 0; n++; }
    return o / n;
  }
  function soleilA(res, i, t) {
    const sf = t / PAS_INSTANTANE, s0 = Math.min(NB_INSTANTANES - 1, Math.floor(sf)), s1 = Math.min(NB_INSTANTANES - 1, s0 + 1), w = sf - s0;
    return res.M[s0 * res.P.n + i] * (1 - w) + res.M[s1 * res.P.n + i] * w;
  }

  function afficherTemperature() {
    const res = etat.temp;
    if (!res) return;
    const t = app.soleil.etat.heure, mode = etat.vueTemp;
    const V = valeursTemperature(res, t, mode);
    etat.valeursT = V;
    poserTexture(res.G, (k) => (Number.isFinite(V.sol[k]) ? couleurT(V.sol[k]) : null));
    if (ui.toits?.checked) colorierToits(res.G, (b) => (Number.isFinite(V.toits[b]) ? couleurT(V.toits[b]) : null)); else effacerToits();
    majLegendeTemperature(res, V, t, mode);
  }

  function texteTemperature(k) {
    const res = etat.temp, i = res?.idx[k];
    if (i == null || i < 0) return '';
    const t = app.soleil.etat.heure;
    return `${fmt(temperatureA(res.R, res.P.n, i, t), 1)} °C à ${fmtH(t)} (maximum ${fmt(res.R.Tmax[i], 1)} °C vers ${fmtH(res.R.hMax[i])}) · `;
  }

  // tableau par matériau : moyenne au soleil et à l'ombre
  function parMateriau(res, V, t, mode) {
    const acc = new Map();
    for (let i = 0; i < res.P.nSol; i++) {
      const v = V.sol[res.P.k[i]];
      if (!Number.isFinite(v)) continue;
      const c = res.P.cls[i];
      const ombre = mode !== 'max' && soleilA(res, i, t) < 0.5;
      const a = acc.get(c) || { s: 0, ns: 0, o: 0, no: 0, max: -1e9 };
      if (ombre) { a.o += v; a.no++; } else { a.s += v; a.ns++; }
      a.max = Math.max(a.max, v);
      acc.set(c, a);
    }
    return [...acc.entries()].sort((a, b) => (b[1].ns + b[1].no) - (a[1].ns + a[1].no));
  }

  function majLegendeTemperature(res, V, t, mode) {
    if (!ui.legende) return;
    const ok = [...V.sol].filter(Number.isFinite);
    const moy = ok.reduce((a, b) => a + b, 0) / Math.max(ok.length, 1);
    const min = Math.min(...ok), max = Math.max(...ok);
    const ta = mode === 'max' ? Math.max(...res.heures.filter(Boolean).map((x) => x.ta)) : res.ta(t);
    const lib = sourcesMeteo().find(([k]) => k === res.source)?.[1] || '';
    const titre = mode === 'max' ? `Maximum de la journée du ${res.d.jour} ${MOIS[res.d.mois]}` : `Le ${res.d.jour} ${MOIS[res.d.mois]} à ${fmtH(t)}`;
    const lignes = parMateriau(res, V, t, mode);
    const toitsOk = [...V.toits].filter(Number.isFinite);
    ui.legende.replaceChildren(
      h('p', { class: 'resultat' }, `${titre} : sol entre ${fmt(min)} et ${fmt(max)} °C (moyenne ${fmt(moy)} °C) pour un air à ${fmt(ta, 1)} °C${toitsOk.length ? ` ; toits jusqu'à ${fmt(Math.max(...toitsOk))} °C` : ''}. Météo : ${lib.toLowerCase()}.`),
      h('div', { class: 'legende-soleil' }, h('span', {}, '15 °C'), h('i', { style: { background: DEGRADE_T } }), h('span', {}, '70 °C')),
      h('table', { class: 'table-chaleur' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Matériau'), h('th', {}, mode === 'max' ? 'Moyenne' : 'Au soleil'), h('th', {}, mode === 'max' ? 'Maximum' : 'À l\'ombre'))),
        h('tbody', {}, ...lignes.map(([c, a]) => h('tr', {},
          h('td', {}, h('i', { style: { background: etat.classes[c].couleur } }), etat.classes[c].libelle),
          h('td', {}, mode === 'max' ? `${fmt((a.s + a.o) / Math.max(a.ns + a.no, 1))} °C` : a.ns ? `${fmt(a.s / a.ns)} °C` : '—'),
          h('td', {}, mode === 'max' ? `${fmt(a.max)} °C` : a.no ? `${fmt(a.o / a.no)} °C` : '—'))))),
      h('p', { class: 'note', 'data-garder': '' }, `Vent : ${res.champ ? 'champ local de l\'outil Vent' : 'vitesse mesurée réduite selon l\'ouverture au ciel (calculer le vent dans l\'outil Vent pour l\'affiner)'}. Estimation : ±5 °C au mieux.`),
    );
  }

  // la barre Soleil pilote la carte : même jour -> nouvel affichage instantané ; autre jour -> nouveau calcul
  let attenteSoleil = 0;
  app.on('soleil', () => {
    if (etat.affichage !== 'temperature' || !etat.temp || !ui.temp?.isConnected) return;
    if (etat.temp.cle === jourSoleil().cle) { cancelAnimationFrame(attenteSoleil); attenteSoleil = requestAnimationFrame(afficherTemperature); }
    else planifierCalcul();
  });

  function prereglage(cle) {
    const p = profils()[cle];
    const [mm, jj] = String(cle === 'chaude' ? '06-21' : p?.date || '07-18').split('-').map(Number);
    etat.meteo = cle;
    if (ui.selMeteo) ui.selMeteo.value = cle;
    etat.affichage = 'temperature';
    majChoix();
    const an = app.soleil.etat.annee;
    etat.temp = null;
    app.soleil.regler({ jour: jourDeLAnnee(new Date(an, mm - 1, jj)), heure: 15 });
    lancerCalcul();
  }

  function infoTemperature() {
    return info(
      'Bilan d\'énergie de surface simplifié, maille par maille (2 m) : rayonnement solaire direct (ombres réelles du bâti effectif — existant non démoli et volumes du projet — et des arbres, à la date de la barre Soleil) et diffus (pondéré par l\'ouverture au ciel), absorbé selon l\'albédo ; infrarouge du ciel (formule de Brutsaert, corrigée de la nébulosité estimée) et des façades voisines ; émission selon l\'émissivité ; convection h = 5,7 + 3,8 v avec le vent local ; évapotranspiration des sols végétaux (part fixe du rayonnement net) ; inertie par la méthode force-restore (effusivité du matériau).',
      'Météo (source choisie en tête du panneau) : moyenne horaire du mois (par défaut Météo-France, Nantes-Bouguenais, 2016-2025 ; ou fichier EPW, rayonnement direct et diffus du fichier), journée chaude type (moyenne heure par heure des jours d\'été à 30 °C ou plus) ou jour le plus chaud mesuré ; rayonnement direct et diffus estimés depuis le global mesuré (modèle d\'Erbs). La journée est simulée deux fois pour la mise en régime ; « Maximum de la journée » garde la valeur la plus haute de chaque maille.',
      'Toitures : quelques points par toit, sans pente ni orientation des pans (toit traité comme horizontal), toujours bien ventilés (vent × 0,8).',
      h('strong', {}, 'Limites : '), 'estimation pédagogique, à ±5 °C au mieux ; pas de réflexions multiples ni d\'ombre des façades sur elles-mêmes, pas d\'humidité du sol ni d\'arrosage, arbres opaques (12 % de lumière filtrée), pas de chaleur anthropique (circulation, climatisation), air supposé uniforme (pas d\'îlot de chaleur de l\'air), vent simplifié. Pour une étude : Ladybug Tools / ENVI-met avec un fichier EPW.',
      h('ol', { class: 'refs' }, ...(etat.mat?.modele || []).map((r) => h('li', {}, r))),
    );
  }

  function construireSectionTemperature() {
    ui.selMeteo = h('select', { 'aria-label': 'Météo', onchange: () => { etat.meteo = ui.selMeteo.value; if (etat.temp) { etat.temp = null; if (etat.affichage === 'temperature') lancerCalcul(); } } },
      ...sourcesMeteo().map(([k, l]) => h('option', { value: k }, l)));
    ui.selMeteo.value = etat.meteo;
    const bCalc = h('button', { type: 'button', class: 'bouton', onclick: () => { etat.affichage = 'temperature'; majChoix(); etat.temp = null; lancerCalcul(); } }, 'Calculer au jour et à l\'heure du soleil');
    const bChaude = h('button', { type: 'button', class: 'bouton discret', onclick: () => prereglage('chaude') }, 'Journée chaude type (21 juin, 15 h)');
    const rec = profils().record;
    const bRecord = rec ? h('button', { type: 'button', class: 'bouton discret', onclick: () => prereglage('record') }, `Jour le plus chaud (${rec.date.split('-').reverse().join('/')}, 15 h)`) : null;
    ui.boutonsTemp = [bCalc, bChaude, bRecord].filter(Boolean);
    const choixVue = h('div', { class: 'choix-chaleur', role: 'group', 'aria-label': 'Valeur affichée' },
      ...[['heure', 'À l\'heure du soleil'], ['max', 'Maximum de la journée']].map(([id, lib]) => h('button', {
        type: 'button', class: `bouton discret${etat.vueTemp === id ? ' actif' : ''}`, 'data-vue-temp': id,
        onclick: (e) => { etat.vueTemp = id; choixVue.querySelectorAll('button').forEach((b) => b.classList.toggle('actif', b === e.currentTarget)); if (etat.affichage === 'temperature' && etat.temp) afficherTemperature(); },
      }, lib)));
    ui.temp = h('div', { class: 'section-temperature' },
      h('div', { class: 'titre-info' }, h('h3', {}, 'Température de surface'), infoTemperature()),
      h('label', { class: 'champ' }, h('span', {}, 'Météo'), ui.selMeteo),
      h('div', { class: 'actions' }, ...ui.boutonsTemp),
      choixVue,
      h('p', { class: 'note', 'data-garder': '' }, 'Date et heure : barre Soleil en haut à droite (la carte suit l\'heure ; un autre jour relance le calcul).'));
    return ui.temp;
  }

  // ------------------------------------------------------------
  // Lot 3 : écart projet - existant, titre et légende pour les exports (js/chaleur-points.js)
  // ------------------------------------------------------------
  const DIVERGENT = [[-10, [33, 102, 172]], [-3.5, [146, 197, 222]], [0, [247, 247, 247]], [3.5, [244, 165, 130]], [10, [178, 24, 43]]];
  function couleurEcart(d) {
    const P = DIVERGENT;
    if (d <= P[0][0]) return P[0][1];
    for (let q = 1; q < P.length; q++) if (d <= P[q][0]) { const [a, ca] = P[q - 1], [b, cb] = P[q], u = (d - a) / (b - a); return ca.map((v, i) => Math.round(v + (cb[i] - v) * u)); }
    return P[P.length - 1][1];
  }
  function afficherEcart(E) {
    etat.affichage = 'ecart';
    majChoix();
    poserTexture(E.G, (k) => (Number.isFinite(E.D[k]) ? couleurEcart(E.D[k]) : null));
    effacerToits();
    if (ui.legende) ui.legende.replaceChildren(h('p', { class: 'resultat' }, 'Carte : écart de température de surface projet − existant (voir « Comparer » plus bas).'));
  }
  function titreCarte() {
    const res = etat.temp;
    if (etat.affichage === 'ecart') return 'écart projet − existant';
    if (etat.affichage !== 'temperature' || !res) return { albedo: 'albédo des surfaces', echauffement: `échauffement des matériaux (température de surface de référence, plein soleil, air ${REFERENCE.ta} °C)` }[etat.affichage] || 'matériaux des surfaces';
    const lib = sourcesMeteo().find(([k]) => k === res.source)?.[1] || '';
    return `${etat.vueTemp === 'max' ? 'maximum de la journée du' : 'température de surface le'} ${res.d.jour} ${MOIS[res.d.mois]}${etat.vueTemp === 'max' ? '' : ` à ${fmtH(app.soleil.etat.heure)}`} (${lib.toLowerCase()})`;
  }
  // légende automatique (js/legende.js) : la carte affichée, avec ses couleurs (mêmes palettes que le panneau)
  function legendeAuto() {
    if (!etat.calque || !etat.mat) return null;
    const titre = `Chaleur : ${titreCarte()}`;
    const D = degradeActif();
    if (D) return { id: 'chaleur', titre, note: 'Estimation pédagogique.',
      degrade: { stops: D.palette, graduations: D.graduations.map((a) => ({ u: (a - D.min) / (D.max - D.min), texte: D.texte(a) })), gauche: D.gauche.replace('◀ ', ''), droite: D.droite.replace(' ▶', '') } };
    if (etat.affichage === 'temperature') return { id: 'chaleur', titre, note: 'Estimation pédagogique, ±5 °C au mieux.',
      degrade: { stops: PALETTE_T.map(([t, c]) => [(t - 15) / 55, c]), graduations: [15, 30, 45, 60, 70].map((t) => ({ u: (t - 15) / 55, texte: `${t} °C` })) } };
    if (etat.affichage === 'ecart') return { id: 'chaleur', titre, note: 'Bleu : plus frais avec le projet.',
      degrade: { stops: DIVERGENT.map(([d, c]) => [(d + 10) / 20, c]), graduations: [-10, -5, 0, 5, 10].map((d) => ({ u: (d + 10) / 20, texte: `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} °C` })) } };
    const G = etat.grille;
    const presents = new Set();
    if (G) { for (let k = 0; k < G.cls.length; k++) if (G.cls[k] < BATI) presents.add(G.cls[k]); if (etat.toitsColores) for (const b of G.batiments) presents.add(etat.idx[b.toit]); }
    return { id: 'chaleur', titre, items: etat.classes.filter((c, i) => !G || presents.has(i)).map((c) => ({ libelle: `${c.libelle} (albédo ${fmt(c.albedo, 2)})`, couleur: c.couleur, forme: 'aplat' })) };
  }
  function texteLegende() {
    const L = [...(ui.legende?.querySelectorAll('.resultat, tr, li') || [])].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (etat.affichage === 'ecart' && points?.etat.ecart) L.unshift(...[...document.querySelectorAll('.section-temperature .resultat')].map((e) => e.textContent));
    return L.slice(0, 4).join('\n');
  }
  function zoneSous(x, z) {
    const G = grille(), k = cellule(G, x, z);
    if (k < 0 || G.cls[k] >= BATI) return null;
    return G.zones[G.zone[k]] || { nom: 'sol' };
  }
  function dansVariante(G, k, v) {
    if (v.type === 'element') return G.zones[G.zone[k]]?.cle === v.cle;
    const p = app.proj.versLocal(v.lat, v.lon);
    const x = G.x0 + ((k % G.n) + 0.5) * G.pas, z = G.z0 + (Math.floor(k / G.n) + 0.5) * G.pas;
    return Math.hypot(x - p.x, z - p.z) <= v.rayon;
  }
  const points = creerPointsChauds(app, {
    etat, note, classes: () => etat.classes, classe, soleilA, partOmbreJour, calculerTemperature, construireGrille, valeursTemperature,
    zoneSous, dansVariante, afficherEcart, titreCarte, texteLegende,
    degradeActif,
  });

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  function bandeau() {
    return h('p', { class: 'chaleur-bandeau', 'data-garder': '' }, h('strong', {}, 'Estimation pédagogique'), ' : ordres de grandeur pour comparer des matériaux et des situations, pas une simulation thermique certifiée.');
  }
  function infoMateriaux() {
    const refs = etat.mat?.references || [];
    return info(
      'Classes de matériaux déduites d\'OpenStreetMap (surface=*, landuse, leisure ; voirie de l\'atlas : chaussées, bandes de trottoir de 2,5 m, cheminements), complétées par l\'orthophoto IGN (végétal, sol clair) là où OSM ne dit rien, puis du sol sous les arbres et de vos corrections.',
      `Toitures : ${etat.toitures?.description || ''} Sources : ${etat.toitures?.source || ''}.`,
      etat.mat?.verification || '',
      'Albédo = part du rayonnement solaire réfléchie (0 = noir, 1 = blanc) ; émissivité = aptitude à rayonner sa chaleur en infrarouge ; effusivité = inertie (un matériau effusif se réchauffe lentement).',
      h('ol', { class: 'refs' }, ...refs.map((r) => h('li', { value: r.n }, r.texte))),
      'Valeurs moyennes de matériaux en place (vieillis) : un enrobé neuf est plus sombre, une dalle encrassée moins claire. Table modifiable dans data/chaleur/materiaux.json.',
    );
  }

  function construirePanneau(conteneur) {
    ui.etat = h('p', { class: 'note', role: 'status' });
    ui.legende = h('div');
    ui.pointeur = h('p', { class: 'coordonnees' });
    ui.toits = h('input', { type: 'checkbox', checked: etat.toitsColores, onchange: () => afficher() });
    const choixAffichage = h('div', { class: 'choix-chaleur', role: 'group', 'aria-label': 'Carte affichée' },
      ...[['materiaux', 'Matériaux'], ['echauffement', 'Échauffement des matériaux'], ['albedo', 'Albédo seul'], ['temperature', 'Température']].map(([id, lib]) => h('button', {
        type: 'button', class: `bouton discret${etat.affichage === id ? ' actif' : ''}`, 'data-carte': id,
        onclick: () => { etat.affichage = id; majChoix(); afficher(); },
      }, lib)));
    ui.choix = choixAffichage;
    // corrections
    const selClasse = h('select', { 'aria-label': 'Matériau à appliquer', onchange: () => { etat.classeChoisie = selClasse.value; } },
      h('optgroup', { label: 'Sol' }, ...etat.classes.filter((c) => c.type === 'sol').map((c) => h('option', { value: c.id }, c.libelle))),
      h('optgroup', { label: 'Toiture (clic sur un bâtiment)' }, ...etat.classes.filter((c) => c.type === 'toit').map((c) => h('option', { value: c.id }, c.libelle))));
    selClasse.value = etat.classeChoisie;
    const selMode = h('select', { 'aria-label': 'Étendue de la correction', onchange: () => { etat.modeCorrection = selMode.value; if (etat.polygone.length) { etat.polygone = []; dessinerPolygone(); } majCorrections(); } },
      h('option', { value: 'element' }, 'Élément OSM sous le clic (rue, place, jardin…)'),
      h('option', { value: 'disque' }, 'Disque autour du clic'),
      h('option', { value: 'polygone' }, 'Zone dessinée (clics successifs)'));
    selMode.value = etat.modeCorrection;
    const inRayon = h('input', { type: 'number', min: 1, max: 30, step: 1, value: etat.rayonDisque, onchange: () => { etat.rayonDisque = Math.min(30, Math.max(1, +inRayon.value || 4)); } });
    ui.rayon = h('label', { class: 'champ' }, h('span', {}, 'Rayon du disque (m)'), inRayon);
    ui.boutonCapture = h('button', { type: 'button', class: 'bouton', onclick: () => (etat.capture ? arreterCapture() : commencerCapture()) }, 'Corriger au clic');
    ui.terminer = h('button', { type: 'button', class: 'bouton', hidden: true, onclick: terminerPolygone }, 'Terminer la zone');
    ui.enregistrer = h('button', { type: 'button', class: 'bouton discret', onclick: enregistrer }, 'Enregistrer les corrections');
    ui.corrections = h('ul', { class: 'liste-corrections' });

    conteneur.append(
      bandeau(),
      app.meteoSource?.bloc(),
      h('div', { class: 'titre-info' }, h('h3', {}, 'Matériaux et albédo'), infoMateriaux()),
      choixAffichage,
      h('label', { class: 'case' }, ui.toits, ' Colorer les toitures'),
      ui.legende,
      ui.pointeur,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret', onclick: effacerTout }, 'Effacer la carte')),
      ui.etat,
      construireSectionTemperature(),
      points.construireSection(),
      h('div', { class: 'titre-info' }, h('h3', {}, 'Corriger un matériau'), info(
        'Choisir le matériau, l\'étendue, puis « Corriger au clic » et cliquer sur la carte : un élément OSM (toute la rue, la place ou le jardin), un disque, ou une zone dessinée point par point (« Terminer la zone »). Un clic sur un bâtiment corrige sa toiture (choisir un matériau de toiture).',
        'Les corrections sont enregistrées dans data/chaleur/corrections.json (coordonnées WGS84) par le serveur local de l\'atlas, sinon le fichier est téléchargé : le copier dans data/chaleur/.')),
      h('label', { class: 'champ' }, h('span', {}, 'Matériau'), selClasse),
      h('label', { class: 'champ' }, h('span', {}, 'Étendue'), selMode),
      ui.rayon,
      h('div', { class: 'actions' }, ui.boutonCapture, ui.terminer),
      ui.corrections,
      h('div', { class: 'actions' }, ui.enregistrer),
    );
    majCorrections();
    afficher();
  }

  function majChoix() {
    ui.choix?.querySelectorAll('button').forEach((b) => b.classList.toggle('actif', b.dataset.carte === etat.affichage));
  }

  async function construire(conteneur) {
    try { await charger(); } catch (e) { conteneur.append(h('p', { class: 'note', 'data-garder': '' }, `Outil Chaleur indisponible : ${e.message}.`)); return; }
    construirePanneau(conteneur);
  }

  app.on('outil', (id) => { if (id !== 'chaleur') { arreterCapture(); } });
  app.on('bati', () => { if (etat.grille && !etat.suspendu) invalider(); });
  // source météo changée (base / EPW) : section Température refaite (journées types), journée recalculée si affichée
  app.on('meteoSource', () => {
    if (!sourcesMeteo().some(([k]) => k === etat.meteo)) etat.meteo = 'mois';
    const avait = !!etat.temp;
    etat.temp = null;
    if (ui.temp?.isConnected) ui.temp.replaceWith(construireSectionTemperature());
    if (avait && etat.affichage === 'temperature') lancerCalcul();
  });
  app.on('etat', () => { if (etat.grille) invalider(); });

  return {
    etat, charger, construire, construireGrille, afficher, effacerTout, decrire, enregistrer,
    calculerTemperature, lancerCalcul, prereglage, valeursTemperature, points, legendeAuto, degradeActif,
    classes: () => etat.classes,
  };
}
