import * as THREE from 'three';
import { h, info } from './util.js';
import {
  chargerMeteo, meteo, rose, normales, mention, NOMS16, MOIS, annees, annee, definirAnnee, extremesAnnee, libellePeriode, extremesJours, sourceEPW,
  extremesDetail, erreurExtremesDetail, periodeExtremes, csvExtremes, roseSituation,
} from './meteo.js';
import { CONDITIONS, CALME, HEURES_MIN, AVERTISSEMENT, texteDominant, texteRecord, texteVent, duNom } from './meteo-extremes.js';
import { svgRose } from './roses-saisons.js';
import { graphiqueMensuel } from './graphique-mensuel.js'; // 15/11/2026 : graphique mensuel commun avec l'outil Vent
import { telecharger } from './donnees.js';
import { blocStatistiques, statsPourExport } from './climat-stats-bloc.js'; // 11/11/2026 : bloc « Statistiques du climat » (calcul : js/climat-stats.js)
import { barreExport, blocExportOnglet } from './climat-export-ui.js'; // 11/11/2026 : export Excel (barre « Exporter », bloc de l'onglet Export)

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
  const etat = { n: 16, saison: 'annee', temperature: 'all', mode: 'frequence', situation: 'habituel' };
  const groupe = new THREE.Group();
  groupe.name = 'rose-vents';
  groupe.visible = false;
  app.scene.add(groupe);

  // jours extrêmes : data/meteo/extremes.json (outils/meteo/extremes.py) ou calculés depuis l'EPW actif (js/meteo.js)
  async function construire() {
    await chargerMeteo();
    dessinerRose3D();
  }

  // situation de l'outil Vent (10/11/2026) : rose des heures de la condition extrême (12 secteurs)
  const roseActive = () => (etat.situation && etat.situation !== 'habituel' ? roseSituation(etat.situation) : rose(etat.n, etat.saison, etat.temperature));
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
    return graphiqueMensuel(n, { actif: moisActif, aria: 'Températures et vent moyens par mois, mesurés à Nantes-Bouguenais' });
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
    const x = extremesJours();
    if (!x?.plus_froid) return [h('p', { class: 'note' }, sourceEPW() ? 'Jours extrêmes : pas assez de journées complètes dans le fichier EPW.' : 'Jours extrêmes : fichier data/meteo/extremes.json absent (outils/meteo/extremes.py).')];
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

  // ---------------------------------------------------------------
  // Conditions extrêmes et vent (10/11/2026) : js/meteo-extremes.js sur les mesures horaires (meteo.js extremesDetail)
  // ---------------------------------------------------------------
  function stylesExtremes() {
    if (document.getElementById('styles-extremes')) return;
    document.head.append(h('style', { id: 'styles-extremes' }, `
.bloc-extremes table.table-extremes { width: 100%; border-collapse: collapse; font-size: 12px; margin: 4px 0 6px; }
.bloc-extremes .table-extremes th, .bloc-extremes .table-extremes td { padding: 2px 4px; border-bottom: 1px solid rgba(47,59,69,.12); text-align: right; vertical-align: top; }
.bloc-extremes .table-extremes th:first-child, .bloc-extremes .table-extremes td:first-child { text-align: left; }
.bloc-extremes .table-extremes tr.faible td { color: #7b8790; }
.bloc-extremes .table-extremes tr.groupe-chaud td:first-child { border-left: 3px solid #d9822b; }
.bloc-extremes .table-extremes tr.groupe-froid td:first-child { border-left: 3px solid #2a7f9e; }
.bloc-extremes .table-extremes tr.groupe-vent td:first-child { border-left: 3px solid #6f93b1; }
.bloc-extremes .table-extremes tr.groupe-mixte td:first-child { border-left: 3px solid #9e7bb5; }
.bloc-extremes .roses-extremes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 4px 0; }
.bloc-extremes .roses-extremes svg { width: 100%; height: auto; display: block; }
.bloc-extremes p.resultat { margin: 4px 0; }
.bloc-extremes .avertissement-extremes { font-size: 11px; color: #5b6770; }
.bloc-extremes ol.liste-extremes, .bloc-extremes ul.liste-extremes { margin: 2px 0 6px; padding-left: 18px; font-size: 12px; }
`));
  }
  const pct = (v) => `${nombre(v, 0)} %`;
  function blocConditions() {
    stylesExtremes();
    const zone = h('div', { class: 'bloc-extremes', 'data-garder': '' }, h('p', { class: 'note', role: 'status' }, 'Conditions extrêmes : lecture des mesures horaires…'));
    const titre = (p) => h('div', { class: 'titre-info' }, h('h3', {}, `Conditions extrêmes et vent, ${p}`),
      info(h('div', {},
        h('p', {}, `Définitions (mesures horaires ; T = température de l'heure, vent = vent moyen sur 10 min à 10 m). Calme : vent < ${String(CALME).replace('.', ',')} m/s (sans direction). Roses à 12 secteurs de 30° ; fréquences en % de toutes les heures de la condition, calmes compris ; direction = d'où vient le vent.`),
        h('ul', {}, ...CONDITIONS.filter((c) => c.id !== 'habituel').map((c) => h('li', {}, h('b', {}, c.libelle), ` : ${c.def}.`))),
        h('p', {}, `Canicule : seuils de vigilance du département appliqués aux mesures de l'aéroport ; ce n'est pas la liste officielle des alertes. Moins de ${HEURES_MIN} h de vent : échantillon faible (en gris).`),
        h('p', {}, AVERTISSEMENT)), mention({ annee: true })));
    extremesDetail().then((R) => {
      const p = periodeExtremes();
      if (!R) { zone.replaceChildren(h('p', { class: 'note', role: 'status' }, erreurExtremesDetail() || 'Conditions extrêmes indisponibles.')); return; }
      const C = R.conditions;
      const dom = (c) => (c.rose.dominant ? `${c.rose.dominant.nom} ${c.rose.dominant.dir}° (${pct(c.rose.dominant.f)})` : (c.heures ? 'calme' : '–'));
      const lignes = CONDITIONS.map((d) => {
        const c = C[d.id];
        if (c.indisponible) return h('tr', { class: `groupe-${d.groupe}`, title: d.def }, h('td', {}, d.libelle), h('td', { colspan: 4 }, 'pas de rafales dans cette source'));
        return h('tr', { class: `groupe-${d.groupe}${c.peuRepresentatif && c.heures ? ' faible' : ''}`, title: `${d.def}${c.peuRepresentatif && c.heures ? ` — échantillon faible : ${c.heuresVent} h de vent` : ''}` },
          h('td', {}, d.libelle), h('td', {}, c.heures.toLocaleString('fr-FR')), h('td', {}, c.jours.toLocaleString('fr-FR')), h('td', {}, dom(c)), h('td', {}, c.heures ? nombre(c.rose.vm) : '–'));
      });
      const r3 = [['canicule', 'Canicule'], ['plus-froid', 'Plus grand froid'], ['habituel', 'Toutes les heures']].map(([id, lib]) => {
        const c = C[id], r = c.rose, okR = r.N > 0 && !!r.dominant;
        return { lib, r, ok: okR, dom: okR ? { k: r.dominant.k, dir: r.dominant.dir, f: r.dominant.f, vm: r.dominant.vm } : null };
      });
      const axe = Math.max(10, Math.ceil(Math.max(...r3.filter((x) => x.ok).flatMap((x) => x.r.secteurs.map((q) => q.f))) / 5) * 5);
      const roses = h('div', { class: 'roses-extremes' });
      roses.innerHTML = r3.map((x) => `<svg viewBox="0 0 100 124" role="img" aria-label="Rose des vents, ${x.lib}">${svgRose(x, axe, { cx: 50, cy: 50, R: 36, p: 8.5 })}</svg>`).join('');
      const mois = (c) => c.parMois.map((n, i) => [n, i]).filter(([n]) => n).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([n, i]) => `${MOIS[i]} ${pct((100 * n) / c.heures)}`).join(', ');
      const episodes = (id, max = 40) => {
        const c = C[id];
        if (!c.episodes.length) return null;
        const l = c.episodes.slice(-max);
        return h('details', { class: 'details' }, h('summary', {}, `${c.libelle} : ${c.episodes.length} épisode${c.episodes.length > 1 ? 's' : ''}`),
          h('ul', { class: 'liste-extremes' }, ...l.map((e) => h('li', {}, e.debut === e.fin ? dateLongue(e.debut) : `du ${dateLongue(e.debut)} au ${dateLongue(e.fin)}`, ` (${e.heures} h)`))),
          c.episodes.length > max ? h('p', { class: 'note' }, `${max} derniers épisodes sur ${c.episodes.length} (liste complète dans le CSV).`) : null);
      };
      const annuel = R.annees.length ? h('details', { class: 'details' }, h('summary', {}, 'Heure la plus chaude et la plus froide de chaque année, avec son vent'),
        h('ul', { class: 'liste-extremes' }, ...R.annees.map((a) => h('li', {}, h('b', {}, `${a.annee} : `),
          a.chaud ? `${nombre(a.chaud.valeur)} °C le ${a.chaud.jour.split('-').reverse().join('/')} à ${a.chaud.heure} h, ${texteVent(a.chaud)}` : '–', ' ; ',
          a.froid ? `${nombre(a.froid.valeur)} °C le ${a.froid.jour.split('-').reverse().join('/')} à ${a.froid.heure} h, ${texteVent(a.froid)}` : '–'))),
        h('p', { class: 'note' }, 'Heure (de Paris) qui contient la température maximale (TX) ou minimale (TN) instantanée ; vent moyen et rafale de cette heure.')) : null;
      const saisons = h('details', { class: 'details' }, h('summary', {}, 'Tendance saisonnière (mois les plus concernés)'),
        h('ul', { class: 'liste-extremes' }, ...CONDITIONS.filter((d) => d.id !== 'habituel' && C[d.id].heures).map((d) => h('li', {}, `${d.libelle} : ${mois(C[d.id])}`))));
      const froids = h('details', { class: 'details' }, h('summary', {}, `Les ${R.joursFroids.length} jours les plus froids (heures de la situation « Plus grand froid »)`),
        h('ol', { class: 'liste-extremes' }, ...R.joursFroids.map((j) => h('li', {}, `${dateLongue(j.date)} : ${nombre(j.tmin)} °C au plus bas, ${nombre(j.tmax)} °C au plus haut`))));
      const can = C.canicule, pf = C['plus-froid'];
      zone.replaceChildren(...[
        titre(p),
        h('p', { class: 'resultat' }, texteDominant(can, p)),
        h('p', { class: 'resultat' }, texteDominant(pf, p)),
        R.recordChaud ? h('p', { class: 'resultat' }, texteRecord(R.recordChaud, true)) : null,
        R.recordFroid ? h('p', { class: 'resultat' }, texteRecord(R.recordFroid, false)) : null,
        C.tempete.rose.dominant ? h('p', { class: 'resultat' }, `Tempête (vent moyen ≥ 10,8 m/s, ${C.tempete.heures.toLocaleString('fr-FR')} h) : le vent vient surtout ${duNom(C.tempete.rose.dominant.nom)} (${C.tempete.rose.dominant.nom}, ${pct(C.tempete.rose.dominant.f)} des heures), ${nombre(C.tempete.rose.vm)} m/s en moyenne.`) : null,
        roses,
        h('table', { class: 'table-extremes' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Condition'), h('th', {}, 'Heures'), h('th', {}, 'Jours'), h('th', {}, 'Vent dominant'), h('th', {}, 'Vent moy. m/s'))),
          h('tbody', {}, ...lignes)),
        episodes('canicule'), episodes('vague-chaleur'), froids, episodes('grand-froid'), episodes('rafale-100'), episodes('froid-vente'), episodes('chaud-sans-vent'),
        annuel, saisons,
        barreExport(app, { portee: 'extremes', titre: 'Exporter les conditions extrêmes', csv: () => { const t = csvExtremes(); return t ? [{ nom: `atlas-hdv-meteo-conditions-extremes-${p.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^0-9a-z-]+/gi, '-')}.csv`, texte: t }] : []; } }),
        h('p', { class: 'avertissement-extremes', 'data-garder': '' }, `${sourceEPW() ? 'Fichier EPW actif : vent horaire, pas de rafales ; année type (mois d\'années différentes). ' : ''}Statistique observée ${p}, pas une prévision. Choisir la situation dans l'outil Vent (W) pour la poser sur la maquette.`),
      ].filter(Boolean));
    });
    return zone;
  }

  // Sélecteur « Moyenne 2016-2025 / année » : js/meteo.js definirAnnee, événement « meteoAnnee ». Depuis le 15/11/2026, Climat et Vent
  // utilisent la barre « Données météo » commune (app.meteoSource.barre({ annee: true })) ; gardé pour compatibilité.
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
  const redessiner = () => {
    if (groupe.visible || groupe.children.length) dessinerRose3D();
    // le conteneur du panneau est commun à tous les outils : seulement si Climat est l'outil ouvert
    if (conteneurPanneau?.isConnected && app.interface?.ouvert === 'climat') { conteneurPanneau.replaceChildren(); construirePanneau(conteneurPanneau); }
  };
  app.on('meteoAnnee', redessiner);
  app.on('meteoSource', redessiner); // source météo changée (base Météo-France / EPW, js/meteo-source.js)
  // onglet Export : petit bloc « Statistiques du climat » (Excel), inséré à l'ouverture de l'outil Export (comme la planche)
  app.on('outil', (id) => {
    if (id !== 'exporter') return;
    setTimeout(() => {
      const c = document.querySelector('#panneau-outil .panneau-contenu');
      if (!c || c.querySelector('.bloc-export-climat') || app.interface?.ouvert !== 'exporter') return;
      c.append(blocExportOnglet(app, () => statsPourExport(app)));
    }, 0);
  });

  function construirePanneau(conteneur) {
    conteneurPanneau = conteneur;
    const n = normales();
    const moisActif = app.soleil ? app.soleil.date().getMonth() : new Date().getMonth();
    conteneur.append(...[
      // barre « Données météo » commune (source + année des mesures, js/meteo-source.js) ; repli : anciens blocs séparés
      ...(app.meteoSource?.barre ? [app.meteoSource.barre({ annee: true })] : [app.meteoSource?.bloc(), selecteurAnnee()]),
      h('div', { class: 'titre-info' }, h('h3', {}, `Températures de l'air et vent par mois, ${libellePeriode()}`),
        info(`${mention({ annee: true })} Le centre-ville, plus minéral, est en général un peu plus chaud que l'aéroport (îlot de chaleur).`, 'La rose des vents est dans l\'outil Vent (touche W), avec le même choix de période.')),
      svgNormales(moisActif),
      n ? h('p', { class: 'resultat' }, texteMois(moisActif)) : null,
      ...blocExtremes(),
      blocConditions(),
      blocStatistiques(app),
    ].filter(Boolean));
  }

  function normalesDuMois(m) {
    const n = normales();
    return n ? { tmin: n.Tmin[m], tmax: n.Tmax[m], t: n.T[m], mois: MOIS[m] } : null;
  }

  // Réglage de la rose posée sur la maquette (depuis l'outil Vent : période, température, 12 ou 16 secteurs).
  function reglerRose(o = {}) {
    let change = false;
    for (const k of ['n', 'saison', 'temperature', 'mode', 'situation']) if (o[k] != null && o[k] !== etat[k]) { etat[k] = o[k]; change = true; }
    if (change) dessinerRose3D();
    if (o.visible != null) groupe.visible = o.visible;
  }

  // selecteurAnnee exporté : null quand la barre « Données météo » commune existe (elle porte déjà l'année : pas de doublon)
  return { construire, construirePanneau, normalesDuMois, groupe, etat, reglerRose, selecteurAnnee: () => (app.meteoSource?.barre ? null : selecteurAnnee()), afficherRose(v) { groupe.visible = v; } };
}
