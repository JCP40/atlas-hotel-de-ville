// Vent local sans champ calculé (15/11/2026) : repli UNIQUE de app.vent.ventLocal (js/vent.js), de Chaleur, de Confort (UTCI)
// et du worker de Chaleur (js/chaleur-worker.js) : rapport vitesse locale / vent libre estimé par l'ouverture au ciel,
// 0,35 + 0,65 SVF (SVF inconnu : 0,3). Module sans dépendance (chargeable dans un Web Worker).
export const abriCiel = (svf) => 0.35 + 0.65 * (Number.isFinite(svf) ? svf : 0.3);
