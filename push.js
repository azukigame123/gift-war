// 押し合いモード (solo "push" mode): server-side game state.
// Same rules as the approved preview (見本⑨). Help (救済) units walk right, harm (妨害) units walk left;
// the hero walks toward the enemy fort and is knocked back by enemies. Values tuned with the balance sim.
"use strict";
(function () {

// abilities follow the main game (UNITS in public/index.html): G = seconds between unit skills, sk = shout
const U = {
  soldier: { hp: 60, atk: 8, rng: 22, spd: 38, sk: "根性！" },
  archer: { hp: 70, atk: 14, rng: 120, spd: 34, G: 9, sk: "連射！" },
  shield: { hp: 260, atk: 9, rng: 22, spd: 28, G: 12, sk: "かかってこい！" },
  rider: { hp: 180, atk: 24, rng: 24, spd: 70, G: 10, sk: "突撃！" },
  mage: { hp: 260, atk: 40, rng: 130, spd: 30, G: 8, sk: "燃え尽きろ！" },
  dragon: { hp: 900, atk: 70, rng: 110, spd: 44, G: 15, sk: "グオォォ！", fly: 1, splash: 45 },
  rookie: { hp: 30, atk: 5, rng: 20, spd: 36 },
  bomber: { hp: 200, atk: 60, rng: 26, spd: 30, splash: 30 },
  golem: { hp: 1400, atk: 60, rng: 30, spd: 22, G: 14, sk: "ドゴォン！" },
};
const UNIT_IDS = Object.keys(U);
// default gift slots: [unit, giftId, giftName, coins, label, count]
const DEF = {
  h: [["soldier", "5655", "バラ", 1, "兵士"], ["rider", "5487", "フィンガーハート", 5, "騎兵"], ["shield", "8913", "ローザ", 10, "盾兵"], ["mage", "5660", "ハートポーズ", 100, "魔法使い"], ["golem", "15194", "つながる心", 299, "ゴーレム"], ["dragon", "7168", "マネーガン", 500, "ドラゴン"]],
  x: [["soldier", "5269", "TikTok", 1, "子分"], ["rider", "13538", "おまもり", 5, "狼騎兵"], ["shield", "51281", "DJレコード", 10, "盾ゴブリン"], ["mage", "8343", "ハンドハート", 100, "黒魔導士"], ["golem", "6267", "コーギー", 299, "岩の巨人"], ["dragon", "11583", "DJメガネ", 500, "魔竜"]],
};
const L = 3000, GMAX = 10, AREA = 5, GSEC = 2;
const TUNE = { hk: 2, hx: 3.5, wall: 1, ha: 1, hw: 16, r1: 200, r2: 300, ab: 1 };
const VIEW = 570 * 0.4; // camera: hero sits 40% from the left of a 570px wide course

function cleanSlots(g) {
  const out = { h: [], x: [] };
  for (const side of ["h", "x"]) {
    const src = g && Array.isArray(g[side]) ? g[side] : [];
    for (let i = 0; i < DEF[side].length; i++) {
      const d = DEF[side][i], v = src[i] && typeof src[i] === "object" ? src[i] : {};
      out[side].push({ unit: d[0], label: d[4], id: String(v.id || d[1]).slice(0, 32), name: String(v.name || d[2]).slice(0, 40), coins: Math.max(0, Math.min(1e6, +v.coins || d[3])), img: typeof v.img === "string" && /^https:\/\//.test(v.img) ? v.img.slice(0, 600) : "" });
    }
  }
  return out;
}

function createPush() {
  let S = null, COUNT = 0, CFG = { goal: 5, fort: 3000, castle: 5000 }, interT = 0, uid = 1;
  let slots = cleanSlots(null);
  const camS = () => Math.max(VIEW, Math.min(L - 570 * 0.6, S.hero.s));
  function newLap() { const fin = COUNT >= CFG.goal - 1, fr = fin ? CFG.fort * 2 : CFG.fort; S = { t: 0, gauge: 0, hero: { s: 150, cd: 0, atk: 40 * TUNE.ha, kb: 0, act: null }, units: [], fx: [], help: [], harm: [], fortB: CFG.castle, maxB: CFG.castle, fortR: fr, maxR: fr, final: fin, over: null, clear: false, feed: [], cut: null, mvp: {}, vfx: [], pops: [], shots: [], zones: [], shake: 0, flash: 0, push: .5 }; }
  function recent(a) { while (a.length && S.t - a[0].t > 20) a.shift(); return a.reduce((p, q) => p + q.c, 0); }
  function add(side, id, label, coins, who, n) {
    if (!S || S.over || !U[id]) return; const u = U[id], h = side === "h", c = camS();
    for (let k = 0; k < (n || 1); k++) {
      const s = h ? Math.max(30, c - VIEW + Math.random() * 30) : Math.min(L - 30, c + 570 * .6 - Math.random() * 30);
      const hm = h ? 1 : 1 + (TUNE.hx - 1) * TUNE.hk / (TUNE.hk + recent(S.harm) / Math.min(20, Math.max(5, S.t)));
      const hp = Math.round(u.hp * hm);
      S.units.push({ i: uid++, side, id, s, y: (Math.random() - .5) * 80, hp, max: hp, cd: Math.random(), bob: Math.random() * 6, m: hm, g: Math.random() * .3, run: 0 });
    }
    if (coins) { (h ? S.help : S.harm).push({ t: S.t, c: coins }); if (h) S.mvp[who] = (S.mvp[who] || 0) + coins; }
    if (coins >= 99 && !(S.cut && S.cut.id === "hero")) S.cut = { side, txt: `${who} の ${label}！`, t: 2.2, d: 2.2, id }; // the hero's big attack is never covered
    else { S.feed.unshift({ side, txt: `${who}：${label}`, t: S.t }); S.feed.length = Math.min(S.feed.length, 3); }
  }
  function skill(kind) {
    if (!S || S.over || S.hero.act) return false; const need = kind === 2 ? AREA : 1; if (S.gauge < need - .05) return false; S.gauge = Math.max(0, S.gauge - need);
    if (kind === 1) S.hero.act = { k: "lunge", t: 0, d: .5 };
    else { S.hero.act = { k: "charge", t: 0, d: .75 }; S.cut = { side: "h", txt: "勇者の大回転斬り！", t: 1.6, d: 1.6, id: "hero" }; }
    return true;
  }
  function heroAct(rdt) {
    const hero = S.hero, a = hero.act; if (!a) return; a.t += rdt;
    const foes = S.units.filter(u => u.side === "x" && u.s > hero.s - 30);
    if (a.k === "lunge" && !a.hit && a.t >= .14) { a.hit = 1; const t = foes.filter(u => u.s < hero.s + TUNE.r1).sort((p, q) => p.s - q.s)[0]; if (t) { t.hp -= 600; S.pops.push({ s: t.s, y: t.y, txt: "600", t: 1, c: "#ffcf3f", big: 1 }); t.s += 30; } S.vfx.push({ k: "slash", s: hero.s + 70, t: .35, d: .35 }); S.shake = Math.max(S.shake, 7); }
    if (a.k === "spin" && !a.hit) { a.hit = 1; foes.filter(u => u.s < hero.s + TUNE.r2).forEach(u => { u.hp -= 320; u.s += 70; S.pops.push({ s: u.s, y: u.y, txt: "320", t: .9, c: "#fff" }); }); S.vfx.push({ k: "ring", s: hero.s + 40, t: .6, d: .6 }); S.flash = .35; S.shake = 16; }
    if (a.t >= a.d) { if (a.k === "charge") hero.act = { k: "spin", t: 0, d: .6 }; else hero.act = null; }
  }
  const sgn = side => side === "h" ? 1 : -1;
  const foesOf = u => S.units.filter(o => o.side !== u.side && o.hp > 0);
  const shout = (u, txt) => S.pops.push({ s: u.s, y: u.y - 30, txt, t: 1.1, c: u.side === "h" ? "#ffe27a" : "#ffb0c0", sk: 1 });
  function dmg(v, a, src) {
    if (v.hp <= 0) return;
    if (v.id === "shield") a *= 1 - Math.min(.6, .12 * (v.crowd || 0));
    if (U[v.id].fly && src && (src.id === "archer" || src.id === "mage")) a *= 1.25;
    if (v.id === "dragon") a *= .8;
    if (v.guardT > 0) a *= .1;
    v.hp -= a;
    if (v.hp <= 0 && v.id === "soldier" && (v.grit || 0) < 2) { // 根性: hold on with 1 hp; the second time he is promoted to a shield
      v.grit = (v.grit || 0) + 1; v.hp = 1; shout(v, v.grit >= 2 ? "出世！" : "根性！");
      if (v.grit >= 2) { v.id = "shield"; v.max = v.hp = U.shield.hp * .5 * (v.m || 1); v.g = 0; v.aura = 1; }
    }
  }
  function shot(k, u, v, t) { S.shots.push({ k, a: u.s, b: u.y, c: v.s, e: v.y, t: t || .3, d: t || .3, side: u.side }); }
  function skillOf(u, foes) {
    const T = U[u.id], near = r => foes.filter(v => Math.abs(v.s - u.s) < r && Math.abs(v.y - u.y) < r * .7);
    switch (u.id) {
      case "archer": if (!near(T.rng + 40).length) return false; u.volley = 5; u.volT = 0; break;
      case "shield": if (!near(90).length) return false; u.guardT = 5; u.tauntT = 9; break;
      case "rider": { const ahead = foes.filter(v => (v.s - u.s) * sgn(u.side) > 0 && (v.s - u.s) * sgn(u.side) < 160 && Math.abs(v.y - u.y) < 40); if (!ahead.length) return false; u.dash = .45; u.dashHit = new Set(); break; }
      case "mage": { const f = near(170).sort((a, b) => Math.abs(a.s - u.s) - Math.abs(b.s - u.s))[0]; if (!f) return false; S.zones.push({ s: f.s, y: f.y, r: 60, t: 4, k: 0, side: u.side, dmg: T.atk * .3 * (u.m || 1), src: u }); break; }
      case "golem": { const hit = near(70); if (!hit.length) return false; hit.forEach(v => { dmg(v, T.atk * .6 * (u.m || 1), u); v.s += sgn(u.side) * 32; v.stun = Math.max(v.stun || 0, 1); }); S.vfx.push({ k: "slam", s: u.s, y: u.y, t: .6, d: .6, side: u.side }); S.shake = Math.max(S.shake, 8);
        if (u.side === "x" && Math.abs(S.hero.s - u.s) < 70) S.hero.kb = Math.min(300, S.hero.kb + 60); break; }
      case "dragon": { const hit = near(170); const heroNear = u.side === "x" && Math.abs(S.hero.s - u.s) < 170; if (!hit.length && !heroNear) return false; hit.forEach(v => v.stun = Math.max(v.stun || 0, 1.5)); if (heroNear) S.hero.stun = 1.5; S.vfx.push({ k: "roar", s: u.s, y: u.y, t: .7, d: .7, side: u.side }); S.shake = Math.max(S.shake, 8); break; }
      default: return false;
    }
    shout(u, T.sk); u.aura = 1; return true;
  }
  function unitStep(u, dt) {
    const T = U[u.id], hero = S.hero, dir = sgn(u.side), M = u.m || 1;
    u.atkT = Math.max(0, (u.atkT || 0) - dt); u.aura = Math.max(0, (u.aura || 0) - dt);
    if (u.guardT > 0) u.guardT -= dt; if (u.tauntT > 0) u.tauntT -= dt;
    if (u.stun > 0) { u.stun -= dt; return; }
    const foes = foesOf(u);
    if (TUNE.ab && T.G && u.hp > 0) { u.g += dt / T.G; if (u.g >= 1 && skillOf(u, foes)) u.g = 0; else u.g = Math.min(u.g, 1); }
    if (u.volley > 0 && (u.volT -= dt) <= 0) { // archer volley: 3 arrows at the nearest foes, 5 times
      u.volley--; u.volT = .2; u.atkT = .25;
      const fs = foes.filter(v => Math.abs(v.s - u.s) < T.rng + 40).sort((a, b) => Math.abs(a.s - u.s) - Math.abs(b.s - u.s)).slice(0, 3);
      for (let k = 0; k < 3 && fs.length; k++) { const v = fs[k % fs.length], cr = Math.random() < .25; dmg(v, T.atk * .8 * M * (cr ? 2 : 1), u); shot("arrow", u, v, .25); }
    }
    if (u.dash > 0) { // rider charge: runs through and hits everyone on the way
      u.dash -= dt; u.s += dir * 320 * dt; u.mv = .15;
      for (const v of foes) if (!u.dashHit.has(v) && Math.abs(v.s - u.s) < 26 && Math.abs(v.y - u.y) < 30) { u.dashHit.add(v); dmg(v, T.atk * 2.5 * M, u); S.fx.push({ s: v.s, y: v.y, t: .3, c: "#fff" }); }
      u.s = Math.max(30, Math.min(L - 30, u.s)); return;
    }
    if ((u.ct = (u.ct || 0) - dt) <= 0) { u.ct = .4; // crowd checks
      if (u.id === "soldier") u.pack = Math.min(4, S.units.filter(v => v !== u && v.side === u.side && Math.abs(v.s - u.s) < 50 && Math.abs(v.y - u.y) < 50).length);
      if (u.id === "shield") u.crowd = foes.filter(v => Math.abs(v.s - u.s) < 60 && Math.abs(v.y - u.y) < 60).length;
    }
    u.cd -= dt;
    let tgt = null, dist = 1e9;
    for (const o of foes) { if (U[o.id].fly && T.rng < 40) continue; let d = Math.abs(o.s - u.s) + Math.abs(o.y - u.y) * .3; if (o.tauntT > 0 && d < 120) d *= .3; if (d < dist) { dist = d; tgt = o; } }
    if (tgt && tgt.tauntT > 0) dist = Math.abs(tgt.s - u.s) + Math.abs(tgt.y - u.y) * .3;
    if (u.side === "x") { const d = Math.abs(u.s - hero.s); if (d < dist) { dist = d; tgt = "hero"; } const df = u.s - 40; if (df < dist) { dist = df; tgt = "fortB"; } } else { const df = L - 40 - u.s; if (df < dist) { dist = df; tgt = "fortR"; } }
    if (tgt && dist <= T.rng) {
      if (u.cd <= 0) {
        u.cd = u.id === "soldier" ? 1 / (1 + .125 * (u.pack || 0)) : 1; u.atkT = .3; let A = T.atk * M;
        if (u.id === "rider") { A *= 1 + Math.min(.8, (u.run || 0) / 150); u.run = 0; }
        if (u.id === "archer" && Math.random() < .25) { A *= 2; S.pops.push({ s: u.s + dir * 30, y: u.y, txt: "会心！", t: .7, c: "#ffe27a" }); }
        if (tgt === "hero") { if (TUNE.wall && hero.s <= 95) { S.fortB -= A; S.fx.push({ s: 40, y: u.y, t: .3, c: "#ff6a7d" }); } hero.kb = Math.min(300, hero.kb + A * 1.2); S.fx.push({ s: hero.s, y: 0, t: .3, c: "#ff6a7d" }); if (T.rng > 40) shot(u.id === "mage" ? "orb" : u.id === "dragon" ? "fire" : "arrow", u, { s: hero.s, y: 0 }); }
        else if (tgt === "fortB") { S.fortB -= A; if (T.rng > 40) shot(u.id === "mage" ? "orb" : u.id === "dragon" ? "fire" : "arrow", u, { s: 40, y: u.y }); }
        else if (tgt === "fortR") { S.fortR -= A; S.fx.push({ s: L - 40, y: u.y, t: .3, c: "#7dffae" }); if (T.rng > 40) shot(u.id === "mage" ? "orb" : u.id === "dragon" ? "fire" : "arrow", u, { s: L - 40, y: u.y }); }
        else {
          if (u.id === "mage") { const fs = foes.filter(v => Math.abs(v.s - u.s) <= T.rng + 10).sort((a, b) => Math.abs(a.s - u.s) - Math.abs(b.s - u.s)).slice(0, 5); if (!fs.includes(tgt)) fs.unshift(tgt); fs.slice(0, 5).forEach(v => { dmg(v, A, u); shot("orb", u, v); }); }
          else if (u.id === "dragon") { foes.filter(v => Math.abs(v.s - tgt.s) < T.splash && Math.abs(v.y - tgt.y) < T.splash).forEach(v => dmg(v, A, u)); shot("fire", u, tgt, .35); S.vfx.push({ k: "burn", s: tgt.s, y: tgt.y, t: .4, d: .4, side: u.side }); }
          else if (u.id === "golem") { foes.filter(v => Math.abs(v.s - tgt.s) < 30 && Math.abs(v.y - tgt.y) < 30).forEach(v => { dmg(v, v === tgt ? A : A * .7, u); if (!U[v.id].fly) v.s += dir * 20; }); S.fx.push({ s: tgt.s, y: tgt.y, t: .3, c: "#ffb347" }); }
          else if (u.id === "shield") { dmg(tgt, A, u); const o2 = foes.find(v => v !== tgt && Math.abs(v.s - u.s) < T.rng + 20 && Math.abs(v.y - u.y) < 30); if (o2) dmg(o2, A, u); S.fx.push({ s: tgt.s, y: tgt.y, t: .3, c: "#fff" }); }
          else { (T.splash ? foes.filter(o => Math.abs(o.s - tgt.s) < T.splash) : [tgt]).forEach(o => dmg(o, A, u)); if (T.rng > 40) shot("arrow", u, tgt); S.fx.push({ s: tgt.s, y: tgt.y, t: .3, c: "#fff" }); }
        }
      }
    } else {
      if (u.side === "h" && u.s > hero.s + 220 && tgt !== "fortR") return;
      const st = T.spd * (u.mini ? 1.2 : 1) * dt; u.s += dir * st; u.mv = .15; u.run = (u.run || 0) + st;
      if (tgt && typeof tgt === "object") u.y += Math.sign(tgt.y - u.y) * 10 * dt;
    }
  }
  function step(dt) {
    if (S.over) { if (S.clear) return; interT -= dt; if (interT <= 0) newLap(); return; }
    S.t += dt; S.gauge = Math.min(GMAX, S.gauge + dt / GSEC);
    const hero = S.hero, rh = recent(S.help), rx = recent(S.harm), push = (rh + 5) / (rh + rx + 10); S.push = push;
    const front = S.units.filter(u => u.side === "x" && u.s > hero.s - 10 && u.s < hero.s + 40), atFort = hero.s >= L - 80;
    hero.moving = false; if (hero.stun > 0) hero.stun -= dt;
    if (hero.act || hero.stun > 0) { } else if (hero.kb > 0) { const d = Math.min(hero.kb, 160 * dt); hero.s -= d; hero.kb -= d; } else if (!front.length && !atFort) { hero.s += TUNE.hw * (0.15 + 1.7 * push) * dt; hero.moving = true; }
    hero.s = Math.max(80, Math.min(L - 80, hero.s));
    hero.cd -= dt; hero.atkT = Math.max(0, (hero.atkT || 0) - dt);
    if (hero.cd <= 0 && !hero.act && !(hero.stun > 0)) { if (front[0]) { front[0].hp -= hero.atk; hero.cd = .6; hero.atkT = .28; } else if (atFort) { S.fortR -= hero.atk; hero.cd = .6; hero.atkT = .28; S.fx.push({ s: L - 40, y: 0, t: .3, c: "#ffcf3f" }); } }
    for (const u of S.units) unitStep(u, dt);
    for (const z of S.zones) { z.t -= dt; z.k -= dt; if (z.k <= 0) { z.k = .5; for (const v of S.units) if (v.side !== z.side && v.hp > 0 && Math.abs(v.s - z.s) < z.r && Math.abs(v.y - z.y) < z.r * .6) dmg(v, z.dmg, z.src); } }
    S.zones = S.zones.filter(z => z.t > 0);
    // golem splits into two small golems (the small ones do not split)
    for (const u of S.units) if (u.hp <= 0 && u.id === "golem" && !u.mini && !u.split) { u.split = 1; for (let k = 0; k < 2; k++) S.units.push({ i: uid++, side: u.side, id: "golem", mini: 1, s: u.s + (k ? 14 : -14) * (u.side === "h" ? -1 : 1), y: u.y + (k ? 18 : -18), hp: u.max * .35, max: u.max * .35, cd: .5, bob: Math.random() * 6, m: (u.m || 1) * .5, g: 0, run: 0 }); }
    S.units.forEach(u => { u.atkT = Math.max(0, (u.atkT || 0) - dt); u.mv = Math.max(0, (u.mv || 0) - dt); u.hitT = Math.max(0, (u.hitT || 0) - dt); if (u.lh != null && u.hp < u.lh) u.hitT = .18; u.lh = u.hp; });
    S.units = S.units.filter(u => u.hp > 0);
    for (const k of ["fx", "vfx", "pops", "shots"]) { S[k].forEach(f => f.t -= dt); S[k] = S[k].filter(f => f.t > 0); }
    S.shake = Math.max(0, S.shake - dt * 40); S.flash = Math.max(0, S.flash - dt);
    if (S.cut) { S.cut.t -= dt; if (S.cut.t <= 0) S.cut = null; }
    const end = w => { S.over = w; if (w === "h") { COUNT++; if (S.final) S.clear = true; } else COUNT--; interT = 10; };
    if (S.fortR <= 0) { S.fortR = 0; end("h"); } else if (S.fortB <= 0) { S.fortB = 0; end("x"); }
  }
  // one server tick: the charge pose slows time like the preview
  function tick(dt) { if (!S) return; if (!S.over) heroAct(dt); const slow = S.hero.act && S.hero.act.k === "charge" ? .22 : 1; step(dt * slow); }
  function gift(g) { // g: {giftId, giftName, count, nick}
    if (!S || S.over) return null; const gn = String(g.giftName || "").toLowerCase();
    for (const side of ["h", "x"]) for (const sl of slots[side]) if ((sl.id && sl.id === String(g.giftId)) || (sl.name && sl.name.toLowerCase() === gn)) {
      for (let i = 0; i < Math.min(200, g.count || 1); i++) add(side, sl.unit, `${sl.name}→${sl.label}`, sl.coins, String(g.nick || "だれか").slice(0, 24), 1);
      return side;
    }
    return null;
  }
  const r1 = v => Math.round(v * 10) / 10;
  function snapshot() {
    if (!S) return null;
    return {
      t: r1(S.t), g: Math.floor(S.gauge * 10) / 10, n: COUNT, cfg: CFG, fin: S.final, over: S.over, clear: S.clear, it: Math.ceil(interT), push: r1(S.push),
      fb: Math.round(S.fortB), mb: S.maxB, fr: Math.round(S.fortR), mr: S.maxR,
      hero: { s: r1(S.hero.s), kb: Math.round(S.hero.kb), mv: S.hero.moving ? 1 : 0, at: S.hero.atkT > 0 ? 1 : 0, act: S.hero.act ? { k: S.hero.act.k, t: r1(S.hero.act.t), d: S.hero.act.d } : null },
      u: S.units.map(u => [u.i, u.side, u.id, r1(u.s), r1(u.y), Math.round(u.hp / u.max * 100), u.atkT > 0 ? 1 : 0, u.mv > 0 ? 1 : 0, u.hitT > 0 ? 1 : 0, r1(u.bob), (u.stun > 0 ? 1 : 0) | (u.guardT > 0 ? 2 : 0) | (u.mini ? 4 : 0) | (u.aura > 0 ? 8 : 0) | (u.dash > 0 ? 16 : 0) | (u.tauntT > 0 ? 32 : 0)]),
      fx: S.fx.map(f => [r1(f.s), r1(f.y || 0), r1(f.t), f.c]), vfx: S.vfx.map(f => [f.k, r1(f.s), r1(f.t), f.d, r1(f.y || 0), f.side || ""]), pops: S.pops.map(p => [r1(p.s), r1(p.y), p.txt, r1(p.t), p.c, p.big ? 1 : p.sk ? 2 : 0]), shots: S.shots.map(q => [q.k, r1(q.a), r1(q.b), r1(q.c), r1(q.e), r1(q.t), q.d]), zones: S.zones.map(z => [r1(z.s), r1(z.y), z.r, r1(z.t), z.side]), hst: S.hero.stun > 0 ? 1 : 0,
      feed: S.feed.filter(f => S.t - f.t < 4).map(f => [f.side, f.txt, r1(S.t - f.t)]), cut: S.cut, sh: r1(S.shake), fl: r1(S.flash),
      mvp: Object.entries(S.mvp).sort((a, b) => b[1] - a[1]).slice(0, 3),
      slots: { h: slots.h.map(s => [s.unit, s.id, s.img, s.label]), x: slots.x.map(s => [s.unit, s.id, s.img, s.label]) },
    };
  }
  return {
    start(cfg, g) { CFG = { goal: [3, 5, 7, 10].includes(+cfg.goal) ? +cfg.goal : 5, fort: [1500, 3000, 5000].includes(+cfg.fort) ? +cfg.fort : 3000, castle: [3000, 5000, 8000].includes(+cfg.castle) ? +cfg.castle : 5000 }; if (g) slots = cleanSlots(g); COUNT = 0; interT = 0; newLap(); },
    setSlots(g) { slots = cleanSlots(g); },
    get slots() { return slots; },
    get running() { return !!S; }, get S() { return S; }, TUNE, heroAct,
    tick, skill, gift, snapshot,
    test(side, i, who) { const sl = slots[side] && slots[side][i]; if (sl) add(side, sl.unit, `${sl.name}→${sl.label}`, sl.coins, who || "テスト", 1); },
  };
}

const API = { createPush, DEF, cleanSlots, UNIT_IDS, U };
if (typeof module !== "undefined" && module.exports) module.exports = API; else window.PushGame = API;
})();
