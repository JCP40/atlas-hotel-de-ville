import { h } from './util.js';

// Phase affichée « Existant / Projet » (23/10/2026), sélecteur en haut à droite (#haut-droite), au-dessus de la bascule
// Maquette 3D / Plan (depuis le 30/10/2026 ; avant : en haut à gauche sous le titre). Les bascules rapides « Arbres » et
// « Routes » sont passées dans Site > Couches > Éléments (js/elements.js : case Routes = chaussées + trottoirs).
// - Existant : site réel, sans les volumes ni les imports du projet, sans démolitions, matériaux de l'existant (Chaleur).
// - Projet : volumes ajoutés, démolitions et matériaux du projet (corrections de phase « projet » de l'outil Chaleur).
// Branché sur le calque Projet (app.projet.definirVisible : bâti effectif reconstruit, événement « bati » : les outils ouverts
// se recalculent) ; suit aussi les bascules faites ailleurs (Vent « avec / sans le projet », comparaison de Chaleur).
// Hauteurs corrigées (data/hauteurs.json) : corrections du relevé, communes aux deux phases.
// Gardée par les points de vue dans app.couches.phase ; indiquée dans la légende automatique (section « phase ») et dans le
// cartouche de la planche à l'échelle (texte()). Événement « phase » à chaque changement. Styles : css/etudes.css.
export const PHASES = {
  existant: { libelle: 'Existant', titre: 'Site actuel : sans les volumes, démolitions et matériaux du projet' },
  projet: { libelle: 'Projet', titre: 'Avec les volumes ajoutés, les démolitions et les matériaux du projet' },
};

export function creerPhase(app) {
  const etat = { phase: app.projet?.visible === false ? 'existant' : 'projet' };
  app.couches.phase = etat.phase;
  const ui = {};

  function definir(p) {
    if (!PHASES[p]) return;
    const change = p !== etat.phase;
    etat.phase = p;
    app.couches.phase = p;
    if (app.projet && app.projet.visible !== (p === 'projet')) app.projet.definirVisible(p === 'projet'); // émet « bati »
    majUI();
    if (change) { app.emettre('phase', p); app.emettre('legende'); }
  }
  // points de vue et chapitres (app.couches.phase), bascules faites par d'autres outils (calque Projet)
  app.on('couches', () => { if (PHASES[app.couches.phase] && app.couches.phase !== etat.phase) definir(app.couches.phase); else majUI(); });
  app.on('bati', () => {
    const p = app.projet?.visible === false ? 'existant' : 'projet';
    if (p === etat.phase) return;
    etat.phase = p; app.couches.phase = p;
    majUI(); app.emettre('phase', p); app.emettre('legende');
  });

  function majUI() {
    if (!ui.el) return;
    for (const b of ui.phases) { const on = b.dataset.phase === etat.phase; b.classList.toggle('actif', on); b.setAttribute('aria-pressed', String(on)); }
  }
  // même largeur que la bascule Maquette 3D / Plan placée juste dessous (boutons étirés : css/etudes.css)
  function placer() {
    const v = document.getElementById('bascule-vue');
    if (!v || !ui.el) return;
    ui.el.style.minWidth = ''; v.style.minWidth = '';
    const l = Math.ceil(Math.max(ui.el.offsetWidth, v.offsetWidth));
    if (!l) return;
    ui.el.style.minWidth = `${l}px`; v.style.minWidth = `${l}px`;
  }
  function construire() {
    if (!document.querySelector('link[href="css/etudes.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/etudes.css' }));
    ui.phases = Object.entries(PHASES).map(([p, P]) => h('button', { type: 'button', class: 'phase-bouton', 'data-phase': p, title: P.titre, 'aria-pressed': 'false', onclick: () => definir(p) }, P.libelle));
    ui.el = h('div', { class: 'barre-phase phase-choix', role: 'group', 'aria-label': 'Phase affichée' }, ...ui.phases);
    // en haut à droite, juste au-dessus de la bascule Maquette 3D / Plan
    const v = document.getElementById('bascule-vue'), hote = document.getElementById('haut-droite');
    if (v) v.before(ui.el); else if (hote) hote.prepend(ui.el); else document.body.append(ui.el);
    majUI();
    requestAnimationFrame(placer);
    window.addEventListener('resize', placer);
    document.fonts?.ready?.then(placer);
  }
  construire();
  setTimeout(placer, 500);

  // légende automatique : phase en tête
  app.legende?.ajouter?.(() => ({ id: 'phase', titre: `Phase : ${PHASES[etat.phase].libelle.toLowerCase()}`, note: PHASES[etat.phase].titre + '.' }));

  return {
    definir, PHASES, placer,
    get phase() { return etat.phase; },
    estProjet: () => etat.phase === 'projet',
    texte: () => `Phase : ${etat.phase === 'projet' ? 'projet (volumes ajoutés, démolitions et matériaux du projet)' : 'existant (site actuel, sans le projet)'}`,
  };
}
