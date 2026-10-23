import { h } from './util.js';
import { chargerMeteo, rose, mention } from './meteo.js';

// Les 4 roses des vents des saisons (22/10/2026) : hiver, printemps, été, automne, 12 secteurs de 30°, MÊME échelle de fréquence
// pour les quatre, source météo active (base Météo-France ou EPW, js/meteo.js ; année choisie dans Climat si elle existe).
// - donneesRoses() : secteurs de chaque saison, secteur dominant, part des heures au-dessus de 5 m/s, saison la plus ventée ;
// - svgRose(d, …) : une rose en SVG (chaîne), unités libres (pixels dans l'atlas, millimètres sur la planche à l'échelle) ;
// - dans l'outil Vent : case « 4 saisons » ajoutée sous la rose (bloc inséré par ce module à l'ouverture du panneau, état dans
//   app.vent.etat.quatreSaisons, gardé par les points de vue) ; clic sur une petite rose = choisir cette saison ;
// - sur la planche à l'échelle (js/planche.js) : une rose par coin, en vecteurs.
// Couleurs de la rose de l'outil Vent : fréquence #6f93b1, part au-dessus de 5 m/s #2f4f6f, grille #b7cbd9.
export const SAISONS4 = [['hiver', 'Hiver'], ['printemps', 'Printemps'], ['ete', 'Été'], ['automne', 'Automne']];
export const NOMS12 = ['N', 'NNE', 'ENE', 'E', 'ESE', 'SSE', 'S', 'SSO', 'OSO', 'O', 'ONO', 'NNO'];
const virgule = (v, d = 1) => v.toFixed(d).replace('.', ',');

export function donneesRoses() {
  const saisons = SAISONS4.map(([cle, lib]) => {
    const r = rose(12, cle, 'all');
    const ok = !!(r && r.N >= 100 && r.secteurs?.length);
    const dom = ok ? r.secteurs.slice().sort((a, b) => b.f - a.f)[0] : null;
    const fort = ok ? r.secteurs.reduce((a, s) => a + (s.f * (s.p5 ?? 0)) / 100, 0) : 0; // % de toutes les heures au-dessus de 5 m/s
    return { cle, lib, r, ok, dom, fort };
  });
  const maxF = Math.max(10, ...saisons.filter((s) => s.ok).flatMap((s) => s.r.secteurs.map((x) => x.f)));
  const axe = Math.ceil(maxF / 5) * 5;
  const ventee = saisons.filter((s) => s.ok).sort((a, b) => b.fort - a.fort)[0]?.cle || null;
  return { saisons, axe, ventee, source: mention({ court: true, annee: true }) };
}

// une rose : centre (cx, cy), rayon R (même unité que la police p) ; texte dessous
export function svgRose(s, axe, { cx, cy, R, p, actif = false, titre = true, couleurs = {} } = {}) {
  const C = { tout: '#6f93b1', fort: '#2f4f6f', grille: '#b7cbd9', texte: '#2f3b45', fleche: '#c8372d', ...couleurs };
  const f2 = (v) => Math.round(v * 100) / 100;
  const pol = (r, d) => { const t = (d * Math.PI) / 180; return [cx + r * Math.sin(t), cy - r * Math.cos(t)]; };
  const coin = (r, d) => { if (r < R * 0.01) return ''; const [x0, y0] = pol(r, d - 15), [x1, y1] = pol(r, d + 15); return `M${f2(cx)} ${f2(cy)} L${f2(x0)} ${f2(y0)} A${f2(r)} ${f2(r)} 0 0 1 ${f2(x1)} ${f2(y1)} Z`; };
  const o = [];
  const pas = axe > 25 ? 10 : 5;
  for (let q = pas; q <= axe; q += pas) o.push(`<circle cx="${f2(cx)}" cy="${f2(cy)}" r="${f2((R * q) / axe)}" fill="none" stroke="${C.grille}" stroke-width="${f2(p * 0.06)}"/>`);
  o.push(`<path d="M${f2(cx)} ${f2(cy - R - p * 0.3)}V${f2(cy + R + p * 0.3)}M${f2(cx - R - p * 0.3)} ${f2(cy)}H${f2(cx + R + p * 0.3)}" stroke="${C.grille}" stroke-width="${f2(p * 0.06)}"/>`);
  if (s.ok) {
    for (const x of s.r.secteurs) {
      o.push(`<path d="${coin((R * x.f) / axe, x.dir)}" fill="${C.tout}" fill-opacity="0.85"/>`);
      o.push(`<path d="${coin((R * x.f * (x.p5 ?? 0)) / 100 / axe, x.dir)}" fill="${C.fort}"/>`);
    }
    // flèche du vent dominant : vient de la direction du secteur, pointe vers le centre
    const [ax, ay] = pol(R + p * 1.1, s.dom.dir), [bx, by] = pol(R * 0.35, s.dom.dir);
    const ang = Math.atan2(by - ay, bx - ax), l = p * 0.7;
    o.push(`<path d="M${f2(ax)} ${f2(ay)}L${f2(bx)} ${f2(by)}" stroke="${C.fleche}" stroke-width="${f2(p * 0.18)}"/>`,
      `<path d="M${f2(bx)} ${f2(by)}L${f2(bx - l * Math.cos(ang - 0.45))} ${f2(by - l * Math.sin(ang - 0.45))}L${f2(bx - l * Math.cos(ang + 0.45))} ${f2(by - l * Math.sin(ang + 0.45))}Z" fill="${C.fleche}"/>`);
  } else {
    o.push(`<text x="${f2(cx)}" y="${f2(cy)}" font-size="${f2(p * 0.8)}" text-anchor="middle" fill="${C.texte}">mesures insuffisantes</text>`);
  }
  for (const [t, az] of [['N', 0], ['E', 90], ['S', 180], ['O', 270]]) {
    const [x, y] = pol(R + p * 0.75, az);
    o.push(`<text x="${f2(x)}" y="${f2(y + p * 0.32)}" font-size="${f2(p * 0.85)}" text-anchor="middle" fill="${C.texte}">${t}</text>`);
  }
  if (titre) {
    const dom = s.ok ? `${NOMS12[s.dom.k]} ${virgule(s.dom.f, 0)} %, ${virgule(s.dom.vm)} m/s` : '';
    o.push(`<text x="${f2(cx)}" y="${f2(cy + R + p * 2.1)}" font-size="${f2(p)}" font-weight="${actif ? 700 : 600}" text-anchor="middle" fill="${C.texte}">${s.lib}${actif ? ' (la plus ventée)' : ''}</text>`);
    if (dom) o.push(`<text x="${f2(cx)}" y="${f2(cy + R + p * 3.2)}" font-size="${f2(p * 0.85)}" text-anchor="middle" fill="${C.texte}">dominant ${dom}</text>`);
  }
  return o.join('');
}

// ------------------------------------------------------------
// Bloc de l'outil Vent (inséré sous la rose à l'ouverture du panneau)
// ------------------------------------------------------------
export function creerRosesSaisons(app) {
  const ui = {};
  function choisirSaison(cle) {
    const sel = [...document.querySelectorAll('#panneau-outil select')].find((x) => [...x.options].some((o) => o.value === 'hiver'));
    if (!sel) return;
    sel.value = cle;
    sel.dispatchEvent(new Event('change'));
    dessiner();
  }
  async function dessiner() {
    if (!ui.grille?.isConnected) return;
    const V = app.vent?.etat;
    ui.grille.hidden = !V?.quatreSaisons;
    if (!V?.quatreSaisons) return;
    await chargerMeteo();
    const D = donneesRoses();
    ui.grille.replaceChildren(...D.saisons.map((s) => {
      const actif = s.cle === D.ventee;
      const fig = h('button', { type: 'button', class: `rose-saison${actif ? ' ventee' : ''}${V.saison === s.cle ? ' choisie' : ''}`, title: `${s.lib} : choisir cette saison`, onclick: () => choisirSaison(s.cle) });
      fig.innerHTML = `<svg viewBox="0 0 100 124" role="img" aria-label="Rose des vents, ${s.lib}">${svgRose(s, D.axe, { cx: 50, cy: 50, R: 36, p: 8.5, actif: false })}</svg>`;
      if (actif) fig.append(h('span', { class: 'rose-saison-marque' }, 'la plus ventée'));
      return fig;
    }));
    ui.note.textContent = `Même échelle pour les quatre roses (cercles tous les ${D.axe > 25 ? 10 : 5} %, jusqu'à ${D.axe} % des heures) ; partie foncée : heures au-dessus de 5 m/s ; flèche rouge : secteur dominant. Saison la plus ventée : celle qui a le plus d'heures au-dessus de 5 m/s. ${D.source}.`;
  }
  function inserer() {
    const conteneur = document.querySelector('#panneau-outil .panneau-vent');
    const ancre = conteneur?.querySelector('.rose-conteneur');
    if (!ancre || conteneur.querySelector('.roses-saisons')) return;
    const V = app.vent.etat;
    ui.grille = h('div', { class: 'roses-saisons-grille', hidden: !V.quatreSaisons });
    ui.note = h('p', { class: 'note roses-saisons-note', 'data-garder': '' });
    const caseQ = h('input', { type: 'checkbox', checked: !!V.quatreSaisons, onchange: (e) => { V.quatreSaisons = e.target.checked; ui.note.hidden = !V.quatreSaisons; dessiner(); app.emettre('legende'); } });
    ui.note.hidden = !V.quatreSaisons;
    ancre.after(h('div', { class: 'roses-saisons', 'data-garder': '' }, h('label', { class: 'case' }, caseQ, '4 saisons côte à côte (même échelle)'), ui.grille, ui.note));
    dessiner();
  }
  app.on('outil', (id) => { if (id === 'vent') setTimeout(inserer, 0); });
  for (const ev of ['meteoSource', 'meteoAnnee']) app.on(ev, () => setTimeout(dessiner, 50));
  // la saison choisie dans la rose du panneau est surlignée
  document.addEventListener('change', (e) => { if (e.target.closest?.('.panneau-vent') && !e.target.closest('.roses-saisons')) setTimeout(dessiner, 0); });
  return { donneesRoses, svgRose, dessiner };
}
