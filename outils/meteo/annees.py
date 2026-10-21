"""Climat année par année (sélecteur « Moyenne 2016-2025 / année » des outils Climat et Vent de l'atlas).

Usage : python annees.py meteofrance_44020001_horaire.csv meteo_annees.json

Entrée : mesures horaires Météo-France de la station 44020001 (filtre.py), heures AAAAMMJJHH en UTC.
Sortie : data/meteo/meteo_annees.json, lu par js/meteo.js (definirAnnee) et js/climat.js.
Mêmes contrôles et mêmes définitions que analyse.py (rose en 12 secteurs par saison, ici toutes températures ;
normales mensuelles) et que extremes.py (journée civile Europe/Paris,
au moins 20 h de mesures ; Tmin = min de TN, Tmax = max de TX, Tmoy = moyenne horaire de T), pour chaque année complète.
"""
import json
import sys

import numpy as np
import pandas as pd

A0, A1 = 2016, 2025
SAISONS = {"annee": range(1, 13), "hiver": [12, 1, 2], "printemps": [3, 4, 5], "ete": [6, 7, 8], "automne": [9, 10, 11]}
CALME = 0.5
BORNES = {"FF": (0, 45), "FXI": (0, 60), "DD": (0, 360), "T": (-20, 45), "TN": (-20, 45), "TX": (-20, 45),
          "U": (1, 100), "GLO": (0, 4000)}
N_EXTREMES = 5


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
    res = {"N": N, "calmes": round(100 * calm.sum() / N, 2), "f": [], "vm": [], "p90": [], "fxi": [], "p5": [], "e": []}
    for k in range(n):
        x = v[s == k]
        res["f"].append(round(100 * len(x) / N, 1))
        if len(x):
            res["vm"].append(round(float(x.FF.mean()), 1))
            res["p90"].append(round(float(x.FF.quantile(.9)), 1))
            res["fxi"].append(None if x.FXI.isna().all() else round(float(x.FXI.max()), 1))
            res["p5"].append(round(100 * float((x.FF > 5).mean()), 1))
            res["e"].append(round(100 * float((x.FF ** 3).sum()) / e_tot, 1))
        else:
            res["vm"].append(None); res["p90"].append(None); res["fxi"].append(None)
            res["p5"].append(0); res["e"].append(0)
    res["vm_all"] = round(float(g.FF.mean()), 2)
    return res


def moy(x, nd=1):
    x = x.dropna()
    return round(float(x.mean()), nd) if len(x) else None


def main(csv, sortie):
    df = pd.read_csv(csv, dtype={"AAAAMMJJHH": str})
    df["t"] = pd.to_datetime(df["AAAAMMJJHH"], format="%Y%m%d%H")
    for c, (lo, hi) in BORNES.items():
        if c in df:
            df[c] = pd.to_numeric(df[c], errors="coerce")
            df.loc[df[c].notna() & ((df[c] < lo) | (df[c] > hi)), c] = np.nan
    df["an"] = df.t.dt.year
    df["mois"] = df.t.dt.month
    # journée civile de Nantes pour les jours extrêmes et les Tmin / Tmax journalières
    loc = df.t.dt.tz_localize("UTC").dt.tz_convert("Europe/Paris").dt.tz_localize(None)
    df["jour"] = loc.dt.normalize()
    df["TNj"] = df["TN"].fillna(df["T"])
    df["TXj"] = df["TX"].fillna(df["T"])
    jours = df.groupby("jour").agg(n=("T", "count"), tmin=("TNj", "min"), tmax=("TXj", "max"), tmoy=("T", "mean"))
    jours = jours[jours.n >= 20].copy()
    jours["tmoy"] = jours["tmoy"].round(1)

    sortie_annees = {}
    for an in range(A0, A1 + 1):
        d = df[df.an == an]
        w = d.dropna(subset=["FF", "DD"])
        w = w[(w.DD > 0) | (w.FF < CALME)]
        roses = {}
        for sn, ms in SAISONS.items():
            gs = w[w.mois.isin(ms)]
            roses[sn] = rose(gs, 12)  # toutes températures (une année seule : tranches de température trop maigres)
        ja = jours[jours.index.year == an]
        ja_m = ja.index.month
        norm = {"mois": list(range(1, 13)), "T": [], "Tmin": [], "Tmax": [], "FF": [], "FXImax": [], "U": [], "GLO_MJm2j": [], "f16": [], "calmes": []}
        for m in range(1, 13):
            g = d[d.mois == m]
            r = rose(w[w.mois == m], 16)
            norm["T"].append(moy(g["T"]))
            norm["Tmin"].append(moy(ja[ja_m == m].tmin))
            norm["Tmax"].append(moy(ja[ja_m == m].tmax))
            norm["FF"].append(moy(g.FF, 2))
            norm["FXImax"].append(round(float(g.FXI.max()), 1) if g.FXI.notna().any() else None)
            norm["U"].append(moy(g.U, 0))
            norm["GLO_MJm2j"].append(round(float(g.GLO.mean()) * 24 / 100, 1) if g.GLO.notna().any() else None)
            norm["f16"].append(r["f"] if r else [0] * 16)
            norm["calmes"].append(r["calmes"] if r else None)

        def ligne(dt, r):
            return {"date": dt.strftime("%Y-%m-%d"), "tmin": round(float(r.tmin), 1), "tmax": round(float(r.tmax), 1), "tmoy": float(r.tmoy)}
        ext = {
            "jours_valides": int(len(ja)),
            "plus_froid": ligne(ja.tmin.idxmin(), ja.loc[ja.tmin.idxmin()]),
            "plus_chaud": ligne(ja.tmax.idxmax(), ja.loc[ja.tmax.idxmax()]),
            "plus_froid_moyenne": ligne(ja.tmoy.idxmin(), ja.loc[ja.tmoy.idxmin()]),
            "plus_chaud_moyenne": ligne(ja.tmoy.idxmax(), ja.loc[ja.tmoy.idxmax()]),
            "froids": [ligne(i, r) for i, r in ja.sort_values(["tmin", "tmoy"]).head(N_EXTREMES).iterrows()],
            "chauds": [ligne(i, r) for i, r in ja.sort_values(["tmax", "tmoy"], ascending=False).head(N_EXTREMES).iterrows()],
            "jours_gel": int((ja.tmin < 0).sum()),
            "jours_30": int((ja.tmax >= 30).sum()),
            "tmoy": round(float(ja.tmoy.mean()), 1),
        }
        sortie_annees[str(an)] = {
            "heures_vent_valides": int(len(w)),
            "couverture_pct": {c: round(100 * d[c].notna().sum() / max(len(pd.date_range(f"{an}-01-01", f"{an}-12-31 23:00", freq="h")), 1), 1) for c in ("FF", "DD", "T")},
            "rose12": roses, "normales": norm,
            "extremes": ext,
        }

    out = {
        "source": "Météo-France, données climatologiques de base horaires, station 44020001 Nantes-Bouguenais, Licence Ouverte Etalab 2.0",
        "def": "Mêmes définitions que meteo.json (rose en 12 secteurs par saison, toutes températures ; normales mensuelles) et extremes.json (journée civile, au moins 20 h), calculées pour chaque année seule.",
        "annees": sortie_annees,
    }

    def c(o):
        if isinstance(o, float):
            return None if np.isnan(o) else (int(o) if o.is_integer() else o)
        if isinstance(o, dict):
            return {k: c(v) for k, v in o.items()}
        if isinstance(o, list):
            return [c(v) for v in o]
        return o
    with open(sortie, "w", encoding="utf-8") as fh:
        json.dump(c(out), fh, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main(*sys.argv[1:3])
