#!/usr/bin/env python3
"""Build a privacy-preserving OPC Studio Stargazer map snapshot.

Only aggregate country counts are written. GitHub logins, names, companies,
bios, and raw location strings are intentionally excluded from the output.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import os
import pathlib
import re
import tempfile
import urllib.error
import urllib.request

REPO = os.environ.get("OPC_COMMUNITY_REPO", "WUBING2023/OPCStudio")
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "website" / "community-data.js"
TOKEN = (os.environ.get("OPC_COMMUNITY_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN") or "").strip()

COUNTRIES = [
    ("China", "中国", 104.19, 35.86, ["china", "中国", "beijing", "shanghai", "shenzhen", "guangzhou", "hangzhou", "nanjing", "wuhan", "chengdu", "hong kong", "香港", "taiwan", "台北"]),
    ("United States", "美国", -98.58, 39.83, ["united states", "usa", "u.s.a", "california", "new york", "seattle", "boston", "chicago", "san francisco", "los angeles", "texas"]),
    ("United Kingdom", "英国", -3.44, 55.38, ["united kingdom", "uk", "england", "scotland", "wales", "london", "manchester", "cambridge", "oxford"]),
    ("Canada", "加拿大", -106.35, 56.13, ["canada", "toronto", "vancouver", "montreal", "ottawa"]),
    ("Germany", "德国", 10.45, 51.17, ["germany", "deutschland", "berlin", "munich", "münchen", "hamburg"]),
    ("France", "法国", 2.21, 46.23, ["france", "paris", "lyon"]),
    ("Japan", "日本", 138.25, 36.20, ["japan", "日本", "tokyo", "东京", "osaka"]),
    ("South Korea", "韩国", 127.77, 35.91, ["south korea", "korea", "seoul", "首尔"]),
    ("Singapore", "新加坡", 103.82, 1.35, ["singapore", "新加坡"]),
    ("Australia", "澳大利亚", 133.78, -25.27, ["australia", "sydney", "melbourne", "brisbane", "perth"]),
    ("India", "印度", 78.96, 20.59, ["india", "new delhi", "delhi", "bangalore", "bengaluru", "mumbai"]),
    ("Brazil", "巴西", -51.93, -14.24, ["brazil", "brasil", "sao paulo", "são paulo"]),
    ("Russia", "俄罗斯", 105.32, 61.52, ["russia", "moscow", "st. petersburg"]),
    ("Netherlands", "荷兰", 5.29, 52.13, ["netherlands", "amsterdam", "rotterdam"]),
    ("Spain", "西班牙", -3.75, 40.46, ["spain", "madrid", "barcelona"]),
    ("Italy", "意大利", 12.57, 41.87, ["italy", "rome", "milan"]),
    ("Switzerland", "瑞士", 8.23, 46.82, ["switzerland", "zurich", "zürich", "geneva"]),
    ("Sweden", "瑞典", 18.64, 60.13, ["sweden", "stockholm"]),
    ("Poland", "波兰", 19.15, 51.92, ["poland", "warsaw", "krakow"]),
    ("Indonesia", "印度尼西亚", 113.92, -0.79, ["indonesia", "jakarta"]),
    ("Malaysia", "马来西亚", 101.98, 4.21, ["malaysia", "kuala lumpur"]),
    ("Vietnam", "越南", 108.28, 14.06, ["vietnam", "viet nam", "hanoi", "ho chi minh"]),
    ("Thailand", "泰国", 100.99, 15.87, ["thailand", "bangkok"]),
    ("New Zealand", "新西兰", 174.89, -40.90, ["new zealand", "auckland", "wellington"]),
]


def api(path: str):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "opcstudio-community-map",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    request = urllib.request.Request(f"https://api.github.com{path}", headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def resolve_country(raw_location: str | None):
    if not raw_location:
        return None
    normalized = re.sub(r"\s+", " ", raw_location.casefold()).strip()
    for name, label, lng, lat, aliases in COUNTRIES:
        if any(alias.casefold() in normalized for alias in aliases):
            return {"name": name, "label": label, "lng": lng, "lat": lat}
    return None


def atomic_write(text: str) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=".community-", suffix=".js", dir=OUTPUT.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(temp_name, OUTPUT)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def main() -> None:
    metadata = api(f"/repos/{REPO}")
    stars = int(metadata.get("stargazers_count") or 0)
    if stars > 40 and not TOKEN:
        raise RuntimeError("A GitHub token is required once the repository has more than 40 stars")

    logins: list[str] = []
    page = 1
    while len(logins) < stars:
        batch = api(f"/repos/{REPO}/stargazers?per_page=100&page={page}")
        if not isinstance(batch, list) or not batch:
            break
        logins.extend(str(user["login"]) for user in batch if user.get("login"))
        if len(batch) < 100:
            break
        page += 1

    def fetch_location(login: str):
        try:
            user = api(f"/users/{login}")
            return resolve_country(user.get("location"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
            return None

    resolved = []
    if logins:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            resolved = [item for item in executor.map(fetch_location, logins) if item]

    counts: dict[str, int] = {}
    country_meta = {}
    for item in resolved:
        counts[item["name"]] = counts.get(item["name"], 0) + 1
        country_meta[item["name"]] = item

    countries = [
        {"name": name, "label": country_meta[name]["label"], "count": count}
        for name, count in sorted(counts.items(), key=lambda entry: (-entry[1], entry[0]))
    ]
    points = [
        {
            "name": country_meta[name]["label"],
            "country": name,
            "lng": country_meta[name]["lng"],
            "lat": country_meta[name]["lat"],
            "count": count,
        }
        for name, count in sorted(counts.items(), key=lambda entry: (-entry[1], entry[0]))
    ]
    snapshot = {
        "repo": REPO,
        "generated": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "stars": stars,
        "located": len(resolved),
        "countries": countries,
        "points": points,
    }
    atomic_write("window.OPC_COMMUNITY = " + json.dumps(snapshot, ensure_ascii=False, indent=2) + ";\n")
    print(f"community snapshot: stars={stars}, located={len(resolved)}, countries={len(countries)}")


if __name__ == "__main__":
    main()