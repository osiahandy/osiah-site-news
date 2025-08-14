// scripts/build-news.mjs
// Build news from YouTube + curated RSS (incl. Google News) + Bandcamp (HTML).
// Node 18+ required.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = "data/news.json";

/* ---------- CONFIG ---------- */
const YOUTUBE_CHANNEL_ID = "UCxSpC-7V5u4rF6eVeHySuxw"; // OSIAH

// Curated outlets (RSS). We’ll filter to posts that actually mention “Osiah”.
const CURATED_FEEDS = [
  "http://feeds.feedburner.com/metalinjection",
  "https://feeds.feedburner.com/LambgoatcomNewsHeadlines",
  "https://www.metalsucks.net/feed/",
  "https://distortedsoundmag.com/feed/",
  "https://www.kerrang.com/feed.rss",
  "https://www.blabbermouth.net/feed/",
  "https://www.nocleansinging.com/feed/",
  "https://www.ghostcultmag.com/feed/",
  "https://bravewords.com/feed",
];

// Google News RSS (broad, then we filter to “Osiah” as a word).
const GOOGLE_NEWS = [
  "https://news.google.com/rss/search?q=osiah%20band%20OR%20%22Osiah%22&hl=en-GB&gl=GB&ceid=GB:en",
];

// Your Bandcamp /music page (no RSS; we’ll parse HTML).
const BANDCAMP_URL = "https://osiahuk.bandcamp.com/music";
// How many Bandcamp items to deep-fetch for dates:
const BANDCAMP_DEEP_FETCH = 6;

/* ---------- HELPERS ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}
function decode(s = "") {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function toIso(d) {
  try {
    return new Date(d).toISOString();
  } catch {
    return null;
  }
}
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
// Match “Osiah” as a word (not “Josiah” etc.)
function mentionsOsiah(text = "") {
  return /(^|[^A-Za-z])osiah([^A-Za-z]|$)/i.test(text);
}

// Minimal RSS item parser (RSS 2.0)
function parseRssItems(xml) {
  const items = [];
  const parts = xml.split(/<item[\s>]/i).slice(1);
  for (const chunk of parts) {
    const block = "<item " + chunk;
    const title = decode(
      (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").trim()
    );
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "")
      .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
      .trim();
    const pub = (
      block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || ""
    ).trim();
    const desc = decode(
      (block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || "").trim()
    );
    items.push({ title, link, pubDate: pub, description: desc });
  }
  return items;
}

/* ---------- SOURCES ---------- */
async function fromYouTubeChannel(channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xml = await fetchText(url);
  const entries = xml
    .split(/<entry>/i)
    .slice(1)
    .map((e) => {
      const title = decode(
        (e.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").trim()
      );
      const link = (e.match(/<link[^>]+href="([^"]+)"/i)?.[1] || "").trim();
      const when = (
        e.match(/<published>([\s\S]*?)<\/published>/i)?.[1] || ""
      ).trim();
      return { title, link, date: toIso(when), source: "YouTube" };
    });
  return entries.filter((x) => x.title && x.link);
}

async function fromRssFeeds(feeds) {
  const out = [];
  for (const feed of feeds) {
    try {
      const xml = await fetchText(feed);
      const items = parseRssItems(xml);
      for (const it of items) {
        const hay = `${it.title} ${it.description}`;
        if (!mentionsOsiah(hay)) continue;
        out.push({
          title: it.title,
          link: it.link,
          date: toIso(it.pubDate) || new Date().toISOString(),
          source: hostOf(feed),
        });
      }
      await sleep(250);
    } catch (e) {
      console.warn("[news] feed failed:", feed, e.message);
    }
  }
  return out;
}

async function fromBandcampPage() {
  try {
    const html = await fetchText(BANDCAMP_URL);
    const base = new URL(BANDCAMP_URL).origin;
    // Find album/track tiles
    const links = [];
    const re = /<a\s+href="(\/(?:album|track)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(html))) {
      const href = base + m[1];
      const title = decode(m[2].replace(/<[^>]+>/g, "").trim());
      const key = `${title}::${href}`;
      if (!title || seen.has(key)) continue;
      seen.add(key);
      links.push({ title, link: href });
    }

    // Deep-fetch the first few to get dates
    const take = links.slice(0, BANDCAMP_DEEP_FETCH);
    const dated = await Promise.all(
      take.map(async (it, i) => {
        try {
          await sleep(i * 200); // gentle stagger
          const page = await fetchText(it.link);
          // Look for itemprop="datePublished" content="YYYY-MM-DD"
          const mm = page.match(
            /itemprop="datePublished"\s+content="([\d-]{10})"/i
          );
          const iso = mm ? toIso(mm[1]) : null;
          return { ...it, date: iso, source: "Bandcamp" };
        } catch {
          return { ...it, date: null, source: "Bandcamp" };
        }
      })
    );

    // Any remaining (without dates) get null date; they’ll sort after dated content
    const remain = links
      .slice(BANDCAMP_DEEP_FETCH)
      .map((it) => ({ ...it, date: null, source: "Bandcamp" }));
    return [...dated, ...remain];
  } catch (e) {
    console.warn("[news] Bandcamp fetch failed:", e.message);
    return [];
  }
}

/* ---------- MAIN ---------- */
(async () => {
  const buckets = [];

  try {
    const yt = await fromYouTubeChannel(YOUTUBE_CHANNEL_ID);
    console.log("[news] YouTube items:", yt.length);
    buckets.push(...yt);
  } catch (e) {
    console.warn("[news] YouTube failed:", e.message);
  }

  try {
    const press = await fromRssFeeds(CURATED_FEEDS);
    console.log("[news] curated press items:", press.length);
    buckets.push(...press);
  } catch (e) {
    console.warn("[news] curated feeds failed:", e.message);
  }

  try {
    const gn = await fromRssFeeds(GOOGLE_NEWS);
    console.log("[news] Google News items:", gn.length);
    buckets.push(...gn);
  } catch (e) {
    console.warn("[news] Google News failed:", e.message);
  }

  try {
    const bc = await fromBandcampPage();
    console.log("[news] Bandcamp items:", bc.length);
    buckets.push(...bc);
  } catch (e) {
    console.warn("[news] Bandcamp failed:", e.message);
  }

  // De-dupe by link
  const byLink = new Map();
  for (const x of buckets) if (x.link) byLink.set(x.link, x);

  // Sort by date desc (unknown dates last)
  const list = Array.from(byLink.values()).sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return db - da;
  });

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(list, null, 2), "utf8");
  console.log(`[news] wrote ${OUT} (${list.length} items)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
