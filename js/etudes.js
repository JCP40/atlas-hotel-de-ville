import { h, allerVers } from './util.js';

// Barre du bas « Chapitres / Études » (23/10/2026). Le sélecteur à gauche de la règle choisit ce qu'elle propose :
// les chapitres de l'atlas (inchangés, js/chapitres.js) ou six études d'Ambiance prêtes à présenter :
// 1 Ensoleillement · 2 Climat · 3 Vent · 4 Chaleur · 5 Confort · 6 Bruit. Un clic ouvre l'analyse avec des réglages et une vue
// par défaut (ETUDES[].ouvrir) ; l'étude active propose « Exporter » : planche à l'échelle directe (réglages par défaut de
// js/planche.js, 500 × 500 mm au 1/500, légende automatique et cartouche), en PDF ou en SVG. Mode mémorisé (localStorage
// atlas-hdv-barre-bas). Créé par js/chapitres.js (app.etudes) ; flèches et touches ← → suivent le mode. Styles : css/etudes.css.
const CLE = 'atlas-hdv-barre-bas';
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

export function creerEtudes(app, regle) {
  // vues par défaut : vue d'ensemble oblique du plateau (comme l'ouverture) ou plan vu de dessus
  function vueEnsemble() {
    if (app.vue2D) app.vue.basculer(false);
    const R = app.config.rayonPlateau || 45;
    const y0 = app.relief?.dz ? app.relief.dz(0, 0) || 0 : 0;
    allerVers(app, [0.9 * R, y0 + 2.55 * R, 2.85 * R], [0, y0 + 4, 0], 1200);
  }
  function vuePlan() { if (!app.vue2D) app.vue.basculer(true); }
  const bouton = (texte) => [...document.querySelectorAll('#panneau-outil button')].find((b) => b.textContent.trim() === texte);

  const ETUDES = [
    { id: 'ensoleillement', titre: 'Ensoleillement', outil: 'soleil', sous: 'ombres et diagramme solaire',
      async ouvrir() { app.soleil.definirMode('diagramme'); vueEnsemble(); } },
    { id: 'climat', titre: 'Climat', outil: 'climat', sous: 'températures, vent, jours extrêmes',
      async ouvrir() { vueEnsemble(); } },
    { id: 'vent', titre: 'Vent', outil: 'vent', sous: '4 roses des saisons, écoulement',
      avant() { if (app.vent?.etat) { app.vent.etat.quatreSaisons = true; app.vent.etat.roseMaquette = false; } },
      async ouvrir() { vuePlan(); app.emettre('legende'); } },
    { id: 'chaleur', titre: 'Chaleur', outil: 'chaleur', sous: 'température de surface, journée chaude, 15 h',
      async ouvrir() { await app.chaleur.charger(); vuePlan(); app.chaleur.prereglage('chaude'); },
      pret: () => !app.chaleur.etat.calcul && !!app.chaleur.etat.calque },
    { id: 'confort', titre: 'Confort', outil: 'confort', sous: 'température ressentie, après-midi chaud',
      async ouvrir() { vuePlan(); await attendre(50); bouton('Confort thermique')?.click(); },
      pret: () => !!app.confort.etat.calque },
    { id: 'bruit', titre: 'Bruit', outil: 'bruit', sous: 'carte du bruit (Lden)',
      async ouvrir() { if (!app.couches.bruit) { app.couches.bruit = true; app.emettre('couches'); } vuePlan(); } },
  ];

  const etat = { actif: false, index: -1 };
  try { etat.actif = localStorage.getItem(CLE) === 'etudes'; } catch { /* stockage indisponible */ }
  const ui = {};

  async function aller(i) {
    if (i < 0 || i >= ETUDES.length) return;
    etat.index = i;
    const E = ETUDES[i];
    app.chapitres?.masquerCarte?.();
    majSegments();
    try {
      // les 4 roses ne restent que pour l'étude Vent (planche : roses par défaut si quatreSaisons)
      if (E.id !== 'vent' && app.vent?.etat) app.vent.etat.quatreSaisons = false;
      E.avant?.();
      app.interface?.ouvrir(E.outil); // une analyse d'Ambiance à la fois (js/ambiances.js)
      await E.ouvrir();
    } catch (e) { console.warn('étude', E.id, e); app.signaler(`Étude « ${E.titre} » : ${e.message}`); }
    app.emettre('etude', E.id);
  }
  const suivant = () => aller(Math.min(etat.index + 1, ETUDES.length - 1));
  const precedent = () => aller(Math.max(etat.index - 1, 0));

  async function exporter(i, type) {
    const E = ETUDES[i];
    if (etat.index !== i) await aller(i);
    if (!app.planche?.exporterDefaut) { app.signaler('Planche à l\'échelle indisponible.'); return null; }
    // calcul encore en cours (Chaleur, Confort) : la planche attend la carte (2 min au plus)
    for (let t = 0; E.pret && !E.pret() && t < 240; t++) { if (t === 0) app.signaler(`Étude « ${E.titre} » : calcul en cours, la planche suivra…`); await attendre(500); }
    app.signaler(`Planche « ${E.titre} » en ${type.toUpperCase()}…`);
    await attendre(300);
    try {
      return await app.planche.exporterDefaut(type, `Hôtel de Ville de Nantes — étude ${i + 1} : ${E.titre.toLowerCase()} (${E.sous})`);
    } catch (e) { app.signaler(`Export impossible : ${e.message}`); console.warn(e); return null; }
  }

  function majSegments() {
    ui.segments?.forEach((s, k) => {
      s.el.classList.toggle('actif', k === etat.index);
      s.el.classList.toggle('passe', k < etat.index);
      s.el.setAttribute('aria-current', k === etat.index ? 'step' : 'false');
      s.export.hidden = k !== etat.index;
    });
  }
  function definirMode(etudes) {
    etat.actif = !!etudes;
    try { localStorage.setItem(CLE, etat.actif ? 'etudes' : 'chapitres'); } catch { /* stockage indisponible */ }
    regle.classList.toggle('mode-etudes', etat.actif);
    regle.querySelector('.segments:not(.segments-etudes)')?.toggleAttribute('hidden', etat.actif);
    ui.liste.hidden = !etat.actif;
    for (const b of ui.modes) { const on = (b.dataset.mode === 'etudes') === etat.actif; b.classList.toggle('actif', on); b.setAttribute('aria-pressed', String(on)); }
    if (etat.actif) app.chapitres?.masquerCarte?.();
    app.emettre('barreBas', etat.actif ? 'etudes' : 'chapitres');
  }

  function construire() {
    if (!document.querySelector('link[href="css/etudes.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/etudes.css' }));
    ui.modes = [['chapitres', 'Chapitres'], ['etudes', 'Études']].map(([m, l]) => h('button', { type: 'button', class: 'mode-barre-bouton', 'data-mode': m, 'aria-pressed': 'false', onclick: () => definirMode(m === 'etudes') }, l));
    const mode = h('div', { class: 'mode-barre', role: 'group', 'aria-label': 'Barre du bas : chapitres ou études' }, ...ui.modes);
    ui.segments = ETUDES.map((E, i) => {
      const exp = (type) => h('button', { type: 'button', class: 'etude-export-bouton', title: `Planche à l'échelle 500 × 500 mm au 1/500 en ${type.toUpperCase()}`, onclick: (e) => { e.stopPropagation(); exporter(i, type); } }, type.toUpperCase());
      const exportEl = h('span', { class: 'etude-export', hidden: true }, h('span', {}, 'Exporter'), exp('pdf'), exp('svg'));
      const el = h('div', { class: 'segment segment-etude', role: 'button', tabindex: 0, 'aria-label': `Étude ${i + 1} : ${E.titre}`, title: E.sous, onclick: () => aller(i),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aller(i); } } },
      h('span', { class: 'numero' }, String(i + 1)), h('span', { class: 'titre' }, E.titre), exportEl);
      return { el, export: exportEl };
    });
    ui.liste = h('div', { class: 'segments segments-etudes', hidden: true }, ...ui.segments.map((s) => s.el));
    regle.prepend(mode);
    const seg = regle.querySelector('.segments');
    if (seg) seg.after(ui.liste); else regle.append(ui.liste);
    definirMode(etat.actif);
  }
  construire();

  return {
    ETUDES, aller, suivant, precedent, exporter, definirMode,
    get actif() { return etat.actif; },
    get index() { return etat.index; },
  };
}
