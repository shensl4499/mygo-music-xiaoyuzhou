// 小宇宙 source for MyGo Music.
// MyGo supplies `host` and `fetch`; this module has no Node dependencies.

const SITE = "https://www.xiaoyuzhoufm.com";
// Audio only ever comes from the platform's own CDN. An RSS enclosure may point
// somewhere else; that host is not in the network permission and not followed.
const MEDIA_HOST = /^https:\/\/media\.xyzcdn\.net\//;

function text(value) {
  return typeof value === "string" ? value : "";
}

function object(value) {
  return value && typeof value === "object" ? value : {};
}

// The platform's images carry several sizes; the middle one suits a card.
function pickImage(image) {
  const pic = object(image);
  return text(pic.middlePicUrl) || text(pic.picUrl) || text(pic.largePicUrl) || text(pic.smallPicUrl);
}

// An episode's own image is usually null, so its show's cover stands in.
export function imageOf(item) {
  const own = pickImage(object(item).image);
  if (own) return own;
  return pickImage(object(object(item).podcast).image);
}

// Shownotes are HTML. MyGo shows a plain description, so tags go and entities
// are decoded. &amp; is decoded last, or "&amp;lt;" would become "<".
export function cleanNotes(html) {
  let s = text(html);
  if (!s) return "";
  s = s.replace(/<img\b[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote)\s*>/gi, "\n");
  s = s.replace(/<[^>]*>/g, "");
  s = s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  s = s.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Why the listener can't play this, or "" when they can. An absent payType is
// not a restriction: only an explicit one is.
export function unavailableReason(episode) {
  const e = object(episode);
  const pay = text(e.payType).toUpperCase();
  if (pay && pay !== "FREE") return "付费单集，请在小宇宙 App 内收听";
  if (e.isPrivateMedia === true) return "私密单集，无法播放";
  if (text(e.status) && text(e.status) !== "NORMAL") return "单集已下架";
  if (e.isPlayable === false) return "小宇宙标记该单集暂不可播放";
  return "";
}

export function mediaOf(episode) {
  const e = object(episode);
  const media = object(e.media);
  const backup = object(media.backupSource);
  const candidates = [
    text(object(e.enclosure).url),
    text(object(media.source).url),
    text(media.url),
  ];
  if (text(backup.mode) === "PUBLIC") candidates.push(text(backup.url));
  for (const url of candidates) {
    if (MEDIA_HOST.test(url)) return url;
  }
  return "";
}

const API = "https://api.xiaoyuzhoufm.com";
const WEB_API = "https://web-api.xiaoyuzhoufm.com";
const UA = "MyGoMusic-Xiaoyuzhou/0.1.0 (unofficial podcast plugin)";
const SESSION_KEY = "session";

// Only these POSTs are reads. Anything else might already have taken effect,
// so a failure is never replayed automatically.
const READ_POSTS = new Set([
  "/v1/episode/list",
  "/v1/episode/list-by-filter",
  "/v1/related-podcast/list",
  "/v1/search/create",
  "/v1/subscription/list",
  "/v1/inbox/list",
  "/v1/favorite/list",
  "/v1/episode-played/list-history",
  "/v1/playback-progress/list",
  "/v1/comment/list-primary",
  "/v1/comment/list-thread",
  "/v1/discovery-feed/list",
  "/v1/category/list-all",
  "/v1/category/podcast/list-tabs",
  "/v1/category/podcast/list-by-tab",
  "/v1/podcaster/owned-podcasts",
]);

const QR_POLL = "/v1/auth/qrcode/login";
const MIDWAY_APP_ID = "v6worU4NnWyL";
const QR_CLIENT_ID = "podcaster-platform";
const QR_POLL_MS = 1500;
const QR_WAIT_MS = 180000;

const cooldown = new Map();
let sessionCache;
let deviceCache;

export function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// MyGo holds its storage mutex while importing this module, so every host call
// happens inside an action, never at the top level.
export function currentSession() {
  if (sessionCache === undefined) sessionCache = host.storage.get(SESSION_KEY) || null;
  return sessionCache;
}

function saveSession(next) {
  sessionCache = next;
  if (next) host.storage.set(SESSION_KEY, next);
  else host.storage.remove(SESSION_KEY);
}

// One identifier for this installation. inbox/favorite/comment reject requests
// without it, so it is persisted rather than regenerated per call.
export function deviceID() {
  if (deviceCache) return deviceCache;
  let id = host.storage.get("deviceId");
  if (!id) {
    const hex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    id = `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
    host.storage.set("deviceId", id);
  }
  deviceCache = id;
  return id;
}

function retryAfter(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(n || 1, 86400);
  const at = Date.parse(raw || "");
  if (Number.isFinite(at)) return Math.min(Math.max(Math.ceil((at - Date.now()) / 1000), 1), 86400);
  return 60;
}

function businessError(env) {
  if (!env || typeof env !== "object") return "小宇宙返回了无效数据";
  if (env.success === false) return env.toast || env.message || "小宇宙未接受该请求";
  if (env.error) return "小宇宙返回业务错误";
  const code = Number(env.code);
  if (Number.isFinite(code) && code !== 0 && code !== 200) {
    return env.toast || env.message || `小宇宙接口返回错误（${code}）`;
  }
  return "";
}

async function request(origin, path, { method, body, query, headers = {}, auth = false, retryable = false, token, withHeaders = false } = {}) {
  let url = origin + path;
  if (query) {
    const parts = [];
    for (const k of Object.keys(query)) {
      if (query[k] === undefined || query[k] === null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`);
    }
    if (parts.length) url += `?${parts.join("&")}`;
  }
  const wait = (cooldown.get(origin) || 0) - Date.now();
  if (wait > 0) throw new Error(`小宇宙限制了请求频率，请 ${Math.ceil(wait / 1000)} 秒后再试`);

  const verb = method || (body === undefined ? "GET" : "POST");
  const init = { method: verb, headers: { Accept: "application/json, text/html;q=0.8", "User-Agent": UA, ...headers } };
  if (verb !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body === undefined ? {} : body);
  }
  if (token) {
    init.headers["x-jike-access-token"] = token;
  } else if (auth) {
    const s = currentSession();
    if (!s || !s.accessToken) throw fail("signIn", "请先连接小宇宙账号");
    init.headers["x-jike-access-token"] = s.accessToken;
  }
  if (origin === API) init.headers["x-jike-device-id"] = deviceID();

  const attempts = retryable ? 3 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const remaining = (cooldown.get(origin) || 0) - Date.now();
      if (remaining > 0) throw new Error(`小宇宙限制了请求频率，请稍后再试`);
      await new Promise((r) => setTimeout(r, attempt * 250));
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      // Never put the request headers, and so the token, into an error.
      lastError = new Error("无法连接小宇宙，请检查网络后重试");
      continue;
    }
    if (res.status === 429) {
      const delay = retryAfter(res.headers.get("Retry-After"));
      cooldown.set(origin, Date.now() + delay * 1000);
      throw new Error(`小宇宙限制了请求频率，请 ${delay} 秒后再试`);
    }
    if (res.status === 401) {
      // The QR poll reports an expired code as 401 with code 21 in the body.
      if (path === QR_POLL) {
        let env;
        try {
          env = await res.json();
        } catch {
          env = null;
        }
        if (env && Number(env.code) === 21) throw new Error("二维码已失效，请重新生成");
      }
      throw fail("signIn", "小宇宙登录已失效，请重新连接账号");
    }
    if (res.status >= 500) {
      lastError = new Error("小宇宙服务暂时不可用，请稍后再试");
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`小宇宙未接受该请求（HTTP ${res.status}）`);
    }
    let env;
    try {
      env = await res.json();
    } catch {
      lastError = new Error("小宇宙返回了无法解析的数据");
      continue;
    }
    const problem = businessError(env);
    if (problem) throw new Error(problem);
    return withHeaders ? { env, headers: res.headers } : env;
  }
  throw lastError || new Error("小宇宙请求未完成");
}

// Credentials arrive in the response headers; the body only carries status.
// Set-Cookie and a body copy are fallbacks the official web client also reads.
function credentialsFrom(env, headers) {
  const pick = (name) => {
    const fromHeader = headers && headers.get(name);
    if (fromHeader) return fromHeader;
    const cookie = (headers && headers.getSetCookie && headers.getSetCookie()) || [];
    for (const line of cookie) {
      const pair = String(line).split(";", 1)[0];
      const at = pair.indexOf("=");
      if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1);
    }
    const data = object(env.data);
    return text(env[name]) || text(data[name]);
  };
  return { accessToken: pick("x-jike-access-token"), refreshToken: pick("x-jike-refresh-token") };
}

function toAccount(profile) {
  const p = object(profile);
  if (!text(p.uid)) return null;
  return {
    id: text(p.uid),
    name: text(p.nickname) || "小宇宙用户",
    imageUrl: pickImage(object(p.avatar).picture),
  };
}

export async function signIn() {
  host.signInPrompt({ text: "正在生成小宇宙登录二维码…" });
  const qr = await webApi("/v1/auth/qrcode/create", { clientId: QR_CLIENT_ID }, { headers: { "x-midway-app-id": MIDWAY_APP_ID } });
  const url = text(qr.url);
  if (!text(qr.id) || !/^https:\/\/h5\.xiaoyuzhoufm\.com\/oauth\?/.test(url)) {
    throw new Error("小宇宙没有返回有效的登录二维码，请稍后重试");
  }
  host.signInPrompt({ qr: url, text: "请用小宇宙 App 的「扫一扫」扫描，并在手机上确认" });
  const deadline = Date.now() + QR_WAIT_MS;
  for (;;) {
    const { env, headers } = await request(WEB_API, QR_POLL, { body: { id: text(qr.id) }, withHeaders: true });
    const status = text(env.status);
    if (status === "CONFIRMED" || status === "USED") {
      const creds = credentialsFrom(env, headers);
      if (!creds.accessToken || !creds.refreshToken) {
        throw new Error("扫码已确认，但小宇宙没有返回完整凭据，请重新扫码");
      }
      const me = await api("/v1/profile/get", { method: "GET", token: creds.accessToken });
      const account = toAccount(object(me.data));
      if (!account) throw new Error("无法核对已登录的小宇宙账号，请重新扫码");
      clearAccountState();
      saveSession({ ...creds, account });
      host.signInPrompt({ text: `已连接：${account.name}` });
      return account;
    }
    if (status === "SCANNED") host.signInPrompt({ qr: url, text: "已扫码，请在手机上确认登录" });
    else if (status !== "WAITTING") throw new Error("小宇宙返回了未知的扫码状态");
    if (Date.now() >= deadline) throw new Error("扫码登录超时，请重新生成二维码");
    await new Promise((r) => setTimeout(r, QR_POLL_MS));
  }
}

// Everything that belongs to one account, not to the plugin installation.
// Called on sign-out AND before a new sign-in, so re-login as a different
// account (without signing out first) cannot inherit the old account's likes,
// subscription status, cached episodes or rate-limit cooldown.
function clearAccountState() {
  cursors.clear();
  favoriteIds.clear();
  favoriteWrites.clear();
  favoritesLoaded = false;
  showCache.clear();
  episodeCache.clear();
  cooldown.clear();
  refreshInFlight = null;
}

// 退出只影响本插件，且必须丢掉上一个账号的一切状态。
export function signOut() {
  saveSession(null);
  clearAccountState();
}

export async function account() {
  const s = currentSession();
  if (!s || !s.accessToken) return null;
  if (s.account) return s.account;
  try {
    const me = await api("/v1/profile/get", { method: "GET" });
    const who = toAccount(object(me.data));
    if (!who) {
      saveSession(null);
      return null;
    }
    saveSession({ ...s, account: who });
    return who;
  } catch (e) {
    if (e.code === "signIn") return null;
    throw e;
  }
}

// A stale access token is routine. Renew once, then let the caller decide
// whether the original request may be replayed.
// Three parallel reads can all hit 401 at once. Only one renewal may be in
// flight: the platform rotates the refresh token, so concurrent renewals would
// race and the loser could clear the good session the winner just saved.
let refreshInFlight = null;

async function doRefresh() {
  const s = currentSession();
  if (!s || !s.refreshToken) throw fail("signIn", "请先连接小宇宙账号");
  let pair;
  try {
    pair = await request(API, "/app_auth_tokens.refresh", {
      method: "POST",
      body: {},
      headers: { "x-jike-access-token": s.accessToken, "x-jike-refresh-token": s.refreshToken },
      withHeaders: true,
    });
  } catch (e) {
    if (e.code === "signIn") {
      saveSession(null);
      throw fail("signIn", "小宇宙登录已失效，请重新连接账号");
    }
    throw e;
  }
  const creds = credentialsFrom(pair.env, pair.headers);
  if (!creds.accessToken) {
    saveSession(null);
    throw fail("signIn", "小宇宙续期失败，请重新连接账号");
  }
  saveSession({ ...s, accessToken: creds.accessToken, refreshToken: creds.refreshToken || s.refreshToken });
}

async function refresh() {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function api(path, options = {}) {
  const method = options.method || (options.body === undefined ? "GET" : "POST");
  const retryable = method === "GET" || READ_POSTS.has(path);
  try {
    return await request(API, path, { ...options, method, auth: true, retryable });
  } catch (e) {
    if (e.code !== "signIn" || options.token || !currentSession()) throw e;
    await refresh();
    // A write may already have taken effect before the 401: never replay it.
    // The session is fine now — a plain retry hint, NOT signIn (which would
    // make the host pop a login dialog for a logged-in listener).
    if (!retryable) throw new Error("登录已续期，请重新操作一次");
    return request(API, path, { ...options, method, auth: true, retryable });
  }
}

// MyGo asks for a whole list here, with no offset, so the pages are drained.
// The cap keeps a very large library from running past the host's call budget.
const DRAIN_CAP = 500;

export async function shows() {
  const scope = "subscriptions";
  resetScope(scope);
  const out = [];
  let offset = 0;
  for (;;) {
    const key = keyFor(scope, offset);
    const body = { limit: 20, sortOrder: "desc", sortBy: "subscribedAt" };
    if (key !== undefined) body.loadMoreKey = key;
    const page = pageOf(await api("/v1/subscription/list", { body }), { scope, offset });
    for (const p of page.items) out.push(toShow(p));
    offset += page.items.length;
    if (!page.more) break;
    if (out.length >= DRAIN_CAP) throw new Error(`订阅过多，已加载前 ${out.length} 档，请用搜索查找其余播客`);
  }
  return out;
}

const showCache = new Map();

export async function show({ id, offset = 0 }) {
  const pid = text(id);
  if (!pid) throw fail("unavailable", "没有这个播客");
  const scope = `episodes:${pid}`;
  if (offset === 0) resetScope(scope);
  let meta = showCache.get(pid);
  if (!meta || offset === 0) {
    meta = object((await api("/v1/podcast/get", { method: "GET", query: { pid } })).data);
    showCache.set(pid, meta);
  }
  const body = { pid, limit: "20", order: "desc" };
  const key = keyFor(scope, offset);
  if (key !== undefined) body.loadMoreKey = key;
  const page = pageOf(await api("/v1/episode/list", { body }), { scope, offset });
  return { show: toShow(meta), episodes: page.items.map(toTrack), more: page.more };
}

export async function subscribeShow({ id, on }) {
  const pid = text(id);
  if (!pid) throw fail("unavailable", "没有这个播客");
  const mode = on ? "ON" : "OFF";
  const env = await api("/v1/subscription/update", { body: { pid, mode } });
  const data = object(env.data);
  // HTTP acceptance is not confirmation: the platform answers with the show.
  if (text(data.pid) !== pid || text(data.subscriptionStatus) !== mode) {
    throw new Error("订阅结果未确认，请在小宇宙 App 内核对后再试");
  }
  showCache.set(pid, data);
  resetScope("subscriptions");
}

const SEARCH_TYPES = { shows: "PODCAST", tracks: "EPISODE" };
const ID = "[0-9a-f]{24}";
const LINK = new RegExp(`xiaoyuzhoufm\\.com/(podcast|episode)/(${ID})`, "i");
// The app shares a short link, which answers where the real one is.
const SHORT = /(?:https?:\/\/)?xyzfm\.link\/([A-Za-z0-9_-]+)/i;

function directLink(value) {
  const m = LINK.exec(text(value));
  if (!m) return null;
  return { kind: m[1].toLowerCase() === "podcast" ? "podcast" : "episode", id: m[2].toLowerCase() };
}

// A pasted link is an exact hit. A bare id is ambiguous between a show and an
// episode, so only a link that names which it is counts. A short link is not
// opened here: search follows it, being the one that can await.
export function parseLink(value) {
  const direct = directLink(text(value));
  if (direct) return direct;
  const short = SHORT.exec(text(value));
  if (!short) return null;
  return { kind: "short", url: `https://xyzfm.link/${short[1]}` };
}

async function podcastById(pid) {
  return object((await api("/v1/podcast/get", { method: "GET", query: { pid } })).data);
}

async function episodeById(eid) {
  return object((await api("/v1/episode/get", { method: "GET", query: { eid } })).data);
}

function headerOf(res, name) {
  if (!res || !res.headers || typeof res.headers.get !== "function") return "";
  return text(res.headers.get(name));
}

// A short link answers a redirect to the page it stands for, which is read
// here rather than followed: the id it lands with is all the API needs, and
// the plugin then never opens the site itself. One that answers a page
// instead keeps the same address in its body, the last place looked. Nothing
// here is fatal: a short link that names nothing falls back to a plain search.
const HOPS = 3;

function absolute(target, base) {
  if (/^https?:\/\//i.test(target)) return target;
  const origin = /^(https?:\/\/[^/]+)/i.exec(base);
  if (!origin) return "";
  return origin[1] + (target.charAt(0) === "/" ? target : `/${target}`);
}

async function resolveShort(url) {
  let next = url;
  for (let hop = 0; hop < HOPS && next; hop++) {
    let res;
    try {
      res = await fetch(next, { method: "GET", redirect: "manual", headers: { Accept: "text/html", "User-Agent": UA } });
    } catch {
      return null;
    }
    const target = headerOf(res, "Location");
    const found = directLink(text(res.url)) || directLink(target);
    if (found) return found;
    if (!target) {
      if (!res.ok) return null;
      let body;
      try {
        body = await res.text();
      } catch {
        return null;
      }
      return directLink(text(body));
    }
    next = absolute(target, next);
  }
  return null;
}

// MyGo renders only the active tab's field, so a link has to answer in the kind
// that was asked for: a show link on the songs tab gives its episodes.
async function linkResult(link, kind) {
  const empty = { [kind]: [], more: false };
  if (link.kind === "podcast") {
    if (kind === "shows") return { shows: [toShow(await podcastById(link.id))], more: false };
    const env = await api("/v1/episode/list", { body: { pid: link.id, limit: "20", order: "desc" } });
    const items = Array.isArray(env.data) ? env.data : [];
    return { tracks: items.map(toTrack), more: false };
  }
  const episode = await episodeById(link.id);
  if (!text(episode.eid)) return empty;
  if (kind === "tracks") return { tracks: [toTrack(episode)], more: false };
  const embedded = object(episode.podcast);
  const pid = text(embedded.pid) || text(episode.pid);
  const show = text(embedded.title) ? embedded : await podcastById(pid);
  return { shows: [toShow(show)], more: false };
}

export async function search({ query, kind = "tracks", offset = 0 }) {
  const type = SEARCH_TYPES[kind];
  if (!type) throw fail("unsupported", "小宇宙只支持搜索播客和单集");
  const q = text(query).trim();
  if (!q) return { [kind]: [], more: false };
  let link = parseLink(q);
  if (link) {
    if (offset > 0) return { [kind]: [], more: false };
    if (link.kind === "short") link = await resolveShort(link.url);
    if (link) return linkResult(link, kind);
  }
  const scope = `search:${kind}:${q}`;
  if (offset === 0) resetScope(scope);
  const body = { keyword: q, type, limit: "20", sourcePageName: "4", currentPageName: "4" };
  const key = keyFor(scope, offset);
  if (key !== undefined) body.loadMoreKey = key;
  const page = pageOf(await api("/v1/search/create", { body }), { scope, offset });
  return { [kind]: page.items.map(kind === "shows" ? toShow : toTrack), more: page.more };
}

export async function suggest() {
  const env = await api("/v1/search/get-preset", { method: "GET" });
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(env.data) ? env.data : []) {
    const word = text(object(row).text).trim();
    if (word && !seen.has(word)) {
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}

const episodeCache = new Map();
const favoriteIds = new Set();
// A write the platform just confirmed is newer than any list we hold. It wins
// until a fresh list says the same thing, when the override is dropped.
const favoriteWrites = new Map();
let favoritesLoaded = false;

async function cachedEpisode(eid) {
  if (episodeCache.has(eid)) return episodeCache.get(eid);
  const e = await episodeById(eid);
  if (text(e.eid)) episodeCache.set(eid, e);
  return e;
}

export async function stream({ id }) {
  const eid = text(id);
  if (!eid) throw fail("unavailable", "没有这个单集");
  const e = await cachedEpisode(eid);
  const why = unavailableReason(e);
  if (why) throw fail("unavailable", why);
  const url = mediaOf(e);
  if (!url) throw fail("unavailable", "该单集没有可播放的音频地址");
  const size = Number(object(e.media).size);
  const out = { url, type: "m4a" };
  if (Number.isFinite(size) && size > 0) out.size = size;
  return out;
}

// Marking an episode played is best effort: it must never interrupt playback.
export async function played({ id }) {
  const eid = text(id);
  if (!eid) return;
  try {
    await api("/v1/episode-played/create", { body: { eid } });
  } catch (e) {
    console.warn(`xiaoyuzhou: 标记已播失败 ${eid}: ${e.message}`);
  }
}

export async function liked({ offset = 0 }) {
  const scope = "favorites";
  if (offset === 0) resetScope(scope);
  const body = { limit: 20 };
  const key = keyFor(scope, offset);
  if (key !== undefined) body.loadMoreKey = key;
  const page = pageOf(await api("/v1/favorite/list", { body }), { scope, offset });
  if (offset === 0) favoriteIds.clear();
  for (const e of page.items) {
    const eid = text(object(e).eid);
    favoriteIds.add(eid);
    if (favoriteWrites.get(eid) === true) favoriteWrites.delete(eid);
  }
  if (!page.more) {
    favoritesLoaded = true;
    for (const [eid, on] of favoriteWrites) {
      if (on === false && !favoriteIds.has(eid)) favoriteWrites.delete(eid);
    }
  }
  return { tracks: page.items.map(toTrack), more: page.more };
}

async function loadFavorites() {
  if (favoritesLoaded) return;
  let offset = 0;
  for (;;) {
    const page = await liked({ offset });
    offset += page.tracks.length;
    if (!page.more) return;
    if (offset >= DRAIN_CAP) return;
  }
}

export async function isLiked({ ids }) {
  await loadFavorites();
  const out = {};
  for (const id of ids || []) {
    const eid = text(id);
    out[id] = favoriteWrites.has(eid) ? favoriteWrites.get(eid) : favoriteIds.has(eid);
  }
  return out;
}

export async function likeEpisode({ id, on }) {
  const eid = text(id);
  if (!eid) throw fail("unavailable", "没有这个单集");
  await api("/v1/favorite/update", { body: { eid, favorited: !!on, sourcePageName: 8, currentPageName: 9 } });
  favoriteWrites.set(eid, !!on);
  if (on) favoriteIds.add(eid);
  else favoriteIds.delete(eid);
  resetScope("favorites");
}

// Browse has no offset, so a continuation cursor rides in the page string.
const PAGE_SEP = "~";

function pageName(base, key) {
  return key === undefined ? base : `${base}${PAGE_SEP}${encodeURIComponent(JSON.stringify(key))}`;
}

function splitPage(page) {
  const at = page.indexOf(PAGE_SEP);
  if (at < 0) return { base: page, key: undefined };
  try {
    return { base: page.slice(0, at), key: JSON.parse(decodeURIComponent(page.slice(at + 1))) };
  } catch {
    throw fail("unavailable", "页面地址已失效，请重新进入");
  }
}

function requireSession() {
  const s = currentSession();
  if (!s || !s.accessToken) throw fail("signIn", "请先连接小宇宙账号");
  return s;
}

async function inboxPage(key) {
  const body = { limit: "20" };
  if (key !== undefined) body.loadMoreKey = key;
  const env = await api("/v1/inbox/list", { body });
  const items = Array.isArray(env.data) ? env.data : [];
  // The cursor alone decides whether there is more: a page that came back
  // empty with a cursor after it is the platform misbehaving, not the end.
  return { tracks: items.map(toTrack), key: env.loadMoreKey, more: env.loadMoreKey != null };
}

async function historyPage(key) {
  const body = { limit: "20" };
  if (key !== undefined) body.loadMoreKey = key;
  const env = await api("/v1/episode-played/list-history", { body });
  const items = Array.isArray(env.data) ? env.data : [];
  const tracks = items.map((row) => object(row).episode).filter((e) => text(object(e).eid)).map(toTrack);
  return { tracks, key: env.loadMoreKey, more: env.loadMoreKey != null };
}

// A browse page takes no offset, so one load has to stand for "all" by
// itself. The platform answers a page at a time — 15 updates, 20 plays — and
// ignores a larger limit, so "See All" shows a single page unless the pages
// are drained here.
//
// There is a ceiling on purpose. A listener with years of updates has
// thousands of them: the pages to reach the end would take far longer than
// the host allows one call, and past a few hundred the list is no longer
// something anyone scrolls. So the drain stops at SEE_ALL_LIMIT and says so,
// rather than paging on for ever or quietly pretending that's all there is.
const SEE_ALL_LIMIT = 300;

async function drained(label, fetchPage) {
  const out = [];
  const seen = new Set();
  let cursor;
  for (;;) {
    const p = await fetchPage(cursor);
    if (!p.tracks.length) {
      // An empty page with a cursor after it is the platform misbehaving, not
      // the end of the list.
      if (p.more) throw new Error(`${label}返回了空页，请稍后再试`);
      return { tracks: out, capped: false };
    }
    for (const t of p.tracks) {
      // An entry without an id can't be played or told apart from another.
      if (!t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    if (!p.more) return { tracks: out, capped: false };
    if (out.length >= SEE_ALL_LIMIT) return { tracks: out.slice(0, SEE_ALL_LIMIT), capped: true };
    cursor = p.key;
  }
}

// The discovery feed is a list of typed blocks; only the two that hold
// episodes are used, and an unfamiliar block is skipped rather than guessed at.
function discoveryEpisodes(env, type) {
  const out = [];
  for (const block of Array.isArray(env.data) ? env.data : []) {
    const b = object(block);
    if (text(b.type) !== type) continue;
    const data = object(b.data);
    const rows = type === "EDITOR_PICK" ? data.picks : data.target;
    for (const row of Array.isArray(rows) ? rows : []) {
      const e = object(object(row).episode);
      if (text(e.eid)) out.push(toTrack(e));
    }
  }
  return out;
}

export async function home() {
  const s = currentSession();
  if (!s || !s.accessToken) {
    return {
      title: "小宇宙",
      subtitle: "连接账号后就能听你的订阅",
      sections: [{
        title: "连接账号",
        links: [{ title: "连接小宇宙账号", subtitle: "用小宇宙 App 扫码登录", page: "connect" }],
      }],
    };
  }
// Sections are optional: one failing must not blank the page. An expired
// session is different — it has to reach the host so it can offer sign-in.
  const optional = (p, fallback) =>
    p.catch((e) => {
      if (e.code === "signIn") throw e;
      return fallback;
    });
  const [inbox, subs, feed] = await Promise.all([
    optional(inboxPage(undefined), { tracks: [] }),
    optional(api("/v1/subscription/list", { body: { limit: 20, sortOrder: "desc", sortBy: "subscribedAt" } }), { data: [] }),
    optional(api("/v1/discovery-feed/list", { body: { returnAll: "false" } }), { data: [] }),
  ]);
  const sections = [
    { title: "订阅更新", tracks: inbox.tracks.slice(0, 10), morePage: "updates", empty: "订阅的播客还没有新单集" },
    { title: "我的订阅", shows: (Array.isArray(subs.data) ? subs.data : []).slice(0, 12).map(toShow), empty: "还没有订阅任何播客" },
  ];
  const picks = discoveryEpisodes(feed, "EDITOR_PICK");
  if (picks.length) sections.push({ title: "编辑精选", tracks: picks });
  const recommended = discoveryEpisodes(feed, "DISCOVERY_EPISODE_RECOMMEND");
  if (recommended.length) sections.push({ title: "大家都在听", tracks: recommended });
  sections.push({ title: "探索", links: [{ title: "按分类浏览", subtitle: "找到下一档想听的播客", page: "categories" }, { title: "收听历史", page: "history" }] });
  return { title: "小宇宙", subtitle: s.account ? s.account.name : "", sections };
}

export async function browse({ page }) {
  requireSession();
  const { base, key } = splitPage(text(page));
  if (base === "connect") {
    requireSession();
    const s = currentSession();
    return {
      title: s.account ? s.account.name : "小宇宙",
      sections: [{ title: "已连接", links: [{ title: "按分类浏览", page: "categories" }] }],
    };
  }
  if (base === "updates") {
    const p = await drained("订阅更新", inboxPage);
    return {
      title: "订阅更新",
      description: p.capped ? `只列出最近 ${SEE_ALL_LIMIT} 条更新，更早的内容请在小宇宙 App 内查看` : undefined,
      sections: [{ tracks: p.tracks, empty: "没有更多更新了" }],
    };
  }
  if (base === "history") {
    const p = await drained("收听历史", historyPage);
    return {
      title: "收听历史",
      description: p.capped ? `只列出最近 ${SEE_ALL_LIMIT} 条记录，更早的内容请在小宇宙 App 内查看` : undefined,
      sections: [{ tracks: p.tracks, empty: "还没有收听记录" }],
    };
  }
  if (base === "categories") {
    const env = await api("/v1/category/list-all", { body: {} });
    const links = (Array.isArray(env.data) ? env.data : []).map((c) => ({
      title: text(object(c).name),
      imageUrl: pickImage(object(c).icon),
      page: `category:${text(object(c).id)}`,
    }));
    return { title: "分类", sections: [{ links }] };
  }
  if (base.startsWith("category:")) {
    const categoryId = base.slice("category:".length);
    const body = { categoryId, tab: "ALL", omitSubscribed: false, loadMoreKey: key === undefined ? 0 : key };
    const env = await api("/v1/category/podcast/list-by-tab", { body });
    const items = Array.isArray(env.data) ? env.data : [];
    const next = env.loadMoreKey;
    const more = items.length > 0 && next !== undefined && next !== null;
    return {
      title: "分类播客",
      sections: [{ shows: items.map((it) => toShow(object(it).podcast || it)), morePage: more ? pageName(base, next) : undefined, empty: "这个分类下没有播客" }],
    };
  }
  if (base.startsWith("podcaster:")) {
    const uid = base.slice("podcaster:".length);
    const [profile, owned] = await Promise.all([
      api("/v1/profile/get", { method: "GET", query: { uid } }),
      api("/v1/podcaster/owned-podcasts", { body: { uid } }),
    ]);
    const who = object(profile.data);
    const shows = (Array.isArray(owned.data) ? owned.data : []).map(toShow);
    return {
      title: text(who.nickname) || "小宇宙用户",
      imageUrl: pickImage(object(who.avatar).picture),
      description: text(who.bio),
      sections: [{ title: "TA 的播客", shows, empty: "TA 还没有发布播客" }],
    };
  }
  if (base.startsWith("popular:")) {
    const pid = base.slice("popular:".length);
    const env = await api("/v1/episode/list-by-filter", { body: { pid, label: "POPULAR" } });
    const items = Array.isArray(env.data) ? env.data : [];
    return { title: "最受欢迎的单集", sections: [{ tracks: items.map(toTrack), empty: "这档播客还没有热门单集" }] };
  }
  throw fail("unavailable", "没有这个页面");
}

function toComment(row) {
  const c = object(row);
  const author = object(c.author);
  const at = Date.parse(text(c.createdAt));
  const out = {
    id: text(c.id),
    author: text(author.nickname) || "小宇宙用户",
    avatarUrl: pickImage(object(author.avatar).picture),
    text: text(c.text),
    likes: Number(c.likeCount) || 0,
    liked: c.liked === true,
  };
  if (Number.isFinite(at)) out.time = at;
  return out;
}

export async function comments({ trackId, offset = 0 }) {
  const eid = text(trackId);
  if (!eid) throw fail("unavailable", "没有这个单集");
  const scope = `comments:${eid}`;
  if (offset === 0) resetScope(scope);
  const body = { owner: { id: eid, type: "EPISODE" }, order: "HOT" };
  const key = keyFor(scope, offset);
  if (key !== undefined) body.loadMoreKey = key;
  const page = pageOf(await api("/v1/comment/list-primary", { body }), { scope, offset });
  return { comments: page.items.map(toComment), more: page.more };
}

export async function recent() {
  const env = await api("/v1/episode-played/list-history", { body: { limit: "20" } });
  return (Array.isArray(env.data) ? env.data : [])
    .map((row) => object(row).episode)
    .filter((e) => text(object(e).eid))
    .map(toTrack);
}

export { likeEpisode as like };

export async function webApi(path, body, options = {}) {
  return request(WEB_API, path, { ...options, body, method: options.method || "POST" });
}

// MyGo pages with an integer offset; the platform pages with an opaque
// loadMoreKey. Each list keeps its own offset -> key map, so two podcasts or
// two queries never share a cursor.
const cursors = new Map();

export function resetScope(scope) {
  cursors.delete(scope);
}

export function keyFor(scope, offset) {
  const keys = cursors.get(scope);
  return keys ? keys.get(offset) : undefined;
}

function usableKey(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return value;
}

// pageOf reads one platform page, remembers where the next one starts, and
// says whether there is one. A page that is empty but still asks to continue,
// or whose hasMore contradicts its cursor, is a platform fault, not an end.
export function pageOf(env, { scope, offset }) {
  const data = env && env.data;
  if (!Array.isArray(data)) throw new Error("小宇宙返回的列表结构不符合预期");
  const key = usableKey(env.loadMoreKey);
  const hasMore = typeof env.hasMore === "boolean" ? env.hasMore : undefined;
  if (hasMore !== undefined && hasMore !== (key !== undefined)) {
    throw new Error("小宇宙的分页标志相互矛盾");
  }
  if (data.length === 0 && key !== undefined) {
    throw new Error("小宇宙返回了空页但仍要求继续，已停止加载");
  }
  if (key !== undefined) {
    let keys = cursors.get(scope);
    if (!keys) {
      keys = new Map();
      cursors.set(scope, keys);
    }
    keys.set(offset + data.length, key);
  }
  return { items: data, more: key !== undefined };
}

export function toShow(podcast) {
  const p = object(podcast);
  const host = object(Array.isArray(p.podcasters) ? p.podcasters[0] : null);
  const show = {
    id: text(p.pid),
    name: text(p.title) || "未命名播客",
    imageUrl: pickImage(p.image),
    description: text(p.description) || text(p.brief),
    publisher: text(p.author) || text(host.nickname),
    episodeCount: Number(p.episodeCount) || 0,
    subscribed: text(p.subscriptionStatus) === "ON",
  };
  if (text(host.uid)) show.publisherPage = `podcaster:${text(host.uid)}`;
  return show;
}

export function toTrack(episode) {
  const e = object(episode);
  const p = object(e.podcast);
  const pid = text(e.pid) || text(p.pid);
  const artists = (Array.isArray(p.podcasters) ? p.podcasters : [])
    .filter((u) => text(object(u).uid))
    .map((u) => ({
      id: text(u.uid),
      name: text(u.nickname) || "小宇宙用户",
      imageUrl: pickImage(object(u.avatar).picture),
    }));
  const seconds = Number(e.duration);
  const track = {
    id: text(e.eid),
    name: text(e.title) || "未命名单集",
    artists,
    album: {
      id: pid,
      name: text(p.title) || "未知播客",
      imageUrl: imageOf(e),
    },
    duration: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0,
    url: `${SITE}/episode/${text(e.eid)}`,
    showId: pid,
    description: cleanNotes(e.shownotes) || text(e.description),
    published: text(e.pubDate),
  };
  if (unavailableReason(e)) track.unavailable = true;
  return track;
}