// 押し合いモード (solo "push" mode): server-side game state.
// Same rules as the approved preview (見本⑨). Help (救済) units walk right, harm (妨害) units walk left;
// the hero walks toward the enemy fort and is knocked back by enemies. Values tuned with the balance sim.
"use strict";

const U = { soldier: { hp: 60, atk: 8, rng: 22, spd: 38 }, archer: { hp: 70, atk: 14, rng: 120, spd: 34 }, shield: { hp: 260, atk: 9, rng: 22, spd: 28 }, rider: { hp: 180, atk: 24, rng: 24, spd: 70 }, mage: { hp: 260, atk: 40, rng: 130, spd: 30, aoe: 1 }, dragon: { hp: 900, atk: 70, rng: 110, spd: 44, aoe: 1 }, rookie: { hp: 30, atk: 5, rng: 20, spd: 36 }, bomber: { hp: 200, atk: 60, rng: 26, spd: 30, aoe: 1 }, golem: { hp: 1400, atk: 60, rng: 30, spd: 22 } };
const UNIT_IDS = Object.keys(U);
// default gift slots: [unit, giftId, giftName, coins, label, count]
const DEF = {
  h: [["soldier", "5655", "バラ", 1, "兵士"], ["rider", "5487", "フィンガーハート", 5, "騎兵"], ["shield", "8913", "ローザ", 10, "盾兵"], ["mage", "5660", "ハートポーズ", 100, "魔法使い"], ["golem", "15194", "つながる心", 299, "ゴーレム"], ["dragon", "7168", "マネーガン", 500, "ドラゴン"]],
  x: [["soldier", "5269", "TikTok", 1, "子分"], ["rider", "13538", "おまもり", 5, "狼騎兵"], ["shield", "51281", "DJレコード", 10, "盾ゴブリン"], ["mage", "8343", "ハンドハート", 100, "黒魔導士"], ["golem", "6267", "コーギー", 299, "岩の巨人"], ["dragon", "11583", "DJメガネ", 500, "魔竜"]],
};
const L = 3000, GMAX = 10, AREA = 5, GSEC = 2;
const TUNE = { hk: 2, hx: 4, wall: 1, ha: 1, hw: 16, r1: 200, r2: 300 };
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
  function newLap() { const fin = COUNT >= CFG.goal - 1, fr = fin ? CFG.fort * 2 : CFG.fort; S = { t: 0, gauge: 0, hero: { s: 150, cd: 0, atk: 40 * TUNE.ha, kb: 0, act: null }, units: [], fx: [], help: [], harm: [], fortB: CFG.castle, maxB: CFG.castle, fortR: fr, maxR: fr, final: fin, over: null, clear: false, feed: [], cut: null, mvp: {}, vfx: [], pops: [], shake: 0, flash: 0, push: .5 }; }
  function recent(a) { while (a.length && S.t - a[0].t > 20) a.shift(); return a.reduce((p, q) => p + q.c, 0); }
  function add(side, id, label, coins, who, n) {
    if (!S || S.over || !U[id]) return; const u = U[id], h = side === "h", c = camS();
    for (let k = 0; k < (n || 1); k++) {
      const s = h ? Math.max(30, c - VIEW + Math.random() * 30) : Math.min(L - 30, c + 570 * .6 - Math.random() * 30);
      const hm = h ? 1 : 1 + (TUNE.hx - 1) * TUNE.hk / (TUNE.hk + recent(S.harm) / Math.min(20, Math.max(5, S.t)));
      const hp = Math.round(u.hp * hm);
      S.units.push({ i: uid++, side, id, s, y: (Math.random() - .5) * 80, hp, max: hp, cd: Math.random(), bob: Math.random() * 6, m: hm });
    }
    if (coins) { (h ? S.help : S.harm).push({ t: S.t, c: coins }); if (h) S.mvp[who] = (S.mvp[who] || 0) + coins; }
    if (coins >= 99) S.cut = { side, txt: `${who} の ${label}！`, t: 2.2, d: 2.2, id };
    else { S.feed.unshift({ side, txt: `${who}：${label}`, t: S.t }); S.feed.length = Math.min(S.feed.length, 3); }
  }
  function skill(kind) {
    if (!S || S.over || S.hero.act) return false; const need = kind === 2 ? AREA : 1; if (S.gauge < need) return false; S.gauge -= need;
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
  function step(dt) {
    if (S.over) { if (S.clear) return; interT -= dt; if (interT <= 0) newLap(); return; }
    S.t += dt; S.gauge = Math.min(GMAX, S.gauge + dt / GSEC);
    const hero = S.hero, rh = recent(S.help), rx = recent(S.harm), push = (rh + 5) / (rh + rx + 10); S.push = push;
    const front = S.units.filter(u => u.side === "x" && u.s > hero.s - 10 && u.s < hero.s + 40), atFort = hero.s >= L - 80;
    hero.moving = false;
    if (hero.act) { } else if (hero.kb > 0) { const d = Math.min(hero.kb, 160 * dt); hero.s -= d; hero.kb -= d; } else if (!front.length && !atFort) { hero.s += TUNE.hw * (0.15 + 1.7 * push) * dt; hero.moving = true; }
    hero.s = Math.max(80, Math.min(L - 80, hero.s));
    hero.cd -= dt; hero.atkT = Math.max(0, (hero.atkT || 0) - dt);
    if (hero.cd <= 0 && !hero.act) { if (front[0]) { front[0].hp -= hero.atk; hero.cd = .6; hero.atkT = .28; } else if (atFort) { S.fortR -= hero.atk; hero.cd = .6; hero.atkT = .28; S.fx.push({ s: L - 40, y: 0, t: .3, c: "#ffcf3f" }); } }
    for (const u of S.units) {
      const T = U[u.id]; u.cd -= dt; const foes = S.units.filter(o => o.side !== u.side && o.hp > 0); let tgt = null, dist = 1e9;
      for (const o of foes) { const d = Math.abs(o.s - u.s) + Math.abs(o.y - u.y) * .3; if (d < dist) { dist = d; tgt = o; } }
      if (u.side === "x") { const d = Math.abs(u.s - hero.s); if (d < dist) { dist = d; tgt = "hero"; } const df = u.s - 40; if (df < dist) { dist = df; tgt = "fortB"; } } else { const df = L - 40 - u.s; if (df < dist) { dist = df; tgt = "fortR"; } }
      if (tgt && dist <= T.rng) {
        if (u.cd <= 0) {
          u.cd = 1; u.atkT = .3; const A = T.atk * (u.m || 1);
          if (tgt === "hero") { if (TUNE.wall && hero.s <= 95) { S.fortB -= A; S.fx.push({ s: 40, y: u.y, t: .3, c: "#ff6a7d" }); } hero.kb = Math.min(300, hero.kb + A * 1.2); S.fx.push({ s: hero.s, y: 0, t: .3, c: "#ff6a7d" }); }
          else if (tgt === "fortB") S.fortB -= A;
          else if (tgt === "fortR") { S.fortR -= A; S.fx.push({ s: L - 40, y: u.y, t: .3, c: "#7dffae" }); }
          else { (T.aoe ? foes.filter(o => Math.abs(o.s - tgt.s) < 30) : [tgt]).forEach(o => o.hp -= A); S.fx.push({ s: tgt.s, y: tgt.y, t: .3, c: T.aoe ? "#ffb347" : "#fff" }); }
        }
      } else { if (u.side === "h" && u.s > hero.s + 220 && tgt !== "fortR") continue; u.s += (u.side === "h" ? 1 : -1) * T.spd * dt; u.mv = .15; if (tgt && typeof tgt === "object") u.y += Math.sign(tgt.y - u.y) * 10 * dt; }
    }
    S.units.forEach(u => { u.atkT = Math.max(0, (u.atkT || 0) - dt); u.mv = Math.max(0, (u.mv || 0) - dt); u.hitT = Math.max(0, (u.hitT || 0) - dt); if (u.lh != null && u.hp < u.lh) u.hitT = .18; u.lh = u.hp; });
    S.units = S.units.filter(u => u.hp > 0);
    for (const k of ["fx", "vfx", "pops"]) { S[k].forEach(f => f.t -= dt); S[k] = S[k].filter(f => f.t > 0); }
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
      t: r1(S.t), g: r1(S.gauge), n: COUNT, cfg: CFG, fin: S.final, over: S.over, clear: S.clear, it: Math.ceil(interT), push: r1(S.push),
      fb: Math.round(S.fortB), mb: S.maxB, fr: Math.round(S.fortR), mr: S.maxR,
      hero: { s: r1(S.hero.s), kb: Math.round(S.hero.kb), mv: S.hero.moving ? 1 : 0, at: S.hero.atkT > 0 ? 1 : 0, act: S.hero.act ? { k: S.hero.act.k, t: r1(S.hero.act.t), d: S.hero.act.d } : null },
      u: S.units.map(u => [u.i, u.side, u.id, r1(u.s), r1(u.y), Math.round(u.hp / u.max * 100), u.atkT > 0 ? 1 : 0, u.mv > 0 ? 1 : 0, u.hitT > 0 ? 1 : 0, r1(u.bob)]),
      fx: S.fx.map(f => [r1(f.s), r1(f.y || 0), r1(f.t), f.c]), vfx: S.vfx.map(f => [f.k, r1(f.s), r1(f.t), f.d]), pops: S.pops.map(p => [r1(p.s), r1(p.y), p.txt, r1(p.t), p.c, p.big ? 1 : 0]),
      feed: S.feed.filter(f => S.t - f.t < 4).map(f => [f.side, f.txt, r1(S.t - f.t)]), cut: S.cut, sh: r1(S.shake), fl: r1(S.flash),
      mvp: Object.entries(S.mvp).sort((a, b) => b[1] - a[1]).slice(0, 3),
      slots: { h: slots.h.map(s => [s.unit, s.id, s.img, s.label]), x: slots.x.map(s => [s.unit, s.id, s.img, s.label]) },
    };
  }
  return {
    start(cfg, g) { CFG = { goal: [3, 5, 7, 10].includes(+cfg.goal) ? +cfg.goal : 5, fort: [1500, 3000, 5000].includes(+cfg.fort) ? +cfg.fort : 3000, castle: [3000, 5000, 8000].includes(+cfg.castle) ? +cfg.castle : 5000 }; if (g) slots = cleanSlots(g); COUNT = 0; interT = 0; newLap(); },
    setSlots(g) { slots = cleanSlots(g); },
    get slots() { return slots; },
    get running() { return !!S; },
    tick, skill, gift, snapshot,
    test(side, i, who) { const sl = slots[side] && slots[side][i]; if (sl) add(side, sl.unit, `${sl.name}→${sl.label}`, sl.coins, who || "テスト", 1); },
  };
}

module.exports = { createPush, DEF, cleanSlots, UNIT_IDS };
