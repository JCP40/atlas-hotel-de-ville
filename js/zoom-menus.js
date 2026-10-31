import { h, lireLS, ecrireLS } from './util.js';

// Verrouillage du zoom des menus sur téléphone et tablette (31/10/2026).
// Sur écran tactile, un pincement ou un double-tap sur un menu (onglets, panneaux, barre des chapitres, Existant / Projet,
// barre Soleil, légende) agrandissait toute la page. Option activée par défaut sur écran tactile, désactivable dans l'Aide
// (case « Verrouiller le zoom des menus (mobile) », localStorage « atlas-hdv-zoom-menus » : '1' ou '0').
// Quand elle est active :
// - classe body.zoom-menus-verrouille : touch-action pan-x pan-y hors du canevas (défilement des panneaux gardé,
//   pincement et double-tap ignorés), le canevas #scene gardant touch-action: none (zoom de la carte par OrbitControls) ;
// - meta viewport : maximum-scale=1, user-scalable=no (pris en compte par Android ; iOS Safari l'ignore pour le pincement) ;
// - garde-fous pour iOS Safari : gesturestart / gesturechange preventDefault et touchmove à plusieurs doigts preventDefault
//   quand le geste ne commence pas sur le canevas.
// Sans écran tactile (souris), la case est absente et rien n'est appliqué.
const CLE = 'atlas-hdv-zoom-menus';
const VIEWPORT_LIBRE = 'width=device-width, initial-scale=1, viewport-fit=cover';
const VIEWPORT_VERROUILLE = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

export function creerZoomMenus(app) {
  const tactile = (() => {
    try { return window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0; } catch { return false; }
  })();
  const memo = lireLS(CLE);
  let actif = tactile && memo !== '0';
  const canevas = app.renderer?.domElement || document.getElementById('scene');
  const surCanevas = (e) => !!canevas && (e.target === canevas || canevas.contains?.(e.target));
  // un pincement commencé sur le canevas reste au canevas jusqu'à ce que tous les doigts soient levés
  let gesteCanevas = false;

  const surGeste = (e) => { if (actif && !surCanevas(e) && !gesteCanevas) e.preventDefault(); };
  document.addEventListener('gesturestart', (e) => { gesteCanevas = surCanevas(e); surGeste(e); }, { passive: false });
  document.addEventListener('gesturechange', surGeste, { passive: false });
  document.addEventListener('gestureend', surGeste, { passive: false });
  document.addEventListener('touchstart', (e) => { if (e.touches.length === 1) gesteCanevas = surCanevas(e); }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (actif && e.touches.length > 1 && !gesteCanevas && !surCanevas(e)) e.preventDefault();
  }, { passive: false });

  function appliquer() {
    document.body.classList.toggle('zoom-menus-verrouille', actif);
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta && tactile) meta.setAttribute('content', actif ? VIEWPORT_VERROUILLE : VIEWPORT_LIBRE);
  }

  function definir(v) {
    actif = !!v && tactile;
    ecrireLS(CLE, v ? '1' : '0');
    appliquer();
    if (ui.input) ui.input.checked = actif;
  }

  // case dans l'Aide (écrans tactiles seulement)
  const ui = {};
  const aide = document.getElementById('aide');
  if (tactile && aide) {
    ui.input = h('input', { type: 'checkbox', checked: actif, onchange: (e) => definir(e.target.checked) });
    const ligne = h('label', { class: 'case case-zoom-menus' }, ui.input, 'Verrouiller le zoom des menus (mobile)');
    const note = aide.querySelector('p.note');
    if (note) note.before(ligne); else aide.append(ligne);
  }
  appliquer();

  return { definir, get actif() { return actif; }, tactile };
}
