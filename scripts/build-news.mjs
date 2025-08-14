// scripts/build-news.mjs
// Build a merged News feed for OSIAH.
// Sources: Google News, YouTube channel feed, Bandcamp feed.
// Output: data/news.json (array of {title,url,image,source,date})

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ======== CONFIG ========
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID || "UCxSpC-7V5u4rF6eVeHySuxw";
const BANDCAMP_SUBDOMAIN = process.env.BC_SUB || "osiahuk"; // e.g., "osiahuk"
const OUTPUT = "data/news.json";
const DEBUG = "news-debug.json"; // optional – artifact in CI

// Query is tuned to bias music/band coverage.
const GOOGLE_NEWS_RSS =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent("osiah (band OR deathcore OR metal)") +
  "&hl=en-GB&gl=GB&ceid=GB:en";

// ======== FILTER TUNING ========

// context terms that indicate music/band relevance
const CONTEXT_TERMS = [
  "deathcore",
  "metal",
  "band",
  "album",
  "single",
  "track",
  "song",
  "video",
  "tour",
  "gig",
  "live",
  "stream",
  "review",
  "interview",
  "unique leader",
  "slam worldwide",
  "merch",
  "vinyl",
  "cd",
  "ep",
  "lp",
];

// common false-positive topics we don't want
const BLOCK_TERMS = [
  "josiah",
  "duggar",
  "lauren duggar",
  "pastor",
  "church",
  "football",
  "basketball",
  "soccer",
  "rugby",
  "ufc",
  "mma",
  "nascar",
  "arrest",
  "murder",
  "shooting",
  "lawsuit",
  "politics",
  "government",
  "ghana",
  "nigeria",
  "uganda",
  "kenya",
  "pregnant",
  "baby",
];

// Let these hosts through even if the headline is short.
const TRUSTED_HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "bandcamp.com",
  "uniqueleader.com",
  "store.uniqueleader.com",
  "rowstore.uniqueleader.com",
  "metalinjection.net",
  "metalsucks.net",
  "distortedsoundmag.com",
  "lambgoat.com",
  "theprp.com",
  "kerrang.com",
  "nme.com",
  "angrymetalguy.com",
  "deadpress.co.uk",
  "newtranscendence.com",
  "noecho.net",
  "idioteq.com",
  "rocksound.tv",
]);

// ======== UTIL ========

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return await res.text();
}

function toISO(d) {
  try {
    return new Date(d).toISOString();
  } catch (_) {
    return new Date().toISOString();
  }
}

function extractRealUrl(u) {
  try {
    const url = new URL(u);
    if (url.hostname === "news.google.com") {
      const real = url.searchParams.get("url");
      if (real) return decodeURIComponent(real);
    }
  } catch (_) {}
  return u;
}

function niceHost(u) {
  try {
    const host = new URL(u).hostname.replace(/^www\./, "");
    if (host === "youtu.be" || host.endsWith("youtube.com")) return "YouTube";
    if (host.endsWith("bandcamp.com")) return "Bandcamp";
    return host;
  } catch (_) {
    return "News";
  }
}

function cleanTitleAndPublisher(rawTitle) {
  if (!rawTitle) return { title: "", publisher: null };
  // Many Google items use "Title - Publisher"
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx > 12 && idx > rawTitle.length - 60) {
    return {
      title: rawTitle.slice(0, idx).trim(),
      publisher: rawTitle.slice(idx + 3).trim(),
    };
  }
  return { title: rawTitle.trim(), publisher: null };
}

function isRelevant({ title, summary = "", url }) {
  const t = (title + " " + summary).toLowerCase();

  // must mention OSIAH exactly (avoid Josiah)
  if (!/\bosiah\b/i.test(t)) return false;
  if (/\bjosiah\b/i.test(t)) return false;

  if (BLOCK_TERMS.some((w) => t.includes(w))) return false;

  if (CONTEXT_TERMS.some((w) => t.includes(w))) return true;

  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (TRUSTED_HOSTS.has(host)) return true;
  } catch (_) {}

  return false;
}

// ======== TINY XML PARSER (no deps) ========

const ITEM_BLOCK = /<item[\s\S]*?<\/item>/gi;
const ENTRY_BLOCK = /<entry[\s\S]*?<\/entry>/gi;

function pickTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

function pickAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}="([^"]+)"[^>]*\\/?>`, "i");
  const m = block.match(re);
  return m ? m[1] : null;
}

function stripTags(s) {
  return s ? s.replace(/<[^>]+>/g, "").trim() : s;
}

// ======== PARSERS ========

async function getYouTube(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xml = await fetchText(url);
  const blocks = xml.match(ENTRY_BLOCK) || [];
  const items = blocks.map((b) => {
    const title = stripTags(pickTag(b, "title")) || "";
    const link = pickAttr(b, "link", "href") || pickTag(b, "link") || "";
    const date =
      pickTag(b, "published") ||
      pickTag(b, "updated") ||
      new Date().toISOString();
    const thumb = pickAttr(b, "media:thumbnail", "url") || null;
    return {
      title,
      url: link,
      image: thumb,
      source: "YouTube",
      date: toISO(date),
    };
  });
  return items;
}

async function getBandcamp(sub) {
  const url = `https://${sub}.bandcamp.com/feed`;
  const xml = await fetchText(url);
  const blocks = xml.match(ENTRY_BLOCK) || xml.match(ITEM_BLOCK) || [];
  const items = blocks.map((b) => {
    const title = stripTags(pickTag(b, "title")) || "";
    // Atom uses <link href="..."/>, RSS uses <link>...</link>
    const link = pickAttr(b, "link", "href") || pickTag(b, "link") || "";
    const date =
      pickTag(b, "updated") ||
      pickTag(b, "pubDate") ||
      new Date().toISOString();
    // Try common image places (enclosure, media:thumbnail, content)
    const enclosure = pickAttr(b, "enclosure", "url");
    const thumb = pickAttr(b, "media:thumbnail", "url");
    const content = pickTag(b, "content") || pickTag(b, "description") || "";
    const imgFromContent = (content.match(/<img[^>]+src="([^"]+)"/i) || [])[1];
    const image = enclosure || thumb || imgFromContent || null;

    return {
      title,
      url: link,
      image,
      source: "Bandcamp",
      date: toISO(date),
    };
  });
  return items;
}

async function getGoogleNews() {
  const xml = await fetchText(GOOGLE_NEWS_RSS);
  const blocks = xml.match(ITEM_BLOCK) || [];
  const items = [];

  for (const b of blocks) {
    const rawTitle = stripTags(pickTag(b, "title")) || "";
    const { title, publisher } = cleanTitleAndPublisher(rawTitle);

    const link = extractRealUrl(stripTags(pickTag(b, "link")) || "");
    const date = pickTag(b, "pubDate") || new Date().toISOString();
    const desc = stripTags(pickTag(b, "description")) || "";

    const card = {
      title,
      url: link,
      image: null, // Google News RSS rarely includes a reliable image
      source: publisher || niceHost(link),
      date: toISO(date),
      _summary: desc,
    };

    if (isRelevant({ title, summary: desc, url: link })) {
      items.push(card);
    }
  }

  return items;
}

// ======== MERGE/WRITE ========

function dedupeByUrl(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const key = it.url || `${it.source}:${it.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function writeJson(path, data) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

async function main() {
  try {
    const [yt, bc, gn] = await Promise.allSettled([
      getYouTube(YT_CHANNEL_ID),
      getBandcamp(BANDCAMP_SUBDOMAIN),
      getGoogleNews(),
    ]);

    const youTubeItems = yt.status === "fulfilled" ? yt.value : [];
    const bandcampItems = bc.status === "fulfilled" ? bc.value : [];
    const googleNewsItems = gn.status === "fulfilled" ? gn.value : [];

    console.log(`[news] parsed ${youTubeItems.length} from YouTube`);
    console.log(`[news] parsed ${bandcampItems.length} from Bandcamp`);
    console.log(`[news] parsed ${googleNewsItems.length} from Google News`);

    let merged = [...youTubeItems, ...bandcampItems, ...googleNewsItems];

    merged = dedupeByUrl(merged)
      .sort((a, b) => (a.date > b.date ? -1 : 1))
      .slice(0, 40); // keep it lean

    await writeJson(OUTPUT, merged);
    try {
      await writeJson(DEBUG, {
        youTubeItems,
        bandcampItems,
        googleNewsItems,
        merged,
      });
    } catch (_) {}

    console.log(`[news] wrote ${OUTPUT} (${merged.length} items)`);
  } catch (err) {
    console.error("[news] build failed:", err);
    // still write an empty array to avoid breaking the site
    try {
      await writeJson(OUTPUT, []);
    } catch (_) {}
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${fileURLToPath(import.meta.url)}`) {
  main();
}
