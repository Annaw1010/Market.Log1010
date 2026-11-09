#!/usr/bin/env python3
"""
Market Pulse updater. GitHub Actions runs this every 20 minutes.

What it does, in order:
  1. Pulls headlines from the RSS feeds and Google News searches in config.json.
  2. Groups headlines that cover the same story and ranks the groups.
  3. Keeps a rolling two-day buffer (data/state.json) plus daily and monthly
     history files, which is how the site can rank the week, month and year.
  4. Pulls market indicators from Yahoo Finance (yfinance), with FRED as backup.
  5. Writes a plain-English market brief and client talking points per period.
  6. Enriches the articles and tickers you saved on the site (data/saved.json).

Files that change every run (latest.json, top.json, indicators.json,
firm_watch.json, watchlist.json) are deployed to GitHub Pages and not committed.
Files that must survive between runs (state.json, history/, saved_meta.json)
are committed by the workflow.
"""
from __future__ import annotations

import hashlib
import html
import json
import math
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote, urlparse
from zoneinfo import ZoneInfo

import requests

try:
    import feedparser  # tolerant RSS/Atom parser, installed in Actions
except ImportError:  # pragma: no cover - local runs without it use the fallback
    feedparser = None

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DAILY_DIR = DATA / "history" / "daily"
MONTHLY_DIR = DATA / "history" / "monthly"

CFG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
TZ = ZoneInfo(CFG.get("timezone", "America/New_York"))
NOW = datetime.now(timezone.utc)
RETENTION_H = int(CFG.get("retention_hours", 54))

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
HTTP = requests.Session()
HTTP.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def et_date(dt: datetime) -> date:
    return dt.astimezone(TZ).date()


def et_day_start(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=TZ)


def stale(ts: str | None, hours: float) -> bool:
    d = parse_iso(ts)
    return d is None or (NOW - d) > timedelta(hours=hours)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as exc:
        log(f"  ! could not parse {path.name}: {exc}")
        return default


def write_json(path: Path, obj, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    else:
        txt = json.dumps(obj, ensure_ascii=False, indent=1)
    path.write_text(txt + "\n", encoding="utf-8")


def dump_lines(head: dict, key: str, rows: list) -> str:
    """One row per line, so git diffs between runs stay small."""
    head_txt = json.dumps(head, ensure_ascii=False)[:-1]
    sep = ", " if head else ""
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    return f'{head_txt}{sep}"{key}": [\n{body}\n]}}\n'


def write_lines_if_changed(path: Path, head: dict, key: str, rows: list) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    new_txt = dump_lines(head, key, rows)
    if path.exists() and path.read_text(encoding="utf-8") == new_txt:
        return False
    path.write_text(new_txt, encoding="utf-8")
    return True


TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def clean_text(s: str | None, limit: int | None = None) -> str:
    s = html.unescape(TAG_RE.sub(" ", s or ""))
    s = WS_RE.sub(" ", s).strip()
    if limit and len(s) > limit:
        s = s[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return s


def norm_title(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def domain(url: str) -> str:
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


# --------------------------------------------------------------------------
# Themes and story grouping
# --------------------------------------------------------------------------

STOP = set(
    """a an and are as at be been but by for from has have he her his how in into is it
    its of on or our over says said she that the their them they this to up was we were
    what when where which who why will with would you your after amid about more than new
    not no just now year years week weeks today report reports could may might also first
    last back down out off here there all any can get gets got make makes made one two
    three us u.s per via set sets see sees while still next big top why how what's it's
    amid ahead day days month months""".split()
)
TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9&.'-]*")


def tokens(text: str) -> set[str]:
    out = set()
    for w in TOKEN_RE.findall(text.lower()):
        w = w.strip(".'-")
        if w.endswith("'s"):
            w = w[:-2]
        if len(w) < 3 or w in STOP:
            continue
        if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.add(w)
    return out


def similar(a: set, b: set) -> bool:
    if not a or not b:
        return False
    inter = len(a & b)
    if inter < 2:
        return False
    if inter / len(a | b) >= 0.3:
        return True
    return inter >= 3 and inter / min(len(a), len(b)) >= 0.6


def greedy_group(records: list, tok) -> list[list]:
    """Group records whose title tokens overlap. Records should arrive best-first."""
    groups: list[tuple[set, list]] = []
    index: dict[str, set[int]] = defaultdict(set)
    for r in records:
        t = tok(r)
        candidates: set[int] = set()
        for w in t:
            candidates |= index.get(w, set())
        target = None
        for gi in sorted(candidates):
            core, members = groups[gi]
            if similar(t, core) or any(similar(t, tok(m)) for m in members[1:4]):
                target = gi
                break
        if target is None:
            groups.append((t, [r]))
            target = len(groups) - 1
        else:
            groups[target][1].append(r)
        for w in t:
            index[w].add(target)
    return [members for _, members in groups]


def _compile_themes():
    out = []
    for t in CFG.get("themes", []):
        pats = []
        for kw in t.get("keywords", []):
            flags = 0 if any(c.isupper() for c in kw) else re.IGNORECASE
            pats.append(re.compile(r"(?<![A-Za-z0-9])" + re.escape(kw) + r"(?![A-Za-z0-9])", flags))
        out.append((t["name"], float(t.get("weight", 0.3)), pats))
    return out


THEMES = _compile_themes()
THEME_WEIGHT = {name: w for name, w, _ in THEMES}
THEME_ORDER = {name: i for i, (name, _, _) in enumerate(THEMES)}


def classify(text: str) -> list[str]:
    return [name for name, _, pats in THEMES if any(p.search(text) for p in pats)]


# --------------------------------------------------------------------------
# Fetching and parsing feeds
# --------------------------------------------------------------------------

def http_get(url: str, timeout: int = 15) -> bytes:
    r = HTTP.get(url, timeout=timeout)
    r.raise_for_status()
    return r.content


def parse_date(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError, IndexError):
        d = parse_iso(s)
    if d is not None and d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def parse_feed(content: bytes) -> list[dict]:
    entries = []
    if feedparser is not None:
        fp = feedparser.parse(content)
        for e in fp.entries:
            src = e.get("source")
            src_title = src.get("title") if isinstance(src, dict) else None
            pub = None
            for key in ("published_parsed", "updated_parsed"):
                t = e.get(key)
                if t:
                    pub = datetime(*t[:6], tzinfo=timezone.utc)
                    break
            entries.append({
                "title": e.get("title", ""),
                "link": e.get("link", ""),
                "published": pub,
                "summary": e.get("summary", ""),
                "source": src_title,
            })
        return entries

    # Fallback parser for local testing without feedparser.
    root = ET.fromstring(content)
    atom = "{http://www.w3.org/2005/Atom}"
    for it in root.iter("item"):
        src_el = it.find("source")
        entries.append({
            "title": it.findtext("title", ""),
            "link": (it.findtext("link") or "").strip(),
            "published": parse_date(it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date")),
            "summary": it.findtext("description", ""),
            "source": src_el.text if src_el is not None else None,
        })
    for it in root.iter(atom + "entry"):
        link_el = it.find(atom + "link")
        entries.append({
            "title": it.findtext(atom + "title", ""),
            "link": link_el.get("href", "") if link_el is not None else "",
            "published": parse_date(it.findtext(atom + "published") or it.findtext(atom + "updated")),
            "summary": it.findtext(atom + "summary", ""),
            "source": None,
        })
    return entries


GOOGLE_SUFFIX = re.compile(r"\s+-\s+([^-]{2,80})$")


def make_item(raw: dict, feed_name: str, feed_weight: float, is_google: bool) -> dict | None:
    title = clean_text(raw.get("title"))
    link = (raw.get("link") or "").strip()
    if not title or not link.startswith("http"):
        return None
    source = feed_name
    summary = "" if is_google else clean_text(raw.get("summary"), 260)
    if is_google:
        src = clean_text(raw.get("source") or "")
        if src and title.endswith(" - " + src):
            title = title[: -len(src) - 3].strip()
        else:
            m = GOOGLE_SUFFIX.search(title)
            if m:
                src = src or m.group(1).strip()
                title = title[: m.start()].strip()
        source = src or "Google News"
    if summary and norm_title(summary).startswith(norm_title(title)):
        summary = ""  # some feeds repeat the headline as the summary
    pub = raw.get("published") or NOW
    if pub > NOW + timedelta(hours=1):
        pub = NOW
    weight = float(CFG.get("publisher_weights", {}).get(source, feed_weight))
    tags = classify(f"{title} {summary}")
    return {
        "id": hashlib.sha1(f"{source}|{norm_title(title)}".encode()).hexdigest()[:12],
        "title": title,
        "link": link,
        "source": source,
        "published": iso(pub),
        "summary": summary,
        "theme": tags[0] if tags else "General",
        "tags": tags,
        "w": round(weight, 2),
        "g": is_google,
    }


def unique_titles(rows: list[dict]) -> list[dict]:
    seen, out = set(), []
    for r in rows:
        k = norm_title(r["title"])
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def google_news(query: str, when: str | None = "1d") -> list[dict]:
    q = f"{query} when:{when}" if when else query
    url = "https://news.google.com/rss/search?q=" + quote(q) + "&hl=en-US&gl=US&ceid=US:en"
    return parse_feed(http_get(url))


def dedupe(items: list[dict]) -> list[dict]:
    best: dict[str, dict] = {}
    for it in items:
        old = best.get(it["id"])
        if old is None:
            best[it["id"]] = it
            continue
        # Prefer a direct publisher link over a Google redirect, keep the earliest time.
        keep, other = (it, old) if (old.get("g") and not it.get("g")) else (old, it)
        keep = dict(keep)
        keep["published"] = min(keep["published"], other["published"])
        if not keep.get("summary") and other.get("summary"):
            keep["summary"] = other["summary"]
        best[it["id"]] = keep
    return list(best.values())


def fetch_all_news() -> tuple[list[dict], dict]:
    jobs = []
    for f in CFG.get("feeds", []):
        jobs.append(("feed", f["name"], f["url"], float(f.get("weight", 1.0))))
    for q in CFG.get("google_news", []):
        jobs.append(("google", q, q, float(CFG.get("google_weight", 0.8))))

    def run(job):
        kind, name, target, weight = job
        try:
            raw = google_news(target, "1d") if kind == "google" else parse_feed(http_get(target))
            out = [make_item(r, "Google News" if kind == "google" else name, weight, kind == "google") for r in raw]
            return name, [o for o in out if o], None
        except Exception as exc:  # noqa: BLE001 - one bad feed should never stop the run
            return name, [], str(exc)[:160]

    items, failed = [], []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for name, got, err in pool.map(run, jobs):
            if err:
                failed.append(name)
                log(f"  ! {name}: {err}")
            items.extend(got)
    status = {"sources_total": len(jobs), "sources_ok": len(jobs) - len(failed), "failed": failed}
    log(f"News: {len(items)} headlines from {status['sources_ok']}/{len(jobs)} sources")
    return dedupe(items), status


# --------------------------------------------------------------------------
# Ranking
# --------------------------------------------------------------------------

def summarize_items(members: list[dict], recency: bool) -> dict:
    best_by_source: dict[str, dict] = {}
    for m in members:
        cur = best_by_source.get(m["source"])
        if cur is None or m["w"] > cur["w"]:
            best_by_source[m["source"]] = m
    base = sum(m["w"] for m in best_by_source.values())
    extra = 0.25 * (len(members) - len(best_by_source))
    rep = max(members, key=lambda m: (m["w"], not m.get("g"), bool(m.get("summary")), m["published"]))

    counts = Counter(m["theme"] for m in members if m["theme"] != "General")
    if counts:
        top_n = max(counts.values())
        theme = min((t for t, c in counts.items() if c == top_n), key=lambda t: THEME_ORDER.get(t, 99))
    else:
        theme = "General"
    tags = sorted({t for m in members for t in m.get("tags", [])}, key=lambda t: THEME_ORDER.get(t, 99))

    score = base + extra + THEME_WEIGHT.get(theme, 0.0)
    first = min(m["published"] for m in members)
    latest = max(m["published"] for m in members)
    if recency:
        age_h = max(0.0, (NOW - parse_iso(latest)).total_seconds() / 3600)
        score *= 0.55 + 0.45 * math.exp(-age_h / 10)

    sources = sorted(best_by_source, key=lambda s: -best_by_source[s]["w"])
    alts = [
        {"title": best_by_source[s]["title"], "link": best_by_source[s]["link"], "source": s}
        for s in sources if s != rep["source"]
    ][:4]

    tok_counts = Counter(w for m in members for w in tokens(m["title"]))
    tok = tokens(rep["title"]) | {w for w, c in tok_counts.items() if c >= 2}
    summary = rep.get("summary") or next((m["summary"] for m in members if m.get("summary")), "")
    return {
        "id": rep["id"],
        "title": rep["title"],
        "link": rep["link"],
        "source": rep["source"],
        "published": first,
        "updated": latest,
        "summary": summary,
        "theme": theme,
        "tags": tags,
        "score": round(score, 3),
        "sources": sources[:12],
        "count": len(members),
        "alts": alts,
        "tok": sorted(tok),
        "_members": [m["id"] for m in members],
    }


def stories_from_items(items: list[dict], recency: bool = False) -> list[dict]:
    ordered = sorted(items, key=lambda i: (-i["w"], i.get("g", False), i["published"]))
    cache = {}

    def tok(r):
        if r["id"] not in cache:
            cache[r["id"]] = tokens(r["title"])
        return cache[r["id"]]

    stories = [summarize_items(g, recency) for g in greedy_group(ordered, tok)]
    stories.sort(key=lambda s: -s["score"])
    return stories


def _strip_private(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if not k.startswith("_")}


def rollup(records: list[dict], top_n: int) -> list[dict]:
    """Merge stories across days. A story that leads several days adds up."""
    recs = [dict(r, _t=set(r.get("tok", []))) for r in records]
    recs.sort(key=lambda r: -r["score"])
    out = []
    for g in greedy_group(recs, lambda r: r["_t"]):
        rep = g[0]
        sources: list[str] = []
        for m in g:
            for s in m.get("sources", []):
                if s not in sources:
                    sources.append(s)
        alts, seen = [], {rep["source"]}
        for m in g:
            for a in [{"title": m["title"], "link": m["link"], "source": m["source"]}] + m.get("alts", []):
                if a["source"] not in seen:
                    seen.add(a["source"])
                    alts.append(a)
        days = sorted({m["date"] for m in g if m.get("date")})
        merged = dict(rep)
        merged.update({
            "score": round(sum(m["score"] for m in g), 3),
            "sources": sources[:12],
            "count": sum(m.get("count", 1) for m in g),
            "alts": alts[:4],
            "published": min(m["published"] for m in g),
            "days": len(days) or 1,
            "date": days[0] if days else rep.get("date"),
        })
        out.append(_strip_private(merged))
    out.sort(key=lambda r: -r["score"])
    return out[:top_n]


def merge_max(old: list[dict], new: list[dict]) -> list[dict]:
    """Combine two versions of one day's list; the newer version of a story wins."""
    recs = [dict(r, _new=True) for r in new] + [dict(r, _new=False) for r in old]
    for r in recs:
        r["_t"] = set(r.get("tok", []))
    recs.sort(key=lambda r: (not r["_new"], -r["score"]))
    out = []
    for g in greedy_group(recs, lambda r: r["_t"]):
        best = max(g, key=lambda r: (r["_new"], r["score"]))
        rec = dict(best)
        rec["score"] = max(x["score"] for x in g)
        out.append(_strip_private(rec))
    out.sort(key=lambda r: -r["score"])
    return out


def load_daily(d: date) -> list[dict]:
    doc = read_json(DAILY_DIR / f"{d.isoformat()}.json", {})
    stories = doc.get("stories", [])
    for s in stories:
        s.setdefault("date", d.isoformat())
    return stories


def update_daily_files(items: list[dict], collecting_since: datetime) -> int:
    today = et_date(NOW)
    by_day = defaultdict(list)
    for it in items:
        by_day[et_date(parse_iso(it["published"]))].append(it)
    changed = 0
    for d in (today - timedelta(days=1), today):
        day_items = by_day.get(d)
        if not day_items:
            continue
        stories = [_strip_private(s) for s in stories_from_items(day_items)[:40]]
        for s in stories:
            s["date"] = d.isoformat()
        if collecting_since > et_day_start(d):
            # The buffer does not cover this whole day, so keep what we had.
            stories = merge_max(load_daily(d), stories)[:40]
        if write_lines_if_changed(DAILY_DIR / f"{d.isoformat()}.json", {"date": d.isoformat()}, "stories", stories):
            changed += 1
    return changed


def month_bounds(y: int, m: int) -> tuple[date, date]:
    start = date(y, m, 1)
    end = date(y + (m == 12), m % 12 + 1, 1)
    return start, end


def daily_records_between(start: date, end: date) -> list[dict]:
    out = []
    d = start
    while d < end:
        out.extend(load_daily(d))
        d += timedelta(days=1)
    return out


def monthly_records(y: int, m: int, today: date) -> list[dict]:
    start, end = month_bounds(y, m)
    current = start <= today < end
    path = MONTHLY_DIR / f"{y:04d}-{m:02d}.json"
    if not current and path.exists():
        return read_json(path, {}).get("stories", [])
    stories = rollup(daily_records_between(start, min(end, today + timedelta(days=1))), 50)
    if not current and stories:
        write_lines_if_changed(path, {"month": f"{y:04d}-{m:02d}"}, "stories", stories)
    return stories


def build_tops(items: list[dict]) -> tuple[dict, dict, dict]:
    today = et_date(NOW)
    last24 = [i for i in items if parse_iso(i["published"]) >= NOW - timedelta(hours=24)]
    day = stories_from_items(last24, recency=True)
    outlets = {}
    for s in day:
        for mid in s.get("_members", []):
            outlets[mid] = len(s["sources"])
    day = [_strip_private(s) for s in day[:25]]

    week = rollup(daily_records_between(today - timedelta(days=6), today + timedelta(days=1)), 25)
    month = rollup(daily_records_between(today - timedelta(days=29), today + timedelta(days=1)), 30)
    year_records = []
    for m in range(1, today.month + 1):
        year_records.extend(monthly_records(today.year, m, today))
    year = rollup(year_records, 40)

    periods = {"day": day, "week": week, "month": month, "year": year}
    themes = {}
    for k, stories in periods.items():
        c = Counter(s["theme"] for s in stories if s["theme"] != "General")
        themes[k] = dict(c.most_common())
    for k in periods:
        periods[k] = [{kk: vv for kk, vv in s.items() if kk != "tok"} for s in periods[k]]

    days = sorted(p.stem for p in DAILY_DIR.glob("*.json"))
    coverage = {"first_day": days[0] if days else None, "history_days": len(days)}
    return {"periods": periods, "themes": themes, "coverage": coverage}, outlets, themes


# --------------------------------------------------------------------------
# One-time backfill so the month and year views are not empty on day one
# --------------------------------------------------------------------------

def backfill() -> int:
    today = et_date(NOW)
    by_day = defaultdict(list)
    start = date(today.year, 1, 1)
    windows = []
    m = start
    while m <= today:
        _, nxt = month_bounds(m.year, m.month)
        windows.append((m, min(nxt, today)))
        m = nxt
    weight = float(CFG.get("google_weight", 0.8))
    for q in CFG.get("backfill_queries", []):
        for a, b in windows:
            if a >= b:
                continue
            try:
                raw = google_news(f"{q} after:{a.isoformat()} before:{b.isoformat()}", when=None)
            except Exception as exc:  # noqa: BLE001
                log(f"  ! backfill {q} {a}: {exc}")
                time.sleep(2)
                continue
            for r in raw:
                it = make_item(r, "Google News", weight, True)
                if not it:
                    continue
                d = et_date(parse_iso(it["published"]))
                if a <= d < b:
                    by_day[d].append(it)
            time.sleep(0.6)
    written = 0
    for d, day_items in by_day.items():
        if d >= today - timedelta(days=1):
            continue
        stories = [_strip_private(s) for s in stories_from_items(dedupe(day_items))[:40]]
        for s in stories:
            s["date"] = d.isoformat()
        merged = merge_max(load_daily(d), stories)[:40]
        if write_lines_if_changed(DAILY_DIR / f"{d.isoformat()}.json", {"date": d.isoformat()}, "stories", merged):
            written += 1
    for p in MONTHLY_DIR.glob("*.json"):
        p.unlink()  # rebuilt from the new daily files on this run
    log(f"Backfill: wrote {written} daily files")
    return written


# --------------------------------------------------------------------------
# Market indicators
# --------------------------------------------------------------------------

PERIOD_DAYS = {"1D": None, "1W": 7, "1M": 30, "YTD": "ytd", "1Y": 365}


def fetch_yahoo(symbols: list[str], period: str = "2y") -> dict[str, list]:
    symbols = [s for s in dict.fromkeys(symbols) if s]
    if not symbols:
        return {}
    try:
        import yfinance as yf
    except ImportError:
        log("  ! yfinance is not installed")
        return {}
    try:
        df = yf.download(symbols, period=period, interval="1d", auto_adjust=False,
                         progress=False, threads=True)
    except Exception as exc:  # noqa: BLE001
        log(f"  ! Yahoo download failed: {exc}")
        return {}
    if df is None or getattr(df, "empty", True):
        return {}
    try:
        close = df["Close"]
    except KeyError:
        return {}
    if not hasattr(close, "columns"):
        close = close.to_frame(symbols[0])
    out = {}
    for s in symbols:
        if s not in close.columns:
            continue
        pts = []
        for idx, v in close[s].dropna().items():
            v = float(v)
            if math.isfinite(v):
                pts.append((idx.strftime("%Y-%m-%d"), v))
        dedup = dict(pts)
        if dedup:
            out[s] = sorted(dedup.items())
    return out


def fetch_fred(series_id: str, years: int = 2) -> list[tuple[str, float]]:
    start = (NOW - timedelta(days=365 * years + 31)).strftime("%Y-%m-%d")
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start}"
    r = HTTP.get(url, timeout=25)
    r.raise_for_status()
    pts = []
    for line in r.text.strip().splitlines()[1:]:
        parts = line.split(",")
        if len(parts) < 2:
            continue
        try:
            pts.append((parts[0], float(parts[1])))
        except ValueError:
            continue  # FRED uses "." for missing values
    return pts


def ref_point(series: list, key: str):
    if len(series) < 2:
        return None
    last_d = date.fromisoformat(series[-1][0])
    if key == "1D":
        return series[-2]
    if key == "YTD":
        target = date(last_d.year, 1, 1) - timedelta(days=1)
    else:
        target = last_d - timedelta(days=PERIOD_DAYS[key])
    for d, v in reversed(series):
        if date.fromisoformat(d) <= target:
            return (d, v)
    return None


def changes(series: list, kind: str) -> dict:
    out = {}
    last = series[-1][1]
    for key in PERIOD_DAYS:
        ref = ref_point(series, key)
        if not ref:
            continue
        prev = ref[1]
        if kind in ("yield", "spread"):
            out[key] = {"bps": round((last - prev) * 100, 1), "from": round(prev, 4), "since": ref[0]}
        else:
            pct = round((last / prev - 1) * 100, 2) if prev else None
            out[key] = {"abs": round(last - prev, 4), "pct": pct, "from": round(prev, 4), "since": ref[0]}
    return out


def trim_series(pts: list) -> list:
    last = date.fromisoformat(pts[-1][0])
    cutoff = min(date(last.year, 1, 1), last - timedelta(days=70)) - timedelta(days=7)
    recent = last - timedelta(days=45)
    keep = [(d, v) for d, v in pts if date.fromisoformat(d) >= cutoff]
    # Full detail for the last 45 days, every third point before that (plenty for a sparkline).
    older = [p for p in keep if date.fromisoformat(p[0]) < recent][::-1][::3][::-1]
    newer = [p for p in keep if date.fromisoformat(p[0]) >= recent]
    return [[d, sig(v)] for d, v in older + newer]


def sig(v: float, figures: int = 5) -> float:
    if v == 0 or not math.isfinite(v):
        return 0.0
    return round(v, max(0, figures - 1 - int(math.floor(math.log10(abs(v))))))


def build_indicators() -> tuple[dict, dict]:
    specs = CFG.get("indicators", [])
    yahoo = fetch_yahoo([s["yahoo"] for s in specs if s.get("yahoo")])
    groups: dict[str, list] = {}
    by_id = {}
    for s in specs:
        pts, src = None, None
        if s.get("yahoo") and yahoo.get(s["yahoo"]):
            pts, src = yahoo[s["yahoo"]], "Yahoo Finance"
            if s["kind"] == "yield" and pts[-1][1] > 20:
                pts = [(d, v / 10) for d, v in pts]
        fresh = bool(pts) and (NOW.date() - date.fromisoformat(pts[-1][0])).days <= 5
        if not fresh and s.get("fred"):
            try:
                fp = fetch_fred(s["fred"])
                if fp:
                    pts, src = fp, "FRED"
            except Exception as exc:  # noqa: BLE001
                log(f"  ! FRED {s['fred']}: {exc}")
        if not pts or len(pts) < 2:
            continue
        rec = {
            "id": s["id"], "name": s["name"], "kind": s["kind"], "group": s["group"],
            "last": round(pts[-1][1], 4), "asof": pts[-1][0], "source": src,
            "chg": changes(pts, s["kind"]), "series": trim_series(pts),
        }
        groups.setdefault(s["group"], []).append(rec)
        by_id[s["id"]] = rec

    macro = []
    for m in CFG.get("macro", []):
        try:
            pts = fetch_fred(m["fred"], years=3)
        except Exception as exc:  # noqa: BLE001
            log(f"  ! FRED {m['fred']}: {exc}")
            continue
        vals = dict(pts)
        if m.get("transform") == "yoy":
            pts = [(d, (v / vals[f"{int(d[:4]) - 1}{d[4:]}"] - 1) * 100)
                   for d, v in pts if f"{int(d[:4]) - 1}{d[4:]}" in vals]
        elif m.get("transform") == "diff":
            def prev_month(d: str) -> str:
                y, mo = int(d[:4]), int(d[5:7])
                y, mo = (y - 1, 12) if mo == 1 else (y, mo - 1)
                return f"{y:04d}-{mo:02d}-01"
            pts = [(d, v - vals[prev_month(d)]) for d, v in pts if prev_month(d) in vals]
        if len(pts) < 2:
            continue
        macro.append({
            "id": m["id"], "name": m["name"], "unit": m.get("unit", ""),
            "value": round(pts[-1][1], 2), "prev": round(pts[-2][1], 2),
            "asof": pts[-1][0], "prev_asof": pts[-2][0],
        })
        by_id[m["id"]] = macro[-1]
    log(f"Indicators: {len(by_id)} series")
    return {"groups": [{"name": g, "items": v} for g, v in groups.items()], "macro": macro}, by_id


# --------------------------------------------------------------------------
# Market brief and client talking points
# --------------------------------------------------------------------------

SPAN = {
    "day": ("1D", "in the latest session"),
    "week": ("1W", "over the past week"),
    "month": ("1M", "over the past month"),
    "year": ("YTD", "so far this year"),
}
THRESH = {
    "day": {"eq": 1.5, "rate": 8, "hy": 15},
    "week": {"eq": 3, "rate": 15, "hy": 25},
    "month": {"eq": 5, "rate": 25, "hy": 40},
    "year": {"eq": 10, "rate": 50, "hy": 75},
}


def _chg(ind: dict, rec_id: str, key: str):
    rec = ind.get(rec_id)
    return (rec, rec.get("chg", {}).get(key)) if rec and "chg" in rec else (rec, None)


def _move(c: dict | None) -> str | None:
    if not c or c.get("pct") is None:
        return None
    p = c["pct"]
    if abs(p) < 0.05:
        return "was little changed"
    return f"{'rose' if p > 0 else 'fell'} {abs(p):.1f}%"


def _bps(c: dict | None) -> str | None:
    if not c:
        return None
    b = c["bps"]
    if abs(b) < 1:
        return "held steady"
    return f"{'rose' if b > 0 else 'fell'} {abs(b):.0f} bp"


def _num(v: float) -> str:
    return f"{v:,.0f}" if v >= 1000 else f"{v:,.2f}"


def _join(parts: list[str]) -> str:
    parts = [p for p in parts if p]
    if len(parts) <= 1:
        return "".join(parts)
    return ", ".join(parts[:-1]) + ", and " + parts[-1]


def write_brief(period: str, ind: dict, stories: list[dict]) -> str:
    key, span = SPAN[period]
    out = []
    spx, c = _chg(ind, "spx", key)
    if spx and _move(c):
        sentence = f"The S&P 500 {_move(c)} {span} to {_num(spx['last'])}"
        extra = []
        for rid, label in (("ixic", "the Nasdaq"), ("rut", "small caps")):
            _, cc = _chg(ind, rid, key)
            if _move(cc):
                extra.append(f"{label} {_move(cc)}")
        out.append(sentence + ("; " + " and ".join(extra) if extra else "") + ".")
    bkx, c = _chg(ind, "bkx", key)
    if bkx and _move(c):
        out.append(f"Bank stocks (KBW Bank Index) {_move(c)}.")
    rates = []
    for rid, label in (("us10y", "The 10-year Treasury yield"), ("us2y", "the 2-year")):
        rec, cc = _chg(ind, rid, key)
        if rec and _bps(cc):
            prep = "at" if _bps(cc) == "held steady" else "to"
            rates.append(f"{label} {_bps(cc)} {prep} {rec['last']:.2f}%")
    if rates:
        out.append(" and ".join(rates) + ".")
    vix = ind.get("vix")
    if vix:
        v = vix["last"]
        mood = "a calm reading" if v < 15 else "a normal reading" if v < 20 else "an elevated reading" if v < 30 else "a stressed reading"
        out.append(f"The VIX is at {v:.1f}, {mood}.")
    cross = []
    for rid, label in (("wti", "WTI crude"), ("gold", "gold"), ("dxy", "the dollar index"), ("btc", "bitcoin")):
        _, cc = _chg(ind, rid, key)
        if _move(cc):
            cross.append(f"{label} {_move(cc)}")
    if cross:
        out.append("Elsewhere, " + _join(cross[:3]) + ".")
    heads = [s["title"].rstrip(".") for s in stories[:2]]
    if heads:
        out.append("In the headlines: " + "; ".join(heads) + ".")
    return " ".join(out)


def client_angles(period: str, ind: dict, themes: dict) -> list[dict]:
    key, _ = SPAN[period]
    t = THRESH[period]
    angles = []
    _, spx = _chg(ind, "spx", key)
    if spx and spx.get("pct") is not None:
        if spx["pct"] <= -t["eq"]:
            angles.append({"title": "Equities sold off", "body": "A natural moment for tax-loss harvesting, rebalancing back to target weights, and helping clients stay invested through a drawdown."})
        elif spx["pct"] >= t["eq"]:
            angles.append({"title": "Equities rallied", "body": "Concentrated stock positions just got bigger. Diversification tools such as exchange funds, collars, and gifting appreciated shares to a donor-advised fund tend to come up."})
    _, ten = _chg(ind, "us10y", key)
    if ten:
        if ten["bps"] >= t["rate"]:
            angles.append({"title": "Long yields rose", "body": "Existing bonds lost value, but new money earns more. Clients holding excess cash may be ready to extend duration, and municipal bonds matter for high earners in high-tax states."})
        elif ten["bps"] <= -t["rate"]:
            angles.append({"title": "Long yields fell", "body": "Existing bonds gained. Clients rolling short T-bills face lower reinvestment rates, which makes the cash and duration conversation timely."})
    vix = ind.get("vix")
    if vix and vix["last"] >= 20:
        angles.append({"title": "Volatility is elevated", "body": "Expect questions about downside protection. Hedging strategies and structured notes get attention, and so does a steady plan."})
    _, hy = _chg(ind, "hy", key)
    if hy:
        if hy["bps"] >= t["hy"]:
            angles.append({"title": "Credit spreads widened", "body": "Riskier borrowers now pay more. Worth reviewing credit quality in fixed income portfolios and how much private credit exposure clients hold."})
        elif hy["bps"] <= -t["hy"]:
            angles.append({"title": "Credit spreads tightened", "body": "Credit markets are calm, which supports borrowing. Private banks lend against portfolios, real estate and other assets, so lending demand is a live topic."})
    th = themes.get(period, {})
    if th.get("Deals & IPOs", 0) >= 3:
        angles.append({"title": "Deals are in the headlines", "body": "Mergers and IPOs turn paper wealth into liquid wealth. Private bankers look for founders and executives ahead of these events (pre-IPO planning, 10b5-1 trading plans, concentrated stock strategies)."})
    if th.get("Tax & policy", 0) >= 2:
        angles.append({"title": "Tax and policy news", "body": "Rule changes drive estate planning, trust, and charitable giving conversations with wealthy families."})
    if th.get("Wealth & banking", 0) >= 3:
        angles.append({"title": "The industry itself is in the news", "body": "Check Firm watch before networking calls so you can mention what your contact's firm announced."})
    dff = ind.get("dff")
    if len(angles) < 2 and dff:
        angles.append({"title": "Cash still matters", "body": f"With fed funds at {dff['last']:.2f}%, idle cash has a real opportunity cost. Money market funds, T-bills and deposit sweeps are a common first conversation with new clients."})
    if len(angles) < 2:
        angles.append({"title": "Stay diversified", "body": "When nothing dramatic is happening, the conversation shifts to long-term planning: asset allocation, liquidity needs, and passing wealth to the next generation."})
    return angles[:5]


# --------------------------------------------------------------------------
# Saved articles, watchlist and firm watch
# --------------------------------------------------------------------------

BAD_TITLES = ("access denied", "just a moment", "attention required", "subscribe to read",
              "are you a robot", "403 forbidden", "page not found", "404")


def meta_tag(text: str, *names: str) -> str:
    for n in names:
        n_re = re.escape(n)
        for pat in (
            rf'<meta[^>]+(?:property|name|itemprop)=["\']{n_re}["\'][^>]*content=["\']([^"\']*)["\']',
            rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name|itemprop)=["\']{n_re}["\']',
        ):
            m = re.search(pat, text, re.I)
            if m and m.group(1).strip():
                return clean_text(m.group(1))
    return ""


def fetch_article_meta(m: dict) -> None:
    m["tries"] = m.get("tries", 0) + 1
    m["meta_at"] = iso(NOW)
    try:
        r = HTTP.get(m["url"], timeout=12, allow_redirects=True)
    except Exception as exc:  # noqa: BLE001
        m["error"] = str(exc)[:120]
        return
    if r.status_code >= 400:
        m["error"] = f"HTTP {r.status_code}"
        return
    text = r.text[:800_000]
    title = meta_tag(text, "og:title", "twitter:title")
    if not title:
        tm = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
        title = clean_text(tm.group(1)) if tm else ""
    if not title or title.lower().startswith(BAD_TITLES):
        m["error"] = "No readable title (paywall or bot check)"
        return
    m.pop("error", None)
    m["title"] = title[:300]
    m["site"] = meta_tag(text, "og:site_name") or domain(r.url or m["url"])
    m["description"] = meta_tag(text, "og:description", "description", "twitter:description")[:400]
    pub = meta_tag(text, "article:published_time", "og:article:published_time", "datePublished", "pubdate")
    if pub:
        m["published"] = pub[:25]


def slug_words(url: str) -> str:
    parts = [p for p in urlparse(url).path.split("/") if p]
    if not parts:
        return ""
    seg = max(parts, key=len)
    seg = re.sub(r"\.(html?|php|aspx?)$", "", seg)
    return " ".join(w for w in re.split(r"[-_]+", seg) if w.isalpha())


def keywords_for(text: str, n: int = 5) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9&'.-]+", text)
    caps = [w for w in words if w[0].isupper()]
    rest = [w for w in words if not w[0].isupper() and len(w) > 3]
    out, seen = [], set()
    for w in caps + rest:
        w = w.strip(".'")
        lw = w.lower()
        if lw in STOP or lw in seen or len(lw) < 3:
            continue
        seen.add(lw)
        out.append(w)
        if len(out) >= n:
            break
    return out


def related_coverage(article: dict, m: dict) -> list[dict]:
    base = article.get("title") or m.get("title") or slug_words(article["url"])
    kws = keywords_for(base, 4)
    if len(kws) < 2:
        return m.get("related", [])
    raw = google_news(" ".join(kws), when="7d")
    own = norm_title(base)
    out = []
    for r in raw:
        it = make_item(r, "Google News", 0.8, True)
        if not it or norm_title(it["title"]) == own:
            continue
        out.append({"title": it["title"], "link": it["link"], "source": it["source"], "published": it["published"]})
    out.sort(key=lambda x: x["published"], reverse=True)
    return unique_titles(out)[:5]


def enrich_articles(saved: dict, meta: dict) -> None:
    arts = meta.setdefault("articles", {})
    keep, budget = set(), 12
    for a in saved.get("articles", []):
        aid, url = a.get("id"), a.get("url", "")
        if not aid or not url.startswith("http"):
            continue
        keep.add(aid)
        m = arts.get(aid)
        if not m or m.get("url") != url:
            m = arts[aid] = {"url": url}
        if not m.get("title") and m.get("tries", 0) < 3 and stale(m.get("meta_at"), 12) and budget > 0:
            budget -= 1
            fetch_article_meta(m)
        if a.get("follow", True) and stale(m.get("related_at"), 6) and budget > 0:
            budget -= 1
            try:
                m["related"] = related_coverage(a, m)
                m["related_at"] = iso(NOW)
            except Exception as exc:  # noqa: BLE001
                log(f"  ! related coverage for {url}: {exc}")
    for k in list(arts):
        if k not in keep:
            del arts[k]


def yahoo_symbol(symbol: str, explicit: str | None = None) -> str:
    if explicit:
        return explicit.strip().upper()
    s = symbol.strip().upper()
    exch, _, tick = s.rpartition(":")
    if exch in ("", "NYSE", "NASDAQ", "AMEX", "NYSEARCA", "BATS", "CBOE"):
        return tick.replace(".", "-")
    return tick


def build_watchlist(saved: dict, meta: dict) -> dict:
    tickers = []
    for t in saved.get("tickers", []):
        s = (t.get("symbol") or "").strip().upper()
        if s:
            tickers.append((s, yahoo_symbol(s, t.get("yahoo")), t))
    hist = fetch_yahoo([y for _, y, _ in tickers])
    tmeta = meta.setdefault("tickers", {})
    out, budget = [], 6
    for s, y, t in tickers:
        rec = {"symbol": s, "yahoo": y}
        pts = hist.get(y)
        if pts and len(pts) > 1:
            rec.update({"last": round(pts[-1][1], 2), "asof": pts[-1][0], "chg": changes(pts, "price"),
                        "spark": [round(v, 2) for _, v in pts[-30:]]})
        m = tmeta.setdefault(s, {})
        if stale(m.get("news_at"), 2) and budget > 0:
            budget -= 1
            try:
                raw = google_news(t.get("query") or f"{y} stock", when="3d")
                news = [make_item(r, "Google News", 0.8, True) for r in raw]
                news = [{"title": n["title"], "link": n["link"], "source": n["source"], "published": n["published"]}
                        for n in news if n]
                news.sort(key=lambda x: x["published"], reverse=True)
                m["news"] = unique_titles(news)[:6]
                m["news_at"] = iso(NOW)
            except Exception as exc:  # noqa: BLE001
                log(f"  ! ticker news {s}: {exc}")
        rec["news"] = m.get("news", [])
        out.append(rec)
    for k in list(tmeta):
        if k not in {s for s, _, _ in tickers}:
            del tmeta[k]
    return {"updated": iso(NOW), "tickers": out}


def refresh_firms(state: dict) -> None:
    if not stale(state.get("firm_fetched"), 1) and state.get("firms"):
        return
    firms = []
    for f in CFG.get("firm_watch", []):
        try:
            raw = google_news(f["query"], when="14d")
        except Exception as exc:  # noqa: BLE001
            log(f"  ! firm watch {f['name']}: {exc}")
            old = next((x for x in state.get("firms", []) if x["name"] == f["name"]), None)
            if old:
                firms.append(old)
            continue
        items = [make_item(r, "Google News", 0.8, True) for r in raw]
        items = [i for i in items if i]
        items.sort(key=lambda i: i["published"], reverse=True)
        items = unique_titles(items)
        firms.append({"name": f["name"], "items": [
            {"title": i["title"], "link": i["link"], "source": i["source"], "published": i["published"]}
            for i in items[:6]]})
        time.sleep(0.3)
    state["firms"] = firms
    state["firm_fetched"] = iso(NOW)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main() -> int:
    t0 = time.time()
    state_path = DATA / "state.json"
    state = read_json(state_path, {})
    prev_items = state.pop("items", [])

    prev_updated = parse_iso(state.get("updated"))
    since = parse_iso(state.get("collecting_since"))
    if not prev_updated or not since or (NOW - prev_updated) > timedelta(hours=12):
        since = NOW
    state["collecting_since"] = iso(since)

    # 1. News
    fresh, status = fetch_all_news()
    cutoff = NOW - timedelta(hours=RETENTION_H)
    items = [i for i in dedupe(prev_items + fresh) if parse_iso(i["published"]) >= cutoff]
    items.sort(key=lambda i: i["published"], reverse=True)

    if (not state.get("backfilled")) or os.environ.get("BACKFILL") == "1":
        try:
            backfill()
        except Exception as exc:  # noqa: BLE001
            log(f"  ! backfill failed: {exc}")
        state["backfilled"] = iso(NOW)

    changed = update_daily_files(items, since)
    log(f"History: {changed} daily file(s) updated")
    top, outlets, themes = build_tops(items)

    latest = []
    for i in items[: int(CFG.get("latest_count", 150))]:
        latest.append({k: i[k] for k in ("id", "title", "link", "source", "published", "summary", "theme")}
                      | {"outlets": outlets.get(i["id"], 1)})

    # 2. Indicators, brief and talking points
    try:
        indicators, by_id = build_indicators()
    except Exception as exc:  # noqa: BLE001
        log(f"  ! indicators failed: {exc}")
        indicators, by_id = {"groups": [], "macro": []}, {}
    indicators["briefs"] = {p: write_brief(p, by_id, top["periods"][p]) for p in SPAN}
    indicators["angles"] = {p: client_angles(p, by_id, themes) for p in SPAN}

    # 3. Saved items and firm watch
    saved = read_json(DATA / "saved.json", {"articles": [], "tickers": []})
    meta = read_json(DATA / "saved_meta.json", {"articles": {}, "tickers": {}})
    try:
        enrich_articles(saved, meta)
    except Exception as exc:  # noqa: BLE001
        log(f"  ! saved articles: {exc}")
    try:
        watch = build_watchlist(saved, meta)
    except Exception as exc:  # noqa: BLE001
        log(f"  ! watchlist: {exc}")
        watch = {"updated": iso(NOW), "tickers": []}
    try:
        refresh_firms(state)
    except Exception as exc:  # noqa: BLE001
        log(f"  ! firm watch: {exc}")

    # 4. Write everything
    stamp = iso(NOW)
    write_json(DATA / "latest.json", {"updated": stamp, "status": status, "items": latest})
    write_json(DATA / "top.json", {"updated": stamp} | top)
    write_json(DATA / "indicators.json", {"updated": stamp} | indicators)
    write_json(DATA / "firm_watch.json", {"updated": state.get("firm_fetched", stamp), "firms": state.get("firms", [])})
    write_json(DATA / "watchlist.json", watch)
    write_json(DATA / "saved_meta.json", meta, compact=False)
    state["updated"] = stamp
    state_path.write_text(dump_lines(state, "items", items), encoding="utf-8")
    log(f"Done in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
