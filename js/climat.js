import * as THREE from 'three';
import { h, info } from './util.js';
import { chargerJSON } from './donnees.js';
import {
  chargerMeteo, meteo, rose, normales, mention, NOMS16, MOIS, annees, annee, definirAnnee, extremesAnnee, libellePeriode,
} from './meteo.js';

const COULEURS_VENT = ['#b7cbd9', '#6f93b1', '#2f4f6f'];
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...enfants) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  enfants.forEach((e) => el.append(e instanceof Node ? e : document.createTextNode(String(e))));
  return el;
};
const nombre = (v, d = 1) => (v == null ? '–' : v.toFixed(d).replace('.', ','));

// Climat du site : températures et vent mesurés par Météo-France à Nantes-Bouguenais (data/meteo/meteo.json,
// lu par js/meteo.js) ; rose des vents sur la maquette, réglée depuis l'outil Vent (reglerRose).
export function creerClimat(app) {
  const etat = { n: 16, saison: 'annee', temperature: 'all', mode: 'frequence' };
  const groupe = new THREE.Group();
  groupe.name = 'rose-vents';
  groupe.visible = false;
  app.scene.add(groupe);

  let extremes = null; // data/meteo/extremes.json (outils/meteo/extremes.py)
  async function construire() {
    await chargerMeteo();
    extremes = await chargerJSON('data/meteo/extremes.json', null);
    dessinerRose3D();
  }

  const roseActive = () => rose(etat.n, etat.saison, etat.temperature);
  const valeur = (sct) => (etat.mode === 'energie' ? sct.e : sct.f);
  const demiLargeur = () => (etat.n === 16 ? 9.5 : 13);

  // ---------------------------------------------------------------
  // Rose des vents posée au sol, dans le cercle du projet (plateau de la maquette), centrée sur le centre
  // du projet. Dessinée par-dessus le bâti pour rester lisible en 3D comme en plan.
  // ---------------------------------------------------------------
  function azimutVersXZ(az, r) {
    const a = THREE.MathUtils.degToRad(az);
    return [Math.sin(a) * r, -Math.cos(a) * r];
  }

  function secteurGeometrie(az0, az1, r0, r1, y) {
    const pts = [];
    const n = 8;
    for (let i = 0; i <= n; i++) pts.push(azimutVersXZ(az0 + ((az1 - az0) * i) / n, r1));
    for (let i = n; i >= 0; i--) pts.push(azimutVersXZ(az0 + ((az1 - az0) * i) / n, r0));
    const forme = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ShapeGeometry(forme);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    return g;
  }

  function dessinerRose3D() {
    groupe.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    groupe.clear();
    app.etiquettes.retirerGroupe('rose');
    const R = app.config.rayonPlateau;
    const r0 = R * 0.1, rMax = R * 0.9; // pétales entre le petit cercle central et 90 % du rayon
    const visible = () => groupe.visible;
    const mat = (c, o = 0.8) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    const anneau = (r, o) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r - 0.35, r + 0.35, 128).rotateX(-Math.PI / 2), mat(0x2f3b45, o));
      m.position.y = 0.45;
      m.renderOrder = 9;
      m.raycast = () => {};
      groupe.add(m);
    };
    anneau(r0, 0.6);
    anneau(R, 0.35);
    for (const [txt, az] of [['N', 0], ['E', 90], ['S', 180], ['O', 270]]) {
      const [x, z] = azimutVersXZ(az, R * 0.95);
      app.etiquettes.ajouter({ texte: txt, position: new THREE.Vector3(x, 1, z), classe: 'etiquette-cardinal', groupe: 'rose', visibleSi: visible, distanceMax: 3000, centre: true });
    }
    const petale = (az0, az1, ra, rb, couleur, o, k = 0) => {
      const m = new THREE.Mesh(secteurGeometrie(az0, az1, ra, rb, 0.5 + k * 0.02), mat(couleur, o));
      m.renderOrder = 10 + k * 0.1;
      m.raycast = () => {};
      groupe.add(m);
    };
    const etiquette = (texte, az, r) => {
      const [x, z] = azimutVersXZ(az, Math.min(r + R * 0.06, R * 0.97));
      app.etiquettes.ajouter({ texte, position: new THREE.Vector3(x, 1, z), classe: 'etiquette-vent', groupe: 'rose', visibleSi: visible, distanceMax: 3000, centre: true });
    };
    const ro = roseActive();
    if (!ro.N) return;
    const max = Math.max(...ro.secteurs.map(valeur));
    const echelle = (rMax - r0) / Math.max(max, 0.1);
    const dl = demiLargeur();
    for (const sct of ro.secteurs) {
      const v = valeur(sct);
      if (v <= 0) continue;
      const r1 = r0 + v * echelle;
      if (etat.mode === 'frequence') {
        // part des vents de plus de 5 m/s au pied du pétale
        const rf = r0 + ((v * sct.p5) / 100) * echelle;
        if (rf > r0) petale(sct.dir - dl, sct.dir + dl, r0, rf, COULEURS_VENT[2], 0.85, 1);
        petale(sct.dir - dl, sct.dir + dl, rf, r1, COULEURS_VENT[1], 0.8, 0);
      } else {
        petale(sct.dir - dl, sct.dir + dl, r0, r1, COULEURS_VENT[2], 0.8, 0);
      }
      if (v >= max * 0.55) etiquette(`${sct.label} ${nombre(v)} %`, sct.dir, r1);
    }
  }

  // ---------------------------------------------------------------
  // Graphique mensuel : températures (minimales et maximales moyennes, moyenne) et vent moyen
  // ---------------------------------------------------------------
  function svgNormales(moisActif) {
    const n = normales();
    if (!n) return h('p', { class: 'note' }, 'Normales absentes (data/meteo/meteo.json).');
    const L = 300, H = 200, g = 26, bas = 128, haut = 12;
    const tMin = -2, tMax = 28;
    const y = (t) => bas - ((t - tMin) / (tMax - tMin)) * (bas - haut);
    const pas = (L - g - 4) / 12;
    const svg = s('svg', { viewBox: `0 0 ${L} ${H}`, class: 'graphique', role: 'img', 'aria-label': 'Températures et vent moyens par mois, mesurés à Nantes-Bouguenais' });
    for (const t of [0, 10, 20]) {
      svg.append(s('line', { x1: g, x2: L - 4, y1: y(t), y2: y(t), class: 'grille' }), s('text', { x: g - 4, y: y(t) + 3, 'text-anchor': 'end', class: 'axe' }, `${t}°`));
    }
    let ligne = '';
    n.mois.forEach((m, i) => {
      const x = g + i * pas;
      svg.append(s('rect', { x: x + pas * 0.28, y: y(n.Tmax[i]), width: pas * 0.44, height: y(n.Tmin[i]) - y(n.Tmax[i]), rx: 2, class: i === moisActif ? 'temp actif' : 'temp' },
        s('title', {}, `${MOIS[i]} : ${nombre(n.Tmin[i])} à ${nombre(n.Tmax[i])} °C (minimales et maximales moyennes), moyenne ${nombre(n.T[i])} °C`)));
      svg.append(s('text', { x: x + pas / 2, y: bas + 11, 'text-anchor': 'middle', class: i === moisActif ? 'axe actif' : 'axe' }, MOIS[i][0].toUpperCase()));
      ligne += `${ligne ? 'L' : 'M'}${(x + pas / 2).toFixed(1)} ${y(n.T[i]).toFixed(1)}`;
    });
    svg.append(s('path', { d: ligne, fill: 'none', stroke: '#2f3b45', 'stroke-width': 1.3 }));
    // vent moyen par mois (barres sous le graphique)
    const y0 = H - 4, kv = 9; // 9 px par m/s
    n.FF.forEach((v, i) => {
      const x = g + i * pas, hv = v * kv;
      svg.append(s('rect', { x: x + pas * 0.25, y: y0 - hv, width: pas * 0.5, height: hv, fill: i === moisActif ? '#2f4f6f' : '#6f93b1' },
        s('title', {}, `${MOIS[i]} : vent moyen ${nombre(v)} m/s, rafale maximale ${nombre(n.FXImax[i])} m/s`)));
    });
    svg.append(s('line', { x1: g, x2: L - 4, y1: y0, y2: y0, class: 'grille' }));
    svg.append(s('line', { x1: g, x2: L - 4, y1: y0 - 4 * kv, y2: y0 - 4 * kv, class: 'grille', 'stroke-dasharray': '2 2' }));
    svg.append(s('text', { x: g - 4, y: y0 - 4 * kv + 3, 'text-anchor': 'end', class: 'axe' }, '4'));
    svg.append(s('text', { x: L - 4, y: y0 - 4 * kv - 4, 'text-anchor': 'end', class: 'axe' }, 'vent moyen (m/s)'));
    svg.append(s('text', { x: g + 2, y: 8, class: 'axe' }, 'barres : minimales à maximales moyennes ; trait : moyenne'));
    return svg;
  }

  function texteMois(i) {
    const n = normales();
    if (!n) return null;
    const top = n.f16[i].map((f, k) => [f, k]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([f, k]) => `${NOMS16[k]} ${nombre(f, 0)} %`);
    return `En ${MOIS[i]} : ${nombre(n.Tmin[i])} °C la nuit et ${nombre(n.Tmax[i])} °C l'après-midi en moyenne (moyenne ${nombre(n.T[i])} °C), humidité ${n.U[i]} %, rayonnement solaire ${nombre(n.GLO_MJm2j[i])} MJ/m² par jour ; vent moyen ${nombre(n.FF[i])} m/s, rafale maximale ${nombre(n.FXImax[i])} m/s ; vents les plus fréquents ${top.join(', ')}, calme ${nombre(n.calmes[i])} %.`;
  }

  // ---------------------------------------------------------------
  // Jours extrêmes et périodes chaudes / froides (data/meteo/extremes.json)
  // ---------------------------------------------------------------
  const dateLongue = (iso) => { const [a, m, j] = iso.split('-').map(Number); return `${j === 1 ? '1er' : j} ${MOIS[m - 1]} ${a}`; };
  const jourMois = (mmjj) => { const [m, j] = mmjj.split('-').map(Number); return `${j === 1 ? '1er' : j} ${MOIS[m - 1]}`; };
  const deg = (v) => `${nombre(v)} °C`;
  // année choisie : jours extrêmes de cette année (data/meteo/meteo_annees.json)
  function blocExtremesAnnee(a, x) {
    const liste = (titre, jours, cle) => h('details', { class: 'details' }, h('summary', {}, titre),
      h('ol', { class: 'liste-extremes' }, ...jours.map((j) => h('li', {}, `${dateLongue(j.date)} : ${deg(j[cle])}`, h('span', { class: 'note' }, ` (moyenne ${deg(j.tmoy)})`)))));
    return [
      h('div', { class: 'titre-info' }, h('h3', {}, `Jours extrêmes, année ${a}`),
        info(`Journée civile (Europe/Paris), au moins 20 h de mesures ; ${x.jours_valides} jours valides. Tmin = minimum de TN, Tmax = maximum de TX, Tmoy = moyenne horaire de T. Périodes types et déciles : voir la moyenne 2016-2025.`, mention({ court: true, annee: true }))),
      h('dl', { class: 'extremes' },
        h('dt', {}, 'Jour le plus froid'), h('dd', {}, `${dateLongue(x.plus_froid.date)} : ${deg(x.plus_froid.tmin)} au plus bas (maximum ${deg(x.plus_froid.tmax)})`),
        h('dt', {}, 'Jour le plus chaud'), h('dd', {}, `${dateLongue(x.plus_chaud.date)} : ${deg(x.plus_chaud.tmax)} au plus haut (minimum ${deg(x.plus_chaud.tmin)})`),
        h('dt', {}, 'Moyenne la plus basse'), h('dd', {}, `${dateLongue(x.plus_froid_moyenne.date)} : ${deg(x.plus_froid_moyenne.tmoy)}`),
        h('dt', {}, 'Moyenne la plus haute'), h('dd', {}, `${dateLongue(x.plus_chaud_moyenne.date)} : ${deg(x.plus_chaud_moyenne.tmoy)}`),
        h('dt', {}, 'Température moyenne de l\'année'), h('dd', {}, deg(x.tmoy)),
        h('dt', {}, 'Jours de gel'), h('dd', {}, `${x.jours_gel} (minimum sous 0 °C)`),
        h('dt', {}, 'Jours de 30 °C ou plus'), h('dd', {}, `${x.jours_30}`)),
      liste(`Les ${x.froids.length} jours les plus froids (minimum)`, x.froids, 'tmin'),
      liste(`Les ${x.chauds.length} jours les plus chauds (maximum)`, x.chauds, 'tmax'),
    ];
  }

  function blocExtremes() {
    const xa = extremesAnnee();
    if (xa) return blocExtremesAnnee(annee(), xa);
    const x = extremes;
    if (!x?.plus_froid) return [h('p', { class: 'note' }, 'Jours extrêmes : fichier data/meteo/extremes.json absent (outils/meteo/extremes.py).')];
    const d = x.deciles || {};
    const moisTop = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, p]) => `${MOIS[m - 1]} ${nombre(p, 0)} %`).join(', ');
    const episode = (e) => (e ? `du ${dateLongue(e.debut)} au ${dateLongue(e.fin)} (${e.jours} jours, ${deg(e.tmoy)} en moyenne)` : '–');
    const liste = (titre, jours, cle) => h('details', { class: 'details' }, h('summary', {}, titre),
      h('ol', { class: 'liste-extremes' }, ...jours.map((j) => h('li', {}, `${dateLongue(j.date)} : ${deg(j[cle])}`, h('span', { class: 'note' }, ` (moyenne ${deg(j.tmoy)})`)))));
    return [
      h('div', { class: 'titre-info' }, h('h3', {}, `Jours extrêmes, ${x.periode}`), info(x.def, x.source)),
      h('dl', { class: 'extremes' },
        h('dt', {}, 'Jour le plus froid'), h('dd', {}, `${dateLongue(x.plus_froid.date)} : ${deg(x.plus_froid.tmin)} au plus bas (maximum ${deg(x.plus_froid.tmax)})`),
        h('dt', {}, 'Jour le plus chaud'), h('dd', {}, `${dateLongue(x.plus_chaud.date)} : ${deg(x.plus_chaud.tmax)} au plus haut (minimum ${deg(x.plus_chaud.tmin)})`),
        h('dt', {}, 'Moyenne la plus basse'), h('dd', {}, `${dateLongue(x.plus_froid_moyenne.date)} : ${deg(x.plus_froid_moyenne.tmoy)}`),
        h('dt', {}, 'Moyenne la plus haute'), h('dd', {}, `${dateLongue(x.plus_chaud_moyenne.date)} : ${deg(x.plus_chaud_moyenne.tmoy)}`),
        h('dt', {}, 'Période la plus froide'), h('dd', {}, `du ${jourMois(x.saison_froide.debut)} au ${jourMois(x.saison_froide.fin)} (${deg(x.saison_froide.tmoy)} en moyenne)`),
        h('dt', {}, 'Période la plus chaude'), h('dd', {}, `du ${jourMois(x.saison_chaude.debut)} au ${jourMois(x.saison_chaude.fin)} (${deg(x.saison_chaude.tmoy)} en moyenne)`),
        h('dt', {}, '10 % des jours les plus froids'), h('dd', {}, `moyenne de ${deg(d.p10_tmoy)} ou moins ; surtout en ${moisTop(d.mois_froids)} ; plus long épisode ${episode(d.episodes_froids?.[0])}`),
        h('dt', {}, '10 % des jours les plus chauds'), h('dd', {}, `moyenne de ${deg(d.p90_tmoy)} ou plus ; surtout en ${moisTop(d.mois_chauds)} ; plus long épisode ${episode(d.episodes_chauds?.[0])}`)),
      liste(`Les ${x.froids.length} jours les plus froids (minimum)`, x.froids, 'tmin'),
      liste(`Les ${x.chauds.length} jours les plus chauds (maximum)`, x.chauds, 'tmax'),
    ];
  }

  // Sélecteur « Moyenne 2016-2025 / année » (Climat et Vent) : js/meteo.js definirAnnee, événement « meteoAnnee »
  function selecteurAnnee() {
    const liste = annees();
    if (!liste.length) return null;
    const p = meteo()?.periode?.stats?.split('/').map((x) => x.slice(0, 4)).join('-') ?? '';
    const sel = h('select', { 'aria-label': 'Période des mesures', onchange: (e) => {
      definirAnnee(e.target.value || null);
      app.emettre('meteoAnnee', annee());
    } }, h('option', { value: '', selected: !annee() }, `Moyenne ${p.replace('-', '–')}`),
    ...liste.map((a) => h('option', { value: a, selected: a === annee() }, `Année ${a}`)));
    return h('label', { class: 'champ selecteur-annee' }, h('span', {}, 'Mesures'), sel);
  }

  let conteneurPanneau = null;
  app.on('meteoAnnee', () => {
    if (groupe.visible || groupe.children.length) dessinerRose3D();
    // le conteneur du panneau est commun à tous les outils : seulement si Climat est l'outil ouvert
    if (conteneurPanneau?.isConnected && app.interface?.ouvert === 'climat') { conteneurPanneau.replaceChildren(); construirePanneau(conteneurPanneau); }
  });

  function construirePanneau(conteneur) {
    conteneurPanneau = conteneur;
    const n = normales();
    const moisActif = app.soleil ? app.soleil.date().getMonth() : new Date().getMonth();
    conteneur.append(...[
      selecteurAnnee(),
      h('div', { class: 'titre-info' }, h('h3', {}, `Températures et vent par mois, ${libellePeriode()}`),
        info(`${mention({ annee: true })} Le centre-ville, plus minéral, est en général un peu plus chaud que l'aéroport (îlot de chaleur).`, 'La rose des vents est dans l\'outil Vent (touche W), avec le même choix de période.')),
      svgNormales(moisActif),
      n ? h('p', { class: 'resultat' }, texteMois(moisActif)) : null,
      ...blocExtremes(),
    ].filter(Boolean));
  }

  function normalesDuMois(m) {
    const n = normales();
    return n ? { tmin: n.Tmin[m], tmax: n.Tmax[m], t: n.T[m], mois: MOIS[m] } : null;
  }

  // Réglage de la rose posée sur la maquette (depuis l'outil Vent : période, température, 12 ou 16 secteurs).
  function reglerRose(o = {}) {
    let change = false;
    for (const k of ['n', 'saison', 'temperature', 'mode']) if (o[k] != null && o[k] !== etat[k]) { etat[k] = o[k]; change = true; }
    if (change) dessinerRose3D();
    if (o.visible != null) groupe.visible = o.visible;
  }

  return { construire, construirePanneau, normalesDuMois, groupe, etat, reglerRose, selecteurAnnee, afficherRose(v) { groupe.visible = v; } };
}
