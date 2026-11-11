// Barre « Exporter » des statistiques du climat (11/11/2026) : Excel (.xlsx), PDF (graphiques + données) et CSV, avec progression et durée estimée.
// Utilisée par js/climat-stats-bloc.js (bloc « Statistiques du climat »), js/climat.js (bloc « Conditions extrêmes » et bloc de l'onglet Export).
// Les modules lourds (js/climat-export.js, js/climat-export-pdf.js, js/xlsx.js, js/pdf-rapport.js) ne sont chargés qu'au premier clic.
// Tout se fait dans le navigateur, hors ligne : aucune donnée n'est envoyée. Styles injectés : style#styles-export-climat.
import { h } from './util.js';
import { telecharger } from './donnees.js';
import { heuresClimat, extremesDetail, mention, source, erreurExtremesDetail } from './meteo.js';

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let enCours = false;
const verrous = new Set(); // rappels pour (dés)activer toutes les barres pendant un export

function styles() {
  if (document.getElementById('styles-export-climat')) return;
  document.head.append(h('style', { id: 'styles-export-climat' }, `
.barre-export-climat { border: 1px solid rgba(47,59,69,.22); border-radius: 4px; padding: 6px 8px 8px; margin: 8px 0; background: rgba(221,229,236,.35); }
.barre-export-climat .titre-export { font-size: 12px; font-weight: 600; margin: 0 0 4px; }
.barre-export-climat .rangee-export { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin: 3px 0; }
.barre-export-climat label.case-export { display: flex; align-items: center; gap: 4px; font-size: 12px; }
.barre-export-climat .taille-export { font-size: 11px; color: #5b6770; }
.barre-export-climat progress { width: 100%; max-width: 360px; height: 8px; }
.barre-export-climat .etat-export { font-size: 11px; color: #3d4a54; margin: 3px 0 0; min-height: 1.2em; }
.barre-export-climat .erreur-export { font-size: 12px; color: #9b1c1c; margin: 3px 0 0; }
.barre-export-climat button[disabled] { opacity: .55; cursor: progress; }
.bloc-export-climat h3 { margin: 10px 0 2px; font-size: 14px; }
@media (max-width: 520px) { .barre-export-climat .rangee-export { flex-direction: column; align-items: stretch; } .barre-export-climat progress { max-width: none; } }
`));
}

const taille = (o) => (o < 1e6 ? `${Math.max(1, Math.round(o / 1e3)).toLocaleString('fr-FR')} Ko` : `${(o / 1e6).toFixed(o < 1e7 ? 1 : 0).replace('.', ',')} Mo`);
const duree = (s) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);

// contexte d'export : mêmes objets que ceux affichés (S, R du bloc, X des conditions extrêmes)
export async function construireContexte(portee, stats) {
  const E = await heuresClimat();
  if (!E) throw new Error(erreurExtremesDetail() || 'Mesures horaires indisponibles : déposer meteofrance_44020001_horaire.csv dans data/meteo/.');
  const X = await extremesDetail();
  return { portee, E, S: portee === 'extremes' ? null : stats?.S ?? null, R: portee === 'extremes' ? null : stats?.R ?? null, X, info: source(), mentionLongue: mention({ annee: true }), mentionCourte: mention({ court: true, annee: true }), version: 'v8', date: new Date() };
}

// options : portee 'tout' | 'extremes' ; stats() → Promise<{ S, R }> (portee 'tout') ; csv() → [{ nom, texte }] ou null (boutons CSV facultatifs)
// pdf : affiche le bouton PDF (false tant que le rapport PDF n'est pas livré)
export function barreExport(app, { portee = 'tout', stats = null, csv = null, titre = 'Exporter', pdf = false } = {}) {
  styles();
  const tout = portee !== 'extremes';
  const etat = h('p', { class: 'etat-export', role: 'status', 'aria-live': 'polite' });
  const erreur = h('p', { class: 'erreur-export', role: 'alert', hidden: true });
  const barre = h('progress', { max: '1', value: '0', hidden: true, 'aria-label': 'Progression de l\'export' });
  const caseH = tout ? h('input', { type: 'checkbox', id: `horaires-${Math.random().toString(36).slice(2, 7)}` }) : null;
  const tailleX = h('span', { class: 'taille-export' });
  const boutons = [];
  const bXlsx = h('button', { type: 'button', class: 'bouton principal petit', onclick: () => lancer('xlsx') }, tout ? 'Excel (.xlsx)' : 'Excel (.xlsx), extrêmes');
  const bPdf = h('button', { type: 'button', class: 'bouton petit', onclick: () => lancer('pdf') }, tout ? 'PDF (graphiques + données)' : 'PDF (extrêmes)');
  boutons.push(bXlsx);
  if (pdf) boutons.push(bPdf);
  const bCsv = csv ? h('button', { type: 'button', class: 'bouton discret petit', onclick: () => { try { for (const f of csv() || []) telecharger(f.nom, f.texte, 'text/csv;charset=utf-8'); } catch (e) { montrerErreur(e); } } }, 'CSV') : null;
  const bloc = h('div', { class: 'barre-export-climat', 'data-garder': '' },
    h('p', { class: 'titre-export' }, titre),
    h('div', { class: 'rangee-export' }, bXlsx, caseH ? h('label', { class: 'case-export' }, caseH, h('span', {}, 'Inclure les données horaires')) : null, tailleX),
    bCsv || pdf ? h('div', { class: 'rangee-export' }, pdf ? bPdf : null, bCsv) : null,
    barre, etat, erreur);

  const verrou = (v) => { for (const b of [...boutons, caseH, bCsv]) if (b) b.disabled = v; };
  verrous.add(verrou);
  function montrerErreur(e) { erreur.hidden = false; erreur.textContent = `Export impossible : ${e?.message || e}`; etat.textContent = ''; barre.hidden = true; console.warn('Export du climat :', e); }
  async function majTaille() {
    if (!tout) { tailleX.textContent = ''; return; }
    try {
      const E = await heuresClimat();
      if (!E) { tailleX.textContent = ''; return; }
      const { estimation } = await import('./climat-export.js');
      const x = estimation({ portee, E, S: null }, { horaires: !!caseH.checked });
      tailleX.textContent = `≈ ${taille(x.octets)}, ${caseH.checked ? `${x.heures.toLocaleString('fr-FR')} heures, ` : ''}environ ${duree(x.secondes)}`;
    } catch { tailleX.textContent = ''; }
  }
  if (caseH) caseH.addEventListener('change', majTaille);
  majTaille();
  if (caseH) for (const ev of ['meteoSource', 'meteoAnnee']) app?.on?.(ev, () => { if (bloc.isConnected) majTaille(); });

  async function lancer(type) {
    if (enCours) return;
    enCours = true; verrous.forEach((f) => f(true));
    erreur.hidden = true; erreur.textContent = '';
    barre.hidden = false; barre.value = 0;
    const t0 = performance.now();
    let derniere = 0;
    const progression = (f, t) => {
      barre.value = f;
      const s = (performance.now() - t0) / 1000;
      if (performance.now() - derniere < 120 && f < 1) return;
      derniere = performance.now();
      etat.textContent = `${t}${f > 0.05 && f < 1 ? ` — ${Math.round(100 * f)} %, reste environ ${duree(Math.max(0, s / f - s))}` : ''}`;
    };
    try {
      progression(0, 'préparation des statistiques…');
      await new Promise((r) => setTimeout(r, 30));
      const st = tout && stats ? await stats() : null;
      const ctx = await construireContexte(portee, st);
      progression(0.03, 'chargement des modules d\'export…');
      const M = await import('./climat-export.js');
      const nom = M.nomFichier(ctx, type);
      let octets;
      if (type === 'xlsx') octets = await M.classeur(ctx, { horaires: !!caseH?.checked, progression: (f, t) => progression(0.05 + 0.95 * f, t) });
      else {
        const P = await import('./climat-export-pdf.js');
        octets = await P.rapportPDF(ctx, { progression: (f, t) => progression(0.05 + 0.95 * f, t) });
      }
      telecharger(nom, new Blob([octets], { type: type === 'xlsx' ? MIME_XLSX : 'application/pdf' }));
      etat.textContent = `Fichier enregistré : ${nom} (${taille(octets.length)}, ${duree((performance.now() - t0) / 1000)}).`;
      barre.hidden = true;
    } catch (e) { montrerErreur(e); } finally { enCours = false; verrous.forEach((f) => f(false)); }
  }
  return bloc;
}

// bloc de l'onglet Export (inséré par js/climat.js à l'ouverture de l'outil Export)
export function blocExportOnglet(app, stats) {
  styles();
  return h('div', { class: 'bloc-export-climat', 'data-garder': '' },
    h('h3', {}, 'Statistiques du climat'),
    h('p', { class: 'note', role: 'status' }, 'Catégories de jours, tranches de température, vent, humidité, UTCI et conditions extrêmes, avec les réglages de l\'outil Climat (source, année, seuils, tranches). ',
      h('button', { type: 'button', class: 'bouton discret petit', onclick: () => app.interface?.ouvrir?.('climat') }, 'Régler dans Climat')),
    barreExport(app, { portee: 'tout', stats, titre: 'Exporter les statistiques du climat' }));
}
