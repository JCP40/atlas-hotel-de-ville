import { h, info } from './util.js';
import { enregistrerDonnees } from './donnees.js';
import { pointDansPolygone } from './geo.js';
import { remplacerBlocFacade, serialiserFacades } from './calage-facades.js';
import { analyserPhoto, insererFacade } from './redressement-facades.js';
import * as V from './vision-facades.js';

// Assistant d'îlot (19/11/2026) : photos Panoramax de toutes les façades d'un ensemble (data/toits/<id>.json), ouvert par le
// bouton « Assistant d'îlot » du panneau Calage (js/calage-facades.js), chargé à la demande.
// Pour chaque façade (existante, ou mur de plus de 4 m sur rue sans photo, proposé comme façade à ajouter) :
// 1. recherche Panoramax (comme js/redressement-facades.js : bbox de 40 m, licences ouvertes), indicateurs analyserPhoto, puis
//    pour les 8 meilleures une image SD redressée « à l'aveugle » (GPS, azimut) qui donne des critères d'image : part du mur
//    masquée (approximation : pixels verts = végétation, pixels sombres ou saturés dans la bande 0-4 m = véhicules, vitrines),
//    netteté (laplacien rapporté au contraste) ; score sur 100 expliqué, 3 meilleures montrées, la 1re choisie ;
// 2. placement : photo HD, vue perspective d'analyse, js/vision-facades.js (verticales et horizontales par RANSAC, arêtes du
//    modèle, corniche à l'égout du modèle, hauteur de prise de vue a priori ± 0,8 m) → confiance bon / à vérifier / manuel ;
// 3. niveaux = ceux du bâtiment : image du SOL (base_m = 0) à l'ÉGOUT du corps (hauteur_m), ou au brisis / au sommet si
//    demandé ; lignes du modèle (sol, égout, brisis, sommet, planchers estimés si « etages ») sur l'aperçu ; réglage fin de la
//    corniche (haut du rectangle dans la photo, image toujours à la cote du modèle) ;
// 4. validation : toutes les façades à la même échelle verticale, alignées sur le sol ; Accepter / Corriger (outil de
//    redressement pré-rempli) / Ignorer ; aperçu sur la maquette ; « Enregistrer les façades acceptées » (JPEG + JSON,
//    anciennes versions gardées par serveur.py dans data/.sauvegardes/) ; rien n'est écrit sans confirmation.

const API = 'https://api.panoramax.xyz/api';
const RAD = Math.PI / 180;
const URL_LICENCES = {
  'Licence Ouverte 2.0 (Etalab)': 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
  'CC BY-SA 4.0': 'https://creativecommons.org/licenses/by-sa/4.0/deed.fr',
  'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/deed.fr',
  'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/deed.fr',
};
const NIVEAUX = { egout: 'égout', brisis: 'brisis', sommet: 'sommet' };
const CONFIANCES = { bon: 'bon', 'a-verifier': 'à vérifier', manuel: 'manuel' };
const DIRS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
const PPM_SORTIE = 60; // px/m de l'image enregistrée (≤ 2048 px de côté, comme l'outil de redressement)
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
const fr = (v, d = 1) => Number(v).toLocaleString('fr-FR', { maximumFractionDigits: d });
const aujourdhui = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const distSeg = (p, a, b) => {
  const vx = b[0] - a[0], vz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / (vx * vx + vz * vz || 1)));
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vz);
};

// Score d'une photo pour une façade (0-100, plus haut = meilleur) : géométrie, résolution utile, mur dégagé, netteté, date
export function scorePhoto(c, q, { netteteMax = 1, maintenant = Date.now() } = {}) {
  const parts = [];
  const geo = 35 * Math.max(0, 1 - c.obliquite / 60);
  parts.push(['vue', geo, `obliquité ${Math.round(c.obliquite)}°`]);
  const res = 20 * Math.min(1, c.pxm / 80);
  parts.push(['résolution', res, `≈ ${Math.round(c.pxm)} px/m sur le mur`]);
  const vis = q ? 20 * (1 - Math.min(1, q.masque * 1.5)) : 10;
  parts.push(['dégagé', vis, q ? `≈ ${Math.round(q.masque * 100)} % du mur masqué (végétation ${Math.round(q.vegetation * 100)} %, bas encombré ${Math.round(q.encombrement * 100)} %)` : 'image non analysée']);
  const net = q ? 10 * Math.min(1, q.nettete / (netteteMax || 1)) : 5;
  parts.push(['netteté', net, q ? `netteté ${Math.round((q.nettete / (netteteMax || 1)) * 100)} % de la meilleure` : '']);
  const age = c.date ? (maintenant - Date.parse(c.date)) / (365.25 * 864e5) : 10;
  const rec = 15 * Math.max(0, 1 - age / 8);
  parts.push(['date', rec, c.date ? `prise il y a ${fr(Math.max(0, age), 1)} an${age >= 2 ? 's' : ''}` : 'date inconnue']);
  let total = parts.reduce((s, p) => s + p[1], 0);
  const malus = [];
  if (!c.dansChamp) { total -= 25; malus.push('façade hors du champ'); }
  if (c.angleFacade > 110) { total -= 10; malus.push('trop près (façade très large dans le champ)'); }
  if (q && q.hors > 0.25) { total -= 25 * q.hors; malus.push(`${Math.round(q.hors * 100)} % du mur hors de l'image`); }
  if (c.distance < 4) { total -= 10; malus.push('à moins de 4 m'); }
  return { total: Math.max(0, Math.round(total)), parts, malus };
}

export function creerAssistantIlot(app, calage) {
  const T = app.toits;
  const etat = { ens: null, items: [], pile: [], refaire: [], apercus: new Map(), occupe: false };
  const ui = {};
  const sol = (x, z) => (app.relief?.dz ? app.relief.dz(x, z) || 0 : 0);

  if (!document.getElementById('styles-assistant-ilot')) {
    document.head.append(h('style', { id: 'styles-assistant-ilot' }, `
.ailot-fond { position: fixed; inset: 0; z-index: 1990; background: rgba(30, 40, 48, 0.45); display: flex; }
.ailot-boite { margin: 2vh 2vw; flex: 1; background: var(--calque-plein, #f6f8f7); color: var(--ardoise, #2f3b45); border-radius: 6px; box-shadow: var(--ombre);
  display: grid; grid-template-rows: auto 1fr auto; min-height: 0; overflow: hidden; font-size: 13px; }
.ailot-tete, .ailot-pied { display: flex; gap: 8px; align-items: center; padding: 8px 12px; flex-wrap: wrap; }
.ailot-tete { border-bottom: 1px solid var(--trait); } .ailot-pied { border-top: 1px solid var(--trait); }
.ailot-tete h2 { font: 500 17px var(--serif, serif); margin: 0 auto 0 0; }
.ailot-corps { overflow: auto; padding: 8px 12px; }
.ailot-facade { display: grid; grid-template-columns: 200px minmax(260px, 1fr) minmax(280px, 1.2fr); gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--trait); }
.ailot-facade.ignoree { opacity: 0.5; } .ailot-facade.acceptee { background: rgba(27, 122, 69, 0.06); }
.ailot-cands { display: grid; gap: 4px; align-content: start; }
.ailot-cand { display: grid; grid-template-columns: 88px 1fr; gap: 6px; padding: 4px; border: 1px solid var(--trait); border-radius: 4px; background: #fff; cursor: pointer; }
.ailot-cand[aria-current='true'] { outline: 2px solid var(--ardoise); }
.ailot-cand img { width: 88px; height: 58px; object-fit: cover; background: #dde; }
.ailot-cand small { display: block; color: var(--ardoise-doux, #5a6670); line-height: 1.25; }
.ailot-res canvas { width: 100%; max-height: 340px; background: #20282e; border-radius: 4px; display: block; }
.ailot-res .ligne { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 4px; }
.ailot-badge { padding: 1px 6px; border-radius: 3px; color: #fff; font-weight: 600; }
.ailot-badge.bon { background: #1b7a45; } .ailot-badge.a-verifier { background: #b07400; } .ailot-badge.manuel { background: #b3261e; } .ailot-badge.attente { background: #6b7780; }
.ailot-comparaison { width: 100%; background: #20282e; border-radius: 4px; display: block; }
.ailot-credit { font-size: 12px; color: var(--ardoise-doux, #5a6670); }
`));
  }

  // ---------------------------------------------------------------- façades et murs de l'ensemble
  const corpsDe = (ens, f) => {
    const corps = ens.donnees?.corps || [];
    const ids = f.corps || [];
    const cands = corps.filter((c) => ids.includes(c.id));
    const liste = cands.length ? cands : corps;
    // corps dont un côté d'emprise est le plus proche du milieu de la façade
    const m = [(f.gauche[0] + f.droite[0]) / 2, (f.gauche[1] + f.droite[1]) / 2];
    let best = liste[0], dmin = Infinity;
    for (const c of liste) {
      const E = c.emprise || [];
      for (let i = 0; i < E.length; i++) { const d = distSeg(m, E[i], E[(i + 1) % E.length]); if (d < dmin) { dmin = d; best = c; } }
    }
    return best;
  };
  const niveauxDe = (c) => {
    const t = c?.toit || {};
    const n = { egout: t.h_egout || 10 };
    if (t.h_brisis > n.egout + 0.3) n.brisis = t.h_brisis;
    if (t.h_faitage > (n.brisis || n.egout) + 0.3) n.sommet = t.h_faitage;
    return n;
  };
  function mursSansPhoto(ens) {
    const res = [];
    const existantes = ens.facades?.facades || [];
    const toutes = T.toutesFacades();
    const autres = (app.empreintes || []).map((e) => e.polys?.[0]?.[0]).filter((r) => r?.length >= 3);
    for (const c of ens.donnees?.corps || []) {
      const E = c.emprise || [];
      for (let i = 0; i < E.length; i++) {
        const a = E[i], b = E[(i + 1) % E.length];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 4) continue;
        let n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointDansPolygone(m[0] + n[0] * 0.3, m[1] + n[1] * 0.3, E)) n = [-n[0], -n[1]];
        // déjà couvert par une façade (milieu du mur sur le segment de la façade, à moins de 1,5 m)
        if ([...existantes, ...toutes].some((f) => distSeg(m, f.gauche, f.droite) < 1.5 && Math.abs(((f.droite[0] - f.gauche[0]) * n[0] + (f.droite[1] - f.gauche[1]) * n[1])) < 0.3 * Math.hypot(f.droite[0] - f.gauche[0], f.droite[1] - f.gauche[1]))) continue;
        // côté rue : point à 3 m devant le mur hors de tout autre corps et de tout bâtiment chargé
        const q = [m[0] + n[0] * 3, m[1] + n[1] * 3];
        if ((ens.donnees.corps || []).some((k) => k !== c && k.emprise?.length >= 3 && pointDansPolygone(q[0], q[1], k.emprise))) continue;
        if (autres.some((r) => pointDansPolygone(q[0], q[1], r))) continue;
        const az = Math.round(((Math.atan2(n[0], -n[1]) / RAD) + 360) % 360);
        const R = [-Math.cos(az * RAD), -Math.sin(az * RAD)];
        const [g, d] = (b[0] - a[0]) * R[0] + (b[1] - a[1]) * R[1] >= 0 ? [a, b] : [b, a];
        const dir = DIRS[Math.round(az / 45) % 8];
        let id = `${ens.id}-${dir}`, k = 2;
        while ([...toutes, ...res.map((x) => x.f)].some((x) => x.id === id)) id = `${ens.id}-${dir}-${k++}`;
        const f = { id, nom: `${(c.nom || c.id).split('(')[0].trim()}, façade ${dir}`, corps: [c.id], gauche: [r2(g[0]), r2(g[1])], droite: [r2(d[0]), r2(d[1])], normale_az: az, hauteur_m: r2(c.toit?.h_egout || 10), image: `${id}.jpg` };
        res.push({ f, corps: c });
      }
    }
    return res;
  }

  function preparer(ensId) {
    const ens = T.ensembles.find((e) => e.id === ensId);
    etat.ens = ens;
    etat.items = [];
    for (const f of ens.facades?.facades || []) {
      const c = corpsDe(ens, f);
      etat.items.push(nouvelItem(f, c, null));
    }
    for (const { f, corps } of mursSansPhoto(ens)) etat.items.push(nouvelItem(f, corps, { ensemble: ens.id, corps: corps.id }));
    etat.pile = []; etat.refaire = [];
  }
  function nouvelItem(f, corps, nouvelle) {
    return {
      f, corps, nouvelle, niveaux: niveauxDe(corps), etages: corps?.etages?.n || null,
      candidats: [], choix: -1, haut: 'egout', decalage: 0, statut: nouvelle ? 'propose-ajout' : 'propose',
      analyses: new Map(), message: 'En attente', ui: {},
    };
  }

  // ---------------------------------------------------------------- Panoramax
  async function lireJSON(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (!r.ok) throw new Error(`Panoramax a répondu ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  function bbox(x, z, rayon) {
    const a = app.proj.versGeo(x - rayon, z + rayon), b = app.proj.versGeo(x + rayon, z - rayon);
    return [a.lon, a.lat, b.lon, b.lat].map((v) => v.toFixed(6)).join(',');
  }
  async function chargerImage(url) {
    const r = await fetch(url, { referrerPolicy: 'no-referrer', credentials: 'omit' });
    if (!r.ok) throw new Error(`image : ${r.status}`);
    const b = await r.blob();
    return b.type.startsWith('image/') ? b : new Blob([b], { type: 'image/jpeg' });
  }
  async function donnees(blob, maxL = 8192) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, maxL / bmp.width);
    const W = Math.round(bmp.width * k), Hh = Math.round(bmp.height * k);
    const c = document.createElement('canvas'); c.width = W; c.height = Hh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, W, Hh);
    bmp.close?.();
    return ctx.getImageData(0, 0, W, Hh);
  }
  const geomFacade = (it) => {
    const f = it.f;
    const M = [(f.gauche[0] + f.droite[0]) / 2, (f.gauche[1] + f.droite[1]) / 2];
    return { M, sol: sol(M[0], M[1]), L: Math.hypot(f.droite[0] - f.gauche[0], f.droite[1] - f.gauche[1]) };
  };
  // pose nominale (GPS, azimut, hauteur a priori) : vue d'analyse tirée du panorama, ou photo plane (largeur W)
  function nominaleDe(it, c, img, fpxMax) {
    const G = geomFacade(it);
    const hc = c.pano ? 2.5 : 1.8;
    const P = [c.x, sol(c.x, c.z) + hc, c.z];
    if (c.pano) {
      const f = it.f, top = G.sol + Math.max(...Object.values(it.niveaux)) + 1;
      const u = [(f.droite[0] - f.gauche[0]) / G.L, (f.droite[1] - f.gauche[1]) / G.L];
      const ext = [[f.gauche[0] - u[0] * 4, top, f.gauche[1] - u[1] * 4], [f.droite[0] + u[0] * 4, top, f.droite[1] + u[1] * 4],
        [f.droite[0] + u[0] * 4, G.sol - 1, f.droite[1] + u[1] * 4], [f.gauche[0] - u[0] * 4, G.sol - 1, f.gauche[1] - u[1] * 4]];
      const v = V.vueAnalyse(P, ext, { fpxMax: Math.min(fpxMax, img.width / (2 * Math.PI)) });
      return { nominale: V.poseNominale({ P, ...v }), hc };
    }
    return { nominale: V.poseNominale({ P, yaw: Number.isFinite(c.az) ? c.az : c.visee, pitch: 0, fov: c.fov, W: img.width, H: img.height }), hc };
  }

  async function chercher(it) {
    const G = geomFacade(it);
    it.message = 'Recherche sur Panoramax…'; majItem(it);
    const vus = new Map();
    let url = `${API}/search?bbox=${bbox(G.M[0], G.M[1], 40)}&limit=200`;
    for (let page = 0; url && page < 4; page++) {
      const d = await lireJSON(url);
      for (const x of d.features || []) if (x?.id && x.geometry && !vus.has(x.id)) vus.set(x.id, x);
      url = (d.links || []).find((l) => l.rel === 'next')?.href || null;
    }
    const liste = [...vus.values()].map((feat) => analyserPhoto(feat, it.f, app.proj))
      .filter((c) => c.utilisable && c.distance <= 40 && c.dansChamp).sort((a, b) => a.note - b.note).slice(0, 8);
    it.message = `${vus.size} photos à moins de 40 m, ${liste.length} retenues pour l'analyse d'image…`; majItem(it);
    // critères d'image sur l'image SD redressée « à l'aveugle » (GPS, azimut)
    const qs = [];
    for (const c of liste) {
      try {
        const img = await donnees(await chargerImage(c.sd || c.hd), 2048);
        const { nominale } = nominaleDe(it, c, img, 400);
        const vue = c.pano ? { equi: img, az0: c.az } : { src: img, echelle: 1 };
        const haut = it.niveaux.egout, pxm = Math.max(4, Math.min(12, 400 / Math.max(G.L, haut)));
        const W = Math.max(8, Math.round(G.L * pxm)), H = Math.max(8, Math.round(haut * pxm));
        const R = V.redresserPose({ ...vue, nominale, pose: nominale, gauche: it.f.gauche, droite: it.f.droite, sol: G.sol, haut, W, H });
        qs.push(V.qualiteFacade(R, pxm, R.hors));
      } catch (err) { console.warn(err); qs.push(null); }
    }
    const nMax = Math.max(1e-6, ...qs.filter(Boolean).map((q) => q.nettete));
    liste.forEach((c, i) => { c.qualite = qs[i]; c.score = scorePhoto(c, qs[i], { netteteMax: nMax }); });
    liste.sort((a, b) => b.score.total - a.score.total);
    it.candidats = liste.slice(0, 3);
    it.message = it.candidats.length ? '' : 'Aucune photo utilisable (licence ouverte, côté rue, façade dans le champ) à moins de 40 m.';
    if (!it.candidats.length) it.statut = 'sans-photo';
  }

  async function placer(it, k) {
    const c = it.candidats[k];
    if (!c) return;
    it.choix = k;
    let A = it.analyses.get(c.id);
    if (!A) {
      it.message = `Photo HD ${c.id.slice(0, 8)} : chargement…`; majItem(it);
      const blob = await chargerImage(c.hd || c.sd);
      it.message = 'Analyse d\'image (segments, points de fuite, arêtes, corniche)…'; majItem(it);
      await new Promise((r) => setTimeout(r, 20));
      const img = await donnees(blob, c.pano ? 8192 : 1600);
      const G = geomFacade(it);
      const { nominale, hc } = nominaleDe(it, c, img, 700);
      const vue = c.pano ? V.rendreVue(img, c.az, nominale) : img;
      const t0 = performance.now();
      const r = V.placerFacade(V.gradients(V.gris(vue)), nominale, { gauche: it.f.gauche, droite: it.f.droite, sol: G.sol, hauts: it.niveaux, emprise: it.corps?.emprise }, { sol, hCam: hc });
      // largeur de l'image HD (photo plane : rapport HD / image analysée)
      const largeurHD = c.dims?.[0] || img.width;
      A = { c, blob, nominale, vue, r, pano: c.pano, echelle: c.pano ? 1 : largeurHD / img.width, largeurHD, hauteurHD: c.dims?.[1] || img.height, ms: Math.round(performance.now() - t0) };
      it.analyses.set(c.id, A);
    }
    it.analyse = A;
    it.confiance = A.r.confiance;
    it.message = '';
    rendreApercu(it);
    majItem(it);
    dessinerComparaison();
  }

  // ---------------------------------------------------------------- rendus
  const hautDe = (it) => it.niveaux[it.haut] ?? it.niveaux.egout;
  function rendreFacade(it, pxm, { hd = null } = {}) {
    const A = it.analyse, G = geomFacade(it), haut = hautDe(it);
    const W = Math.max(8, Math.round(G.L * pxm)), H = Math.max(8, Math.round(haut * pxm));
    const commun = { nominale: A.nominale, pose: A.r.pose, gauche: it.f.gauche, droite: it.f.droite, sol: G.sol, haut, decalageHaut: it.decalage, W, H };
    if (hd) return V.redresserPose({ ...commun, ...(A.pano ? { equi: hd, az0: A.c.az } : { src: hd, echelle: hd.width / A.vue.width }) });
    return V.redresserPose({ ...commun, src: A.vue, echelle: 1 });
  }
  function rendreApercu(it) {
    if (!it.analyse) return;
    const haut = hautDe(it), G = geomFacade(it);
    const pxm = Math.min(30, 700 / Math.max(G.L, haut));
    const R = rendreFacade(it, pxm);
    const c = document.createElement('canvas'); c.width = R.width; c.height = R.height;
    c.getContext('2d').putImageData(new ImageData(R.data, R.width, R.height), 0, 0);
    it.rendu = { canvas: c, pxm, haut };
  }
  // lignes de référence du modèle : [cote (m au-dessus du sol), libellé, couleur, pointillé]
  function lignesNiveaux(it) {
    const n = it.niveaux, L = [[0, 'sol', '#4dd17a', false], [n.egout, `égout ${fr(n.egout)} m`, '#ffd400', false]];
    if (n.brisis) L.push([n.brisis, `brisis ${fr(n.brisis)} m`, '#ff8a3d', false]);
    if (n.sommet) L.push([n.sommet, `sommet ${fr(n.sommet)} m`, '#ff5c8a', false]);
    if (it.etages > 1) for (let k = 1; k < it.etages; k++) L.push([(n.egout * k) / it.etages, k === 1 ? `planchers estimés (${it.etages} niv.)` : '', '#9fd8ff', true]);
    return L;
  }
  function dessinerApercu(it) {
    const cv = it.ui.canvas;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!it.rendu) { cv.width = 400; cv.height = 120; ctx.fillStyle = '#20282e'; ctx.fillRect(0, 0, 400, 120); ctx.fillStyle = '#ccd'; ctx.font = '13px sans-serif'; ctx.fillText(it.message || 'Pas d\'aperçu', 10, 60); return; }
    const { canvas: im, pxm, haut } = it.rendu;
    const marge = 92;
    cv.width = im.width + marge; cv.height = im.height + 16;
    ctx.fillStyle = '#20282e'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(im, 0, 8);
    ctx.font = '11px sans-serif';
    for (const [z, lib, coul, tir] of lignesNiveaux(it)) {
      if (z > haut + 1e-6) continue;
      const y = 8 + im.height - z * pxm;
      ctx.setLineDash(tir ? [6, 4] : []); ctx.lineWidth = tir ? 1 : 1.5; ctx.strokeStyle = coul;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(im.width + 6, y); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = coul; if (lib) ctx.fillText(lib, im.width + 8, y + 4);
    }
  }
  function dessinerComparaison() {
    const cv = ui.comparaison;
    if (!cv) return;
    const items = etat.items.filter((it) => it.rendu && it.statut !== 'ignore');
    const ctx = cv.getContext('2d');
    const hmax = Math.max(1, ...items.map((it) => hautDe(it)), ...etat.items.map((it) => it.niveaux.sommet || it.niveaux.brisis || it.niveaux.egout));
    const pxm = 230 / hmax;
    const larg = items.reduce((s, it) => s + geomFacade(it).L * pxm + 12, 70);
    cv.width = Math.max(400, Math.round(larg)); cv.height = 260;
    ctx.fillStyle = '#20282e'; ctx.fillRect(0, 0, cv.width, cv.height);
    const ySol = 250;
    let x = 60;
    ctx.font = '11px sans-serif';
    for (const it of items) {
      const w = geomFacade(it).L * pxm, hh = hautDe(it) * pxm;
      ctx.drawImage(it.rendu.canvas, x, ySol - hh, w, hh);
      ctx.fillStyle = '#fff'; ctx.fillText(it.f.id.slice(0, Math.max(4, Math.floor(w / 6))), x + 2, 12);
      x += w + 12;
    }
    // lignes de référence communes (niveaux du premier corps ; les corps différents ont leurs propres lignes sur chaque aperçu)
    const n = etat.items[0]?.niveaux || {};
    for (const [z, lib, coul] of [[0, 'sol', '#4dd17a'], [n.egout, 'égout', '#ffd400'], [n.brisis, 'brisis', '#ff8a3d'], [n.sommet, 'sommet', '#ff5c8a']]) {
      if (!Number.isFinite(z)) continue;
      const y = ySol - z * pxm;
      ctx.strokeStyle = coul; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = coul; ctx.fillText(`${lib} ${fr(z)} m`, 2, y - 3);
    }
  }

  // ---------------------------------------------------------------- annulation
  const instantane = () => etat.items.map((it) => ({ statut: it.statut, choix: it.choix, haut: it.haut, decalage: it.decalage }));
  function memoriser() { etat.pile.push(instantane()); etat.refaire = []; majPied(); }
  async function restaurer(s) {
    for (const [i, v] of s.entries()) {
      const it = etat.items[i];
      const changeChoix = v.choix !== it.choix;
      Object.assign(it, { statut: v.statut, haut: v.haut, decalage: v.decalage });
      if (changeChoix && v.choix >= 0) await placer(it, v.choix); else { rendreApercu(it); majItem(it); }
    }
    dessinerComparaison(); majPied();
  }
  async function annuler() { if (!etat.pile.length) return; etat.refaire.push(instantane()); await restaurer(etat.pile.pop()); }
  async function retablir() { if (!etat.refaire.length) return; etat.pile.push(instantane()); await restaurer(etat.refaire.pop()); }

  // ---------------------------------------------------------------- fenêtre
  function libelleStatut(it) {
    return { propose: 'proposée', 'propose-ajout': 'nouvelle façade proposée', accepte: 'acceptée', ignore: 'ignorée', corrigee: 'corrigée dans l\'outil de redressement', 'sans-photo': 'sans photo' }[it.statut] || it.statut;
  }
  function construireItem(it) {
    const f = it.f;
    it.ui.canvas = h('canvas', { 'aria-label': `Aperçu redressé : ${f.nom}` });
    it.ui.cands = h('div', { class: 'ailot-cands' });
    it.ui.etat = h('div', { class: 'ligne' });
    it.ui.haut = h('select', { 'aria-label': 'Haut de l\'image', onchange: () => { memoriser(); it.haut = it.ui.haut.value; rendreApercu(it); majItem(it); dessinerComparaison(); } },
      ...Object.keys(it.niveaux).map((k) => h('option', { value: k }, `jusqu'au ${NIVEAUX[k]} (${fr(it.niveaux[k])} m)`)));
    it.ui.corniche = h('input', { type: 'range', min: -1.5, max: 1.5, step: 0.05, value: it.decalage, 'aria-label': 'Réglage fin de la corniche (m)', style: { width: '140px' },
      onpointerdown: () => memoriser(), onkeydown: () => memoriser(),
      oninput: () => { it.decalage = +it.ui.corniche.value; it.ui.valCorniche.textContent = `${it.decalage >= 0 ? '+' : '−'}${fr(Math.abs(it.decalage), 2)} m`; rendreApercu(it); dessinerApercu(it); },
      onchange: () => dessinerComparaison() });
    it.ui.valCorniche = h('span', { class: 'discret' }, '0 m');
    it.ui.boutons = h('div', { class: 'ligne' },
      h('button', { type: 'button', class: 'bouton petit', onclick: () => { memoriser(); it.statut = 'accepte'; majItem(it); majPied(); } }, 'Accepter'),
      h('button', { type: 'button', class: 'bouton discret petit', onclick: () => corriger(it), title: 'Ouvre l\'outil de redressement avec cette photo et ces coins (enregistrement par cet outil)' }, 'Corriger'),
      h('button', { type: 'button', class: 'bouton discret petit', onclick: () => { memoriser(); it.statut = 'ignore'; majItem(it); dessinerComparaison(); majPied(); } }, 'Ignorer'),
      h('button', { type: 'button', class: 'bouton discret petit', onclick: () => analyserItem(it, true), title: 'Relancer la recherche et le placement' }, '↻'));
    it.ui.credit = h('div', { class: 'ailot-credit' });
    it.ui.racine = h('div', { class: 'ailot-facade' },
      h('div', {}, h('strong', {}, f.nom), h('br'),
        h('span', { class: 'discret' }, `${f.id} · ${fr(geomFacade(it).L)} m · ${it.corps?.id || '—'}`), h('br'),
        h('span', { class: 'discret' }, `niveaux du modèle : sol 0, égout ${fr(it.niveaux.egout)}${it.niveaux.brisis ? `, brisis ${fr(it.niveaux.brisis)}` : ''}${it.niveaux.sommet ? `, sommet ${fr(it.niveaux.sommet)}` : ''} m${it.etages ? ` · ${it.etages} niveaux sous l'égout` : ''}`),
        it.ui.statut = h('p', { class: 'note', role: 'status', style: { margin: '4px 0' } })),
      it.ui.cands,
      h('div', { class: 'ailot-res' }, it.ui.canvas, it.ui.etat,
        h('div', { class: 'ligne' }, it.ui.haut, h('span', {}, 'Corniche'), it.ui.corniche, it.ui.valCorniche), it.ui.boutons, it.ui.credit));
    majItem(it);
    return it.ui.racine;
  }
  function majItem(it) {
    if (!it.ui.racine) return;
    it.ui.racine.className = `ailot-facade${it.statut === 'ignore' ? ' ignoree' : it.statut === 'accepte' ? ' acceptee' : ''}`;
    it.ui.statut.textContent = `${libelleStatut(it)}${it.message ? ` · ${it.message}` : ''}`;
    it.ui.haut.value = it.haut;
    it.ui.corniche.value = it.decalage;
    it.ui.valCorniche.textContent = `${it.decalage >= 0 ? '+' : '−'}${fr(Math.abs(it.decalage), 2)} m`;
    it.ui.cands.replaceChildren(...it.candidats.map((c, k) => h('div', { class: 'ailot-cand', role: 'button', tabindex: 0, 'aria-current': k === it.choix ? 'true' : 'false',
      title: [`${c.id}`, ...c.score.parts.map(([n, v, t]) => `${n} ${Math.round(v)} : ${t}`), ...c.score.malus.map((m) => `− ${m}`)].join('\n'),
      onclick: () => { if (k !== it.choix) { memoriser(); placer(it, k); } }, onkeydown: (e) => { if (e.key === 'Enter' && k !== it.choix) { memoriser(); placer(it, k); } } },
    h('img', { src: c.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
    h('div', {}, h('strong', {}, `${c.score.total}/100`), ` · ${c.pano ? '360°' : `plan ${Math.round(c.fov)}°`} · ${Math.round(c.distance)} m`,
      h('small', {}, c.score.parts.map(([n, v]) => `${n} ${Math.round(v)}`).join(' · ')),
      h('small', {}, `${c.score.parts[2][2]}${c.score.malus.length ? ` · ${c.score.malus.join(', ')}` : ''}`),
      h('small', {}, `${(c.date || '').split('-').reverse().join('/')} · ${c.auteur} · ${c.licence}`)))));
    const A = it.analyse, r = A?.r;
    it.ui.etat.replaceChildren(...(r ? [
      h('span', { class: `ailot-badge ${r.confiance}` }, CONFIANCES[r.confiance]),
      h('span', {}, r.erreur_m != null ? `erreur estimée ≈ ± ${fr(r.erreur_m, 2)} m (estimation interne)` : 'coins estimés (GPS, azimut) : à corriger'),
      h('span', { class: 'discret' }, `prise de vue ${fr(r.pose.P[1] - sol(r.pose.P[0], r.pose.P[2]), 2)} m · caméra déplacée de ${fr(Math.hypot(r.pose.P[0] - A.c.x, r.pose.P[2] - A.c.z), 1)} m / GPS · verticales ${fr(r.etapes.rotation?.inclinaison || 0, 2)}°`),
      r.raisons?.length ? h('span', { class: 'discret' }, `(${r.raisons.join(', ')})`) : '',
    ] : []));
    const c = A?.c;
    it.ui.credit.replaceChildren(...(c ? ['Photo ', h('a', { href: `https://api.panoramax.xyz/?pic=${c.id}`, target: '_blank', rel: 'noopener noreferrer' }, c.id.slice(0, 8)),
      ` · ${c.auteur} · `, h('a', { href: URL_LICENCES[c.licence] || '#', target: '_blank', rel: 'noopener noreferrer' }, c.licence), ` · ${(c.date || '').split('-').reverse().join('/')} · Panoramax`] : []));
    for (const b of it.ui.boutons.querySelectorAll('button')) b.disabled = etat.occupe || (!A && b.textContent !== '↻');
    it.ui.haut.disabled = it.ui.corniche.disabled = !A;
    dessinerApercu(it);
  }
  function majPied() {
    if (!ui.enregistrer) return;
    const n = etat.items.filter((it) => it.statut === 'accepte').length;
    ui.enregistrer.textContent = `Enregistrer les façades acceptées (${n})`;
    ui.enregistrer.disabled = !n || etat.occupe;
    ui.apercu.disabled = !n || etat.occupe;
    ui.annuler.disabled = !etat.pile.length; ui.retablir.disabled = !etat.refaire.length;
  }
  async function analyserItem(it, force = false) {
    try {
      if (force) { it.candidats = []; it.analyses.clear(); it.analyse = null; it.rendu = null; it.choix = -1; }
      if (!it.candidats.length) await chercher(it);
      if (it.candidats.length) await placer(it, 0);
    } catch (err) {
      console.error(err);
      it.message = `Erreur : ${err.message}`;
    }
    majItem(it); dessinerComparaison(); majPied();
  }
  async function analyserTout() {
    etat.occupe = true; majPied();
    for (const it of etat.items) {
      if (!ui.fond?.isConnected) break;
      ui.progression.textContent = `Analyse : ${it.f.nom}…`;
      await analyserItem(it);
    }
    etat.occupe = false;
    ui.progression.textContent = 'Analyse terminée : vérifiez chaque façade (lignes du modèle sur la photo), puis Accepter, Corriger ou Ignorer.';
    etat.items.forEach(majItem); majPied();
  }

  function ouvrir(ensId = null) {
    if (ui.fond?.isConnected) fermer(true);
    const ids = (T.ensembles || []).map((e) => e.id);
    const id = ensId && ids.includes(ensId) ? ensId : ids.includes('ilot-saint-vincent') ? 'ilot-saint-vincent' : ids[0];
    if (!id) { app.signaler('Aucun ensemble détaillé chargé (représentation « Détaillé » ?).'); return; }
    preparer(id);
    ui.choixEns = h('select', { 'aria-label': 'Ensemble', onchange: () => ouvrir(ui.choixEns.value) },
      ...(T.ensembles || []).map((e) => h('option', { value: e.id, selected: e.id === id }, e.id === 'hotel-de-ville' ? 'Hôtel de Ville' : e.donnees?.titre || e.id)));
    ui.progression = h('p', { class: 'note', role: 'status', style: { margin: 0, flex: '1 1 300px' } });
    ui.annuler = h('button', { type: 'button', class: 'bouton discret', onclick: annuler }, 'Annuler');
    ui.retablir = h('button', { type: 'button', class: 'bouton discret', onclick: retablir }, 'Rétablir');
    ui.apercu = h('button', { type: 'button', class: 'bouton', onclick: apercuMaquette, title: 'Pose les façades acceptées sur la maquette (rien n\'est écrit)' }, 'Aperçu sur la maquette');
    ui.enregistrer = h('button', { type: 'button', class: 'bouton principal', onclick: enregistrer }, 'Enregistrer les façades acceptées');
    ui.comparaison = h('canvas', { class: 'ailot-comparaison', 'aria-label': 'Façades redressées à la même échelle, alignées sur le sol' });
    ui.liste = h('div', {}, ...etat.items.map(construireItem));
    ui.boite = h('div', { class: 'ailot-boite', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Assistant d\'îlot' },
      h('div', { class: 'ailot-tete' }, h('h2', {}, 'Assistant d\'îlot'), ui.choixEns,
        info('Pour chaque façade de l\'ensemble (et chaque mur de plus de 4 m sur rue sans photo, proposé comme façade à ajouter) : photos Panoramax à moins de 40 m (licences ouvertes), score sur 100 = vue (obliquité) 35 + résolution utile sur le mur 20 + mur dégagé 20 + netteté 10 + date 15, moins les défauts. « Mur masqué » est une approximation : pixels verts (arbres) et pixels sombres ou saturés dans la bande 0-4 m (voitures, vitrines) de l\'image redressée d\'après le GPS.',
          'Placement : les verticales et les horizontales de la façade sont mesurées sur la photo (segments, points de fuite par RANSAC) ; la position de la caméra est cherchée autour du GPS en alignant les arêtes verticales du modèle (sommets de l\'emprise) sur les arêtes de la photo, la hauteur de prise de vue en alignant l\'égout du modèle sur la corniche (± 0,8 m autour de 2,5 m pour un panorama de véhicule). Confiance « bon » seulement si les deux arêtes du mur, la corniche et les points de fuite sont nets ; sinon « à vérifier » ou « manuel » (coins estimés d\'après le GPS et l\'azimut).',
          'Niveaux : l\'image va toujours du sol au niveau du modèle choisi (égout par défaut ; brisis ou sommet si la photo les montre) ; les lignes du modèle sont dessinées sur l\'aperçu (planchers « estimés » : niveaux régulièrement répartis sous l\'égout). Le curseur Corniche déplace le haut du rectangle dans la photo sans changer la cote du modèle.',
          'Essais : sur images synthétiques à vérité terrain, verticales retrouvées à moins de 0,2°, coins à 0,3-12 % de la largeur du mur selon le contraste des arêtes (non garanti sous 1 %) : vérifiez toujours l\'aperçu. Seule l\'emprise autour de chaque façade est envoyée à api.panoramax.xyz.'),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => fermer(), 'aria-label': 'Fermer' }, '×')),
      h('div', { class: 'ailot-corps' }, ui.liste, h('h3', {}, 'Comparaison à la même échelle (alignées sur le sol)'), ui.comparaison),
      h('div', { class: 'ailot-pied' }, ui.progression, ui.annuler, ui.retablir, ui.apercu, ui.enregistrer));
    ui.fond = h('div', { class: 'ailot-fond' }, ui.boite);
    ui.fond.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') fermer(); });
    document.body.append(ui.fond);
    majPied(); dessinerComparaison();
    analyserTout();
  }

  // ---------------------------------------------------------------- Corriger : outil de redressement pré-rempli
  async function corriger(it) {
    const A = it.analyse;
    if (!A) return;
    try {
      const m = await import('./redressement-facades.js');
      const R = (app.redressementFacades ||= m.creerRedressementFacades(app, calage));
      ui.fond.style.display = 'none';
      R.ouvrir(it.f, it.nouvelle && !T.toutesFacades().includes(it.f) ? { ensemble: etat.ens.id, corps: it.corps.id } : null);
      await R.choisirPhoto(A.c);
      const cam = R.etat.source?.cam;
      if (cam) {
        // coins du modèle vus de la caméra trouvée → directions → pixels de l'image affichée par l'outil
        const G = geomFacade(it), haut = hautDe(it) + it.decalage, f = it.f;
        const Mn = A.nominale.M, Mp = A.r.pose.M, P = A.r.pose.P;
        const pts = [[f.gauche[0], G.sol + haut, f.gauche[1]], [f.droite[0], G.sol + haut, f.droite[1]], [f.droite[0], G.sol, f.droite[1]], [f.gauche[0], G.sol, f.gauche[1]]].map((X) => {
          const v = [X[0] - P[0], X[1] - P[1], X[2] - P[2]];
          const cc = Mp.map((l) => l[0] * v[0] + l[1] * v[1] + l[2] * v[2]);
          const d = [0, 1, 2].map((j) => Mn[0][j] * cc[0] + Mn[1][j] * cc[1] + Mn[2][j] * cc[2]);
          return cam.projeter([cam.P[0] + d[0], cam.P[1] + d[1], cam.P[2] + d[2]]);
        });
        if (pts.every(Boolean)) {
          R.etat.coins = pts; R.etat.rendu = null;
          const boite = document.querySelector('.redr-fond');
          [...(boite?.querySelectorAll('button') || [])].find((b) => b.textContent === 'Cadrer')?.click();
          boite?.querySelector('.redr-outils select')?.dispatchEvent(new Event('change'));
        }
      }
      // retour à l'assistant quand l'outil de redressement est fermé
      const attendre = setInterval(() => {
        if (document.querySelector('.redr-fond')) return;
        clearInterval(attendre);
        if (!ui.fond) return;
        ui.fond.style.display = '';
        if (it.f.redressement?.date === aujourdhui() && it.f.source === 'Panoramax') { it.statut = 'corrigee'; it.message = 'enregistrée par l\'outil de redressement'; }
        majItem(it); majPied();
      }, 500);
    } catch (err) {
      console.error(err);
      if (ui.fond) ui.fond.style.display = '';
      app.signaler(`Outil de redressement indisponible : ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- aperçu sur la maquette, enregistrement
  async function rendreHD(it) {
    const A = it.analyse;
    const G = geomFacade(it), haut = hautDe(it);
    const pxm = Math.min(PPM_SORTIE, 2048 / Math.max(G.L, haut));
    it.message = 'Rendu HD…'; majItem(it);
    const hd = await donnees(A.blob, 8192);
    const R = rendreFacade(it, pxm, { hd });
    const c = document.createElement('canvas'); c.width = R.width; c.height = R.height;
    c.getContext('2d').putImageData(new ImageData(R.data, R.width, R.height), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    it.message = '';
    // coins dans l'image source HD (trace) : panorama équirectangulaire ou photo plane
    const f = it.f, top = G.sol + haut + it.decalage;
    const X4 = [[f.gauche[0], top, f.gauche[1]], [f.droite[0], top, f.droite[1]], [f.droite[0], G.sol, f.droite[1]], [f.gauche[0], G.sol, f.gauche[1]]];
    const coins = X4.map((X) => {
      if (A.pano) return V.pixelPanorama(X, { nominale: A.nominale, pose: A.r.pose, az0: A.c.az, We: hd.width, He: hd.height }).map(r1);
      const p = V.projeter(A.r.pose, X);
      return p ? p.map((v) => r1(v * (hd.width / A.vue.width))) : null;
    });
    return { blob, W: R.width, H: R.height, pxm: r1(pxm), coins, largeurSource: hd.width, hors: R.hors.reduce((s, v) => s + v, 0) / R.hors.length };
  }
  async function apercuMaquette() {
    const acc = etat.items.filter((it) => it.statut === 'accepte' && it.analyse);
    etat.occupe = true; majPied();
    try {
      for (const it of acc) {
        const S = await rendreHD(it);
        it.sortie = S;
        if (!etat.apercus.has(it)) etat.apercus.set(it, { hauteur_m: it.f.hauteur_m, base_m: it.f.base_m, ajoutee: false });
        if (it.nouvelle && !T.toutesFacades().includes(it.f)) { T.ajouterFacade(etat.ens.id, it.f); etat.apercus.get(it).ajoutee = true; calage?.rafraichirPanneau?.(); }
        it.f.hauteur_m = r2(hautDe(it)); it.f.base_m = 0;
        if (S.url) URL.revokeObjectURL(S.url);
        S.url = URL.createObjectURL(S.blob);
        T.rechargerImageFacade(it.f, S.url);
        majItem(it);
      }
      if (T.representation?.() !== 'photos') app.signaler('Aperçu posé : choisissez « Détaillé avec photos » (Bâtiments > Bâti) pour le voir.');
      ui.progression.textContent = `Aperçu posé sur la maquette pour ${acc.length} façade${acc.length > 1 ? 's' : ''} (rien n'est écrit).`;
    } catch (err) { console.error(err); app.signaler(`Aperçu impossible : ${err.message}`); }
    etat.occupe = false; majPied(); etat.items.forEach(majItem);
  }
  function retirerApercus() {
    for (const [it, o] of etat.apercus) {
      it.f.hauteur_m = o.hauteur_m;
      if (o.base_m === undefined) delete it.f.base_m; else it.f.base_m = o.base_m;
      if (!o.ajoutee) T.rechargerImageFacade(it.f); else T.rechargerImageFacade(it.f, `${T.cheminImage(it.f)}?absente`);
    }
    etat.apercus.clear();
  }
  async function enregistrer() {
    const acc = etat.items.filter((it) => it.statut === 'accepte' && it.analyse);
    if (!acc.length) return;
    const ens = etat.ens.id;
    const liste = acc.map((it) => `• data/facades/${ens}/${it.f.image}${it.nouvelle && !etat.apercus.get(it)?.ajoutee && !T.toutesFacades().includes(it.f) ? ' (nouvelle)' : ''}`).join('\n');
    if (!confirm(`Écrire ${acc.length} image${acc.length > 1 ? 's' : ''} et mettre à jour data/facades/${ens}.json ?\n${liste}\nLes anciennes images et l'ancien fichier sont gardés dans data/.sauvegardes/ (serveur.py).`)) return;
    etat.occupe = true; majPied();
    try {
      for (const it of acc) if (!it.sortie) it.sortie = await rendreHD(it);
      const r = await fetch(`data/facades/${ens}.json`, { cache: 'no-store' });
      let texte = null, d = null;
      if (r.ok) { texte = await r.text(); d = JSON.parse(texte); } else if (acc.some((it) => !it.nouvelle)) throw new Error(`data/facades/${ens}.json illisible (${r.status})`);
      const o = d?.origine || app.config.origine;
      const { x: dx, z: dz } = app.proj.versLocal(o.lat, o.lon);
      const nouvellesEntrees = [];
      for (const it of acc) {
        const S = it.sortie, c = it.analyse.c, rr = it.analyse.r;
        const champs = {
          hauteur_m: r2(hautDe(it)), base_m: 0, pixels: [S.W, S.H], source: 'Panoramax', photo: c.id, lien: c.lien, auteur: c.auteur, licence: c.licence, date_prise: c.date,
          confiance: rr.confiance === 'bon' ? 'bonne' : rr.confiance === 'a-verifier' ? 'moyenne' : 'faible',
          remarque: `Assistant d'îlot : photo ${c.pano ? '360°' : 'perspective'} à ${Math.round(c.distance)} m, obliquité ${Math.round(c.obliquite)}°, score ${c.score.total}/100 ; placement ${CONFIANCES[rr.confiance]}${rr.raisons?.length ? ` (${rr.raisons.join(', ')})` : ''}.`,
          niveaux: { sol: 0, egout: it.niveaux.egout, ...(it.niveaux.brisis ? { brisis: it.niveaux.brisis } : {}), ...(it.niveaux.sommet ? { sommet: it.niveaux.sommet } : {}), haut: it.haut, corniche_decalage_m: r2(it.decalage), ...(it.etages ? { planchers_estimes: it.etages } : {}) },
        };
        const trace = (ancien) => ({
          date: aujourdhui(), outil: 'assistant-ilot', photo_id: c.id, collection: c.collection, type: c.pano ? '360' : 'perspective', image_source: 'hd', largeur_source: S.largeurSource,
          coins: S.coins, px_par_m: S.pxm, obliquite_deg: Math.round(c.obliquite), distance_m: Math.round(c.distance), score: c.score.total,
          placement: { confiance: rr.confiance, erreur_estimee_m: rr.erreur_m, camera: { x: r2(rr.pose.P[0] - dx), z: r2(rr.pose.P[2] - dz), h_prise_m: r2(rr.pose.P[1] - sol(rr.pose.P[0], rr.pose.P[2])) }, ecart_gps_m: r1(Math.hypot(rr.pose.P[0] - c.x, rr.pose.P[2] - c.z)) },
          ...(ancien ? { ancien } : {}),
        });
        const cible = d?.facades?.find((x) => x.id === it.f.id);
        if (cible) {
          const ancien = cible.redressement?.ancien || { image: cible.image, source: cible.source, photo: cible.photo, auteur: cible.auteur, licence: cible.licence, date_prise: cible.date_prise, confiance: cible.confiance, pixels: cible.pixels, hauteur_m: cible.hauteur_m, ...(cible.base_m !== undefined ? { base_m: cible.base_m } : {}) };
          const nouv = JSON.parse(JSON.stringify({ ...cible, ...champs, redressement: trace(ancien) }));
          d.facades[d.facades.indexOf(cible)] = nouv;
          texte = remplacerBlocFacade(texte, it.f.id, nouv) || serialiserFacades(d, texte);
        } else {
          const f = it.f;
          const entree = JSON.parse(JSON.stringify({ id: f.id, nom: f.nom, corps: f.corps, gauche: [r2(f.gauche[0] - dx), r2(f.gauche[1] - dz)], droite: [r2(f.droite[0] - dx), r2(f.droite[1] - dz)], normale_az: f.normale_az, image: f.image, ...champs, redressement: trace(null) }));
          if (d) { const avant = { facades: [...d.facades] }; d.facades.push(entree); texte = insererFacade(texte, avant, entree) || serialiserFacades(d, texte); } else {
            d = { _note: 'Photos de façade (même format que data/facades/hotel-de-ville.json), créé par l\'assistant d\'îlot de l\'atlas.', titre: `Photos de façade : ${etat.ens.donnees?.titre || ens}`, id: ens, date: aujourdhui(), origine: { lat: o.lat, lon: o.lon }, facades: [entree] };
            texte = serialiserFacades(d, '{\n "', 1);
          }
          nouvellesEntrees.push(it);
        }
      }
      JSON.parse(texte); // contrôle avant écriture
      let tous = true;
      for (const it of acc) tous = (await enregistrerDonnees(`facades/${ens}/${it.f.image}`, it.sortie.blob, { type: 'image/jpeg', apres: `façade ${it.f.id} (assistant d'îlot)` })) === 'serveur' && tous;
      tous = (await enregistrerDonnees(`facades/${ens}.json`, texte, { apres: `${acc.length} façade(s), assistant d'îlot` })) === 'serveur' && tous;
      // mémoire : champs écrits, façades ajoutées, images relues
      for (const it of acc) {
        const e = d.facades.find((x) => x.id === it.f.id);
        Object.assign(it.f, { hauteur_m: e.hauteur_m, base_m: 0, pixels: e.pixels, source: e.source, photo: e.photo, lien: e.lien, auteur: e.auteur, licence: e.licence, date_prise: e.date_prise, confiance: e.confiance, remarque: e.remarque, niveaux: e.niveaux, redressement: e.redressement });
        if (!T.toutesFacades().includes(it.f)) T.ajouterFacade(ens, it.f);
        if (tous) T.rechargerImageFacade(it.f); else { it.sortie.url ||= URL.createObjectURL(it.sortie.blob); T.rechargerImageFacade(it.f, it.sortie.url); }
        it.statut = 'enregistree'; it.nouvelle = null;
        etat.apercus.delete(it);
      }
      calage?.rafraichirPanneau?.();
      ui.progression.textContent = tous ? `Enregistré : ${acc.length} image(s) dans data/facades/${ens}/ et data/facades/${ens}.json (anciennes versions dans data/.sauvegardes/).`
        : `Sans serveur : fichiers téléchargés, à copier dans data/facades/${ens}/ et data/facades/.`;
    } catch (err) {
      console.error(err);
      app.signaler(`Enregistrement impossible : ${err.message}`);
    }
    etat.occupe = false; etat.items.forEach(majItem); majPied();
  }

  function fermer(sansQuestion = false) {
    if (etat.apercus.size && !sansQuestion && !confirm('Des aperçus non enregistrés sont posés sur la maquette. Fermer et les retirer ?')) return;
    retirerApercus();
    ui.fond?.remove();
    ui.fond = null;
    for (const it of etat.items) { it.analyses?.clear(); if (it.sortie?.url) URL.revokeObjectURL(it.sortie.url); }
  }

  return { ouvrir, fermer, etat, analyserItem, placer, enregistrer, apercuMaquette, mursSansPhoto, scorePhoto };
}
