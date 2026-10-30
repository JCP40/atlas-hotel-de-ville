// Une seule analyse d'Ambiance affichée à la fois (23/10/2026).
// Ouvrir un outil d'Ambiance (Soleil, Climat, Vent, Confort, Chaleur, Bruit) efface les cartes et objets des autres.
// L'affichage est conservé quand on ouvre un autre outil (Export, Vues, Couches…), qu'on ferme le panneau,
// qu'on bascule 3D / plan, qu'on exporte (planche, PNG) ou qu'on rappelle une vue enregistrée (la vue rouvre son outil).
export const AMBIANCES = ['soleil', 'climat', 'vent', 'confort', 'chaleur', 'bruit'];

export function creerAmbiances(app) {
  let courante = null;
  const effacer = {
    soleil: () => { app.soleil?.effacerCarte?.(); app.soleil?.masquerTrajectoires?.(); },
    climat: () => {},
    vent: () => app.vent?.fermer?.(),
    confort: () => { app.confort?.effacerCarte?.(); app.confort?.effacerFacades?.(); },
    chaleur: () => app.chaleur?.effacerTout?.(),
    bruit: () => { if (app.couches.bruit) { app.couches.bruit = false; app.emettre('couches'); } },
  };
  function effacerSauf(id) {
    for (const a of AMBIANCES) {
      if (a === id) continue;
      try { effacer[a](); } catch (e) { console.warn('ambiance', a, e); }
    }
    courante = id;
    app.emettre('legende');
  }
  // à chaque ouverture d'une ambiance (même la courante : une vue rappelée a pu rallumer une autre analyse)
  app.on('outil', (id) => { if (AMBIANCES.includes(id)) effacerSauf(id); });
  return { AMBIANCES, effacerSauf, get courante() { return courante; } };
}
