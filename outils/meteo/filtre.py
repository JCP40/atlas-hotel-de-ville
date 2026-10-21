"""Filtre la station 44020001 dans les fichiers H_44_*.csv.gz (arguments) -> CSV de sortie."""
import sys, gzip
import pandas as pd

out = sys.argv[1]
files = sys.argv[2:]
COLS = ["NUM_POSTE", "AAAAMMJJHH", "FF", "DD", "FXI", "DXI", "FXY", "DXY", "T", "TN", "TX",
        "TD", "U", "PSTAT", "PMER", "RR1", "GLO", "INS", "N"]
parts = []
for f in files:
    with gzip.open(f, "rt", encoding="utf-8", errors="replace") as fh:
        it = pd.read_csv(fh, sep=";", dtype=str, chunksize=200000, usecols=lambda c: c in COLS)
        for ch in it:
            ch = ch[ch["NUM_POSTE"].str.strip() == "44020001"]
            if len(ch):
                parts.append(ch)
df = pd.concat(parts)
df["AAAAMMJJHH"] = df["AAAAMMJJHH"].str.strip()
df = df[(df["AAAAMMJJHH"] >= "2016010100")]
df = df.drop_duplicates("AAAAMMJJHH").sort_values("AAAAMMJJHH")
keep = [c for c in COLS if c in df.columns and c != "NUM_POSTE"]
for c in keep[1:]:
    df[c] = pd.to_numeric(df[c].str.strip().str.replace(",", "."), errors="coerce")
# colonnes entièrement vides retirées
keep = [c for c in keep if c == "AAAAMMJJHH" or df[c].notna().any()]
df[keep].to_csv(out, index=False, float_format="%g")
print(len(df), df["AAAAMMJJHH"].min(), df["AAAAMMJJHH"].max(), keep)
