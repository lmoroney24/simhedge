"""
Downloads real USDA LRP (Livestock Risk Protection) numbers for Feeder Cattle
and saves them to data/lrp-data.js (site/data in the private repo).

Source: USDA Risk Management Agency's official daily data files (the
"Actuarial Data Master", the same feed insurance companies use):
    https://pubfs-rma.fpac.usda.gov/pub/References/adm_livestock/
RMA posts one zip per business day. Each holds two pipe-separated text files:
    A00630 LrpRate              every coverage price, rate and cost on sale that day
    A00620 LrpActualEndingValue USDA's actual ending values as plans finish

Run it from the project folder:
    python3 site/tools/fetch_lrp.py            # today's prices + every history month (about a minute)
    python3 site/tools/fetch_lrp.py --daily    # today's prices + only new history months, plus any
                                               # ending values released since the last run
                                               # (what the daily job runs)
Actual ending values: each daily file lists only the values USDA released that
day, so the script keeps the saved ones and reads every file since the last run.
(--backfill-aev reads every daily file since July 2021: slow, only for a fresh start.)

Browsers can't read RMA's files directly (and each day is an 18 MB file), so
this script trims them to what Sim Hedge needs and ships that with the site.
That also means the demo works offline.
"""

import io
import json
import re
import ssl
import sys
import time
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

BASE_URL = "https://pubfs-rma.fpac.usda.gov/pub/References/adm_livestock/"
STATE = "Tennessee"
STATE_CODE, COUNTY_CODE, PLAN = "47", "998", "81"      # Tennessee, all counties, LRP
COMMODITIES = {"0801", "0802"}                           # Feeder Cattle, Fed Cattle
# Lives in site/tools, so the public website repo can run it too (daily job).
OUT_FILE = Path(__file__).resolve().parent.parent / "data" / "lrp-data.js"

# The cattle types Sim Hedge covers. Feeder Cattle (0801): Weight 1 = under
# 600 lbs, Weight 2 = 600 to 1,000 lbs. Fed Cattle (0802), "fat cattle":
# steers and heifers going to slaughter, 1,000 to 1,800 lbs. Fed Cattle pays on
# the CME Live Cattle Index; Feeder Cattle pays on the CME Feeder Cattle Index.
TYPES = {
    "809": "Steers under 600 lbs",
    "810": "Steers 600-1,000 lbs",
    "811": "Heifers under 600 lbs",
    "812": "Heifers 600-1,000 lbs",
    "820": "Fat cattle 1,000-1,800 lbs",
}
FED_TYPE = "820"
# Type codes repeat across commodities (Feeder Cattle also has a type 820,
# "Unborn Bulls & Heifers"), so every type is matched with its commodity.
TYPE_COMMODITY = {"809": "0801", "810": "0801", "811": "0801", "812": "0801", "820": "0802"}
# History only needs one type: every type's prices are the same national
# index times a fixed "price adjustment factor" (Steers 600-1,000 = 1.00).
HISTORY_TYPE = "810"

# USDA's share of the LRP premium by coverage level (LRP policy subsidy
# schedule; matches RMA's published producer premiums since July 2021).
SUBSIDY = [(0.95, 0.35), (0.90, 0.40), (0.85, 0.45), (0.80, 0.50), (0.0, 0.55)]

COLUMNS = ["weeks", "endDate", "expEnd", "coverage", "level", "cost", "premium", "actualEnd"]


def subsidy_for(level):
    return next(share for floor, share in SUBSIDY if level >= floor - 1e-9)


def producer_premium(cost, level):
    """Farmer's share of the premium, $/cwt, rounded to the cent like RMA."""
    return round(cost * (1 - subsidy_for(level)) + 1e-9, 2)


# --- Reading RMA's file server -------------------------------------------------

def _context():
    ctx = ssl.create_default_context()
    try:
        ctx.load_verify_locations("/etc/ssl/cert.pem")  # macOS system certificates
    except OSError:
        pass
    return ctx


CTX = _context()


def get(url, tries=4):
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(url, timeout=120, context=CTX) as r:
                return r.read()
        except OSError as err:
            if attempt == tries:
                raise
            print(f"    retry {attempt} for {url} ({err})", flush=True)
            time.sleep(5 * attempt)


def folder_dates(year):
    """Dates (YYYYMMDD) that have a daily file in one reinsurance-year folder."""
    html = get(f"{BASE_URL}{year}/").decode("utf-8", "ignore")
    return sorted(set(re.findall(rf"{year}_ADMLivestockLrp_Daily_(\d{{8}})\.zip", html)))


def reinsurance_year(yyyymmdd):
    """LRP's reinsurance year starts July 1: sales on 2026-10-21 are RY 2027."""
    y, m = int(yyyymmdd[:4]), int(yyyymmdd[4:6])
    return y + 1 if m >= 7 else y


def daily_zip(yyyymmdd, year=None):
    year = year or reinsurance_year(yyyymmdd)
    data = get(f"{BASE_URL}{year}/{year}_ADMLivestockLrp_Daily_{yyyymmdd}.zip")
    return zipfile.ZipFile(io.BytesIO(data))


def rows_of(zf, record):
    """Yields dicts for one record file (A00630 or A00620) in a daily zip,
    keeping only Tennessee / all counties / feeder cattle / LRP."""
    name = next((n for n in zf.namelist() if f"_{record}_" in n), None)
    if name is None:          # some days (e.g. Saturdays) only post ending values
        return
    with zf.open(name) as f:
        header = None
        for raw in io.TextIOWrapper(f, encoding="utf-8", errors="ignore"):
            cells = raw.rstrip("\r\n").split("|")
            if header is None:
                header = cells
                continue
            if cells[6] != STATE_CODE or cells[7] != COUNTY_CODE or cells[4] not in COMMODITIES or cells[5] != PLAN:
                continue
            yield dict(zip(header, cells))


def iso(yyyymmdd):
    return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:]}"


def rate_rows(zf, types, sales_date):
    """Coverage choices on sale that day, as dicts in Sim Hedge's format."""
    out = []
    for r in rows_of(zf, "A00630"):
        if r["Type Code"] not in types or r["Commodity Code"] != TYPE_COMMODITY[r["Type Code"]] \
                or r["Sales Effective Date"] != sales_date or r["Deleted Date"]:
            continue
        level, cost = float(r["Livestock Coverage Level Percent"]), float(r["Cost Per Cwt Amount"])
        out.append({
            "type": r["Type Code"],
            "factor": float(r["Price Adjustment Factor"] or 1),   # blank in 2021-22 files (always 1.00 for 810)
            "weeks": int(r["Endorsement Length Count"]),
            "endDate": iso(r["End Date"]),
            "expEnd": float(r["Expected Ending Value Amount"]),   # expected ending value, $/cwt
            "coverage": float(r["Coverage Price"]),               # coverage price, $/cwt
            "level": level,                                       # coverage level, 0.70 - 1.00
            "cost": cost,                                         # full premium, $/cwt
            "premium": producer_premium(cost, level),             # farmer's share after subsidy, $/cwt
            "actualEnd": None,
        })
    out.sort(key=lambda r: (r["type"], r["weeks"], -r["level"]))
    return out


def ending_values(zf, type_code):
    """Actual ending values RELEASED on one day's file (each daily file only
    lists that day's releases): {end date: value} for one cattle type."""
    return {iso(r["End Date"]): float(r["Actual Ending Value Amount"])
            for r in rows_of(zf, "A00620")
            if r["Type Code"] == type_code and r["Commodity Code"] == TYPE_COMMODITY[type_code] and not r["Deleted Date"]}


def compact(rows, keep_type=True):
    """Short arrays keep the data file small. Column order is in COLUMNS."""
    return [([r["type"]] if keep_type else []) +
            [r["weeks"], r["endDate"], r["expEnd"], r["coverage"], r["level"], r["cost"], r["premium"], r["actualEnd"]]
            for r in rows]


# --- Main ---------------------------------------------------------------------

def main():
    daily = "--daily" in sys.argv
    today_year = reinsurance_year(date.today().strftime("%Y%m%d"))
    years = list(range(2022, today_year + 1))            # Sim Hedge history starts July 2021 (RY 2022)
    dates_by_year = {y: folder_dates(y) for y in years}

    # Only dates that are sales days in their own folder (folders keep
    # posting ending-value updates after their sales year is over).
    sales_dates = sorted(d for y, ds in dates_by_year.items() for d in ds if reinsurance_year(d) == y)
    # Newest day that actually has prices (skip ending-value-only files).
    for latest in reversed(sales_dates):
        current = rate_rows(daily_zip(latest), set(TYPES), latest)
        if current:
            break
    print(f"Latest USDA prices: {iso(latest)}", flush=True)

    for code in TYPES:
        n = sum(r["type"] == code for r in current)
        print(f"  {TYPES[code]}: {n} rows", flush=True)
        if not n:
            raise RuntimeError(f"No rows for type {code} on {latest}")
    factors = {code: next(r["factor"] for r in current if r["type"] == code) for code in TYPES}

    old = None
    if OUT_FILE.exists():
        text = OUT_FILE.read_text()
        old = json.loads(text[text.index("{"):text.rindex("}") + 1])
    saved = {m["effectiveDate"]: m for m in (old or {}).get("history", [])} if daily else {}
    end_i, actual_i = COLUMNS.index("endDate"), COLUMNS.index("actualEnd")

    # Prices for each history month: the first day of the month that has prices.
    by_month = {}
    for d in sales_dates:
        by_month.setdefault(d[:6], []).append(d)
    saved_by_month = {k.replace("-", "")[:6]: m for k, m in saved.items()}
    history = []
    for ym in sorted(by_month):
        if ym in saved_by_month:
            history.append(saved_by_month[ym])
            continue
        rows = []
        for d in by_month[ym]:
            rows = rate_rows(daily_zip(d), {HISTORY_TYPE}, d)
            if rows:
                break
        if rows:
            history.append({"effectiveDate": iso(d), "rows": compact(rows, keep_type=False)})
            print(f"  history {iso(d)}: {len(rows)} rows", flush=True)

    # Actual ending values. Each daily file only lists the values released
    # that day, so keep the ones already saved and read every file posted
    # since the last run (plus a 3-day overlap in case one was re-posted).
    known = {}
    for m in (old or {}).get("history", []):
        for r in m["rows"]:
            if r[actual_i] is not None:
                known[r[end_i]] = r[actual_i]
    if old:
        start = (old.get("aevThrough") or old["fetchedOn"]).replace("-", "")
        start = (datetime.strptime(start, "%Y%m%d") - timedelta(days=3)).strftime("%Y%m%d")
    elif "--backfill-aev" in sys.argv:
        start = "20210701"
    else:
        start = None
        print("  No saved ending values: run with --backfill-aev to read every daily file (slow).")
    fed_known = dict((old or {}).get("fedEndingValues", {}))   # fat cattle: kept from today on
    all_files = sorted((d, y) for y, ds in dates_by_year.items() for d in ds)
    if start:
        for d, y in all_files:
            if d >= start:
                zf = daily_zip(d, y)
                found, fed = ending_values(zf, HISTORY_TYPE), ending_values(zf, FED_TYPE)
                if found or fed:
                    print(f"  ending values released {iso(d)}: {len(found)} feeder, {len(fed)} fat", flush=True)
                known.update(found)
                fed_known.update(fed)
    for m in history:
        for r in m["rows"]:
            r[actual_i] = known.get(r[end_i], r[actual_i])
    aev_through = iso(all_files[-1][0])

    # Nothing new from USDA (weekends, holidays): leave the file alone.
    if old and old["current"]["effectiveDate"] == iso(latest) and old.get("history") == history \
            and old["current"]["rows"] == compact(current) \
            and old.get("source") == BASE_URL and old.get("aevThrough") \
            and old.get("fedEndingValues", {}) == fed_known:
        print("No new USDA data since the last download. File unchanged.")
        return

    data = {
        "fetchedOn": date.today().isoformat(),
        "source": BASE_URL,
        "state": STATE,
        "columns": COLUMNS,
        "types": {code: {"name": name, "factor": factors[code]} for code, name in TYPES.items()},
        "current": {"effectiveDate": iso(latest), "rows": compact(current)},
        "historyType": HISTORY_TYPE,
        "history": history,
        "aevThrough": aev_through,   # newest daily file whose ending values were read
        "fedEndingValues": dict(sorted(fed_known.items())),   # fat cattle (CME Live Cattle Index) ending values
    }
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(
        "// Real USDA RMA LRP data (RMA daily ADM files). Generated by tools/fetch_lrp.py - do not edit by hand.\n"
        "window.LRP_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n"
    )
    print(f"Saved {OUT_FILE} ({OUT_FILE.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
