// TikTok LIVE connections, one per streamer username, shared by every room that needs it.
"use strict";
const { EventEmitter } = require("events");

const MOCK = process.env.MOCK_TIKTOK === "1";
const API_KEY = process.env.EULER_API_KEY || undefined;
let TT = null;
if (!MOCK) { try { TT = require("tiktok-live-connector"); } catch (e) { console.error("tiktok-live-connector missing", e.message); } }

const pick = (...xs) => xs.find(x => x !== undefined && x !== null && x !== "");
const urlOf = o => o && pick(o.url_list && o.url_list[0], o.urlList && o.urlList[0], o.url && o.url[0], typeof o === "string" ? o : undefined);

class Live extends EventEmitter {
  constructor(name) {
    super();
    this.name = name; this.st = "wait"; this.msg = ""; this.avatar = null; this.refs = 0;
    this.conn = null; this.timer = null; this.streak = new Map(); this.closed = false;
    this.setMaxListeners(50);
  }
  info() { return { st: this.st, msg: this.msg, avatar: this.avatar }; }
  set(st, msg) { this.st = st; this.msg = msg || ""; this.emit("state", this.info()); }
  start() { if (MOCK) return this.startMock(); this.connect(); }
  async connect() {
    if (this.closed) return;
    clearTimeout(this.timer);
    if (!TT) return this.set("err", "サーバーにTikTok接続の部品がありません");
    this.set("wait");
    const { TikTokLiveConnection, WebcastEvent } = TT;
    if (this.conn) { const o = this.conn; this.conn = null; try { o.removeAllListeners(); o.disconnect(); } catch (e) { } }
    const c = new TikTokLiveConnection(this.name, { signApiKey: API_KEY, processInitialData: false, enableExtendedGiftInfo: false });
    this.conn = c;
    c.on(WebcastEvent.GIFT, d => this.onGift(d));
    c.on(WebcastEvent.LIKE, d => { const n = +d.likeCount || 0; if (n > 0) this.emit("like", { n, nick: nickOf(d.user) }); });
    c.on(WebcastEvent.CHAT, d => this.emit("chat", { nick: nickOf(d.user), text: String(d.comment || "") }));
    c.on(WebcastEvent.STREAM_END || "streamEnd", () => { this.set("ng", "配信が終わりました"); this.retry(60); });
    c.on("disconnected", () => { if (!this.closed && this.st === "ok") { this.set("wait", "つなぎ直しています"); this.retry(5); } });
    try {
      const state = await c.connect();
      const ri = (state && state.roomInfo) || c.roomInfo || {};
      const owner = ri.owner || (ri.data && ri.data.owner) || {};
      this.avatar = urlOf(owner.avatar_thumb) || urlOf(owner.avatarThumb) || urlOf(owner.avatar_medium) || null;
      this.set("ok");
    } catch (e) {
      const m = String((e && (e.message || e.name)) || e);
      if (/offline|not.*live|isn.?t online|not online|UserOffline/i.test(m) || (e && e.name === "UserOfflineError")) { this.set("ng", "配信していません"); this.retry(45); }
      else if (/rate|limit|429/i.test(m)) { this.set("err", "接続の回数制限に達しました。少し待ってください"); this.retry(90); }
      else if (/api.?key|unauthor|401|403/i.test(m)) { this.set("err", "Euler Stream のAPIキーを確認してください"); this.retry(120); }
      else { this.set("err", "つながりませんでした（" + m.slice(0, 80) + "）"); this.retry(60); }
    }
  }
  retry(sec) { if (this.closed) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.connect(), sec * 1000); }
  onGift(d) {
    const g = d.giftDetails || d.extendedGiftInfo || {};
    const giftId = String(pick(d.giftId, g.id, "")), giftName = String(pick(g.giftName, g.name, d.extendedGiftInfo && d.extendedGiftInfo.name, ""));
    const coins = +pick(g.diamondCount, g.diamond_count, d.extendedGiftInfo && d.extendedGiftInfo.diamond_count, 0);
    const user = d.user || {}, uid = String(pick(user.userId, user.uniqueId, "?"));
    const rc = Math.max(1, +d.repeatCount || 1), streakable = +pick(g.giftType, d.giftType, 0) === 1;
    let count = rc;
    if (streakable) {
      const key = uid + ":" + giftId, last = this.streak.get(key) || 0;
      count = Math.max(0, rc - last);
      if (d.repeatEnd) this.streak.delete(key); else this.streak.set(key, rc);
      if (this.streak.size > 500) this.streak.clear();
    }
    if (giftId && giftName) learn({ id: giftId, name: giftName, coins, img: urlOf(g.giftImage && (g.giftImage.giftPictureUrl || g.giftImage)) || urlOf(g.image) || urlOf(g.icon) || null });
    if (count > 0) this.emit("gift", { giftId, giftName, coins, count: Math.min(count, 200), nick: nickOf(user) });
  }
  async gifts() {
    if (MOCK) return [["5655", "Rose", 1], ["5487", "Finger Heart", 5], ["5658", "Rosa", 10], ["5879", "Doughnut", 30], ["6427", "Hat and Mustache", 99], ["8217", "Boxing Gloves", 299], ["6000", "Snowman", 299], ["7934", "Galaxy", 1000]].map(([id, name, coins]) => ({ id, name, coins, img: null }));
    if (!TT) return null;
    try {
      const c = this.conn || new TT.TikTokLiveConnection(this.name, { signApiKey: API_KEY, webConfigOverrides: { DEFAULT_HTTP_CLIENT_PARAMS: { app_language: "ja-JP", browser_language: "ja-JP" } } });
      if (!c.roomId) { try { await c.fetchRoomId(); } catch (e) { GIFT_ERR = "roomId: " + String(e && e.message || e).slice(0, 160); } }
      if (!c.roomId) { GIFT_ERR = GIFT_ERR || "roomId not found"; return null; }
      let list = null, why = [];
      try { list = await TT.fetchRoomGiftsFromEulerRoute({ roomId: c.roomId, webClient: c.webClient, apiClient: c.apiClient, webcastLanguage: "ja-JP" }); } catch (e) { why.push("euler: " + String(e && e.message || e).slice(0, 120)); }
      if (!list) { try { list = await c.fetchAvailableGifts(); } catch (e) { why.push("direct: " + String(e && e.message || e).slice(0, 120)); } }
      if (!list) { GIFT_ERR = why.join(" / "); return null; }
      const arr = Array.isArray(list) ? list : (list && (list.gifts || list.data && list.data.gifts)) || [];
      return arr.map(g => ({ id: String(g.id), name: String(g.name || ""), coins: +g.diamond_count || +g.diamondCount || 0, img: urlOf(g.image) || urlOf(g.icon) || null }))
        .filter(g => g.id && g.name).sort((a, b) => a.coins - b.coins);
    } catch (e) { GIFT_ERR = "gifts: " + String(e && e.message || e).slice(0, 160); return null; }
  }
  startMock() {
    this.avatar = null;
    setTimeout(() => this.set(/off/i.test(this.name) ? "ng" : "ok", /off/i.test(this.name) ? "配信していません" : ""), 600);
    const fake = [["5655", "Rose", 1], ["5487", "Finger Heart", 5], ["5658", "Rosa", 10], ["5879", "Doughnut", 30], ["6427", "Hat and Mustache", 99], ["8217", "Boxing Gloves", 299], ["7934", "Galaxy", 1000]];
    const nicks = ["ゆうき", "mochi", "たろ", "sora", "にゃん", "kei", "rio"];
    this.mockT = setInterval(() => {
      if (this.st !== "ok") return;
      const r = Math.random();
      if (r < .35) { const g = fake[Math.random() < .8 ? (Math.random() * 3 | 0) : (Math.random() * fake.length | 0)]; this.emit("gift", { giftId: g[0], giftName: g[1], coins: g[2], count: 1, nick: nicks[Math.random() * nicks.length | 0] }); }
      else if (r < .75) this.emit("like", { n: 5 + (Math.random() * 30 | 0) });
      else if (r < .8) this.emit("chat", { nick: "mochi", text: "がんばれ！" });
    }, 700);
  }
  stop() { this.closed = true; clearTimeout(this.timer); clearInterval(this.mockT); try { this.conn && this.conn.disconnect(); } catch (e) { } this.removeAllListeners(); }
}
function nickOf(u) { u = u || {}; return String(pick(u.nickname, u.uniqueId, "だれか")).slice(0, 24); }

const LIVES = new Map();
function clean(n) { return String(n || "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "").replace(/\/.*$/, "").slice(0, 40); }
function acquire(name) {
  name = clean(name); if (!name) return null;
  let l = LIVES.get(name.toLowerCase());
  if (!l) { l = new Live(name); LIVES.set(name.toLowerCase(), l); l.start(); }
  l.refs++; clearTimeout(l.dropT); return l;
}
function release(l) {
  if (!l) return; l.refs = Math.max(0, l.refs - 1);
  if (l.refs === 0) { clearTimeout(l.dropT); l.dropT = setTimeout(() => { if (l.refs === 0) { l.stop(); LIVES.delete(l.name.toLowerCase()); } }, 5 * 60 * 1000); }
}
let GIFT_CACHE = { at: 0, list: null }; let GIFT_ERR = "";
const LEARNED = new Map(); // gifts seen in real streams (used when the full list cannot be fetched)
function learn(g) { if (!LEARNED.has(g.id) || (g.img && !LEARNED.get(g.id).img)) LEARNED.set(g.id, g); }
async function giftCatalog(name) {
  if (GIFT_CACHE.list && Date.now() - GIFT_CACHE.at < 6 * 3600 * 1000) return GIFT_CACHE.list;
  const l = LIVES.get(clean(name).toLowerCase()) || [...LIVES.values()][0] || new Live(process.env.GIFT_SOURCE || "tiktok");
  const list = await l.gifts();
  if (list && list.length) GIFT_CACHE = { at: Date.now(), list };
  const base = list || GIFT_CACHE.list;
  if (base) return base;
  if (LEARNED.size) { const l = [...LEARNED.values()].sort((a, b) => a.coins - b.coins); l.partial = true; return l; }
  return null;
}
// warm the gift list at start-up so it is ready before anyone goes live
setTimeout(() => giftCatalog("").catch(() => { }), 3000);
setInterval(() => giftCatalog("").catch(() => { }), 6 * 3600 * 1000);
module.exports = { acquire, release, giftCatalog, clean, MOCK, giftErr: () => GIFT_ERR, version: "gw-4" };
