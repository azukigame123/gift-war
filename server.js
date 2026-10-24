// ギフト攻城戦 server: serves the game page, runs rooms (online battles + practice), and relays TikTok LIVE events.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { createSim, snapshot } = require("./sim");
const TT = require("./tiktok");

const PORT = +process.env.PORT || 8080;
const SPEED = Math.max(1, Math.min(20, +process.env.GAME_SPEED || 1)); // testing only
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

// ---------- http ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  if (u.pathname === "/api/gifts") {
    const list = await TT.giftCatalog(u.searchParams.get("u") || "");
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ok: !!list, gifts: list || [] }));
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
const UNIT_IDS = ["rookie", "archer", "shield", "rider", "bomber", "mage", "golem", "dragon"];
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const other = t => t === "b" ? "r" : "b";

function cleanDeck(d) { const s = new Set((Array.isArray(d) ? d : []).filter(x => UNIT_IDS.includes(x))); return s.size >= 1 ? [...s] : [...UNIT_IDS]; }
function cleanGifts(g) {
  const o = {}; if (!g || typeof g !== "object") return o;
  for (const k of [...UNIT_IDS, "glove"]) { const v = g[k]; if (v && typeof v === "object") o[k] = { id: String(v.id || "").slice(0, 32), name: String(v.name || "").slice(0, 40).toLowerCase() }; }
  return o;
}

function roomView(room) {
  const pv = t => { const P = room.players[t]; if (!P) return null; return { name: P.name, live: P.live ? P.live.info() : { st: "", msg: "", avatar: null }, here: !!P.ws, ready: !!P.ready, cpu: !!P.cpu }; };
  return { code: room.code, phase: room.phase, practice: room.practice, offline: !!room.offline, players: { b: pv("b"), r: pv("r") } };
}
// stream-only pages (LIVE Studio "link" source) watch a streamer by TikTok username
const WATCH = new Map();
const wkey = n => TT.clean(n).toLowerCase();
function broadcast(room, o) {
  for (const t of ["b", "r"]) {
    const P = room.players[t]; if (!P) continue;
    if (P.ws) send(P.ws, Object.assign({ you: t }, o));
    if ((o.t === "start" || o.t === "snap") && P.name && !P.cpu) { const W = WATCH.get(wkey(P.name)); if (W) { const msg = JSON.stringify(Object.assign({ you: t }, o)); for (const w of W) if (w.readyState === 1) w.send(msg); } }
  }
}
function roomOf(name) { const k = wkey(name); for (const room of ROOMS.values()) for (const t of ["b", "r"]) { const P = room.players[t]; if (P && !P.cpu && P.name && wkey(P.name) === k) return { room, team: t }; } return null; }
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

function battling(room) { return room.phase === "battle" && room.sim && room.sim.S && !room.sim.S.over; }
function onGift(room, team, g) {
  if (!battling(room)) return; if (room.practice && team === "b" && room.src !== "live") return;
  const P = room.players[team], sim = room.sim, gn = g.giftName.toLowerCase();
  const match = k => { const m = P.gifts[k]; return m && ((m.id && m.id === g.giftId) || (m.name && m.name === gn)); };
  if (match("glove")) { sim.sendGlove(team); return; }
  const unit = UNIT_IDS.find(k => k !== "rookie" && match(k));
  if (!unit) return;
  for (let i = 0; i < g.count; i++) sim.addStock(team, unit, g.nick);
}
function onLike(room, team, l) {
  if (!battling(room)) return; if (room.practice && team === "b" && room.src !== "live") return;
  const S = room.sim.S; S.charge[team] += l.n; S.likesAcc[team] += l.n;
  while (S.likesAcc[team] >= 100) { S.likesAcc[team] -= 100; room.sim.addStock(team, "rookie", l.nick || "いいね"); }
}
function onChat(room, team, c) {
  if (!battling(room)) return; if (room.practice && team === "b" && room.src !== "live") return;
  const P = room.players[team]; const w = (P.cheer || "").trim();
  if (w && c.text.includes(w)) room.sim.cheer(team);
}

function startMatch(room) {
  if (!room.sim) { room.ev = []; room.sim = createSim({ log: (c, t) => room.ev.push(["l", c, t]), play: k => room.ev.push(["s", k]) }); }
  const sim = room.sim;
  for (const t of ["b", "r"]) { const P = room.players[t]; sim.DECK[t].clear(); cleanDeck(P && P.deck).forEach(x => sim.DECK[t].add(x)); sim.MODE[t] = "5"; }
  sim.CFG.cap = room.cap || 60;
  sim.newState();
  for (const t of ["b", "r"]) { for (const id in sim.S.stock[t]) sim.S.stock[t][id] = sim.S.stock[t][id].map(() => "はじめの兵"); sim.S.q[t].forEach(e => e.name = "はじめの兵"); }
  sim.S.gf = { b: {}, r: {} };
  if (room.practice) { sim.setAuto(true, false); sim.setAutoGift(true); sim.AG.b = room.src === "auto"; sim.AG.r = true; sim.GR.r = room.lvl; sim.GR.b = 1; sim.PRAC.on = true; }
  else {
    sim.setAuto(false, false); sim.GR.b = sim.GR.r = 1; sim.PRAC.on = false;
    for (const t of ["b", "r"]) { const P = room.players[t]; const live = P && P.live && P.live.st === "ok"; const off = !!room.offline && !live; sim.AG[t] = off; sim.OFF[t] = false; }
    sim.setAutoGift(sim.AG.b || sim.AG.r);
  }
  if (room.practice) { sim.OFF.b = sim.OFF.r = false; }
  room.ev = [];
  room.phase = "countdown";
  broadcast(room, { t: "start", room: roomView(room), s: snapshot(sim.S) });
  clearTimeout(room.cdT);
  room.cdT = setTimeout(() => { room.phase = "battle"; runLoop(room); }, 2700);
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
    if (sim.S.over) { clearInterval(room.loop); room.loop = null; room.phase = "result"; for (const t of ["b", "r"]) if (room.players[t]) room.players[t].ready = false; }
  }, 1000 / 60);
}
function stopRoom(room) { clearInterval(room.loop); clearTimeout(room.cdT); for (const t of ["b", "r"]) detachLive(room.players[t]); ROOMS.delete(room.code); }
function maybeClose(room) {
  const here = ["b", "r"].some(t => room.players[t] && room.players[t].ws && !room.players[t].cpu);
  if (!here) { clearTimeout(room.dieT); room.dieT = setTimeout(() => { const still = ["b", "r"].some(t => room.players[t] && room.players[t].ws && !room.players[t].cpu); if (!still) stopRoom(room); }, room.phase === "battle" ? 120000 : 15000); }
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: "/ws", perMessageDeflate: { threshold: 512 } , maxPayload: 64 * 1024 });
wss.on("connection", ws => {
  const C = { ws, name: "", gifts: {}, cheer: "がんばれ", deck: UNIT_IDS.slice(0, 7), room: null, team: null, live: null, on: null, rate: 0 };
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
    P.ws = ws; P.name = C.name; P.gifts = C.gifts; P.cheer = C.cheer; P.deck = C.deck; P.ready = false;
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
        if (m.deck) C.deck = cleanDeck(m.deck);
        const P = me();
        if (P) { const nameChanged = P.name !== C.name; P.name = C.name; P.gifts = C.gifts; P.cheer = C.cheer; P.deck = C.deck; if (nameChanged) attachLive(C.room, C.team); lobbyUpdate(C.room); }
        else soloLive();
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
        if (room.practice) { leave(); soloLive(); send(ws, { t: "left" }); return; }
        if (room.phase === "result") { room.phase = "lobby"; for (const t of ["b", "r"]) if (room.players[t]) room.players[t].ready = false; }
        lobbyUpdate(room); break;
      }
      case "watch": {
        const k = wkey(m.name || ""); if (!k) return;
        if (C.watch) { const W = WATCH.get(C.watch); if (W) W.delete(ws); }
        C.watch = k; if (!WATCH.has(k)) WATCH.set(k, new Set()); WATCH.get(k).add(ws);
        const f = roomOf(k); if (f && f.room.sim && f.room.phase !== "lobby") send(ws, { t: "start", you: f.team, room: roomView(f.room), s: snapshot(f.room.sim.S), resume: true });
        break;
      }
      case "ping": send(ws, { t: "pong", at: m.at }); break;
    }
  });
  const rt = setInterval(() => { C.rate = 0; }, 1000);
  ws.on("close", () => { clearInterval(rt); if (C.watch) { const W = WATCH.get(C.watch); if (W) { W.delete(ws); if (!W.size) WATCH.delete(C.watch); } } leave(); dropSolo(); });
  send(ws, { t: "hi", mock: TT.MOCK, version: 1 });
});

// keep idle connections alive behind proxies
setInterval(() => { for (const ws of wss.clients) { try { ws.ping(); } catch (e) { } } }, 25000);

server.listen(PORT, () => console.log(`gift-war server on :${PORT}${TT.MOCK ? " (MOCK TikTok)" : ""}`));
