(() => {
  const $ = id => document.getElementById(id);
  const ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  let pool = [], lastPick = null, cacheKey = "";

  // ---------- Opening-hours parser (common OSM forms) ----------
  // Returns {open:true|false, closes?:"HH:MM"} or null when the hours can't be read.

  function parseTime(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    return +m[1] * 60 + +m[2];
  }

  function parseDays(s) {
    const set = new Set();
    for (const part of s.split(",")) {
      const p = part.trim();
      const r = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(p);
      if (!r) return null;
      let a = DAYS.indexOf(r[1]), b = r[2] ? DAYS.indexOf(r[2]) : a;
      for (let i = a; ; i = (i + 1) % 7) {
        set.add(i);
        if (i === b) break;
      }
    }
    return set;
  }

  function buildWeek(oh) {
    const week = Array.from({ length: 7 }, () => []);
    const rules = oh.replace(/\|\|/g, ";").split(";").map(r => r.trim()).filter(Boolean);
    if (!rules.length) return null;

    for (const rule of rules) {
      if (/^(PH|SH)\b/.test(rule)) continue; // public/school holiday rules: ignore
      if (rule === "24/7") {
        week.forEach((_, i) => week[i] = [[0, 1440]]);
        continue;
      }

      const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?(?:\s*,\s*PH)?\s*(.*)$/.exec(rule);
      if (!m) return null;

      const days = m[1] ? parseDays(m[1].replace(/\s/g, "")) : new Set([0, 1, 2, 3, 4, 5, 6]);
      if (!days) return null;

      const rest = m[2].trim();
      let intervals;
      if (rest === "") {
        intervals = [[0, 1440]];
      } else if (/^(off|closed)$/i.test(rest)) {
        intervals = [];
      } else {
        intervals = [];
        for (const span of rest.split(",")) {
          const t = span.trim().split("-");
          if (t.length !== 2) return null;
          const a = parseTime(t[0]), b0 = parseTime(t[1]);
          if (a == null || b0 == null) return null;
          let b = b0;
          if (b <= a) b += 1440; // runs past midnight
          intervals.push([a, b]);
        }
      }

      days.forEach(d => week[d] = intervals); // later rules override earlier ones
    }
    return week;
  }

  function fmt(min) {
    min %= 1440;
    return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
  }

  function openNow(oh, now = new Date()) {
    if (!oh) return null;

    let week;
    try {
      week = buildWeek(oh);
    } catch (e) {
      return null;
    }
    if (!week) return null;

    const d = (now.getDay() + 6) % 7, y = (d + 6) % 7, t = now.getHours() * 60 + now.getMinutes();

    for (const [a, b] of week[d]) {
      if (t >= a && t < b) return { open: true, closes: b >= 1440 && a === 0 && b === 1440 ? null : fmt(b) };
    }
    for (const [a, b] of week[y]) {
      if (b > 1440 && t + 1440 >= a && t + 1440 < b) return { open: true, closes: fmt(b) };
    }
    return { open: false };
  }

  // ---------- Data ----------

  function getLocation() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error("This browser can't share its location."));
      navigator.geolocation.getCurrentPosition(
        p => res(p.coords),
        e => {
          rej(new Error(e.code === 1
            ? "Location access was blocked. Allow it in your browser settings and try again."
            : "Couldn't get a location fix. Check location services are on and try again."));
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
      );
    });
  }

  async function fetchPlaces(lat, lon, radius, bars) {
    const kinds = bars ? "pub|bar|biergarten" : "pub";
    const q = `[out:json][timeout:25];nwr["amenity"~"^(${kinds})$"](around:${radius},${lat},${lon});out center tags;`;

    for (const url of ENDPOINTS) {
      try {
        const r = await fetch(url, {
          method: "POST",
          body: "data=" + encodeURIComponent(q),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        return j.elements;
      } catch (e) {
        // try the next endpoint
      }
    }
    throw new Error("The pub map service isn't responding right now. Try again in a minute.");
  }

  function distance(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = x => x * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function shape(el, here) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!t.name || lat == null) return null;

    const addr = [
      t["addr:housenumber"] && t["addr:street"] ? t["addr:housenumber"] + " " + t["addr:street"] : t["addr:street"],
      t["addr:city"] || t["addr:town"],
      t["addr:postcode"],
    ].filter(Boolean).join(", ");

    return {
      name: t.name,
      kind: t.amenity,
      lat, lon, addr,
      hours: t.opening_hours || "",
      dist: distance(here.latitude, here.longitude, lat, lon),
    };
  }

  // ---------- UI ----------

  function setStatus(msg, err) {
    $("status").textContent = msg;
    $("status").classList.toggle("err", !!err);
  }

  function busy(on) {
    $("go").disabled = on;
    $("go").classList.toggle("spinning", on);
    $("again").disabled = on;
  }

  function show(p) {
    lastPick = p;
    $("r-name").textContent = p.name;

    const pill = $("r-pill");
    pill.className = "pill " + (p.state ? "open" : "unknown");
    pill.textContent = p.state ? (p.state.closes ? "Open till " + p.state.closes : "Open now") : "Hours unknown";

    const m = Math.round(p.dist / 10) * 10;
    $("r-dist").textContent = (m < 1000 ? m + " m" : (p.dist / 1000).toFixed(1) + " km")
      + " · ~" + Math.max(1, Math.round(p.dist / 80)) + " min walk";

    $("r-type").textContent = { pub: "Pub", bar: "Bar", biergarten: "Beer garden" }[p.kind] || "";
    $("r-addr").textContent = p.addr;
    $("r-addr").hidden = !p.addr;
    $("r-hours").textContent = p.hours;
    $("r-hours").hidden = !p.hours;
    $("r-dir").href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=walking`;
    $("result").hidden = false;
  }

  function pick() {
    if (!pool.length) return;
    const choices = pool.length > 1 && lastPick ? pool.filter(p => p !== lastPick) : pool;
    show(choices[Math.floor(Math.random() * choices.length)]);
  }

  async function run(forceRefresh) {
    const radius = +document.querySelector('input[name="r"]:checked').value;
    const bars = $("bars").checked, unk = $("unknown").checked;

    busy(true);
    setStatus("Finding you…");

    try {
      const here = await getLocation();
      const key = [radius, bars, here.latitude.toFixed(3), here.longitude.toFixed(3)].join("|");

      if (forceRefresh || key !== cacheKey) {
        setStatus("Looking for pubs nearby…");
        const els = await fetchPlaces(here.latitude, here.longitude, radius, bars);
        window.__all = els.map(e => shape(e, here)).filter(Boolean);
        cacheKey = key;
      }

      const all = window.__all.map(p => ({ ...p, state: openNow(p.hours) }));
      const open = all.filter(p => p.state && p.state.open);
      const unknown = all.filter(p => !p.state);
      pool = unk ? open.concat(unknown) : open;

      // re-point lastPick at the new object if same place
      if (lastPick) lastPick = pool.find(p => p.name === lastPick.name && p.lat === lastPick.lat) || lastPick;

      const word = bars ? "places" : "pubs";

      if (!all.length) {
        $("result").hidden = true;
        setStatus(`No ${word} found within ${radius >= 1000 ? radius / 1000 + " km" : radius + " m"}. Try a bigger radius.`, true);
        return;
      }

      if (!pool.length) {
        $("result").hidden = true;
        setStatus(
          `Found ${all.length} ${word}, but none are listed as open now.`
          + (unk ? "" : " Tick “Include places with no listed opening hours” to widen the search."),
          true
        );
        return;
      }

      setStatus(`${open.length} open` + (unk ? ` + ${unknown.length} with unknown hours` : "") + ` · ${all.length} ${word} in range`);
      pick();
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      busy(false);
    }
  }

  $("go").addEventListener("click", () => { lastPick = null; run(false); });
  $("again").addEventListener("click", () => { pick(); });
  ["bars", "unknown"].forEach(id => $(id).addEventListener("change", () => { if (cacheKey) run(id === "bars"); }));
  document.querySelectorAll('input[name="r"]').forEach(r => r.addEventListener("change", () => { cacheKey = ""; }));

  window.__openNow = openNow; // handy for testing
})();
