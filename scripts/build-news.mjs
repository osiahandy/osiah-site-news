// Build data/news.json from YouTube (channel + uploads playlist fallback) + Bandcamp
// No API keys needed. Runs on GitHub Actions (Node 20).
import { writeFile } from "node:fs/promises";

/** 1) FILL THIS IN: your YouTube channel IDs (must start with "UC") */
const YT_CHANNELS = ["UCxSpC-7V5u4rF6eVeHySuxw"];

/** 2) Bandcamp feed (leave as-is unless your URL differs) */
const BANDCAMP_FEED = "https://osiah.bandcamp.com/feed";

/** 3) Tweak size if you want */
const MAX_ITEMS = 24;

function uploadsPlaylistId(uc) {
  // YouTube "uploads" playlist is "UU" + channelId without leading "UC"
  return uc?.startsWith("UC") ? `UU${uc.slice(2)}` : "";
}

async function fetchText(url, source) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "osiah-news-action/1.1" },
    });
    if (!res.ok) {
      console.log(
        `[news] ${source} fetch failed: ${res.status} ${res.statusText}`
      );
      return "";
    }
    return await res.text();
  } catch (e) {
    console.log(`[news] ${source} fetch error:`, e?.message || e);
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

async function parseFeed(xml, source) {
  if (!xml) return [];
  const isAtom = /<feed[\s>]/i.test(xml);
  const blocks = [
    ...xml.matchAll(
      isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi
    ),
  ].map((m) => m[0]);

  const items = blocks
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

  console.log(`[news] parsed ${items.length} from ${source}`);
  return items;
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

async function main() {
  const pulls = [];

  // YouTube channel + uploads playlist fallback
  for (const uc of YT_CHANNELS) {
    if (!uc || !uc.startsWith("UC")) {
      console.log(`[news] skipped invalid channel id: ${uc}`);
      continue;
    }
    const channelFeed = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(
      uc
    )}`;
    const playlistId = uploadsPlaylistId(uc);
    const playlistFeed = playlistId
      ? `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(
          playlistId
        )}`
      : null;

    pulls.push(
      fetchText(channelFeed, `YouTube:channel:${uc}`).then((t) =>
        parseFeed(t, "YouTube")
      )
    );
    if (playlistFeed) {
      pulls.push(
        fetchText(playlistFeed, `YouTube:uploads:${playlistId}`).then((t) =>
          parseFeed(t, "YouTube")
        )
      );
    }
  }

  // Bandcamp
  pulls.push(
    fetchText(BANDCAMP_FEED, "Bandcamp").then((t) => parseFeed(t, "Bandcamp"))
  );

  const settled = await Promise.allSettled(pulls);
  const all = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  // No extra filters for now — YouTube/Bandcamp are trusted sources.
  const out = dedupe(all)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_ITEMS);

  await writeFile("data/news.json", JSON.stringify(out, null, 2));
  console.log(`[news] wrote data/news.json (${out.length} items)`);

  // Write a debug file (uploaded as Action artifact; not committed)
  const debug = {
    counts: {
      input: all.length,
      output: out.length,
    },
    sample: out.slice(0, 5),
    when: new Date().toISOString(),
  };
  await writeFile("news-debug.json", JSON.stringify(debug, null, 2));
  console.log("[news] wrote news-debug.json (artifact)");
}

main().catch((err) => {
  console.error("[news] build failed", err);
  process.exit(1);
});
