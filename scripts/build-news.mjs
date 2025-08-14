// Build data/news.json from YouTube (channel feed) + Bandcamp (RSS)
// No API keys required. Runs in GitHub Actions (Node 20 has global fetch).
// TODO: put your YouTube UC channel ID(s) below.

import { writeFile } from "node:fs/promises";

const CONFIG = {
  youtubeChannels: [
    // e.g. "UCxxxxxxxxxxxxxxxxxxxx"
  ],
  bandcampFeed: "https://osiah.bandcamp.com/feed",
  maxItems: 24,

  // Filters to avoid unrelated results if you add more sources later
  blocklist: [
    /\bJOSIAH\b/i,
    /\bpastor\b/i,
    /\bsermon\b/i,
    /\bfootball\b/i,
    /\bbasketball\b/i,
    /\barrest(ed)?\b/i,
  ],
  // Require OSIAH mention in title/desc (Bandcamp/YouTube usually include)
  mustInclude: [/\bOSIAH\b/i],
};

async function fetchText(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "osiah-news-action/1.0" },
    });
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  }
}

function decode(html = "") {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function stripTags(s = "") {
  return s.replace(/<[^>]+>/g, "").trim();
}
function pickText(block, tags) {
  for (const t of tags) {
    const m = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
    if (m) return decode(m[1]).trim();
  }
  return "";
}
function attr(s, re, name) {
  const m = s.match(re);
  if (!m) return "";
  const a = m[0].match(new RegExp(`${name}="([^"]+)"`, "i"));
  return a ? decode(a[1]) : "";
}
function normalizeYouTube(link = "") {
  try {
    const u = new URL(link);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\//, "");
      return `https://www.youtube.com/watch?v=${id}`;
    }
  } catch {}
  return link;
}
function normalize(item) {
  return {
    id: item.link,
    title: item.title,
    link: item.link,
    date: new Date(item.date || Date.now()).toISOString(),
    excerpt: item.excerpt || "",
    image: item.image || "",
    source: item.source || "News",
  };
}
function passesFilters(it) {
  const hay = `${it.title} ${it.excerpt}`;
  if (CONFIG.blocklist.some((rx) => rx.test(hay))) return false;

  // Don’t force mustInclude if we *know* the source is your channel/Bandcamp
  const isTrusted = /bandcamp/i.test(it.source) || /youtube/i.test(it.source);
  if (!isTrusted && !CONFIG.mustInclude.some((rx) => rx.test(hay)))
    return false;

  return true;
}
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.link || it.title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function parseFeed(xml, source) {
  if (!xml) return [];
  const isAtom = /<feed[\s>]/i.test(xml);
  const blocks = [
    ...xml.matchAll(
      isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi
    ),
  ].map((m) => m[0]);

  return blocks
    .map((b) => {
      const title = pickText(b, ["title"]);
      const link = isAtom
        ? attr(b, /<link[^>]+rel="alternate"[^>]*>/i, "href")
        : pickText(b, ["link"]);
      const date =
        pickText(b, ["updated", "published", "pubDate"]) ||
        new Date().toISOString();
      const desc = stripTags(pickText(b, ["summary", "description"])) || "";
      const image =
        attr(b, /<media:thumbnail[^>]+>/i, "url") ||
        attr(b, /<media:content[^>]+>/i, "url") ||
        attr(b, /<enclosure[^>]+type="image\/[^"]+"[^>]*>/i, "url") ||
        "";

      return normalize({
        title,
        link: normalizeYouTube(link),
        date,
        excerpt: desc,
        image,
        source,
      });
    })
    .filter((x) => x.title && x.link);
}

async function main() {
  const pulls = [];

  for (const ch of CONFIG.youtubeChannels) {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(
      ch
    )}`;
    pulls.push(fetchText(url).then((t) => parseFeed(t, "YouTube")));
  }
  pulls.push(
    fetchText(CONFIG.bandcampFeed).then((t) => parseFeed(t, "Bandcamp"))
  );

  const all = (await Promise.allSettled(pulls)).flatMap((r) =>
    r.status === "fulfilled" ? r.value : []
  );

  const out = dedupe(all)
    .filter(passesFilters)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, CONFIG.maxItems);

  await writeFile("data/news.json", JSON.stringify(out, null, 2));
  console.log(`Wrote data/news.json (${out.length} items)`);
}

main().catch((err) => {
  console.error("news build failed", err);
  process.exit(1);
});
