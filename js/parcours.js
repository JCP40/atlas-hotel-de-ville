import * as THREE from 'three';
import { h, info } from './util.js';
import { chargerJSON, enregistrerDonnees, telecharger } from './donnees.js';
import { focaleVersFov, fovVersFocale } from './vues.js';

// Parcours enregistrés (onglet Vues > Parcours), créé par js/vues.js : remplace l'interface neutre app.parcours
// (boucle de rendu : app.parcours.maj(dt) à chaque image, controls.update() suspendu pendant la lecture ;
// Espace = pause et Échap = arrêt sont déjà gérés par js/interface.js, chapitres et plan arrêtent la lecture).
// - Enregistrement continu (caméra échantillonnée 10 fois par seconde, quelle que soit la navigation : orbite, vue piéton…)
//   ou par points clés (un clic = la vue actuelle ; durée entre deux points selon la distance).
// - Lecture : spline de Catmull-Rom sur la position et la cible, focale interpolée ; vitesse, pause, boucle.
// - data/parcours.json { description, parcours: [{ id, nom, mode, duree, points: [{ t, p: [lat, lon, h], c: [lat, lon, h], f }] }] }
//   (WGS84 + hauteur au-dessus du sol, comme les vues : indépendant de config.origine).
// - Export vidéo WebM : MediaRecorder sur canvas.captureStream() pendant une lecture complète (si le navigateur le permet).
// - Mode borne : demarrer() (fin de la présentation automatique) lit le premier parcours une fois, s'il existe.
const PAS_CONTINU = 0.1; // s
const VITESSE_CLES = 12; // m/s entre deux points clés (au moins 2 s)

export function creerParcours(app, vues) {
  if (!document.querySelector('link[href$="css/parcours.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/parcours.css' }));
  const cam3 = vues.cam3, ctl3 = vues.ctl3;
  const canvas = app.renderer.domElement;
  const etat = {
    liste: [], modifie: false, choisi: -1,
    enreg: null, // { mode, points, t, dernier }
    lecture: null, // { parcours, t, pause, boucle, vitesse, courbes, fin }
    vitesse: 1, boucle: false, video: null,
  };
  const ui = {};
  const r7 = (v) => Math.round(v * 1e7) / 1e7, r2 = (v) => Math.round(v * 100) / 100;
  const geo = (v) => { const g = vues.versGeo(v); return [r7(g.lat), r7(g.lon), r2(g.h)]; };
  const local = ([lat, lon, hh]) => vues.versLocal({ lat, lon, h: hh });

  // tracé du parcours choisi sur la maquette
  const trace = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x2a7f9e, dashSize: 3, gapSize: 2, depthTest: false, transparent: true, opacity: 0.85 }));
  trace.name = 'trace-parcours'; trace.renderOrder = 8; trace.userData.pasDeRelief = true; trace.visible = false; trace.raycast = () => {};
  app.scene.add(trace);
  function dessinerTrace() {
    const p = etat.liste[etat.choisi] || (etat.enreg && { points: etat.enreg.points });
    trace.visible = !!p && p.points.length > 1 && !etat.lecture;
    if (!trace.visible) return;
    const pts = p.points.map((q) => local(q.p));
    trace.geometry.dispose();
    trace.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    trace.computeLineDistances();
  }

  // ------------------------------------------------------------
  // Enregistrement
  // ------------------------------------------------------------
  function preparerCamera() {
    // la lecture et l'enregistrement se font en perspective (ou vue piéton pour l'enregistrement)
    if (app.vue2D || vues.axo.actif) { vues.quitterModes({ sauf: 'pieton' }); if (app.vue2D) vues.basculerVue(false); }
  }
  function point(t) {
    return { t: r2(t), p: geo(app.camera.position), c: geo(app.controls.target), f: Math.round(fovVersFocale(cam3.fov) * 10) / 10 };
  }
  function commencer(mode) {
    arreter();
    preparerCamera();
    etat.choisi = -1;
    etat.enreg = { mode, points: [], t: 0, dernier: -1 };
    if (mode === 'cles') ajouterCle();
    else etat.enreg.points.push(point(0));
    majPanneau();
    app.signaler(mode === 'cles' ? 'Parcours par points clés : déplacez la caméra puis « Ajouter un point clé ».' : 'Enregistrement du parcours : naviguez (orbite ou vue piéton), puis « Terminer ».');
  }
  function ajouterCle() {
    const e = etat.enreg; if (!e || e.mode !== 'cles') return;
    const q = point(0);
    const prec = e.points[e.points.length - 1];
    if (prec) {
      const d = local(prec.p).distanceTo(local(q.p)) + 0.3 * local(prec.c).distanceTo(local(q.c));
      if (d < 0.05) { app.signaler('Point clé identique au précédent : déplacez d\'abord la caméra.'); return; }
      q.t = r2(prec.t + Math.max(2, d / VITESSE_CLES));
    }
    e.points.push(q);
    dessinerTrace(); majPanneau();
  }
  function terminer(nom) {
    const e = etat.enreg; if (!e) return null;
    etat.enreg = null;
    if (e.points.length < 2) { app.signaler('Parcours trop court : rien n\'a été enregistré.'); majPanneau(); dessinerTrace(); return null; }
    const p = { id: `p${Date.now().toString(36)}`, nom: (nom || '').trim() || `Parcours ${etat.liste.length + 1}`, mode: e.mode, date: new Date().toISOString().slice(0, 16), duree: e.points[e.points.length - 1].t, points: e.points };
    etat.liste.push(p);
    etat.choisi = etat.liste.length - 1;
    etat.modifie = true;
    majPanneau(); dessinerTrace();
    app.signaler(`Parcours « ${p.nom} » enregistré (${p.points.length} points, ${formaterDuree(p.duree)}).`);
    return p;
  }
  function annuler() { etat.enreg = null; majPanneau(); dessinerTrace(); }

  // ------------------------------------------------------------
  // Lecture
  // ------------------------------------------------------------
  // Catmull-Rom (uniforme) entre q1 et q2, avec voisins q0 et q3
  const cr = (q0, q1, q2, q3, u) => {
    const u2 = u * u, u3 = u2 * u;
    return new THREE.Vector3().addScaledVector(q0, -0.5 * u3 + u2 - 0.5 * u).addScaledVector(q1, 1.5 * u3 - 2.5 * u2 + 1)
      .addScaledVector(q2, -1.5 * u3 + 2 * u2 + 0.5 * u).addScaledVector(q3, 0.5 * u3 - 0.5 * u2);
  };
  function echantillon(L, t) {
    const pts = L.points, n = pts.length;
    let i = 0;
    while (i < n - 2 && pts[i + 1].t <= t) i++;
    const a = pts[i], b = pts[Math.min(i + 1, n - 1)];
    let u = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 1;
    if (L.parcours.mode === 'cles') u = u * u * (3 - 2 * u); // arrivée et départ adoucis à chaque point clé
    const k = (j) => Math.max(0, Math.min(n - 1, j));
    const P = L.P, C = L.C;
    return {
      p: cr(P[k(i - 1)], P[i], P[k(i + 1)], P[k(i + 2)], u),
      c: cr(C[k(i - 1)], C[i], C[k(i + 1)], C[k(i + 2)], u),
      f: a.f + ((b.f ?? a.f) - a.f) * u,
    };
  }
  function lire(i = etat.choisi, { boucle = etat.boucle, video = false } = {}) {
    const p = etat.liste[i];
    if (!p || p.points.length < 2) { app.signaler('Choisissez un parcours enregistré.'); return false; }
    if (etat.enreg) annuler();
    arreter();
    preparerCamera();
    vues.quitterModes();
    etat.choisi = i;
    const L = { parcours: p, points: p.points, P: p.points.map((q) => local(q.p)), C: p.points.map((q) => local(q.c)), t: 0, pause: false, boucle, video, fovAvant: cam3.fov };
    etat.lecture = L;
    app.animationCamera = null;
    ctl3.enabled = false;
    app.camera = cam3; app.controls = ctl3;
    api.actif = true;
    appliquerEchantillon(echantillon(L, 0));
    dessinerTrace(); majPanneau();
    return true;
  }
  function appliquerEchantillon(s) {
    cam3.position.copy(s.p);
    ctl3.target.copy(s.c);
    cam3.lookAt(s.c);
    const fov = focaleVersFov(s.f);
    if (Math.abs(cam3.fov - fov) > 0.01) { cam3.fov = fov; cam3.updateProjectionMatrix(); }
  }
  function arreter() {
    const L = etat.lecture;
    if (!L) return;
    etat.lecture = null;
    api.actif = false;
    ctl3.enabled = true;
    // la cible d'orbite reste devant la caméra (au moins 2 m, distance minimale des contrôles)
    if (cam3.position.distanceTo(ctl3.target) < 2.5) ctl3.target.copy(cam3.position).add(cam3.getWorldDirection(new THREE.Vector3()).multiplyScalar(5));
    ctl3.update();
    // vidéo : l'enregistreur s'arrête après le rendu de la dernière image
    if (L.recorder && L.recorder.state !== 'inactive') requestAnimationFrame(() => L.recorder.stop());
    dessinerTrace(); majPanneau();
  }
  function basculerPause() {
    if (!etat.lecture) return;
    etat.lecture.pause = !etat.lecture.pause;
    majPanneau();
  }
  function maj(dt) {
    const e = etat.enreg;
    if (e && e.mode === 'continu') {
      e.t += dt;
      if (e.t - e.points[e.points.length - 1].t >= PAS_CONTINU) {
        const q = point(e.t), prec = e.points[e.points.length - 1];
        // caméra immobile : on n'empile pas les points, on garde le temps (pause dans le parcours)
        if (q.p.some((v, k) => v !== prec.p[k]) || q.c.some((v, k) => v !== prec.c[k]) || q.f !== prec.f || e.t - prec.t > 1) e.points.push(q);
        if (ui.statut && e.points.length % 10 === 0) majStatut();
      }
      return;
    }
    const L = etat.lecture;
    if (!L) return;
    if (!L.pause) L.t += dt * etat.vitesse;
    const D = L.points[L.points.length - 1].t;
    if (L.t >= D) {
      if (L.boucle && !L.video) L.t %= D;
      else { appliquerEchantillon(echantillon(L, D)); arreter(); return; }
    }
    appliquerEchantillon(echantillon(L, L.t));
    if (ui.statut) majStatut();
  }

  // ------------------------------------------------------------
  // Export vidéo WebM (MediaRecorder sur le canevas WebGL)
  // ------------------------------------------------------------
  function formatVideo() {
    if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) return null;
    return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || null;
  }
  function exporterVideo(i = etat.choisi) {
    const type = formatVideo();
    if (!type) { app.signaler('Export vidéo impossible : ce navigateur ne permet pas d\'enregistrer le canevas (MediaRecorder / captureStream). Utilisez Chrome, Edge ou Firefox récents, ou une capture d\'écran vidéo du système.'); return false; }
    const p = etat.liste[i];
    if (!p) { app.signaler('Choisissez un parcours enregistré.'); return false; }
    let enr;
    try {
      const flux = canvas.captureStream(30);
      enr = new MediaRecorder(flux, { mimeType: type, videoBitsPerSecond: 8e6 });
    } catch (err) { app.signaler(`Export vidéo impossible : ${err.message}`); return false; }
    const morceaux = [];
    enr.ondataavailable = (e) => { if (e.data?.size) morceaux.push(e.data); };
    enr.onstop = () => {
      const blob = new Blob(morceaux, { type: 'video/webm' });
      etat.video = { taille: blob.size };
      const nom = `${p.nom.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'parcours'}.webm`;
      if (blob.size) { telecharger(nom, blob, 'video/webm'); app.signaler(`Vidéo ${nom} (${Math.round(blob.size / 1024)} ko) : sans les étiquettes ni les panneaux, qui ne sont pas dans le canevas.`); }
      else app.signaler('La vidéo est vide (navigateur sans rendu du canevas).');
      majPanneau();
    };
    if (!lire(i, { boucle: false, video: true })) return false;
    etat.lecture.recorder = enr;
    enr.start(500);
    majPanneau();
    return true;
  }

  // ------------------------------------------------------------
  // Liste et fichier data/parcours.json
  // ------------------------------------------------------------
  function renommer(i, nom) { const p = etat.liste[i]; if (!p || !nom?.trim()) return; p.nom = nom.trim(); etat.modifie = true; majPanneau(); }
  function supprimer(i) {
    if (!etat.liste[i]) return;
    if (etat.lecture?.parcours === etat.liste[i]) arreter();
    etat.liste.splice(i, 1);
    if (etat.choisi >= etat.liste.length) etat.choisi = etat.liste.length - 1;
    etat.modifie = true;
    majPanneau(); dessinerTrace();
  }
  function serialiser() {
    return { description: 'Parcours de caméra de l\'atlas (onglet Vues > Parcours). t en secondes ; p (position) et c (cible) en [lat, lon, h], h = hauteur au-dessus du sol (m) ; f = focale en mm équivalent 24 × 36.', parcours: etat.liste };
  }
  async function charger() {
    const d = await chargerJSON('data/parcours.json', null);
    etat.liste = Array.isArray(d?.parcours) ? d.parcours.filter((p) => Array.isArray(p?.points) && p.points.length > 1) : [];
    etat.modifie = false;
  }
  async function enregistrer() {
    const r = await enregistrerDonnees('parcours.json', JSON.stringify(serialiser()), { apres: 'relu à la prochaine ouverture' });
    etat.modifie = false; majPanneau();
    return r;
  }

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  const formaterDuree = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${Math.round(s * 10) / 10} s`);
  function majStatut() {
    if (!ui.statut) return;
    const e = etat.enreg, L = etat.lecture;
    ui.statut.textContent = e ? `Enregistrement ${e.mode === 'cles' ? 'par points clés' : 'continu'} : ${e.points.length} point${e.points.length > 1 ? 's' : ''}${e.mode === 'continu' ? `, ${formaterDuree(e.t)}` : `, ${formaterDuree(e.points[e.points.length - 1]?.t || 0)}`}`
      : L ? `${L.video ? 'Vidéo en cours' : L.pause ? 'En pause' : 'Lecture'} : ${L.parcours.nom}, ${formaterDuree(L.t)} / ${formaterDuree(L.points[L.points.length - 1].t)}` : '';
  }
  function majPanneau() {
    if (!ui.zone) return;
    const e = etat.enreg, L = etat.lecture;
    ui.enreg.replaceChildren(...(e
      ? [e.mode === 'cles' ? h('button', { type: 'button', class: 'bouton', onclick: ajouterCle }, 'Ajouter un point clé') : null,
        h('button', { type: 'button', class: 'bouton principal', onclick: () => terminer(ui.nom.value) }, 'Terminer'),
        h('button', { type: 'button', class: 'bouton discret', onclick: annuler }, 'Annuler')].filter(Boolean)
      : app.mode === 'borne' ? [] : [
        h('button', { type: 'button', class: 'bouton principal', title: 'Enregistre la caméra en continu pendant que vous naviguez', onclick: () => commencer('continu') }, '● Enregistrer'),
        h('button', { type: 'button', class: 'bouton', title: 'Parcours fait de vues successives, reliées par une courbe douce', onclick: () => commencer('cles') }, 'Par points clés')]));
    ui.nom.hidden = !e;
    ui.lecture.replaceChildren(
      h('button', { type: 'button', class: 'bouton principal', disabled: !!e || !etat.liste[etat.choisi], onclick: () => (L ? basculerPause() : lire()) }, L ? (L.pause ? '▶ Reprendre' : '❚❚ Pause') : '▶ Lire'),
      h('button', { type: 'button', class: 'bouton', disabled: !L, onclick: arreter }, '■ Arrêter'),
      h('label', {}, 'Vitesse ', h('select', { 'aria-label': 'Vitesse de lecture', onchange: (ev) => { etat.vitesse = +ev.target.value; } },
        ...[0.25, 0.5, 1, 2, 4].map((v) => h('option', { value: String(v), selected: v === etat.vitesse }, `× ${String(v).replace('.', ',')}`)))),
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.boucle, onchange: (ev) => { etat.boucle = ev.target.checked; if (etat.lecture && !etat.lecture.video) etat.lecture.boucle = etat.boucle; } }), 'Boucle'));
    ui.liste.replaceChildren(...etat.liste.map((p, i) => h('li', { class: i === etat.choisi ? 'choisi' : '' },
      h('button', { type: 'button', class: 'nom-parcours', title: 'Choisir ce parcours', onclick: () => { etat.choisi = i; dessinerTrace(); majPanneau(); } },
        h('span', {}, p.nom), h('em', {}, `${p.mode === 'cles' ? `${p.points.length} points clés` : 'continu'}, ${formaterDuree(p.duree ?? p.points[p.points.length - 1].t)}`)),
      h('button', { type: 'button', class: 'mini', title: 'Lire', 'aria-label': `Lire ${p.nom}`, onclick: () => lire(i) }, '▶'),
      app.mode === 'borne' ? null : h('button', { type: 'button', class: 'mini', title: 'Renommer', 'aria-label': `Renommer ${p.nom}`, onclick: () => { const n = window.prompt('Nom du parcours', p.nom); if (n) renommer(i, n); } }, '✎'),
      app.mode === 'borne' ? null : h('button', { type: 'button', class: 'mini danger', title: 'Supprimer', 'aria-label': `Supprimer ${p.nom}`, onclick: () => { if (window.confirm(`Supprimer le parcours « ${p.nom} » ?`)) supprimer(i); } }, '×'))));
    ui.vide.hidden = etat.liste.length > 0;
    const fmt = formatVideo();
    ui.video.disabled = !fmt || !etat.liste[etat.choisi] || !!e || !!L;
    ui.videoNote.textContent = fmt ? `Vidéo ${fmt.replace('video/', '').replace(';codecs=', ', ')} à 30 images/s : le parcours choisi est lu une fois, du début à la fin, puis le fichier est téléchargé.` : 'Export vidéo indisponible dans ce navigateur (MediaRecorder ou captureStream absent) : utilisez Chrome, Edge ou Firefox récents, ou une capture d\'écran vidéo du système.';
    if (ui.enregistrer) ui.enregistrer.textContent = `Enregistrer parcours.json${etat.modifie ? ' *' : ''}`;
    majStatut();
  }
  function construirePanneau(c) {
    ui.zone = c;
    ui.nom = h('input', { type: 'text', class: 'nom-nouveau-parcours', placeholder: `Parcours ${etat.liste.length + 1}`, 'aria-label': 'Nom du parcours' });
    ui.nom.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') terminer(ui.nom.value); });
    ui.enreg = h('div', { class: 'actions' });
    ui.statut = h('p', { class: 'note statut-parcours', 'aria-live': 'polite' });
    ui.lecture = h('div', { class: 'actions lecture-parcours' });
    ui.liste = h('ol', { class: 'liste-parcours' });
    ui.vide = h('p', { class: 'note', 'data-garder': '' }, 'Aucun parcours enregistré.');
    ui.video = h('button', { type: 'button', class: 'bouton', onclick: () => exporterVideo() }, 'Exporter en vidéo WebM');
    ui.videoNote = h('p', { class: 'note', 'data-garder': '' });
    ui.enregistrer = app.mode === 'presentateur' ? h('button', { type: 'button', class: 'bouton', onclick: enregistrer }, 'Enregistrer parcours.json') : null;
    c.append(
      h('section', {},
        h('div', { class: 'titre-info' }, h('h3', {}, 'Enregistrer un déplacement'),
          info('« Enregistrer » : la caméra est relevée dix fois par seconde pendant que vous naviguez (orbite, zoom, vue piéton de l\'outil Observateur), jusqu\'à « Terminer ». Les arrêts de plus d\'une seconde sont gardés comme des pauses.',
            '« Par points clés » : chaque « Ajouter un point clé » garde la vue actuelle ; la lecture les relie par une courbe douce (vitesse moyenne 12 m/s, au moins 2 s entre deux points).',
            'Le plan et l\'axonométrie repassent en perspective : un parcours se lit toujours en perspective, avec la focale enregistrée.')),
        ui.enreg, ui.nom, ui.statut),
      h('section', {},
        h('div', { class: 'titre-info' }, h('h3', {}, 'Parcours enregistrés'),
          info('Lecture : Espace = pause, Échap = arrêt (raccourcis de l\'atlas). Les étiquettes sont masquées pendant la lecture. Un parcours se joue aussi en fin de présentation automatique du mode borne (le premier de la liste).',
            'Fichier data/parcours.json (serveur local), sinon téléchargé : à déposer dans data/. Positions en latitude / longitude.')),
        ui.vide, ui.liste, ui.lecture,
        h('div', { class: 'actions' }, ui.video, ui.enregistrer),
        ui.videoNote),
    );
    majPanneau();
  }

  const api = {
    actif: false,
    demarrer() { if (etat.liste.length) lire(0, { boucle: false }); },
    arreter, basculerPause, maj, construire() {},
    construirePanneau, charger, enregistrer, serialiser, commencer, ajouterCle, terminer, annuler, lire, exporterVideo, formatVideo, renommer, supprimer,
    etat, echantillon,
    get liste() { return etat.liste; },
  };
  return api;
}
