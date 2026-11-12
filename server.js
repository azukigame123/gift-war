// ギフト攻城戦 server: serves the game page, runs rooms (online battles + practice), and relays TikTok LIVE events.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const { createSim, snapshot } = require("./sim");
const TT = require("./tiktok");
const { createPush } = require("./push");

const PORT = +process.env.PORT || 8080;
const SPEED = Math.max(1, Math.min(20, +process.env.GAME_SPEED || 1)); // testing only
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

// ---------- invites: only people with a link made by the owner can play ----------
// Tokens are "name.signature"; the signature is an HMAC, so nothing has to be stored.
// Change INVITE_VERSION on Render to cancel every invite at once.
const INV_SECRET = crypto.createHash("sha256").update("gift-war-invite:" + (process.env.INVITE_SECRET || process.env.EULER_API_KEY || "dev-secret") + ":" + (process.env.INVITE_VERSION || "1")).digest();
const GATE = process.env.INVITE_OFF !== "1";
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:" + PORT).replace(/\/$/, "");
const sig = name => crypto.createHmac("sha256", INV_SECRET).update(name).digest("base64url").slice(0, 16);
const makeInv = name => encodeURIComponent(name) + "." + sig(name);
const pboostKey = name => sig("pboost:" + name);
const isOwnerName = name => !GATE || name === "owner"; // 2倍タイム is for the owner only, even after push mode opens to invited streamers // key for the 2倍タイム URL that ChainRoulette calls
function checkInv(tok) {
  if (!GATE) return { name: "guest", owner: true };
  tok = String(tok || ""); const i = tok.lastIndexOf("."); if (i <= 0) return null;
  let name; try { name = decodeURIComponent(tok.slice(0, i)); } catch (e) { return null; }
  const a = Buffer.from(tok.slice(i + 1)), b = Buffer.from(sig(name));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (name !== "owner" && INVDB.revoked.includes(name)) return null;
  return { name, owner: name === "owner" };
}
// invited users are kept on disk (DATA_DIR) so they survive restarts when a persistent disk is mounted
const pathM = path;
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/var/data") ? "/var/data" : pathM.join(__dirname, "data"));
const INV_FILE = pathM.join(DATA_DIR, "invites.json");
let INVDB = { users: [], revoked: [] };
try { INVDB = Object.assign(INVDB, JSON.parse(fs.readFileSync(INV_FILE, "utf8"))); } catch (e) {}
function saveInvDB() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = INV_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(INVDB, null, 1)); fs.renameSync(tmp, INV_FILE); } catch (e) { console.log("[invite] save failed", e.message); } }
const PERSIST = !!process.env.DATA_DIR || DATA_DIR === "/var/data";
// ---------- who is connected right now (owner can see it in the invite list) ----------
const CONNS = new Map(); // invite name -> Set of connection states
function presence(name) {
  const S = CONNS.get(name); let st = "";
  if (S) for (const C of S) { const r = C.room; const v = r ? (r.phase === "battle" || r.phase === "countdown" ? (r.practice ? "練習中" : "対戦中") : r.practice ? "練習中" : "部屋で準備中") : "ゲーム画面"; if (!st || v.endsWith("中") && !st.endsWith("戦中")) st = v; }
  return { online: !!(S && S.size), doing: st };
}
// ---------- match history (per streamer, newest first, max 200) ----------
const HIST_FILE = pathM.join(DATA_DIR, "history.json");
let HIST = {}; try { HIST = JSON.parse(fs.readFileSync(HIST_FILE, "utf8")) || {}; } catch (e) {}
let histT = null;
function saveHist() { clearTimeout(histT); histT = setTimeout(() => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = HIST_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(HIST)); fs.renameSync(tmp, HIST_FILE); } catch (e) { console.log("[hist] save failed", e.message); } }, 1500); }
const histKey = n => String(n || "").trim().toLowerCase();
function recordMatch(room) {
  const S = room.sim && room.sim.S; if (!S || !S.over || room.recorded) return; room.recorded = true;
  const len = Math.max(0, Math.round((Date.now() - (room.t0 || Date.now())) / 1000));
  for (const t of ["b", "r"]) {
    const P = room.players[t]; if (!P || P.cpu || !P.name) continue;
    const o = room.players[t === "b" ? "r" : "b"], st = (room.stat && room.stat[t]) || { g: {}, likes: 0, cheers: 0 };
    const key = histKey(P.who && !P.who.owner ? P.who.name : P.name); if (!key) continue;
    const rec = {
      at: new Date().toISOString(), mode: room.practice ? "practice" : "battle", len, src: room.practice ? room.src : (room.offline ? "offline" : "live"),
      me: { name: P.name, disp: P.disp || "" }, opp: o ? (o.cpu ? { cpu: true, lvl: room.lvl } : { name: o.name || "", disp: o.disp || "" }) : null,
      win: S.over.team === t ? 1 : S.over.team ? 0 : 0.5,
      gifts: Object.values(st.g).sort((a, b) => b.coins - a.coins).slice(0, 300),
      likes: st.likes, cheers: st.cheers, units: (S.cnt && S.cnt[t]) || {}
    };
    const L = HIST[key] = HIST[key] || []; L.unshift(rec); if (L.length > 200) L.length = 200;
  }
  saveHist();
}
function statOf(room, team) { room.stat = room.stat || {}; return room.stat[team] = room.stat[team] || { g: {}, likes: 0, cheers: 0 }; }
console.log("[invite] storage " + INV_FILE + (PERSIST ? " (persistent disk)" : " (NOT persistent: set DATA_DIR to a Render disk)") + ", users " + INVDB.users.length);
const cleanTT = n => String(n || "").trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 24);
const ownerUrl = PUBLIC_URL + "/?inv=" + makeInv("owner");
console.log("[invite] owner URL (keep it private): " + ownerUrl);

// ---------- http ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  if (u.pathname === "/api/whoami") {
    const who = checkInv(u.searchParams.get("inv"));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(who ? { ok: true, name: who.name, owner: !!who.owner, gate: GATE } : { ok: false, gate: GATE }));
  }
  if (u.pathname === "/api/pboost") { // 押し合いの2倍タイム（オーナー専用）: /api/pboost?k=KEY&x=2&sec=30&side=all|h|x
    const k = Buffer.from(String(u.searchParams.get("k") || "")), own = GATE ? "owner" : "guest", want = Buffer.from(pboostKey(own));
    const okKey = k.length === want.length && crypto.timingSafeEqual(k, want), G = okKey ? PUSHG.get(own) : null;
    res.writeHead(okKey ? 200 : 403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    if (!okKey) return res.end(JSON.stringify({ ok: false, msg: "鍵が違います。操作画面の「2倍タイムのURL」をコピーし直してください" }));
    if (!G) return res.end(JSON.stringify({ ok: false, msg: "押し合いが始まっていないので、2倍タイムにはなりませんでした" }));
    const r = G.game.boost(u.searchParams.get("x"), u.searchParams.get("sec"), u.searchParams.get("side"));
    TT.dbg(G.who, "push-boost", JSON.stringify(r)); return res.end(JSON.stringify(Object.assign({ ok: true, msg: `${r.x}倍タイム（残り${r.left}秒）` }, r)));
  }
  if (u.pathname === "/api/history") {
    const who = checkInv(u.searchParams.get("inv"));
    res.writeHead(who ? 200 : 403, { "content-type": "application/json", "cache-control": "no-store" });
    if (!who) return res.end("{}");
    if (who.owner && !u.searchParams.get("u")) { const names = new Set([...INVDB.users.map(x => histKey(x.name)), ...Object.keys(HIST)]); return res.end(JSON.stringify({ owner: true, users: [...names].filter(Boolean).map(n => { const L = HIST[n] || [], inv = INVDB.users.find(x => histKey(x.name) === n); return { name: n, memo: inv ? inv.memo || "" : "", invited: !!inv, n: L.length, wins: L.filter(r => r.win === 1).length, last: L[0] ? L[0].at : null }; }).sort((a, b) => String(b.last || "").localeCompare(String(a.last || ""))) })); }
    const name = histKey(who.owner ? u.searchParams.get("u") : who.name);
    return res.end(JSON.stringify({ owner: !!who.owner, name, list: HIST[name] || [] }));
  }
  if (u.pathname === "/api/ttdebug") {
    const who = checkInv(u.searchParams.get("inv"));
    res.writeHead(who && who.owner ? 200 : 403, { "content-type": "application/json", "cache-control": "no-store" });
    if (!who || !who.owner) return res.end("{}");
    const rooms = [...ROOMS.values()].map(r => ({ code: r.code, phase: r.phase, practice: !!r.practice, src: r.src || "", offline: !!r.offline, players: Object.fromEntries(["b", "r"].map(t => { const P = r.players[t]; return [t, P ? { name: P.name, cpu: !!P.cpu, live: P.live ? P.live.st : "", gifts: Object.fromEntries(Object.entries(P.gifts || {}).map(([k, v]) => [k, v && (v.id + "/" + v.name)])) } : null]; })) }));
    return res.end(JSON.stringify(Object.assign({ rooms }, TT.debugInfo()), null, 1));
  }
  if (u.pathname.startsWith("/api/invite")) {
    const who = checkInv(u.searchParams.get("inv"));
    res.writeHead(who && who.owner ? 200 : 403, { "content-type": "application/json", "cache-control": "no-store" });
    if (!who || !who.owner) return res.end(JSON.stringify({ ok: false }));
    const list = () => INVDB.users.map(x => Object.assign({}, x, presence(x.name), { url: PUBLIC_URL + "/?inv=" + makeInv(x.name), tiktok: "https://www.tiktok.com/@" + encodeURIComponent(x.name) }));
    if (u.pathname === "/api/invites") return res.end(JSON.stringify({ ok: true, persist: PERSIST, users: list() }));
    const name = cleanTT(u.searchParams.get("name"));
    if (!name || name === "owner") return res.end(JSON.stringify({ ok: false, msg: "TikTokのユーザー名を入れてください" }));
    if (u.pathname === "/api/invite/del") {
      INVDB.users = INVDB.users.filter(x => x.name !== name); if (!INVDB.revoked.includes(name)) INVDB.revoked.push(name); saveInvDB();
      return res.end(JSON.stringify({ ok: true, users: list() }));
    }
    INVDB.revoked = INVDB.revoked.filter(x => x !== name);
    const memo = String(u.searchParams.get("memo") || "").slice(0, 40);
    const ex = INVDB.users.find(x => x.name === name);
    if (ex) { if (memo) ex.memo = memo; } else INVDB.users.unshift({ name, memo, at: new Date().toISOString() });
    saveInvDB();
    return res.end(JSON.stringify({ ok: true, name, url: PUBLIC_URL + "/?inv=" + makeInv(name), users: list() }));
  }
  if (u.pathname === "/api/gifts") {
    const list = await TT.giftCatalog(u.searchParams.get("u") || "");
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ok: !!list, partial: !!(list && list.partial), gifts: list || [], why: list ? undefined : TT.giftErr(), v: TT.version }));
  }
  let p = decodeURIComponent(u.pathname); if (p === "/") p = "/index.html";
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": p.endsWith(".html") ? "no-cache" : "public, max-age=86400" });
    res.end(buf);
  });
});

// ---------- rooms ----------
const ROOMS = new Map();
const CODE_CH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => { let c; do { c = Array.from({ length: 6 }, () => CODE_CH[Math.random() * CODE_CH.length | 0]).join(""); } while (ROOMS.has(c)); return c; };
const UNIT_IDS = ["rookie", "soldier", "archer", "shield", "rider", "bomber", "mage", "golem", "dragon"];
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const other = t => t === "b" ? "r" : "b";

function cleanDeck(d) { const s = new Set((Array.isArray(d) ? d : []).filter(x => UNIT_IDS.includes(x))); return s.size >= 1 ? [...s] : [...UNIT_IDS]; }
function cleanGifts(g) {
  const o = {}; if (!g || typeof g !== "object") return o;
  for (const k of [...UNIT_IDS, "glove"]) { const v = g[k]; if (v && typeof v === "object") o[k] = { id: String(v.id || "").slice(0, 32), name: String(v.name || "").slice(0, 40).toLowerCase(), alt: String(v.alt || "").slice(0, 40).toLowerCase(), coins: Math.max(0, Math.min(1e6, +v.coins || 0)) }; }
  return o;
}

function roomView(room) {
  const pv = t => { const P = room.players[t]; if (!P) return null; return { name: P.name, disp: P.disp || "", icon: P.icon || "", live: P.live ? P.live.info() : { st: "", msg: "", avatar: null }, here: !!P.ws, ready: !!P.ready, cpu: !!P.cpu, deck: cleanDeck(P.deck) }; };
  return { code: room.code, phase: room.phase, practice: room.practice, offline: !!room.offline, players: { b: pv("b"), r: pv("r") } };
}
// stream-only pages (LIVE Studio "link" source) watch a streamer by TikTok username
const WATCH = new Map();
const wkey = n => TT.clean(n).toLowerCase();
function broadcast(room, o) {
  for (const t of ["b", "r"]) {
    const P = room.players[t]; if (!P) continue;
    if (P.ws) send(P.ws, Object.assign({ you: t }, o));
    if ((o.t === "start" || o.t === "snap") && !P.cpu) { const ws2 = new Set(); for (const k of pkeys(P)) { const W = WATCH.get(k); if (W) for (const w of W) ws2.add(w); } if (ws2.size) { const msg = JSON.stringify(Object.assign({ you: t }, o)); for (const w of ws2) if (w.readyState === 1) w.send(msg); } }
  }
}
// a stream page can follow a player by TikTok name or by invite name (so the URL works before a TikTok ID is entered)
function pkeys(P) { return [...new Set([P && P.name && wkey(P.name), P && P.who && P.who.name && wkey(P.who.name)].filter(Boolean))]; }
function roomOf(name) { const k = wkey(name); for (const room of ROOMS.values()) for (const t of ["b", "r"]) { const P = room.players[t]; if (P && !P.cpu && pkeys(P).includes(k)) return { room, team: t }; } return null; }
function lobbyUpdate(room) { broadcast(room, { t: "lobby", room: roomView(room) }); }

function attachLive(room, team) {
  const P = room.players[team]; if (!P || P.cpu) return;
  if (P.live && TT.clean(P.live.name).toLowerCase() === TT.clean(P.name).toLowerCase()) return;
  detachLive(P);
  if (!P.name) return;
  const L = TT.acquire(P.name); if (!L) return;
  P.live = L;
  P.on = {
    state: () => { if (P.ws) send(P.ws, { t: "tt", info: L.info() }); lobbyUpdate(room); },
    gift: g => onGift(room, team, g),
    like: l => onLike(room, team, l),
    chat: c => onChat(room, team, c),
  };
  for (const k in P.on) L.on(k, P.on[k]);
  P.on.state();
}
function detachLive(P) { if (P && P.live) { for (const k in P.on || {}) P.live.off(k, P.on[k]); TT.release(P.live); P.live = null; P.on = null; } }

function battling(room) { return room.phase === "battle" && room.sim && room.sim.S && !room.sim.S.over && !room.offline; }
function onGift(room, team, g) {
  if (!battling(room)) { TT.dbg(g.nick, "gift-ignored", `phase=${room.phase} offline=${!!room.offline}`); return; } if (room.practice && team === "b" && room.src !== "live") { TT.dbg(g.nick, "gift-ignored", "practice without live source"); return; }
  const P = room.players[team], sim = room.sim, gn = g.giftName.toLowerCase();
  const match = k => { const m = P.gifts[k]; return m && ((m.id && m.id === g.giftId) || (m.name && m.name === gn) || (m.alt && m.alt === gn)); };
  const note = u => { const st = statOf(room, team), k = g.nick + "\u0000" + g.giftId, cf = P.gifts[u] || {}; const e = st.g[k] = st.g[k] || { nick: String(g.nick || "").slice(0, 24), id: String(g.giftId || ""), gift: String(cf.alt || g.giftName || "").slice(0, 40), unit: u, n: 0, coins: 0 }; e.n += g.count; e.coins += (+g.coins || 0) * g.count; };
  if (match("glove")) { note("glove"); sim.sendGlove(team); return; }
  const unit = UNIT_IDS.find(k => k !== "rookie" && match(k));
  if (!unit) { TT.dbg(g.nick, "gift-unmatched", `${g.giftId} ${g.giftName}`); return; }
  TT.dbg(g.nick, "gift-unit", `${g.giftName} -> ${unit} x${g.count}`); note(unit);
  for (let i = 0; i < g.count; i++) sim.addStock(team, unit, g.nick);
}
function onLike(room, team, l) {
  if (!battling(room)) return; if (room.practice && team === "b" && room.src !== "live") return;
  const S = room.sim.S; S.charge[team] += l.n; S.likesAcc[team] += l.n; statOf(room, team).likes += l.n;
  while (S.likesAcc[team] >= 100) { S.likesAcc[team] -= 100; room.sim.addStock(team, "rookie", l.nick || "いいね"); }
}
function onChat(room, team, c) {
  if (!battling(room)) return; if (room.practice && team === "b" && room.src !== "live") return;
  const P = room.players[team]; const w = (P.cheer || "").trim(), ce = P.cheerEmote && P.cheerEmote.id;
  if ((w && c.text.includes(w)) || (ce && (c.emotes || []).some(e => e.id === ce))) { room.sim.cheer(team); statOf(room, team).cheers++; }
}

function startMatch(room) {
  if (!room.sim) { room.ev = []; room.sim = createSim({ log: (c, t) => room.ev.push(["l", c, t]), play: k => room.ev.push(["s", k]) }); }
  const sim = room.sim;
  for (const t of ["b", "r"]) { const P = room.players[t]; sim.DECK[t].clear(); cleanDeck(P && P.deck).forEach(x => sim.DECK[t].add(x)); sim.MODE[t] = "5"; }
  sim.CFG.cap = room.cap || 60;
  for (const t of ["b", "r"]) { const P = room.players[t]; sim.SM[t] = {}; if (P && !P.cpu) for (const k of UNIT_IDS) { const g = P.gifts && P.gifts[k]; const m = sim.smOf(k, g && g.coins); if (m !== 1) sim.SM[t][k] = m; } }
  sim.newState();
  for (const t of ["b", "r"]) { for (const id in sim.S.stock[t]) sim.S.stock[t][id] = sim.S.stock[t][id].map(() => "はじめの兵"); sim.S.q[t].forEach(e => e.name = "はじめの兵"); }
  sim.S.gf = { b: {}, r: {} };
  if (room.practice) { sim.setAuto(true, false); sim.setAutoGift(true); sim.AG.b = room.src === "auto"; sim.AG.r = true; sim.GR.r = room.lvl; sim.GR.b = 1; sim.PRAC.on = true; }
  else {
    sim.setAuto(false, false); sim.GR.b = sim.GR.r = 1; sim.PRAC.on = false;
    for (const t of ["b", "r"]) { const P = room.players[t]; const off = !!room.offline; /* 配信なし: both sides get troops and likes automatically, live gifts are ignored */ sim.AG[t] = off; sim.OFF[t] = false; }
    sim.setAutoGift(sim.AG.b || sim.AG.r);
  }
  if (room.practice) { sim.OFF.b = sim.OFF.r = false; }
  room.ev = []; room.stat = {}; room.recorded = false;
  room.phase = "countdown";
  broadcast(room, { t: "start", room: roomView(room), s: snapshot(sim.S) });
  clearTimeout(room.cdT);
  room.cdT = setTimeout(() => { room.phase = "battle"; room.t0 = Date.now(); runLoop(room); }, 6300); // VS intro 3.6s + countdown 2.7s
}
function runLoop(room) {
  clearInterval(room.loop);
  let next = Date.now(), n = 0;
  room.loop = setInterval(() => {
    const sim = room.sim; let steps = 0;
    while (Date.now() >= next && steps < 6 * SPEED) { for (let q = 0; q < SPEED && !sim.S.over; q++) { sim.tick(); sim.step(); } next += 1000 / 60; steps += SPEED; n++; if (sim.S.over) break; }
    if (Date.now() - next > 500) next = Date.now();
    if (sim.S.over || n >= 4) {
      n = 0;
      const ev = room.ev; room.ev = [];
      broadcast(room, { t: "snap", s: snapshot(sim.S), ev });
    }
    if (sim.S.over) { clearInterval(room.loop); room.loop = null; room.phase = "result"; for (const t of ["b", "r"]) if (room.players[t]) room.players[t].ready = false; try { recordMatch(room); } catch (e) { console.log("[hist]", e.message); } }
  }, 1000 / 60);
}
function stopRoom(room) { clearInterval(room.loop); clearTimeout(room.cdT); for (const t of ["b", "r"]) detachLive(room.players[t]); ROOMS.delete(room.code); }
function maybeClose(room) {
  const here = ["b", "r"].some(t => room.players[t] && room.players[t].ws && !room.players[t].cpu);
  if (!here) { clearTimeout(room.dieT); room.dieT = setTimeout(() => { const still = ["b", "r"].some(t => room.players[t] && room.players[t].ws && !room.players[t].cpu); if (!still) stopRoom(room); }, room.phase === "battle" ? 120000 : 15000); }
}

// ---------- 押し合いモード (owner only for now) ----------
const PUSHG = new Map(); // owner invite name -> { game, ops:Set<ws>, live, on, name, loop, dieT }
function pushKeys(G) { return [...new Set([G.name && wkey(G.name), G.who && wkey(G.who)].filter(Boolean))]; }
function pushOf(k) { for (const G of PUSHG.values()) if (pushKeys(G).includes(k)) return G; return null; }
function pushSend(G, o) {
  const msg = JSON.stringify(o);
  for (const w of G.ops) if (w.readyState === 1) w.send(msg);
  for (const k of pushKeys(G)) { const W = WATCH.get(k); if (W) for (const w of W) if (w.readyState === 1 && !G.ops.has(w)) w.send(msg); }
}
function pushLive(G, name) {
  name = TT.clean(name || "");
  if (G.live && TT.clean(G.live.name).toLowerCase() === name.toLowerCase()) return;
  if (G.live) { for (const k in G.on) G.live.off(k, G.on[k]); TT.release(G.live); G.live = null; }
  G.name = name; if (!name) return;
  const L = TT.acquire(name); if (!L) return; G.live = L;
  G.on = { state: info => pushSend(G, { t: "ptt", info: L.info() }), like: l => { G.game.like(l.n, l.nick); }, gift: g => { const side = G.game.gift(g); TT.dbg(g.nick, side ? "push-gift" : "push-unmatched", `${g.giftId} ${g.giftName} x${g.count} -> ${side || "-"}`); } };
  for (const k in G.on) L.on(k, G.on[k]);
  G.on.state();
}
// before a push game starts (and after it stops) the stream pages show a still field and "0 / goal", using the last settings
const PUSHLAST = new Map(); // watch key -> { cfg, gifts }
function idleSnap(k) { const L = PUSHLAST.get(k) || {}, g = createPush(); g.start(L.cfg || {}, L.gifts || null); const s = g.snapshot(); s.idle = 1; s.g = 0; return s; }
function pushIdle(G) { for (const k of pushKeys(G)) { const W = WATCH.get(k), msg = JSON.stringify({ t: "psnap", s: idleSnap(k) }); if (W) for (const w of W) if (w.readyState === 1) w.send(msg); } }
function pushStop(G) { clearInterval(G.loop); clearTimeout(G.dieT); if (G.live) { for (const k in G.on) G.live.off(k, G.on[k]); TT.release(G.live); G.live = null; } pushSend(G, { t: "pend" }); PUSHG.delete(G.who); pushIdle(G); }
function pushRun(G) {
  clearInterval(G.loop); let n = 0;
  G.loop = setInterval(() => { for (let q = 0; q < SPEED; q++) G.game.tick(1 / 30); if (++n % 2 === 0) pushSend(G, { t: "psnap", s: G.game.snapshot() }); }, 1000 / 30);
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: "/ws", verifyClient: (info, cb) => { const q = new URL(info.req.url, "http://x").searchParams; const who = checkInv(q.get("inv")); if (!who) return cb(false, 401, "invite required"); info.req.who = who; cb(true); }, perMessageDeflate: { threshold: 512 } , maxPayload: 64 * 1024 });
wss.on("connection", (ws, req) => {
  const WHO = req.who || { name: "guest", owner: false };
  const PK = WHO.owner ? "" : WHO.name; let pc = null;
  const C = { ws, name: "", gifts: {}, cheer: "がんばれ", deck: UNIT_IDS.slice(), room: null, team: null, live: null, on: null, rate: 0 };
  let solo = null; // TikTok status while not in a room
  const soloLive = () => {
    if (C.room) return;
    if (solo && solo.L && TT.clean(solo.L.name).toLowerCase() === TT.clean(C.name).toLowerCase()) return send(ws, { t: "tt", info: solo.L.info() });
    if (solo) { solo.L.off("state", solo.f); TT.release(solo.L); solo = null; }
    if (!C.name) return send(ws, { t: "tt", info: { st: "", msg: "", avatar: null } });
    const L = TT.acquire(C.name); const f = info => send(ws, { t: "tt", info }); L.on("state", f); solo = { L, f }; f(L.info());
  };
  const dropSolo = () => { if (solo) { solo.L.off("state", solo.f); TT.release(solo.L); solo = null; } };
  const me = () => C.room && C.room.players[C.team];
  const leave = () => {
    const room = C.room; if (!room) return;
    const P = room.players[C.team];
    if (P && P.ws === ws) {
      P.ws = null;
      if (room.phase === "lobby" || room.phase === "result" || room.practice) { detachLive(P); room.players[C.team] = null; if (room.practice) stopRoom(room); }
    }
    C.room = null; C.team = null;
    if (ROOMS.has(room.code)) { lobbyUpdate(room); maybeClose(room); }
  };
  const enter = (room, team) => {
    dropSolo();
    let P = room.players[team];
    if (!P) P = room.players[team] = { name: "", gifts: {}, cheer: "", deck: [], ready: false };
    P.ws = ws; P.who = WHO; P.name = C.name; P.disp = C.disp || ""; P.icon = C.icon || ""; P.gifts = C.gifts; P.cheer = C.cheer; P.cheerEmote = C.cheerEmote || null; P.deck = C.deck; P.ready = false;
    C.room = room; C.team = team; clearTimeout(room.dieT);
    attachLive(room, team);
    send(ws, { t: "joined", you: team, room: roomView(room) });
    lobbyUpdate(room);
    if (room.phase !== "lobby" && room.sim) send(ws, { t: "start", room: roomView(room), s: snapshot(room.sim.S), resume: true });
  };

  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    if (++C.rate > 400) return; // flood guard (reset every second)
    switch (m.t) {
      case "hello": case "cfg": {
        if (typeof m.name === "string") C.name = TT.clean(m.name);
        if (m.gifts) C.gifts = cleanGifts(m.gifts);
        if (typeof m.cheer === "string") C.cheer = m.cheer.slice(0, 12);
        if ("cheerEmote" in m) { const e = m.cheerEmote; C.cheerEmote = e && typeof e.id === "string" && e.id ? { id: e.id.slice(0, 40), img: typeof e.img === "string" && /^https:\/\//.test(e.img) ? e.img.slice(0, 600) : "" } : null; }
        if (typeof m.icon === "string") C.icon = (m.icon.length <= 40000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(m.icon)) ? m.icon : "";
        if (typeof m.disp === "string") C.disp = m.disp.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16);
        if (m.deck) C.deck = cleanDeck(m.deck);
        const P = me();
        if (P) { const nameChanged = P.name !== C.name; P.name = C.name; P.disp = C.disp || ""; P.icon = C.icon || ""; P.gifts = C.gifts; P.cheer = C.cheer; P.cheerEmote = C.cheerEmote || null; P.deck = C.deck; if (nameChanged) { clearTimeout(P.attT); const rm = C.room, tm = C.team; P.attT = setTimeout(() => attachLive(rm, tm), 2500); } lobbyUpdate(C.room); }
        else { clearTimeout(C.soloT); C.soloT = setTimeout(soloLive, 1500); }
        if (C.push && PUSHG.get(WHO.name) === C.push) { const G = C.push; clearTimeout(C.pushT); C.pushT = setTimeout(() => pushLive(G, C.name), 1500); }
        break;
      }
      case "create": { leave(); const room = { code: newCode(), phase: "lobby", players: { b: null, r: null }, practice: false, offline: !!m.offline, cap: Math.max(10, Math.min(200, +m.cap || 60)) }; ROOMS.set(room.code, room); enter(room, "b"); break; }
      case "join": {
        const code = String(m.code || "").toUpperCase().trim(); const room = ROOMS.get(code);
        if (!room || room.practice) return send(ws, { t: "err", msg: "その入室コードの部屋は見つかりません" });
        if (C.room === room) return;
        const back = ["b", "r"].find(t => room.players[t] && !room.players[t].ws && C.name && room.players[t].name.toLowerCase() === C.name.toLowerCase());
        const team = back || (!room.players.r ? "r" : !room.players.b ? "b" : null);
        if (!team) return send(ws, { t: "err", msg: "この部屋はもう2人そろっています" });
        leave(); enter(room, team); break;
      }
      case "learnEmote": { // wait for the next stamp sent on this streamer's LIVE and report it back
        if (C.learn) { C.learn.stop(); C.learn = null; }
        if (m.stop) break;
        if (!C.name) return send(ws, { t: "emote", err: "先に「あなた」の欄にTikTokのユーザー名を入れてください" });
        const L = TT.acquire(C.name); if (!L) return send(ws, { t: "emote", err: "TikTokにつながりません" });
        const f = c => { const e = (c.emotes || [])[0]; if (e) { send(ws, { t: "emote", e }); stop(); } };
        const stop = () => { clearTimeout(tm); L.off("chat", f); TT.release(L); if (C.learn && C.learn.stop === stop) C.learn = null; };
        const tm = setTimeout(() => { send(ws, { t: "emote", err: "2分以内にスタンプが届きませんでした" }); stop(); }, 120000);
        L.on("chat", f); C.learn = { stop }; break;
      }
      case "leave": leave(); soloLive(); break;
      case "ready": {
        const room = C.room, P = me(); if (!room || !P || room.practice || room.phase !== "lobby") return;
        if (m.deck) P.deck = C.deck = cleanDeck(m.deck);
        const bothLive = ["b", "r"].every(t => room.players[t] && room.players[t].live && room.players[t].live.st === "ok");
        if (!bothLive && !room.offline && !TT.MOCK && !process.env.ALLOW_OFFLINE) return send(ws, { t: "err", msg: "2人とも配信中になってから準備完了を押してください" });
        P.ready = true; lobbyUpdate(room);
        if (["b", "r"].every(t => room.players[t] && room.players[t].ready && room.players[t].ws)) startMatch(room);
        break;
      }
      case "unready": { const P = me(); if (P && C.room.phase === "lobby") { P.ready = false; lobbyUpdate(C.room); } break; }
      case "practice": {
        leave();
        const room = { code: "P" + newCode(), phase: "lobby", players: { b: null, r: { name: "CPU", cpu: true, gifts: {}, deck: [], ready: true } }, practice: true, cap: Math.max(10, Math.min(200, +m.cap || 60)), lvl: [0.6, 1, 1.6].includes(+m.lvl) ? +m.lvl : 1, src: ["live", "test", "auto"].includes(m.src) ? m.src : "test" };
        ROOMS.set(room.code, room); if (m.deck) C.deck = cleanDeck(m.deck);
        enter(room, "b"); room.players.r.deck = room.players.b.deck.slice();
        startMatch(room); break;
      }
      case "act": { const room = C.room; if (!room || room.phase !== "battle" || !room.sim) return; if (m.a && m.a.a === "like") { const n = Date.now(); if (n - (C.likeT || 0) < 80) return; C.likeT = n; } try { room.sim.doAct(C.team, m.a); } catch (e) { } break; }
      case "done": {
        const room = C.room; if (!room) return;
        for (const k of new Set([C.name && wkey(C.name), wkey(WHO.name)].filter(Boolean))) { const W = WATCH.get(k); if (W) for (const w of W) if (w.readyState === 1) w.send(JSON.stringify({ t: "rdone" })); }
        if (room.practice) { leave(); soloLive(); send(ws, { t: "left" }); return; }
        if (room.phase === "result") { room.phase = "lobby"; for (const t of ["b", "r"]) if (room.players[t]) room.players[t].ready = false; }
        lobbyUpdate(room); break;
      }
      case "watch": {
        const k = wkey(m.name || ""); if (!k) return;
        if (C.watch) { const W = WATCH.get(C.watch); if (W) W.delete(ws); }
        C.watch = k; if (!WATCH.has(k)) WATCH.set(k, new Set()); WATCH.get(k).add(ws);
        const f = roomOf(k); if (f && f.room.sim && f.room.phase !== "lobby") send(ws, { t: "start", you: f.team, room: roomView(f.room), s: snapshot(f.room.sim.S), resume: true });
        const pg = pushOf(k); send(ws, { t: "psnap", s: pg ? pg.game.snapshot() : idleSnap(k) });
        break;
      }
      case "pstart": case "pslots": case "pskill": case "ptest": case "pstop": case "pjoin": case "pboost": case "plike": {
        if (!WHO.owner) return send(ws, { t: "err", msg: "押し合いモードは今はオーナーだけが使えます" });
        let G = PUSHG.get(WHO.name);
        if ((m.t === "pjoin" || m.t === "pstart") && WHO.owner) send(ws, { t: "pkey", k: pboostKey(WHO.name) });
        if (m.t === "pjoin") { if (G) { G.ops.add(ws); C.push = G; clearTimeout(G.dieT); send(ws, { t: "psnap", s: G.game.snapshot() }); if (G.live) send(ws, { t: "ptt", info: G.live.info() }); } break; }
        if (m.t === "pstart") {
          if (!G) { G = { game: createPush(), ops: new Set(), who: WHO.name, name: "", live: null, on: null }; PUSHG.set(WHO.name, G); }
          G.ops.add(ws); C.push = G; clearTimeout(G.dieT);
          G.game.start(m.cfg || {}, m.gifts); pushLive(G, C.name); for (const k of pushKeys(G)) PUSHLAST.set(k, { cfg: m.cfg || {}, gifts: m.gifts || null }); pushRun(G); pushSend(G, { t: "psnap", s: G.game.snapshot() }); break;
        }
        if (!G) return;
        if (m.t === "pslots") { G.game.setSlots(m.gifts); for (const k of pushKeys(G)) { const L = PUSHLAST.get(k); if (L) L.gifts = m.gifts; } }
        else if (m.t === "pskill") G.game.skill(m.k === 2 ? 2 : 1);
        else if (m.t === "plike") G.game.like(m.n === 50 ? 50 : 10, "テスト");
        else if (m.t === "ptest") G.game.test(m.side === "x" ? "x" : "h", Math.max(0, Math.min(5, m.i | 0)), "テスト");
        else if (m.t === "pstop") pushStop(G);
        else if (m.t === "pboost" && WHO.owner) G.game.boost(2, 30, "all");
        break;
      }
      case "ping": send(ws, { t: "pong", at: m.at }); break;
    }
  });
  const rt = setInterval(() => { C.rate = 0; }, 1000);
  ws.on("close", () => { clearInterval(rt); if (C.push) { const G = C.push; G.ops.delete(ws); if (!G.ops.size) { clearTimeout(G.dieT); G.dieT = setTimeout(() => { if (!G.ops.size) pushStop(G); }, 30 * 60000); } } if (C.watch) { const W = WATCH.get(C.watch); if (W) { W.delete(ws); if (!W.size) WATCH.delete(C.watch); } } leave(); dropSolo(); if (C.learn) C.learn.stop(); if (pc) { const S = CONNS.get(PK); if (S) { S.delete(pc); if (!S.size) CONNS.delete(PK); } const ux = INVDB.users.find(x => x.name === PK); if (ux) { ux.seen = new Date().toISOString(); saveInvDB(); } } });
  if (PK) { pc = C; let S = CONNS.get(PK); if (!S) CONNS.set(PK, S = new Set()); S.add(C); const ux = INVDB.users.find(x => x.name === PK); if (ux) { ux.seen = new Date().toISOString(); saveInvDB(); } }
  send(ws, { t: "hi", mock: TT.MOCK, version: 1, who: WHO.name, owner: !!WHO.owner });
});

// keep idle connections alive behind proxies
setInterval(() => { for (const ws of wss.clients) { try { ws.ping(); } catch (e) { } } }, 25000);

server.listen(PORT, () => console.log(`gift-war server on :${PORT}${TT.MOCK ? " (MOCK TikTok)" : ""}`));
