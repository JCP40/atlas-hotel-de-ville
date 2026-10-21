"""Analyse : CSV MF filtré + EPW -> meteo.json, comparatif. args: csv epw out_json out_cmp"""
import sys, json
import numpy as np
import pandas as pd

csv, epw, out_json, out_cmp = sys.argv[1:5]
df = pd.read_csv(csv, dtype={"AAAAMMJJHH": str})
df["t"] = pd.to_datetime(df["AAAAMMJJHH"], format="%Y%m%d%H")
df["an"] = df.t.dt.year
df["mois"] = df.t.dt.month

# ---------- contrôle qualité ----------
BORNES = {"FF": (0, 45), "FXI": (0, 60), "FXY": (0, 45), "DD": (0, 360), "T": (-20, 45),
          "TN": (-20, 45), "TX": (-20, 45), "U": (1, 100), "PSTAT": (940, 1050),
          "PMER": (950, 1060), "GLO": (0, 4000), "RR1": (0, 100)}
qc = {"aberrantes": {}, "couverture_pct": {}}
for c, (lo, hi) in BORNES.items():
    if c in df:
        bad = df[c].notna() & ((df[c] < lo) | (df[c] > hi))
        qc["aberrantes"][c] = int(bad.sum())
        df.loc[bad, c] = np.nan
saut = df["T"].diff().abs() > 8
qc["aberrantes"]["T_saut_gt8C_h"] = int(saut.sum())
qc["aberrantes"]["FXI_lt_FF"] = int((df.FXI < df.FF).sum())
qc["aberrantes"]["DD_sans_vent_ou_inverse"] = int(((df.FF >= 1) & (df.DD == 0)).sum())
for an, g in df.groupby("an"):
    nh = (pd.Timestamp(an + 1, 1, 1) - pd.Timestamp(an, 1, 1)).days * 24
    if an == df.an.max():
        nh = int((df.t.max() - pd.Timestamp(an, 1, 1)).total_seconds() // 3600) + 1
    qc["couverture_pct"][str(an)] = {c: round(100 * g[c].notna().sum() / nh, 1)
                                     for c in ["FF", "DD", "FXI", "T", "U", "PSTAT", "GLO"] if c in g}

# ---------- période d'analyse : 10 années complètes ----------
A0, A1 = 2016, 2025
d = df[(df.an >= A0) & (df.an <= A1)].copy()
SAISONS = {"annee": range(1, 13), "hiver": [12, 1, 2], "printemps": [3, 4, 5], "ete": [6, 7, 8], "automne": [9, 10, 11]}
TCL = {"all": (-99, 99), "froid": (-99, 5), "frais": (5, 12), "doux": (12, 20), "chaud": (20, 99)}
CALME = 0.5
w = d.dropna(subset=["FF", "DD"])
w = w[(w.DD > 0) | (w.FF < CALME)]  # DD=0 avec vent = indéterminé, exclu


def secteur(dd, n):
    return (np.round(dd / (360 / n)).astype(int) % n)


def rose(g, n):
    N = len(g)
    if N == 0:
        return None
    calm = g.FF < CALME
    v = g[~calm]
    s = secteur(v.DD.values, n)
    e_tot = float((v.FF ** 3).sum()) or 1.0
    res = {"N": N, "calmes": round(100 * calm.sum() / N, 2),
           "f": [], "vm": [], "p90": [], "fxi": [], "p5": [], "e": []}
    for k in range(n):
        x = v[s == k]
        res["f"].append(round(100 * len(x) / N, 2))
        if len(x):
            res["vm"].append(round(float(x.FF.mean()), 2))
            res["p90"].append(round(float(x.FF.quantile(.9)), 1))
            res["fxi"].append(None if x.FXI.isna().all() else round(float(x.FXI.max()), 1))
            res["p5"].append(round(100 * float((x.FF > 5).mean()), 1))
            res["e"].append(round(100 * float((x.FF ** 3).sum()) / e_tot, 2))
        else:
            res["vm"].append(None); res["p90"].append(None); res["fxi"].append(None)
            res["p5"].append(0); res["e"].append(0)
    res["vm_all"] = round(float(g.FF.mean()), 2)
    return res


roses = {}
for n in (16, 12):
    roses[str(n)] = {}
    for sn, ms in SAISONS.items():
        roses[str(n)][sn] = {}
        gs = w[w.mois.isin(ms)]
        for tn, (lo, hi) in TCL.items():
            g = gs if tn == "all" else gs[(gs["T"] >= lo) & (gs["T"] < hi)]
            roses[str(n)][sn][tn] = rose(g, n)

# ---------- normales mensuelles ----------
d["jour"] = d.t.dt.date
jour = d.groupby("jour").agg(tn=("TN", "min"), tx=("TX", "max"), nb=("T", "count"))
jour = jour[jour.nb >= 20]
jour["mois"] = pd.to_datetime(jour.index).month
norm = {"mois": list(range(1, 13)), "T": [], "Tmin": [], "Tmax": [], "FF": [], "FXImax": [], "U": [], "GLO_MJm2j": [], "f16": [], "calmes": []}
for m in range(1, 13):
    g = d[d.mois == m]
    gw = w[w.mois == m]
    norm["T"].append(round(float(g["T"].mean()), 1))
    norm["Tmin"].append(round(float(jour[jour.mois == m].tn.mean()), 1))
    norm["Tmax"].append(round(float(jour[jour.mois == m].tx.mean()), 1))
    norm["FF"].append(round(float(g.FF.mean()), 2))
    norm["FXImax"].append(round(float(g.FXI.max()), 1))
    norm["U"].append(round(float(g.U.mean()), 0))
    # GLO en J/cm² par heure -> MJ/m²/jour (moyenne horaire *24 /100)
    norm["GLO_MJm2j"].append(round(float(g.GLO.mean()) * 24 / 100, 1) if "GLO" in g and g.GLO.notna().any() else None)
    r = rose(gw, 16)
    norm["f16"].append(r["f"]); norm["calmes"].append(r["calmes"])

# ---------- probabilités de dépassement ----------
SEUILS = [round(0.5 * i, 1) for i in range(0, 25)]  # 0..12 m/s


def exc(g, n):
    N = len(g)
    v = g[g.FF >= CALME]
    s = secteur(v.DD.values, n)
    J = []
    for k in range(n):
        x = v.FF.values[s == k]
        J.append([round(100 * float((x >= th).sum()) / N, 2) for th in SEUILS])
    return {"N": N, "J": J}


EXC = {"seuils": SEUILS, "def": "J[secteur][classe] = % des heures (toutes, calmes inclus) où direction=secteur et FF >= seuil",
       "16": {}, "12": {}}
for n in (16, 12):
    for sn, ms in SAISONS.items():
        EXC[str(n)][sn] = exc(w[w.mois.isin(ms)], n)

# ---------- EPW ----------
e = pd.read_csv(epw, skiprows=8, header=None)
ew = pd.DataFrame({"mois": e[1], "T": e[6], "DD": e[20], "FF": e[21], "FXI": np.nan})
ew = ew[(ew.FF < 99) & (ew.DD <= 360)]
ew["DD"] = ew.DD.where(~((ew.DD == 0) & (ew.FF >= CALME)), 360)  # EPW : 0 = nord possible
rose_epw = {str(n): rose(ew, n) for n in (16, 12)}

NOMS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"]
NOMS12 = [f"{i*30:03d}" for i in range(12)]
rm, re_ = roses["16"]["annee"]["all"], rose_epw["16"]
diff = [round(a - b, 2) for a, b in zip(rm["f"], re_["f"])]
top = lambda f: [NOMS16[i] for i in np.argsort(f)[::-1][:3]]
cmp = {"mf_top3": top(rm["f"]), "epw_top3": top(re_["f"]),
       "mf_calmes": rm["calmes"], "epw_calmes": re_["calmes"],
       "mf_vm": rm["vm_all"], "epw_vm": re_["vm_all"],
       "ecart_freq_pts_16": dict(zip(NOMS16, diff)),
       "ecart_abs_moyen_pts": round(float(np.mean(np.abs(diff))), 2),
       "ecart_abs_max_pts": round(float(np.max(np.abs(diff))), 2)}

out = {
    "source": {"mf": "Météo-France, données climatologiques de base horaires, dépt 44 (meteo.data.gouv.fr / object.files.data.gouv.fr)",
               "epw": "climate.onebuilding.org, FRA_PL_Nantes.Atlantique.AP.072220_TMYx.2011-2025"},
    "licence": {"mf": "Licence Ouverte Etalab 2.0", "epw": "OneBuilding (usage libre, citer la source)"},
    "station": {"id": "44020001", "nom": "NANTES-BOUGUENAIS", "lat": 47.15, "lon": -1.608333, "alt": 26, "wmo": "07222"},
    "periode": {"stats": f"{A0}-01-01/{A1}-12-31", "csv": f"{df.t.min():%Y-%m-%d %H}/{df.t.max():%Y-%m-%d %H} UTC", "heures_vent_valides": int(len(w))},
    "unites": {"FF": "m/s (vent moyen 10 min, 10 m)", "FXI": "m/s rafale instantanée", "T": "°C", "heure": "UTC",
               "e": "% de l'énergie éolienne (somme FF³) de la rose", "p5": "% des heures du secteur avec FF>5 m/s",
               "f": "% de toutes les heures (calmes inclus)", "calme": f"FF < {CALME} m/s",
               "secteurs16": NOMS16, "secteurs12_centre_deg": NOMS12},
    "classes_T": {k: list(v) for k, v in TCL.items()},
    "couverture": qc["couverture_pct"], "qc_aberrantes_retirees": qc["aberrantes"],
    "rose": roses, "normales": norm, "EXC": EXC,
    "epw": {"rose": rose_epw, "T_moy": round(float(ew["T"].mean()), 1)},
    "comparatif": cmp,
}
def _c(o):
    if isinstance(o, float) and o.is_integer(): return int(o)
    if isinstance(o, dict): return {k: _c(v) for k, v in o.items()}
    if isinstance(o, list): return [_c(v) for v in o]
    return o
out = _c(out)
with open(out_json, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

lines = ["# Comparatif rose des vents : Météo-France 44020001 (2016-2025) vs EPW TMYx 2011-2025", "",
         f"- Secteurs dominants MF : {', '.join(cmp['mf_top3'])} ; EPW : {', '.join(cmp['epw_top3'])}",
         f"- Calmes (<{CALME} m/s) : MF {cmp['mf_calmes']} % ; EPW {cmp['epw_calmes']} %",
         f"- Vent moyen : MF {cmp['mf_vm']} m/s ; EPW {cmp['epw_vm']} m/s",
         f"- Écart de fréquence moyen |MF-EPW| : {cmp['ecart_abs_moyen_pts']} pts (max {cmp['ecart_abs_max_pts']})", "",
         "| Secteur | MF % | EPW % | Écart (pts) |", "|---|---|---|---|"]
for i, nm in enumerate(NOMS16):
    lines.append(f"| {nm} | {rm['f'][i]} | {re_['f'][i]} | {diff[i]:+} |")
open(out_cmp, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print(json.dumps({"cmp": cmp, "qc": qc}, ensure_ascii=False, indent=1))
