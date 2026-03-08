const axios = require("axios");
const AdmZip = require("adm-zip");
const he = require("he");
const { URLSearchParams } = require("url");

class TitulkyClient {
  constructor(username, password) {
    this.serverUrl = "https://www.titulky.com";
    this.username = username;
    this.password = password;
    this.cookies = {};
    this.loggedIn = false;
    this.loginPromise = null;
    this.lastLoginTime = 0;
  }

  _parseCookiesFromHeaders(headers) {
    const setCookie = headers["set-cookie"];
    if (!setCookie) return;
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of arr) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) this.cookies[m[1].trim()] = m[2].trim();
    }
  }

  _cookieString() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  async _request(url, opts = {}) {
    const config = {
      url,
      method: opts.method || "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "cs,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        Cookie: this._cookieString(),
        ...opts.headers,
      },
      maxRedirects: 5,
      responseType: opts.responseType || "text",
      decompress: true,
      validateStatus: () => true,
      timeout: 30000,
    };
    if (opts.data) config.data = opts.data;
    if (opts.referer) config.headers["Referer"] = opts.referer;
    const res = await axios(config);
    this._parseCookiesFromHeaders(res.headers);
    return res;
  }

  // ── Login ───────────────────────────────────────────────────────

  async login() {
    if (this.loggedIn && Date.now() - this.lastLoginTime < 30 * 60 * 1000) return true;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this._doLogin();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async _doLogin() {
    if (!this.username) return false;
    console.log("[Titulky] Logging in…");
    const params = new URLSearchParams({
      Login: this.username,
      Password: this.password,
      foreverlog: "0",
      Detail2: "",
    });
    const res = await this._request(`${this.serverUrl}/index.php`, {
      method: "POST",
      data: params.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: this.serverUrl },
    });
    const content = typeof res.data === "string" ? res.data : "";
    if (content.includes("BadLogin")) {
      console.log("[Titulky] Login failed");
      this.loggedIn = false;
      return false;
    }
    this.loggedIn = true;
    this.lastLoginTime = Date.now();
    console.log("[Titulky] Login OK");
    return true;
  }

  // ── Search (multi-strategy) ─────────────────────────────────────

  async search(titles) {
    // titles is an array of search strings to try in order
    if (!Array.isArray(titles)) titles = [titles];
    await this.login();

    for (const title of titles) {
      if (!title || title.length < 2) continue;

      const results = await this._searchStandard(title);
      if (results.length > 0) return results;
    }

    return [];
  }

  async _searchStandard(title) {
    const url = `${this.serverUrl}/?` + new URLSearchParams({ Fulltext: title });
    console.log(`[Titulky] Search: ${url}`);
    const res = await this._request(url);
    const content = typeof res.data === "string" ? res.data : "";
    if (content.includes("Nenalezena ani jedna")) {
      console.log("[Titulky] No results");
      return [];
    }
    return this._parseSearchResults(content);
  }

  // ── Parse results ───────────────────────────────────────────────

  _parseSearchResults(content) {
    let subtitles = [];

    // Method 1: table rows with class="r..."
    const rowRe = /<tr\s+class="r[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRe.exec(content)) !== null) {
      try {
        const sub = this._parseTableRow(m[1]);
        if (sub) subtitles.push(sub);
      } catch (e) {
        /* skip */
      }
    }

    // Method 2: link-based fallback
    if (subtitles.length === 0) {
      console.log("[Titulky] No table rows, trying link-based parse…");
      subtitles = this._parseLinkBased(content);
    }

    console.log(`[Titulky] Found ${subtitles.length} subtitle(s)`);
    if (subtitles.length > 0) {
      console.log(
        "[Titulky] First:",
        subtitles.slice(0, 3).map((s) => `"${s.title}" [${s.id}]`),
      );
    }
    return subtitles;
  }

  _parseTableRow(row) {
    const linkMatch = row.match(/href="\/?([\w][\w.+-]*-(\d{3,}))\.htm"/i);
    if (!linkMatch) return null;
    const linkFile = linkMatch[1];
    const id = linkMatch[2];

    // title
    const titleMatch = row.match(/<a[^>]+>(?:<div[^>]+>)?([^<]+)/i);
    const title = titleMatch ? he.decode(titleMatch[1].trim()) : linkFile;

    // version
    let version = null;
    const verMatch = row.match(/title="([^"]{3,})"/i);
    if (verMatch) version = he.decode(verMatch[1]);

    // language
    let lang = "cze";
    const langMatch = row.match(/<img[^>]+alt="(\w{2})"/i);
    if (langMatch) {
      const c = langMatch[1].toUpperCase();
      if (c === "SK") lang = "slo";
      else if (c === "CZ") lang = "cze";
    }

    // download count
    let downCount = 0;
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(row)) !== null) cells.push(cm[1]);
    if (cells.length > 4) {
      const n = parseInt(cells[4].replace(/<[^>]+>/g, "").trim(), 10);
      if (n > 0) downCount = n;
    }

    // size
    let size = null;
    if (cells.length > 7) {
      const sm = cells[7].match(/([\d.]+)/);
      if (sm) size = parseFloat(sm[1]);
    }

    // author
    let author = null;
    if (cells.length > 8) {
      const am = cells[8].match(/<a[^>]+>([^<]+)/i);
      if (am) author = am[1].trim();
    }

    return { id, linkFile, title, version, lang, downCount, size, author };
  }

  _parseLinkBased(content) {
    const subtitles = [];
    const seen = new Set();
    // Match links like href="/Some-Movie-Name-123456.htm" or href="Some-Movie-Name-123456.htm"
    const re = /<a\s+[^>]*href="\/?([\w][\w.+-]*-(\d{3,}))\.htm"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(content)) !== null) {
      const linkFile = m[1];
      const id = m[2];
      const rawTitle = m[3].replace(/<[^>]+>/g, "").trim();

      if (seen.has(id)) continue;
      // Skip non-subtitle pages
      if (/precti-si|pozadavek|internetova|podivej|napoveda|forum|prispevek|reklama/i.test(linkFile)) continue;

      seen.add(id);
      subtitles.push({
        id,
        linkFile,
        title: he.decode(rawTitle) || linkFile.replace(/-\d+$/, "").replace(/-/g, " "),
        version: null,
        lang: "cze",
        downCount: 0,
        size: null,
        author: null,
      });
    }
    return subtitles;
  }

  // ── Download ────────────────────────────────────────────────────

  async downloadSubtitle(subId, linkFile) {
    await this.login();
    console.log(`[Titulky] Download sub ${subId}`);

    const ts = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({ R: String(ts), titulky: subId, histstamp: "", zip: "z" });
    const downloadPageUrl = `${this.serverUrl}/idown.php?${params}`;
    const referer = `${this.serverUrl}/${linkFile}.htm`;

    const res = await this._request(downloadPageUrl, { referer });
    const content = typeof res.data === "string" ? res.data : "";

    // Captcha check
    if (/captcha\/captcha\.php/i.test(content)) {
      console.log("[Titulky] Captcha required");
      return null;
    }

    // Wait time
    let waitTime = 0;
    const wm = content.match(/CountDown\((\d+)\)/i);
    if (wm) waitTime = parseInt(wm[1], 10);

    // Download link
    const lm =
      content.match(/<a[^>]+id=["']?downlink["']?[^>]+href=["']([^"']+)["']/i) ||
      content.match(/href=["']([^"']+)["'][^>]*id=["']?downlink["']?/i);
    if (!lm) {
      console.log("[Titulky] No download link found");
      console.log("[Titulky] Page snippet:", content.substring(0, 500));
      return null;
    }
    const downloadLink = lm[1].startsWith("http") ? lm[1] : this.serverUrl + lm[1];

    if (waitTime > 0) {
      console.log(`[Titulky] Waiting ${waitTime}s…`);
      await new Promise((r) => setTimeout(r, waitTime * 1000));
    }

    console.log(`[Titulky] Downloading ${downloadLink}`);
    const zipRes = await this._request(downloadLink, {
      referer: `${this.serverUrl}/idown.php`,
      responseType: "arraybuffer",
    });

    if (!zipRes.data || zipRes.data.length < 50) {
      console.log("[Titulky] Download too small");
      return null;
    }

    return this._extractSubtitles(Buffer.from(zipRes.data));
  }

  _extractSubtitles(zipBuffer) {
    const exts = [".srt", ".sub", ".txt", ".smi", ".ssa", ".ass"];
    try {
      const zip = new AdmZip(zipBuffer);
      const results = [];
      for (const entry of zip.getEntries()) {
        const ext = "." + entry.entryName.split(".").pop().toLowerCase();
        if (exts.includes(ext) && !entry.isDirectory) {
          results.push({ filename: entry.entryName, content: entry.getData() });
        }
      }
      results.sort((a, b) => {
        const as = a.filename.toLowerCase().endsWith(".srt") ? 0 : 1;
        const bs = b.filename.toLowerCase().endsWith(".srt") ? 0 : 1;
        return as - bs;
      });
      console.log(`[Titulky] Extracted ${results.length} file(s)`);
      return results;
    } catch (e) {
      console.error("[Titulky] Zip error:", e.message);
      return null;
    }
  }
}

module.exports = TitulkyClient;
