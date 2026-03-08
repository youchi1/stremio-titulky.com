const express = require("express");
const TitulkyClient = require("./lib/titulkyClient");
const axios = require("axios");
const iconv = require("iconv-lite");
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { makeLogger, isDev } = require("./lib/logger");

const log = makeLogger("App");
const logR2 = makeLogger("R2");
const logAddon = makeLogger("Addon");
const logPing = makeLogger("Ping");
const logCustom = makeLogger("Custom");
const logAdmin = makeLogger("Admin");
const logVerify = makeLogger("Verify");
const logReq = makeLogger("Req");
const logRD = makeLogger("RD");

const app = express();
const PORT = process.env.PORT || 3100;

// ── R2 Cloud Cache ───────────────────────────────────────────────
const r2Enabled = !!(
  process.env.R2_ENDPOINT &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET
);

let s3 = null;
const r2CachedIds = new Set(); // in-memory index of cached subtitle IDs

if (r2Enabled) {
  s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  logR2.info(`Cache enabled (bucket: ${process.env.R2_BUCKET})`);

  // Load cache index on startup (async, non-blocking)
  (async () => {
    try {
      let continuationToken = undefined;
      let total = 0;
      do {
        const res = await s3.send(
          new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET,
            Prefix: "subs/",
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of res.Contents || []) {
          const id = obj.Key.replace("subs/", "").replace(".srt", "");
          if (id) r2CachedIds.add(id);
          total++;
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      logR2.info(`Cache index loaded: ${total} subtitle(s)`);
    } catch (e) {
      logR2.error(`Cache index load error: ${e.message}`);
    }
  })();
} else {
  logR2.info("Cache disabled (missing env variables)");
}

async function r2Get(subId) {
  if (!s3) return null;
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: `subs/${subId}.srt`,
      }),
    );
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    const content = Buffer.concat(chunks).toString("utf-8");
    const filename = res.Metadata?.filename || `${subId}.srt`;
    logR2.debug(`Cache HIT: ${subId}`);
    return { content, filename };
  } catch (e) {
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
      return null; // not cached
    }
    logR2.error(`Get error: ${e.message}`);
    return null;
  }
}

async function r2Put(subId, content, filename) {
  if (!s3) return;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: `subs/${subId}.srt`,
        Body: content,
        ContentType: "text/plain; charset=utf-8",
        Metadata: { filename },
      }),
    );
    r2CachedIds.add(String(subId));
    logR2.debug(`Cached: ${subId}`);
  } catch (e) {
    logR2.error(`Put error: ${e.message}`);
  }
}

// ── R2 History helpers ───────────────────────────────────────────

async function r2GetHistory(username) {
  if (!s3) return [];
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: `history/${username}.json`,
      }),
    );
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return [];
  }
}

async function r2SaveHistory(username, history) {
  if (!s3) return;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: `history/${username}.json`,
        Body: JSON.stringify(history),
        ContentType: "application/json",
      }),
    );
  } catch (e) {
    logR2.error(`History save error: ${e.message}`);
  }
}

async function r2AddToHistory(username, item) {
  if (!s3) return;
  let history = await r2GetHistory(username);
  // Remove duplicate (by full id including episode)
  history = history.filter((h) => h.id !== item.id);
  // Add to front
  history.unshift(item);
  // Keep only 10
  history = history.slice(0, 10);
  await r2SaveHistory(username, history);
}

// ── R2 Custom subtitle helpers ───────────────────────────────────

async function r2GetCustomSubs(imdbId) {
  if (!s3) return [];
  try {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
        Prefix: `custom/${imdbId}/`,
      }),
    );
    if (!res.Contents || res.Contents.length === 0) return [];

    const subs = [];
    for (const obj of res.Contents) {
      if (!/\.(srt|ssa|ass|sub|vtt)$/i.test(obj.Key)) continue;
      try {
        const getRes = await s3.send(
          new GetObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: obj.Key,
          }),
        );
        const chunks = [];
        for await (const chunk of getRes.Body) chunks.push(chunk);
        const filename = obj.Key.split("/").pop();
        const label = getRes.Metadata?.label || filename.replace(/\.(srt|ssa|ass|sub|vtt)$/i, "");
        const lang = getRes.Metadata?.lang || "cze";
        const uploader = getRes.Metadata?.uploader || "unknown";
        subs.push({ key: obj.Key, filename, label, lang, uploader });
      } catch {
        /* skip */
      }
    }
    logR2.debug(`Found ${subs.length} custom sub(s) for ${imdbId}`);
    return subs;
  } catch {
    return [];
  }
}

async function r2PutCustomSub(imdbId, filename, content, label, lang, uploader) {
  if (!s3) return false;
  try {
    const key = `custom/${imdbId}/${filename}`;
    const ext = filename.split(".").pop().toLowerCase();
    const mimeTypes = { srt: "text/plain", ssa: "text/plain", ass: "text/plain", sub: "text/plain", vtt: "text/vtt" };
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: content,
        ContentType: (mimeTypes[ext] || "text/plain") + "; charset=utf-8",
        Metadata: { label, lang, uploader: uploader || "unknown" },
      }),
    );
    logR2.info(`Custom sub saved: ${key} (by ${uploader})`);
    return true;
  } catch (e) {
    logR2.error(`Custom sub error: ${e.message}`);
    return false;
  }
}

// ── Client cache (keyed by username) ──────────────────────────────
const clientCache = new Map();
const subtitleCache = new Map(); // cache downloaded subs for 1h
const SUBTITLE_CACHE_TTL = 60 * 60 * 1000;

// ── Release tag matching ──────────────────────────────────────────

const RELEASE_TAGS = [
  "bluray",
  "bdrip",
  "brrip",
  "bd-rip",
  "blu-ray",
  "bdremux",
  "remux",
  "web-dl",
  "webdl",
  "webrip",
  "web-rip",
  "web",
  "hdtv",
  "hdrip",
  "dvdrip",
  "dvd",
  "dvdscr",
  "hdcam",
  "cam",
  "ts",
  "telesync",
  "tc",
  "dcp",
  "2160p",
  "1080p",
  "720p",
  "480p",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "hdr",
  "hdr10",
  "dolby-vision",
  "sdr",
  "atmos",
  "dts",
  "dts-hd",
  "truehd",
  "aac",
  "ac3",
  "dd5",
  "flac",
  "imax",
  "repack",
  "proper",
  "dual",
];

function extractReleaseTags(filename) {
  if (!filename) return [];
  const lower = filename.toLowerCase().replace(/[._]/g, " ").replace(/[-]/g, " ");
  const found = [];
  for (const tag of RELEASE_TAGS) {
    const tagLower = tag.replace(/[-]/g, " ");
    if (lower.includes(tagLower)) found.push(tag);
  }
  return [...new Set(found)];
}

function scoreSubtitle(subVersion, playingTags) {
  if (!subVersion || playingTags.length === 0) return 0;
  const subTags = extractReleaseTags(subVersion);
  let score = 0;
  // Resolution match (most important)
  const resolutions = ["2160p", "1080p", "720p", "480p"];
  for (const res of resolutions) {
    if (playingTags.includes(res) && subTags.includes(res)) score += 20;
  }
  // Source type match
  const sources = ["bluray", "bdremux", "remux", "web-dl", "webdl", "webrip", "hdtv", "dvdrip", "dcp"];
  for (const src of sources) {
    if (playingTags.includes(src) && subTags.includes(src)) score += 15;
  }
  // Codec match
  const codecs = ["x264", "x265", "h264", "h265", "hevc", "avc"];
  for (const codec of codecs) {
    if (playingTags.includes(codec) && subTags.includes(codec)) score += 5;
  }
  return score;
}

// ── Config helpers ────────────────────────────────────────────────

function encodeConfig(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function decodeConfig(str) {
  try {
    return JSON.parse(Buffer.from(str, "base64url").toString("utf-8"));
  } catch {
    try {
      return JSON.parse(Buffer.from(str, "base64").toString("utf-8"));
    } catch {
      return null;
    }
  }
}

async function getClient(config) {
  const key = config.username;
  if (clientCache.has(key)) {
    const client = clientCache.get(key);
    if (client.loggedIn) return client;
  }
  const client = new TitulkyClient(config.username, config.password);
  const ok = await client.login();
  if (ok) {
    clientCache.set(key, client);
    return client;
  }
  return null;
}

// ── Cinemeta – resolve IMDB ID → title ────────────────────────────

async function getMeta(type, id) {
  const imdbId = id.split(":")[0];
  try {
    const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 8000 });
    return res.data?.meta || null;
  } catch {
    return null;
  }
}

// ── Trust proxy (Render runs behind a reverse proxy) ──────────────
app.set("trust proxy", 1);

// ── Request logging ───────────────────────────────────────────────
app.use((req, res, next) => {
  logReq.debug(`${req.method} ${req.path} (proto: ${req.protocol}, x-forwarded-proto: ${req.get("x-forwarded-proto")})`);
  next();
});

// ── CORS headers for Stremio ──────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Landing / Configure page ──────────────────────────────────────

app.get("/", (req, res) => res.redirect("/configure"));

app.get("/configure", (req, res) => {
  const host = `${req.protocol}://${req.get("host")}`;
  res.type("html").send(getConfigurePage(host));
});

// Stremio requests /:config/configure after reading manifest
app.get("/:config/configure", (req, res) => {
  const host = `${req.protocol}://${req.get("host")}`;
  res.type("html").send(getConfigurePage(host));
});

// ── Manifest ──────────────────────────────────────────────────────

function getManifest(config, host) {
  const configStr = encodeConfig(config);
  return {
    id: isDev ? "community.titulky.com.dev" : "community.titulky.com",
    version: "1.0.0",
    name: isDev ? "Titulky.com Dev" : "Titulky.com",
    description: "České a slovenské titulky z Titulky.com",
    catalogs: [],
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    logo: "https://raw.githubusercontent.com/david325345/stremio-titulky.com/main/public/logo.png",
    behaviorHints: {
      configurable: true,
    },
  };
}

app.get("/:config/manifest.json", (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ error: "Invalid config" });
  const host = `${req.protocol}://${req.get("host")}`;
  res.json(getManifest(config, host));
});

// ── Subtitle search ───────────────────────────────────────────────

app.get("/:config/subtitles/:type/:id/:extra?.json", async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ subtitles: [] });

  const { type, id } = req.params;
  const host = `${req.protocol}://${req.get("host")}`;

  try {
    const client = await getClient(config);
    if (!client) return res.json({ subtitles: [] });

    // Build search queries - try multiple title variants
    const meta = await getMeta(type, id);
    if (!meta) return res.json({ subtitles: [] });

    const searchTitles = [];
    const name = meta.name || meta.title || "";

    if (type === "series") {
      const parts = id.split(":");
      const season = parts[1] ? parseInt(parts[1], 10) : 1;
      const episode = parts[2] ? parseInt(parts[2], 10) : 1;
      const epStr = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
      // Try: "Show Name S01E01", then just "Show Name"
      if (name) searchTitles.push(`${name} ${epStr}`);
      if (meta.aliases) {
        for (const alias of meta.aliases) {
          if (alias && alias !== name) searchTitles.push(`${alias} ${epStr}`);
        }
      }
      if (name) searchTitles.push(name);
    } else {
      // Movie: try name, then aliases, then name without special chars
      if (name) searchTitles.push(name);
      if (meta.aliases) {
        for (const alias of meta.aliases) {
          if (alias && alias !== name) searchTitles.push(alias);
        }
      }
      // Try without trailing dots/punctuation
      const cleaned = name.replace(/[.!?]+$/, "").trim();
      if (cleaned && cleaned !== name) searchTitles.push(cleaned);
      // Try just the first word if title is very short
      if (name.split(" ").length <= 3 && name.length > 2) {
        searchTitles.push(name);
      }
    }

    // Deduplicate
    const uniqueTitles = [...new Set(searchTitles)].filter((t) => t && t.length > 1);

    logAddon.info(`Search titles: ${JSON.stringify(uniqueTitles)} (${type} ${id})`);
    const results = await client.search(uniqueTitles);

    // Save to watch history (async, don't wait)
    const imdbId = id.split(":")[0];
    r2AddToHistory(config.username, {
      imdbId,
      type,
      id,
      name,
      poster: meta.poster || null,
      time: Date.now(),
    });

    // Extract playing filename from Stremio extra params
    const extraStr = req.params.extra || "";
    const filenameMatch = extraStr.match(/filename=([^&]+)/);
    let playingFilename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : "";

    // Check if filename is usable (not empty, not just whitespace, has release info)
    const isUsableFilename = playingFilename.trim().length > 3 && extractReleaseTags(playingFilename).length > 0;

    // If no usable filename and RD token available, try Real-Debrid automatically
    if (!isUsableFilename && config.rdToken) {
      try {
        logRD.info(`No usable filename from Stremio (got: "${playingFilename}"), checking Real-Debrid…`);
        const rdHeaders = { Authorization: `Bearer ${config.rdToken}` };

        // Build search terms from IMDB title
        const titleWords = name
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, "")
          .split(/\s+/)
          .filter((w) => w.length > 2);

        function matchesTitle(filename) {
          if (!filename) return false;
          const fn = filename.toLowerCase().replace(/[._-]/g, " ");
          return titleWords.length > 0 && titleWords.every((w) => fn.includes(w));
        }

        // Search /downloads for matching filename
        let found = false;
        const rdRes = await axios.get("https://api.real-debrid.com/rest/1.0/downloads?limit=20", {
          headers: rdHeaders,
          timeout: 5000,
        });
        if (rdRes.data) {
          const match = rdRes.data.find((d) => matchesTitle(d.filename));
          if (match) {
            playingFilename = match.filename;
            found = true;
            logRD.debug(`Found matching filename in /downloads: "${playingFilename}"`);
          }
        }

        // If not found, search /torrents
        if (!found) {
          const rdTorrents = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=20", {
            headers: rdHeaders,
            timeout: 5000,
          });
          if (rdTorrents.data) {
            const match = rdTorrents.data.find((t) => matchesTitle(t.filename));
            if (match) {
              playingFilename = match.filename;
              found = true;
              logRD.debug(`Found matching filename in /torrents: "${playingFilename}"`);
            }
          }
        }

        if (!found) {
          logRD.debug(`No matching filename for "${name}" → using IMDB title + quality sort`);
        }
      } catch (e) {
        logRD.error(`API error: ${e.message}`);
      }
    }

    const playingTags = extractReleaseTags(playingFilename);

    logAddon.info(
      `Playing: "${playingFilename}" | Tags: ${playingTags.join(", ") || "none"}${!isUsableFilename ? (config.rdToken ? " (RD fallback)" : " (no filename)") : ""}`,
    );

    // Filter results by title match
    const movieName = name
      .toLowerCase()
      .replace(/[.!?]+$/, "")
      .trim();

    let filtered = results.filter((sub) => {
      const subTitle = (sub.title || "").toLowerCase().replace(/[._-]/g, " ").trim();
      const subLink = (sub.linkFile || "").toLowerCase().replace(/[._-]/g, " ");
      return isExactTitleMatch(movieName, subTitle) || isExactTitleMatch(movieName, subLink);
    });

    logAddon.debug(`After filter: ${filtered.length}/${results.length}`);

    // Score subtitles
    const hasReleaseTags = playingTags.length > 0;
    const scoredResults = filtered.map((sub) => ({
      sub,
      score: hasReleaseTags ? scoreSubtitle(sub.version || sub.title, playingTags) : qualityScore(sub.version || sub.title),
    }));
    scoredResults.sort((a, b) => b.score - a.score);

    // Build response — max 10
    const configStr = req.params.config;
    const isOmni = !!config.omni;

    // For Omni: sort by priority: cached+match > cached > download+match > download
    if (isOmni) {
      scoredResults.sort((a, b) => {
        const aCached = r2CachedIds.has(String(a.sub.id)) ? 2 : 0;
        const bCached = r2CachedIds.has(String(b.sub.id)) ? 2 : 0;
        const aMatch = a.score > 0 && hasReleaseTags ? 1 : 0;
        const bMatch = b.score > 0 && hasReleaseTags ? 1 : 0;
        return bCached + bMatch - (aCached + aMatch) || b.score - a.score;
      });
    }

    const omniCounters = {};
    const subtitles = scoredResults.slice(0, 10).map(({ sub, score }) => {
      const cached = r2CachedIds.has(String(sub.id));

      if (isOmni) {
        const icon = cached ? "✅" : "⬇️";
        const star = hasReleaseTags && score > 0 ? "⭐" : "";
        const quality = getQualityEmoji(sub.version || sub.title || "");
        // Counter per group for unique emoji sequence
        const groupKey = `${icon}${star}${quality}`;
        if (!omniCounters[groupKey]) omniCounters[groupKey] = 0;
        omniCounters[groupKey]++;
        const num = numberEmoji(omniCounters[groupKey]);
        return {
          id: `titulky-${sub.id}`,
          url: `${host}/sub/${configStr}/${sub.id}/${encodeURIComponent(sub.linkFile)}`,
          lang: sub.lang,
          SubEncoding: "UTF-8",
          SubFormat: "vtt",
        };
      } else {
        const label = buildLabel(sub, score, hasReleaseTags);
        const icon = cached ? "✅" : "⬇️";
        return {
          id: `titulky-${sub.id}`,
          url: `${host}/sub/${configStr}/${sub.id}/${encodeURIComponent(sub.linkFile)}`,
          lang: sub.lang,
          SubEncoding: "UTF-8",
          SubFormat: "srt",
        };
      }
    });

    // Add custom subtitles from R2 (user-uploaded)
    const imdbIdClean = id.split(":")[0];
    const customImdbId = type === "series" ? id.replace(/:/g, "-") : imdbIdClean;
    const customSubs = await r2GetCustomSubs(customImdbId);
    for (const cs of customSubs) {
      const ext = cs.filename.split(".").pop().toLowerCase();
      const isAssType = ext === "ass" || ext === "ssa";
      let subFormat, subUrl;
      if (isOmni && isAssType) {
        subFormat = ext;
        subUrl = `${host}/custom-sub-raw/${customImdbId}/${encodeURIComponent(cs.filename)}`;
      } else {
        subFormat = isAssType || ext === "vtt" ? "vtt" : "srt";
        subUrl = `${host}/custom-sub/${customImdbId}/${encodeURIComponent(cs.filename)}`;
      }
      if (isOmni) {
        if (!omniCounters["📌"]) omniCounters["📌"] = 0;
        omniCounters["📌"]++;
        const num = numberEmoji(omniCounters["📌"]);
        subtitles.unshift({
          id: `custom-${cs.key}`,
          url: subUrl,
          lang: cs.lang,
          SubEncoding: "UTF-8",
          SubFormat: subFormat,
        });
      } else {
        subtitles.unshift({
          id: `custom-${cs.key}`,
          url: subUrl,
          lang: cs.lang,
          SubEncoding: "UTF-8",
          SubFormat: subFormat,
        });
      }
    }

    res.json({ subtitles });
  } catch (e) {
    logAddon.error("Search error:", e.message);
    res.json({ subtitles: [] });
  }
});

function isExactTitleMatch(movieName, subText) {
  if (!movieName || !subText) return false;

  // Normalize both strings
  const movie = movieName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
  const sub = subText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();

  // Direct match
  if (sub === movie) return true;

  // Sub starts with movie name, followed by year/space/end/release info
  if (sub.startsWith(movie)) {
    const after = sub.slice(movie.length).trim();
    if (!after || /^\d{4}/.test(after) || /^(s\d|season|720|1080|2160|bluray|brrip|web|dvd|hdtv|x26)/i.test(after)) {
      return true;
    }
  }

  return false;
}

function buildLabel(sub, score, hasReleaseTags) {
  let label = sub.version || sub.title || "";
  if (hasReleaseTags && score > 0) label = `⭐ ${label}`;
  return label;
}

const NUM_EMOJI = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
function numberEmoji(n) {
  return NUM_EMOJI[n] || `${n}`;
}

function getQualityEmoji(version) {
  const v = (version || "").toLowerCase();
  if (v.includes("remux")) return "💎";
  if (
    v.includes("bluray") ||
    v.includes("blu-ray") ||
    v.includes("bdrip") ||
    v.includes("brrip") ||
    v.includes("2160p") ||
    v.includes("4k")
  )
    return "🟢";
  if (v.includes("web-dl") || v.includes("webdl") || v.includes("webrip") || v.includes("web")) return "🟡";
  if (v.includes("hdtv")) return "🟠";
  if (v.includes("dvdrip") || v.includes("dvd")) return "🔴";
  if (v.includes("cam") || v.includes("telesync")) return "⚫";
  return "";
}

// Quality ranking when no release tags from playing file
const QUALITY_ORDER = [
  { tag: "2160p", score: 100 },
  { tag: "remux", score: 95 },
  { tag: "bdremux", score: 95 },
  { tag: "bluray", score: 90 },
  { tag: "blu-ray", score: 90 },
  { tag: "1080p", score: 80 },
  { tag: "web-dl", score: 70 },
  { tag: "webdl", score: 70 },
  { tag: "webrip", score: 65 },
  { tag: "720p", score: 60 },
  { tag: "hdtv", score: 50 },
  { tag: "hdrip", score: 45 },
  { tag: "brrip", score: 40 },
  { tag: "bdrip", score: 40 },
  { tag: "dvdrip", score: 30 },
  { tag: "dvd", score: 25 },
  { tag: "480p", score: 20 },
  { tag: "hdcam", score: 10 },
  { tag: "cam", score: 5 },
  { tag: "ts", score: 5 },
  { tag: "telesync", score: 5 },
];

function qualityScore(text) {
  if (!text) return 0;
  const lower = text.toLowerCase().replace(/[._]/g, " ").replace(/[-]/g, " ");
  let best = 0;
  for (const q of QUALITY_ORDER) {
    const tagLower = q.tag.replace(/[-]/g, " ");
    if (lower.includes(tagLower) && q.score > best) best = q.score;
  }
  return best;
}

// ── Encoding detection & conversion ──────────────────────────────

function ensureUtf8(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

  // Check for UTF-8 BOM
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString("utf-8");
  }

  // Check for UTF-16 LE BOM
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return iconv.decode(buffer, "utf-16le");
  }

  // Try to decode as UTF-8 and check if it's valid
  const utf8Str = buffer.toString("utf-8");
  if (isValidUtf8(utf8Str)) {
    return utf8Str;
  }

  // Not valid UTF-8 → assume Windows-1250 (Czech/Slovak standard)
  logAddon.debug("Converting subtitle from CP1250 to UTF-8");
  return iconv.decode(buffer, "win1250");
}

function isValidUtf8(str) {
  // If decoding as UTF-8 produces replacement characters (�) for common
  // Czech/Slovak byte sequences, it's likely CP1250
  // Check for typical CP1250 patterns that become garbled in UTF-8
  const replacements = (str.match(/\uFFFD/g) || []).length;
  if (replacements > 0) return false;

  // Check for suspicious sequences: CP1250 Czech chars (0xE8=č, 0xF8=ř, 0xE9=é, 0xED=í, etc.)
  // decoded as UTF-8 produce sequences like Ã¨, Ã¸, Ã©, Ã­
  // These are multi-byte UTF-8 sequences that don't make sense for Czech text
  const suspicious = (str.match(/[\xC0-\xC3][\x80-\xBF]/g) || []).length;
  const totalChars = str.length;

  // If more than 5% of chars are suspicious multi-byte sequences, likely CP1250
  if (totalChars > 50 && suspicious / totalChars > 0.02) return false;

  return true;
}

// ── Subtitle download proxy ───────────────────────────────────────

// Download lock: prevents multiple parallel downloads of the same subtitle
const downloadLocks = new Map(); // subId → Promise

app.get("/sub/:config/:subId/:linkFile", async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).send("Invalid config");

  const isOmni = !!config.omni;
  const { subId, linkFile } = req.params;
  const cacheKey = `${subId}-${linkFile}`;

  // Helper: send subtitle with optional SRT→VTT conversion for Omni
  function sendSub(content, filename) {
    if (isOmni) {
      const vtt = srtToVtt(content);
      const vttFilename = filename.replace(/\.srt$/i, ".vtt");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(vttFilename)}"`);
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      return res.send(vtt);
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(content);
  }

  // 1. Check in-memory cache
  if (subtitleCache.has(cacheKey)) {
    const cached = subtitleCache.get(cacheKey);
    if (Date.now() - cached.time < SUBTITLE_CACHE_TTL) {
      logAddon.debug(`Serving memory-cached subtitle ${subId}${isOmni ? " (VTT)" : ""}`);
      return sendSub(cached.content, cached.filename);
    }
    subtitleCache.delete(cacheKey);
  }

  // 2. Check R2 cloud cache
  const r2Cached = await r2Get(subId);
  if (r2Cached) {
    subtitleCache.set(cacheKey, { ...r2Cached, time: Date.now() });
    return sendSub(r2Cached.content, r2Cached.filename);
  }

  // 3. Download from titulky.com (with lock to prevent parallel downloads)
  try {
    // If another request is already downloading this subtitle, wait for it
    if (downloadLocks.has(subId)) {
      logAddon.debug(`Waiting for ongoing download of ${subId}…`);
      await downloadLocks.get(subId);
      // After wait, check cache again
      if (subtitleCache.has(cacheKey)) {
        const cached = subtitleCache.get(cacheKey);
        logAddon.debug(`Serving after-wait cached subtitle ${subId}${isOmni ? " (VTT)" : ""}`);
        return sendSub(cached.content, cached.filename);
      }
    }

    // Create lock promise
    let resolveLock;
    const lockPromise = new Promise((r) => {
      resolveLock = r;
    });
    downloadLocks.set(subId, lockPromise);

    const client = await getClient(config);
    if (!client) {
      downloadLocks.delete(subId);
      resolveLock();
      return res.status(500).send("Login failed");
    }

    const decoded = decodeURIComponent(linkFile);
    const files = await client.downloadSubtitle(subId, decoded);

    if (!files || files.length === 0) {
      logAddon.warn(`Download failed for ${subId} - captcha or limit reached`);
      downloadLocks.delete(subId);
      resolveLock();
      const limitMsg = isOmni
        ? `WEBVTT\n\n1\n00:00:01.000 --> 00:00:30.000\nPřekročili jste denní limit stažení titulků z Titulky.com. Stáhněte titulky které jsou v cachi (označené ✅) nebo počkejte na reset limitu do dalšího dne.\n`
        : `1\n00:00:01,000 --> 00:00:30,000\nPřekročili jste denní limit stažení titulků z Titulky.com. Stáhněte titulky které jsou v cachi (označené ✅) nebo počkejte na reset limitu do dalšího dne.\n`;
      res.setHeader("Content-Type", isOmni ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8");
      return res.send(limitMsg);
    }

    const file = files[0];
    const utf8Content = ensureUtf8(file.content);

    subtitleCache.set(cacheKey, {
      content: utf8Content,
      filename: file.filename,
      time: Date.now(),
    });

    // Save to R2 cloud cache (async, don't wait)
    r2Put(subId, utf8Content, file.filename);

    // Release lock
    downloadLocks.delete(subId);
    resolveLock();

    return sendSub(utf8Content, file.filename);
  } catch (e) {
    // Release lock on error
    if (downloadLocks.has(subId)) {
      const lock = downloadLocks.get(subId);
      downloadLocks.delete(subId);
    }
    logAddon.error("Download error:", e.message);
    res.status(500).send("Download failed");
  }
});

// ── SRT to VTT converter ─────────────────────────────────────────

function srtToVtt(srtContent) {
  const text = typeof srtContent === "string" ? srtContent : srtContent.toString("utf-8");
  // Replace SRT time format commas with VTT dots
  const vttBody = text.replace(/\r\n/g, "\n").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return "WEBVTT\n\n" + vttBody.trim() + "\n";
}

// ── ASS/SSA to SRT converter ─────────────────────────────────────

function assToVtt(assContent) {
  const text = typeof assContent === "string" ? assContent : assContent.toString("utf-8");
  const lines = text.split(/\r?\n/);

  // Parse [V4+ Styles] for color/style info
  const styles = {};
  let inStyles = false;
  let styleFormat = [];

  // Find [Events] section and parse Format line
  let inEvents = false;
  let formatFields = [];
  const dialogues = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Styles section
    if (/^\[V4\+?\s*Styles?\]/i.test(trimmed)) {
      inStyles = true;
      inEvents = false;
      continue;
    }
    if (inStyles && /^Format:/i.test(trimmed)) {
      styleFormat = trimmed
        .replace(/^Format:\s*/i, "")
        .split(",")
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (inStyles && /^Style:/i.test(trimmed)) {
      const parts = trimmed.replace(/^Style:\s*/i, "").split(",");
      const nameIdx = styleFormat.indexOf("name");
      const colorIdx = styleFormat.indexOf("primarycolour");
      const boldIdx = styleFormat.indexOf("bold");
      const italicIdx = styleFormat.indexOf("italic");
      if (nameIdx >= 0 && parts[nameIdx]) {
        styles[parts[nameIdx].trim()] = {
          color: colorIdx >= 0 ? assColorToVtt(parts[colorIdx]?.trim()) : null,
          bold: boldIdx >= 0 ? parts[boldIdx]?.trim() === "-1" || parts[boldIdx]?.trim() === "1" : false,
          italic: italicIdx >= 0 ? parts[italicIdx]?.trim() === "-1" || parts[italicIdx]?.trim() === "1" : false,
        };
      }
      continue;
    }

    // Events section
    if (/^\[Events\]/i.test(trimmed)) {
      inEvents = true;
      inStyles = false;
      continue;
    }
    if (/^\[/.test(trimmed) && inEvents) break;

    if (inEvents && /^Format:/i.test(trimmed)) {
      formatFields = trimmed
        .replace(/^Format:\s*/i, "")
        .split(",")
        .map((f) => f.trim().toLowerCase());
      continue;
    }

    if (inEvents && /^Dialogue:/i.test(trimmed)) {
      const parts = trimmed.replace(/^Dialogue:\s*/i, "").split(",");
      if (parts.length >= formatFields.length) {
        const startIdx = formatFields.indexOf("start");
        const endIdx = formatFields.indexOf("end");
        const textIdx = formatFields.indexOf("text");
        const styleIdx = formatFields.indexOf("style");

        if (startIdx >= 0 && endIdx >= 0 && textIdx >= 0) {
          const textParts = parts.slice(textIdx).join(",");
          const styleName = styleIdx >= 0 ? parts[styleIdx]?.trim() : null;
          dialogues.push({
            start: assTimeToVtt(parts[startIdx].trim()),
            end: assTimeToVtt(parts[endIdx].trim()),
            text: assTextToVtt(textParts.trim(), styles[styleName] || null),
          });
        }
      }
    }
  }

  // Build VTT
  let vtt = "WEBVTT\n\n";
  vtt += dialogues.map((d, i) => `${d.start} --> ${d.end}\n${d.text}\n`).join("\n");
  return vtt;
}

function assTimeToVtt(assTime) {
  // ASS: H:MM:SS.CC → VTT: HH:MM:SS.mmm
  const m = assTime.match(/(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return "00:00:00.000";
  const h = m[1].padStart(2, "0");
  const min = m[2].padStart(2, "0");
  const sec = m[3].padStart(2, "0");
  const cs = m[4].padEnd(3, "0").substring(0, 3);
  return `${h}:${min}:${sec}.${cs}`;
}

function assColorToVtt(assColor) {
  if (!assColor) return null;
  // ASS color: &HAABBGGRR or &HBBGGRR
  const m = assColor.replace(/^&H/i, "").replace(/&$/, "");
  if (m.length >= 6) {
    const b = m.slice(-6, -4);
    const g = m.slice(-4, -2);
    const r = m.slice(-2);
    return `#${r}${g}${b}`;
  }
  return null;
}

function assTextToVtt(text, style) {
  let result = text;

  // Convert inline ASS tags to VTT/HTML
  // Bold
  result = result.replace(/\{\\b1\}/g, "<b>").replace(/\{\\b0\}/g, "</b>");
  // Italic
  result = result.replace(/\{\\i1\}/g, "<i>").replace(/\{\\i0\}/g, "</i>");
  // Underline
  result = result.replace(/\{\\u1\}/g, "<u>").replace(/\{\\u0\}/g, "</u>");
  // Color tags: {\c&HBBGGRR&} or {\1c&HBBGGRR&}
  result = result.replace(/\{\\(?:1)?c&H([0-9A-Fa-f]{6})&?\}/g, (_, hex) => {
    const color = assColorToVtt("&H" + hex);
    return color ? `<c.color${color}>` : "";
  });
  // Remove remaining ASS tags
  result = result.replace(/\{[^}]*\}/g, "");
  // Newlines
  result = result.replace(/\\N/g, "\n").replace(/\\n/g, "\n").replace(/\\h/g, " ");

  // Apply style-level formatting
  if (style) {
    if (style.bold) result = `<b>${result}</b>`;
    if (style.italic) result = `<i>${result}</i>`;
    if (style.color) result = `<c.color${style.color}>${result}</c>`;
  }

  return result.trim();
}

// ── Serve custom subtitle from R2 ─────────────────────────────────

app.get("/custom-sub/:imdbId/:filename", async (req, res) => {
  if (!s3) return res.status(404).send("R2 not configured");
  try {
    const { imdbId, filename } = req.params;
    const key = `custom/${imdbId}/${filename}`;
    logCustom.debug(`Serving: ${key}`);
    const getRes = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
    );
    const chunks = [];
    for await (const chunk of getRes.Body) chunks.push(chunk);
    const buf = Buffer.concat(chunks);

    // Convert ASS/SSA to VTT for Stremio compatibility (preserves more styling than SRT)
    const ext = filename.split(".").pop().toLowerCase();
    let content;
    if (ext === "ass" || ext === "ssa") {
      logCustom.debug(`Converting ${ext.toUpperCase()} to VTT`);
      content = assToVtt(buf);
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    } else if (ext === "vtt") {
      content = buf;
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    } else {
      content = buf;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }

    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(content);
  } catch (e) {
    logCustom.error("Serve error:", e.message);
    res.status(404).send("Not found");
  }
});

// ── Serve custom subtitle RAW from R2 (no conversion, for Omni) ──

app.get("/custom-sub-raw/:imdbId/:filename", async (req, res) => {
  if (!s3) return res.status(404).send("R2 not configured");
  try {
    const { imdbId, filename } = req.params;
    const key = `custom/${imdbId}/${filename}`;
    logCustom.debug(`Serving RAW: ${key}`);
    const getRes = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
    );
    const chunks = [];
    for await (const chunk of getRes.Body) chunks.push(chunk);
    const buf = Buffer.concat(chunks);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(buf);
  } catch (e) {
    logCustom.error("Raw serve error:", e.message);
    res.status(404).send("Not found");
  }
});

// ── Dashboard page ───────────────────────────────────────────────

app.get("/:config/dashboard", async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !config.username) return res.status(401).send("Not logged in");
  const host = `${req.protocol}://${req.get("host")}`;
  const history = await r2GetHistory(config.username);
  res.type("html").send(getDashboardPage(host, config, history, req.params.config));
});

// ── Upload custom subtitle ───────────────────────────────────────

app.post("/:config/upload", express.json({ limit: "2mb" }), async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !config.username) return res.status(401).json({ error: "Not logged in" });

  const { imdbId, content, filename, label, lang } = req.body;
  if (!imdbId || !content || !filename) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Convert base64 content - only convert encoding for SRT, leave ASS/SSA as-is
  let subContent;
  try {
    const buf = Buffer.from(content, "base64");
    const ext = filename.split(".").pop().toLowerCase();
    if (ext === "srt" || ext === "sub") {
      subContent = ensureUtf8(buf);
    } else {
      // ASS/SSA/VTT — keep as-is (they usually have encoding declaration inside)
      subContent = buf;
    }
  } catch {
    return res.status(400).json({ error: "Invalid file content" });
  }

  const ok = await r2PutCustomSub(
    imdbId,
    filename.replace(/[^a-zA-Z0-9._-]/g, "_"),
    subContent,
    label || filename.replace(/\.(srt|ssa|ass|sub|vtt)$/i, ""),
    lang || "cze",
    config.username,
  );

  res.json({ success: ok });
});

// ── List custom subtitles for an IMDB ID ─────────────────────────

app.get("/:config/custom-list/:imdbId", async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !config.username) return res.status(401).json({ error: "Not logged in" });

  const subs = await r2GetCustomSubs(req.params.imdbId);
  res.json({ subs });
});

// ── Admin users ──────────────────────────────────────────────────
const ADMIN_USERS = new Set(
  (process.env.ADMIN_USERS || "David32")
    .toLowerCase()
    .split(",")
    .map((u) => u.trim()),
);

function isAdmin(username) {
  return ADMIN_USERS.has((username || "").toLowerCase());
}

// ── Delete custom subtitle ───────────────────────────────────────

app.post("/:config/custom-delete", express.json(), async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !config.username) return res.status(401).json({ error: "Not logged in" });

  const { key } = req.body;
  if (!key || !key.startsWith("custom/")) {
    return res.status(400).json({ error: "Invalid key" });
  }

  if (!s3) return res.status(500).json({ error: "R2 not configured" });

  // Check permission: get uploader metadata
  try {
    const getRes = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
    );
    // Consume body to avoid leak
    for await (const _ of getRes.Body) {
    }
    const uploader = getRes.Metadata?.uploader || "unknown";

    if (!isAdmin(config.username) && uploader.toLowerCase() !== config.username.toLowerCase()) {
      logR2.warn(`Delete denied: ${config.username} tried to delete sub by ${uploader}`);
      return res.status(403).json({ error: "Nemáte oprávnění smazat tyto titulky" });
    }
  } catch (e) {
    // If file doesn't exist, just return success
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
      return res.json({ success: true });
    }
  }

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
    );
    logR2.info(`Deleted custom sub: ${key} (by ${config.username})`);
    res.json({ success: true });
  } catch (e) {
    logR2.error(`Delete error: ${e.message}`);
    res.json({ success: false, error: e.message });
  }
});

// ── Admin: Download backup (ZIP of entire R2 bucket) ─────────────

const AdmZip = require("adm-zip");

app.get("/:config/admin/backup", async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !isAdmin(config.username)) return res.status(403).send("Forbidden");
  if (!s3) return res.status(500).send("R2 not configured");

  logAdmin.info(`Backup requested by ${config.username}`);

  try {
    const zip = new AdmZip();
    let continuationToken = undefined;
    let total = 0;

    do {
      const listRes = await s3.send(
        new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of listRes.Contents || []) {
        try {
          const getRes = await s3.send(
            new GetObjectCommand({
              Bucket: process.env.R2_BUCKET,
              Key: obj.Key,
            }),
          );
          const chunks = [];
          for await (const chunk of getRes.Body) chunks.push(chunk);
          const buf = Buffer.concat(chunks);

          // Store metadata as JSON sidecar
          if (getRes.Metadata && Object.keys(getRes.Metadata).length > 0) {
            zip.addFile(obj.Key + ".meta.json", Buffer.from(JSON.stringify(getRes.Metadata)));
          }
          zip.addFile(obj.Key, buf);
          total++;
        } catch {
          /* skip failed files */
        }
      }

      continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
    } while (continuationToken);

    logAdmin.info(`Backup created: ${total} file(s)`);

    const zipBuffer = zip.toBuffer();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="titulky-backup.zip"`);
    res.send(zipBuffer);
  } catch (e) {
    logAdmin.error("Backup error:", e.message);
    res.status(500).send("Backup failed");
  }
});

// ── Admin: Restore backup (upload ZIP) ───────────────────────────

const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post("/:config/admin/restore", upload.single("backup"), async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !isAdmin(config.username)) return res.status(403).json({ error: "Forbidden" });
  if (!s3) return res.status(500).json({ error: "R2 not configured" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  logAdmin.info(`Restore requested by ${config.username} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

  try {
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    let count = 0;

    for (const entry of entries) {
      if (entry.isDirectory || entry.entryName.endsWith(".meta.json")) continue;

      const key = entry.entryName;
      const content = entry.getData();

      // Look for metadata sidecar
      const metaEntry = zip.getEntry(key + ".meta.json");
      let metadata = {};
      if (metaEntry) {
        try {
          metadata = JSON.parse(metaEntry.getData().toString("utf-8"));
        } catch {}
      }

      // Detect content type
      const ext = key.split(".").pop().toLowerCase();
      let contentType = "application/octet-stream";
      if (ext === "json") contentType = "application/json";
      else if (["srt", "ssa", "ass", "sub", "txt"].includes(ext)) contentType = "text/plain; charset=utf-8";
      else if (ext === "vtt") contentType = "text/vtt; charset=utf-8";

      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: key,
          Body: content,
          ContentType: contentType,
          Metadata: metadata,
        }),
      );

      // Update cache index if it's a subtitle
      if (key.startsWith("subs/")) {
        const id = key.replace("subs/", "").replace(".srt", "");
        if (id) r2CachedIds.add(id);
      }

      count++;
    }

    logAdmin.info(`Restored ${count} file(s)`);
    res.json({ success: true, count });
  } catch (e) {
    logAdmin.error("Restore error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// ── Login test endpoint ───────────────────────────────────────────

app.post("/verify", express.json(), async (req, res) => {
  logVerify.debug("Request body:", JSON.stringify(req.body));
  const { username, password } = req.body || {};
  if (!username || !password) {
    logVerify.warn("Missing credentials");
    return res.json({ success: false, error: "missing_credentials" });
  }

  try {
    const client = new TitulkyClient(username, password);
    const ok = await client.login();
    logVerify.info("Login result:", ok);
    if (ok) clientCache.set(username, client);
    res.json({ success: ok });
  } catch (e) {
    logVerify.error("Error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// ── Configure page HTML ───────────────────────────────────────────

function getConfigurePage(host) {
  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Titulky.com – Stremio Addon</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0c0e14;
    --surface: #151821;
    --surface-2: #1c2030;
    --border: #2a2e40;
    --accent: #4f8cff;
    --accent-hover: #6ba0ff;
    --accent-glow: rgba(79, 140, 255, 0.15);
    --text: #e4e7f0;
    --text-dim: #8891a8;
    --danger: #ff5c5c;
    --success: #4fdb8a;
    --radius: 12px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'DM Sans', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    position: relative;
    overflow: hidden;
  }

  body::before {
    content: '';
    position: fixed;
    top: -40%; left: -20%;
    width: 80vw; height: 80vw;
    background: radial-gradient(circle, rgba(79,140,255,0.06) 0%, transparent 65%);
    pointer-events: none;
  }

  body::after {
    content: '';
    position: fixed;
    bottom: -30%; right: -10%;
    width: 60vw; height: 60vw;
    background: radial-gradient(circle, rgba(79,140,255,0.04) 0%, transparent 60%);
    pointer-events: none;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 48px 40px;
    max-width: 440px;
    width: 100%;
    position: relative;
    z-index: 1;
    box-shadow: 0 24px 80px rgba(0,0,0,0.4);
  }

  .logo-row {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 8px;
  }

  .logo-icon {
    width: 44px; height: 44px;
    background: var(--accent-glow);
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
    border: 1px solid rgba(79,140,255,0.2);
  }

  h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }

  .subtitle {
    color: var(--text-dim);
    font-size: 14px;
    margin-bottom: 32px;
    line-height: 1.5;
  }

  label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }

  input[type="text"], input[type="password"] {
    width: 100%;
    padding: 12px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    margin-bottom: 20px;
  }

  input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  .btn {
    width: 100%;
    padding: 14px;
    border: none;
    border-radius: var(--radius);
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .btn-primary {
    background: var(--accent);
    color: #fff;
  }
  .btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }
  .btn-primary:active { transform: translateY(0); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  .btn-install {
    background: var(--success);
    color: #0c0e14;
    margin-top: 12px;
    text-decoration: none;
  }
  .btn-install:hover { filter: brightness(1.1); transform: translateY(-1px); }

  .btn-copy {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    margin-top: 8px;
  }
  .btn-copy:hover { border-color: var(--accent); }

  .status {
    text-align: center;
    font-size: 14px;
    margin-top: 16px;
    min-height: 20px;
  }
  .status.error { color: var(--danger); }
  .status.ok { color: var(--success); }

  .result { display: none; margin-top: 24px; }
  .result.show { display: block; }

  .divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 24px 0;
  }

  .url-box {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--text-dim);
    word-break: break-all;
    line-height: 1.6;
  }

  .spinner {
    width: 18px; height: 18px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    display: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 500px) {
    .card { padding: 32px 24px; }
  }
</style>
</head>
<body>
<div class="card">
  <div class="logo-row">
    <div class="logo-icon">🎬</div>
    <h1>Titulky.com</h1>
  </div>
  <p class="subtitle">Přihlaste se svým účtem z Titulky.com pro vyhledávání českých a slovenských titulků přímo ve Stremiu.</p>

  <label for="username">Uživatelské jméno</label>
  <input type="text" id="username" placeholder="Váš login" autocomplete="username">

  <label for="password">Heslo</label>
  <input type="password" id="password" placeholder="Vaše heslo" autocomplete="current-password">

  <div class="omni-section" style="margin-top: 20px;">
    <label class="toggle-row" style="display: flex; align-items: center; gap: 10px; cursor: pointer; margin-bottom: 0;">
      <input type="checkbox" id="omniToggle" onchange="toggleOmni()" style="width: auto; accent-color: var(--accent); transform: scale(1.2);">
      <span style="font-size: 14px; color: var(--text);">Optimalizace pro Omni na ATV</span>
    </label>
    <div id="rdSection" style="display: none; margin-top: 12px; padding: 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius);">
      <label for="rdToken" style="margin-top: 0;">Real-Debrid API klíč</label>
      <input type="text" id="rdToken" placeholder="Získejte na real-debrid.com/apitoken" style="font-family: 'JetBrains Mono', monospace; font-size: 12px;">
      <p style="font-size: 11px; color: var(--text-dim); margin-top: 6px;">Volitelné – lepší párování titulků podle přehrávaného souboru z RD.</p>
    </div>
  </div>

  <button class="btn btn-primary" id="verifyBtn" onclick="verify()">
    <span class="spinner" id="spinner"></span>
    <span id="btnText">Ověřit a nainstalovat</span>
  </button>

  <div class="status" id="status"></div>

  <div class="result" id="result">
    <hr class="divider">
    <a class="btn btn-install" id="installLink" href="#">
      📦 Nainstalovat do Stremio (desktop app)
    </a>
    <a class="btn btn-install" id="webInstallLink" href="#" target="_blank" style="background: var(--accent); margin-top: 8px;">
      🌐 Nainstalovat přes Stremio Web
    </a>
    <button class="btn btn-copy" onclick="copyUrl()">
      📋 Kopírovat URL addonu
    </button>
    <a class="btn btn-install" id="dashboardLink" href="#" style="background: var(--surface-2); border: 1px solid var(--border); color: var(--accent); margin-top: 8px;">
      📺 Dashboard – nahrát vlastní titulky
    </a>
    <div style="margin-top: 16px;">
      <label>URL addonu</label>
      <div class="url-box" id="addonUrl"></div>
    </div>
  </div>
</div>

<script>
const HOST = '${host}';

function toggleOmni() {
  const checked = document.getElementById('omniToggle').checked;
  document.getElementById('rdSection').style.display = checked ? 'block' : 'none';
}

async function verify() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const omni = document.getElementById('omniToggle').checked;
  const rdToken = document.getElementById('rdToken').value.trim();
  const status = document.getElementById('status');
  const result = document.getElementById('result');
  const btn = document.getElementById('verifyBtn');
  const spinner = document.getElementById('spinner');
  const btnText = document.getElementById('btnText');

  if (!username || !password) {
    status.className = 'status error';
    status.textContent = 'Vyplňte oba údaje';
    return;
  }

  btn.disabled = true;
  spinner.style.display = 'block';
  btnText.textContent = 'Ověřuji…';
  status.className = 'status';
  status.textContent = '';
  result.classList.remove('show');

  try {
    const res = await fetch('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (data.success) {
      status.className = 'status ok';
      status.textContent = '✓ Přihlášení úspěšné';

      const configObj = { username, password };
      if (omni) configObj.omni = true;
      if (omni && rdToken) configObj.rdToken = rdToken;

      const config = btoa(JSON.stringify(configObj))
        .replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
      const manifestUrl = window.location.origin + '/' + config + '/manifest.json';
      const stremioUrl = 'stremio://' + manifestUrl.replace(/^https?:[/][/]/, '');
      const webInstallUrl = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);

      document.getElementById('installLink').href = stremioUrl;
      document.getElementById('webInstallLink').href = webInstallUrl;
      document.getElementById('dashboardLink').href = '/' + config + '/dashboard';
      document.getElementById('addonUrl').textContent = manifestUrl;
      result.classList.add('show');

      // Save config to localStorage for auto-login
      try { localStorage.setItem('titulky_config', config); } catch {}
    } else {
      status.className = 'status error';
      status.textContent = '✗ Nesprávné přihlašovací údaje';
    }
  } catch (e) {
    status.className = 'status error';
    status.textContent = 'Chyba připojení: ' + e.message;
  }

  btn.disabled = false;
  spinner.style.display = 'none';
  btnText.textContent = 'Ověřit a nainstalovat';
}

function copyUrl() {
  const url = document.getElementById('addonUrl').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.querySelector('.btn-copy');
    btn.textContent = '✓ Zkopírováno';
    setTimeout(() => btn.textContent = '📋 Kopírovat URL addonu', 2000);
  });
}

document.getElementById('password').addEventListener('keydown', e => {
  if (e.key === 'Enter') verify();
});

// Auto-login: if config saved in localStorage, restore session
(function autoLogin() {
  try {
    const saved = localStorage.getItem('titulky_config');
    if (!saved) return;
    const parsed = JSON.parse(atob(saved.replace(/-/g, '+').replace(/_/g, '/')));
    if (parsed.username && parsed.password) {
      document.getElementById('username').value = parsed.username;
      document.getElementById('password').value = parsed.password;
      if (parsed.omni) {
        document.getElementById('omniToggle').checked = true;
        toggleOmni();
      }
      if (parsed.rdToken) {
        document.getElementById('rdToken').value = parsed.rdToken;
      }
      verify();
    }
  } catch {}
})();
</script>
</body>
</html>`;
}

// ── Start ─────────────────────────────────────────────────────────

function getDashboardPage(host, config, history, configStr) {
  const historyHtml =
    history.length === 0
      ? '<p class="subtitle">Zatím jsi nic nepřehrával. Pusť si film nebo seriál ve Stremiu a vrať se sem.</p>'
      : history
          .map(
            (h) => `
      <div class="history-item" data-imdb="${h.imdbId}" data-id="${h.id}" data-type="${h.type}" data-name="${h.name.replace(/"/g, "&quot;")}">
        <img class="poster" src="${h.poster || "https://via.placeholder.com/80x120/1c2030/8891a8?text=?"}" alt="${h.name}">
        <div class="history-info">
          <div class="history-title">${h.name}${
            h.type === "series" && h.id.includes(":")
              ? (() => {
                  const p = h.id.split(":");
                  return " S" + String(p[1] || 1).padStart(2, "0") + "E" + String(p[2] || 1).padStart(2, "0");
                })()
              : ""
          }</div>
          <div class="history-meta">${h.type === "series" ? "Seriál" : "Film"} · ${h.imdbId}</div>
          <button class="btn btn-upload" onclick="showUpload('${h.id.replace(/:/g, "-")}', '${h.name.replace(/'/g, "\\'")}${
            h.type === "series" && h.id.includes(":")
              ? (() => {
                  const p = h.id.split(":");
                  return " S" + String(p[1] || 1).padStart(2, "0") + "E" + String(p[2] || 1).padStart(2, "0");
                })()
              : ""
          }', '${h.type}')">
            📤 Nahrát titulky
          </button>
        </div>
      </div>
    `,
          )
          .join("");

  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard – Titulky.com Addon</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0c0e14; --surface: #151821; --surface-2: #1c2030;
    --border: #2a2e40; --accent: #4f8cff; --accent-hover: #6ba0ff;
    --text: #e4e7f0; --text-dim: #8891a8; --danger: #ff5c5c;
    --success: #4fdb8a; --radius: 12px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'DM Sans', sans-serif; background: var(--bg);
    color: var(--text); min-height: 100vh; padding: 24px;
  }
  .container { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .subtitle { color: var(--text-dim); font-size: 14px; margin-bottom: 24px; }

  .history-item {
    display: flex; gap: 16px; padding: 16px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); margin-bottom: 12px;
  }
  .poster {
    width: 70px; height: 100px; object-fit: cover;
    border-radius: 8px; flex-shrink: 0; background: var(--surface-2);
  }
  .history-info { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .history-title { font-weight: 600; font-size: 16px; margin-bottom: 4px; }
  .history-meta { color: var(--text-dim); font-size: 13px; margin-bottom: 12px; }

  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 18px; border: none; border-radius: var(--radius);
    font-family: inherit; font-size: 14px; font-weight: 500;
    cursor: pointer; transition: all 0.2s;
  }
  .btn-upload { background: var(--surface-2); color: var(--accent); border: 1px solid var(--border); }
  .btn-upload:hover { background: var(--border); }
  .btn-primary { background: var(--accent); color: #fff; width: 100%; justify-content: center; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-back { background: transparent; color: var(--text-dim); border: 1px solid var(--border); margin-bottom: 24px; }

  .upload-modal {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    z-index: 100; align-items: center; justify-content: center; padding: 24px;
  }
  .upload-modal.show { display: flex; }
  .upload-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 32px; max-width: 480px; width: 100%;
  }
  .upload-card h2 { font-size: 18px; margin-bottom: 16px; }

  label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 6px; margin-top: 16px; }
  input, select {
    width: 100%; padding: 12px 14px; border: 1px solid var(--border);
    border-radius: var(--radius); background: var(--surface-2);
    color: var(--text); font-family: inherit; font-size: 14px;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  input[type="file"] { padding: 10px; }
  input[type="file"]::file-selector-button {
    padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--surface-2); color: var(--text); cursor: pointer;
    font-family: inherit; margin-right: 12px;
  }

  .status { margin-top: 16px; font-size: 14px; text-align: center; min-height: 20px; }
  .status.ok { color: var(--success); }
  .status.error { color: var(--danger); }
  .close-btn {
    float: right; background: none; border: none; color: var(--text-dim);
    font-size: 20px; cursor: pointer; padding: 0 4px;
  }
  .close-btn:hover { color: var(--text); }
  .loading-text { color: var(--text-dim); font-size: 14px; }
  .existing-sub {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 8px; margin-bottom: 8px;
  }
  .existing-sub-info { flex: 1; min-width: 0; }
  .existing-sub-name { display: block; font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .existing-sub-meta { display: block; font-size: 12px; color: var(--text-dim); margin-top: 2px; }
  .btn-delete {
    background: none; border: 1px solid var(--border); border-radius: 8px;
    color: var(--danger); cursor: pointer; padding: 6px 10px; font-size: 14px;
    flex-shrink: 0; margin-left: 10px; transition: all 0.2s;
  }
  .btn-delete:hover { background: rgba(255,92,92,0.1); border-color: var(--danger); }
</style>
</head>
<body>
<div class="container">
  <a href="/${configStr}/configure" class="btn btn-back">← Zpět na konfiguraci</a>
  <h1>📺 Poslední přehrávané</h1>
  <p class="subtitle">Nahraj vlastní titulky k filmům a seriálům, které jsi přehrával.</p>

  ${historyHtml}

  ${
    isAdmin(config.username)
      ? `
  <hr style="border: none; border-top: 1px solid var(--border); margin: 32px 0;">
  <h2 style="font-size: 18px; margin-bottom: 8px;">🔧 Admin</h2>
  <p class="subtitle">Záloha a obnova dat z Cloudflare R2.</p>
  <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px;">
    <button class="btn btn-upload" onclick="downloadBackup()" id="backupBtn">💾 Stáhnout zálohu</button>
    <label class="btn btn-upload" style="cursor:pointer;">
      📂 Nahrát zálohu
      <input type="file" accept=".zip" style="display:none;" onchange="uploadBackup(this)">
    </label>
  </div>
  <div class="status" id="adminStatus"></div>
  `
      : ""
  }
</div>

<div class="upload-modal" id="uploadModal">
  <div class="upload-card">
    <button class="close-btn" onclick="hideUpload()">✕</button>
    <h2 id="uploadTitle">Titulky</h2>

    <div id="existingSubs">
      <p class="loading-text">Načítám…</p>
    </div>

    <hr style="border: none; border-top: 1px solid var(--border); margin: 20px 0;">
    <h3 style="font-size: 15px; margin-bottom: 12px;">Nahrát nové titulky</h3>

    <label for="subFile">Soubor titulků (.srt, .ssa, .ass, .sub, .vtt)</label>
    <input type="file" id="subFile" accept=".srt,.ssa,.ass,.sub,.vtt">

    <label for="subLabel">Popis (volitelné)</label>
    <input type="text" id="subLabel" placeholder="např. CZ, fansub, 1080p BluRay">

    <label for="subLang">Jazyk</label>
    <select id="subLang">
      <option value="cze">Čeština</option>
      <option value="slk">Slovenčina</option>
      <option value="eng">Angličtina</option>
    </select>

    <button class="btn btn-primary" style="margin-top: 20px;" onclick="doUpload()">📤 Nahrát</button>
    <div class="status" id="uploadStatus"></div>
  </div>
</div>

<script>
const CONFIG_STR = '${configStr}';
const CURRENT_USER = '${config.username.replace(/'/g, "\\'")}';
const IS_ADMIN = ${isAdmin(config.username)};
let currentImdbId = '';

async function showUpload(id, name, type) {
  currentImdbId = id;
  document.getElementById('uploadTitle').textContent = name;
  document.getElementById('uploadStatus').textContent = '';
  document.getElementById('subFile').value = '';
  document.getElementById('subLabel').value = '';
  document.getElementById('existingSubs').innerHTML = '<p class="loading-text">Načítám…</p>';
  document.getElementById('uploadModal').classList.add('show');

  // Load existing custom subs
  try {
    const res = await fetch('/' + CONFIG_STR + '/custom-list/' + id);
    const data = await res.json();
    renderExistingSubs(data.subs || []);
  } catch {
    document.getElementById('existingSubs').innerHTML = '<p class="subtitle">Nepodařilo se načíst titulky</p>';
  }
}

function renderExistingSubs(subs) {
  const el = document.getElementById('existingSubs');
  if (subs.length === 0) {
    el.innerHTML = '<p class="subtitle">Žádné nahrané titulky</p>';
    return;
  }
  el.innerHTML = '<p style="font-size:13px; color:var(--text-dim); margin-bottom:8px;">Nahrané titulky:</p>' +
    subs.map(s => {
      const canDelete = IS_ADMIN || (s.uploader && s.uploader.toLowerCase() === CURRENT_USER.toLowerCase());
      const uploaderText = s.uploader && s.uploader !== 'unknown' ? ' · nahrál ' + s.uploader : '';
      return \`
      <div class="existing-sub" id="sub-\${btoa(s.key).replace(/[^a-zA-Z0-9]/g,'')}">
        <div class="existing-sub-info">
          <span class="existing-sub-name">\${s.label}</span>
          <span class="existing-sub-meta">\${s.filename} · \${s.lang === 'cze' ? 'CZ' : s.lang === 'slk' ? 'SK' : s.lang.toUpperCase()}\${uploaderText}</span>
        </div>
        \${canDelete ? '<button class="btn-delete" onclick="deleteSub(\\'' + s.key.replace(/'/g, "\\\\\\\\'") + '\\', this)" title="Smazat">🗑</button>' : ''}
      </div>
    \`;}).join('');
}

async function deleteSub(key, btnEl) {
  if (!confirm('Opravdu smazat tyto titulky?')) return;
  btnEl.disabled = true;
  btnEl.textContent = '…';

  try {
    const res = await fetch('/' + CONFIG_STR + '/custom-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await res.json();
    if (data.success) {
      btnEl.closest('.existing-sub').remove();
      // Check if any left
      const container = document.getElementById('existingSubs');
      if (!container.querySelector('.existing-sub')) {
        container.innerHTML = '<p class="subtitle">Žádné nahrané titulky</p>';
      }
    } else {
      alert('Chyba: ' + (data.error || 'neznámá'));
      btnEl.disabled = false;
      btnEl.textContent = '🗑';
    }
  } catch (e) {
    alert('Chyba: ' + e.message);
    btnEl.disabled = false;
    btnEl.textContent = '🗑';
  }
}

function hideUpload() {
  document.getElementById('uploadModal').classList.remove('show');
}

document.getElementById('uploadModal').addEventListener('click', function(e) {
  if (e.target === this) hideUpload();
});

async function doUpload() {
  const fileInput = document.getElementById('subFile');
  const label = document.getElementById('subLabel').value.trim();
  const lang = document.getElementById('subLang').value;
  const status = document.getElementById('uploadStatus');

  if (!fileInput.files.length) {
    status.className = 'status error';
    status.textContent = 'Vyber soubor';
    return;
  }

  const file = fileInput.files[0];
  if (!/\\.(srt|ssa|ass|sub|vtt)$/i.test(file.name)) {
    status.className = 'status error';
    status.textContent = 'Podporované formáty: .srt, .ssa, .ass, .sub, .vtt';
    return;
  }

  status.className = 'status';
  status.textContent = 'Nahrávám…';

  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);

    const res = await fetch('/' + CONFIG_STR + '/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imdbId: currentImdbId,
        content: base64,
        filename: file.name,
        label: label || file.name.replace(/\\.(srt|ssa|ass|sub|vtt)$/i, ''),
        lang: lang,
      }),
    });
    const data = await res.json();

    if (data.success) {
      status.className = 'status ok';
      status.textContent = '✓ Titulky nahrány!';
      fileInput.value = '';
      document.getElementById('subLabel').value = '';
      // Reload the list
      const listRes = await fetch('/' + CONFIG_STR + '/custom-list/' + currentImdbId);
      const listData = await listRes.json();
      renderExistingSubs(listData.subs || []);
    } else {
      status.className = 'status error';
      status.textContent = 'Chyba: ' + (data.error || 'neznámá');
    }
  } catch (e) {
    status.className = 'status error';
    status.textContent = 'Chyba: ' + e.message;
  }
}

async function downloadBackup() {
  if (!IS_ADMIN) return;
  const btn = document.getElementById('backupBtn');
  const status = document.getElementById('adminStatus');
  btn.disabled = true;
  btn.textContent = '⏳ Vytvářím zálohu…';
  status.className = 'status';
  status.textContent = 'Stahování zálohy může trvat…';

  try {
    const res = await fetch('/' + CONFIG_STR + '/admin/backup');
    if (!res.ok) throw new Error('Server error ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'titulky-backup-' + new Date().toISOString().slice(0,10) + '.zip';
    a.click();
    URL.revokeObjectURL(url);
    status.className = 'status ok';
    status.textContent = '✓ Záloha stažena';
  } catch (e) {
    status.className = 'status error';
    status.textContent = 'Chyba: ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = '💾 Stáhnout zálohu';
}

async function uploadBackup(input) {
  if (!IS_ADMIN || !input.files.length) return;
  const file = input.files[0];
  if (!file.name.endsWith('.zip')) { alert('Vyber ZIP soubor'); return; }

  const status = document.getElementById('adminStatus');
  status.className = 'status';
  status.textContent = 'Nahrávám zálohu… (' + (file.size / 1024 / 1024).toFixed(1) + ' MB)';

  try {
    const formData = new FormData();
    formData.append('backup', file);
    const res = await fetch('/' + CONFIG_STR + '/admin/restore', {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (data.success) {
      status.className = 'status ok';
      status.textContent = '✓ Obnoveno ' + data.count + ' soubor(ů)';
    } else {
      status.className = 'status error';
      status.textContent = 'Chyba: ' + (data.error || 'neznámá');
    }
  } catch (e) {
    status.className = 'status error';
    status.textContent = 'Chyba: ' + e.message;
  }
  input.value = '';
}
</script>
</body>
</html>`;
}

// ── Express error middleware ──────────────────────────────────────
app.use((err, req, res, next) => {
  log.error(`Unhandled route error: ${err.stack || err.message}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Process-level error handlers ─────────────────────────────────
process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.stack || err.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

app.listen(PORT, () => {
  log.info(`Titulky.com Stremio addon running on port ${PORT}${isDev ? " (DEV MODE)" : ""}`);
  log.info(`Configure at: http://localhost:${PORT}/configure`);

  // ── Self-ping: keep alive until midnight UTC, then sleep ────────
  const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes
  let pingTimer = null;
  let pingCount = 0;

  function msUntilMidnightUTC() {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    return midnight.getTime() - now.getTime();
  }

  function formatMs(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }

  function startPing() {
    if (pingTimer) return;
    const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const sleepIn = formatMs(msUntilMidnightUTC());
    pingCount = 0;
    logPing.info(`Keep-alive started -> ${host} (sleep in ${sleepIn})`);

    pingTimer = setInterval(async () => {
      const now = new Date();
      const hours = now.getUTCHours();

      if (hours === 0) {
        logPing.info(`Midnight UTC - stopping after ${pingCount} ping(s), going to sleep`);
        clearInterval(pingTimer);
        pingTimer = null;
        return;
      }

      try {
        await axios.get(`${host}/`, { timeout: 10000 });
        pingCount++;
        const sleepIn = formatMs(msUntilMidnightUTC());
        logPing.debug(`#${pingCount} OK (${now.toISOString().slice(11, 16)} UTC) - sleep in ${sleepIn}`);
      } catch (e) {
        logPing.error(`Failed: ${e.message}`);
      }
    }, PING_INTERVAL);
  }

  // Start pinging immediately on boot
  startPing();

  // If server wakes up after midnight sleep, restart pinging on first request
  app.use((req, res, next) => {
    if (!pingTimer) {
      logPing.info("Server woke up from sleep");
      startPing();
    }
    next();
  });
});
