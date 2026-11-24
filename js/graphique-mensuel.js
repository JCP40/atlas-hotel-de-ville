// Graphique mensuel commun (15/11/2026) : températures (barres des minimales aux maximales moyennes, trait de la moyenne) et
// vent moyen (barres du bas) par mois, d'après normales() de js/meteo.js. Utilisé par l'outil Climat (svgNormales, graphique
// fixe avec info-bulles) et par l'outil Vent (dessinerMois, graphique cliquable : un mois choisi règle le vent dominant).
// Avant : le même dessin copié dans climat.js et vent.js. Fonction pure : renvoie un élément <svg> (aucun état gardé).
import { MOIS } from './meteo.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...enfants) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  enfants.forEach((e) => el.append(e instanceof Node ? e : document.createTextNode(String(e))));
  return el;
};
const nombre = (v, d = 1) => (v == null ? '–' : v.toFixed(d).replace('.', ','));
export const COULEURS_MENSUEL = { vent: '#6f93b1', ventActif: '#2f4f6f', moyenne: '#2f3b45' };

// n : normales() ; options :
//  actif : mois mis en avant (0-11) ; H, bas, haut : hauteur du dessin, bas et haut de l'échelle des températures (-2 à 28 °C) ;
//  kv : px par m/s des barres de vent ; dyVent : écart du libellé « vent moyen (m/s) » au-dessus de la ligne des 4 m/s ; classe, role, aria : attributs du <svg> ; titres : info-bulles sur les barres (Climat) ;
//  legende : texte « barres : … » en haut à gauche ; surligner : bande derrière le mois actif (Vent) ;
//  choisir(i) : rend chaque mois cliquable (cibles transparentes, clavier compris) ; titreCible(i) : info-bulle de la cible.
export function graphiqueMensuel(n, {
  actif = -1, H = 200, bas = 128, haut = 12, kv = 9, classe = 'graphique', role = 'img', aria = '', titres = true, legende = true,
  surligner = false, choisir = null, titreCible = null, dyVent = 4,
} = {}) {
  const L = 300, g = 26, tMin = -2, tMax = 28;
  const y = (t) => bas - ((t - tMin) / (tMax - tMin)) * (bas - haut);
  const pas = (L - g - 4) / 12, y0 = H - 4;
  const svg = s('svg', { viewBox: `0 0 ${L} ${H}`, class: classe, role, 'aria-label': aria });
  if (surligner && actif >= 0) svg.append(s('rect', { x: g + actif * pas, y: 2, width: pas, height: H - 4, class: 'mois-actif' }));
  for (const t of [0, 10, 20]) svg.append(s('line', { x1: g, x2: L - 4, y1: y(t), y2: y(t), class: 'grille' }), s('text', { x: g - 4, y: y(t) + 3, 'text-anchor': 'end', class: 'axe' }, `${t}°`));
  let ligne = '';
  n.T.forEach((t, i) => {
    const x = g + i * pas, a = i === actif;
    svg.append(s('rect', { x: x + pas * 0.28, y: y(n.Tmax[i]), width: pas * 0.44, height: y(n.Tmin[i]) - y(n.Tmax[i]), rx: 2, class: a ? 'temp actif' : 'temp' },
      ...(titres ? [s('title', {}, `${MOIS[i]} : ${nombre(n.Tmin[i])} à ${nombre(n.Tmax[i])} °C (minimales et maximales moyennes), moyenne ${nombre(n.T[i])} °C`)] : [])));
    svg.append(s('rect', { x: x + pas * 0.25, y: y0 - n.FF[i] * kv, width: pas * 0.5, height: n.FF[i] * kv, fill: a ? COULEURS_MENSUEL.ventActif : COULEURS_MENSUEL.vent },
      ...(titres ? [s('title', {}, `${MOIS[i]} : vent moyen ${nombre(n.FF[i])} m/s, rafale maximale ${nombre(n.FXImax[i])} m/s`)] : [])));
    svg.append(s('text', { x: x + pas / 2, y: bas + 11, 'text-anchor': 'middle', class: a ? 'axe actif' : 'axe' }, MOIS[i][0].toUpperCase()));
    ligne += `${ligne ? 'L' : 'M'}${(x + pas / 2).toFixed(1)} ${y(t).toFixed(1)}`;
  });
  svg.append(s('path', { d: ligne, fill: 'none', stroke: COULEURS_MENSUEL.moyenne, 'stroke-width': 1.3 }));
  svg.append(s('line', { x1: g, x2: L - 4, y1: y0, y2: y0, class: 'grille' }), s('line', { x1: g, x2: L - 4, y1: y0 - 4 * kv, y2: y0 - 4 * kv, class: 'grille', 'stroke-dasharray': '2 2' }));
  svg.append(s('text', { x: g - 4, y: y0 - 4 * kv + 3, 'text-anchor': 'end', class: 'axe' }, '4'), s('text', { x: L - 4, y: y0 - 4 * kv - dyVent, 'text-anchor': 'end', class: 'axe' }, 'vent moyen (m/s)'));
  if (legende) svg.append(s('text', { x: g + 2, y: 8, class: 'axe' }, 'barres : minimales à maximales moyennes ; trait : moyenne'));
  if (choisir) n.T.forEach((t, i) => {
    const r = s('rect', { x: g + i * pas, y: 0, width: pas, height: H, class: 'cible', tabindex: 0, role: 'button', 'aria-label': MOIS[i] }, ...(titreCible ? [s('title', {}, titreCible(i))] : []));
    r.addEventListener('click', () => choisir(i));
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choisir(i); } });
    svg.append(r);
  });
  return svg;
}
