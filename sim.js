// Builds an isolated copy of the game simulation from public/index.html.
// The same code that runs in the browser runs here, so both sides behave identically.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let SCRIPT = null;
function load() {
  const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  const cut = (a, b) => {
    const i = html.indexOf(a), j = html.indexOf(b);
    if (i < 0 || j < 0) throw new Error("sim marker missing: " + a);
    return html.slice(i + a.length, j);
  };
  const sz = (html.match(/const SZ=\{[^\n]*\};/) || [""])[0] + "\n" + (html.match(/const ATKS=\{[^\n]*\};/) || [""])[0] + "\n" + (html.match(/const POSES=\{[^\n]*\};/) || [""])[0];
  const body = sz + "\n" + cut("//#SIM-A", "//#END-A") + "\n" + cut("//#SIM-B", "//#END-B");
  const code = `(function(env){
    const {log,play}=env;
    const COL={b:"#3d9bff",r:"#ff5468",bd:"#1f5fae",rd:"#a3263a",gold:"#ffcf3f"};
    const document={getElementById:()=>({})};
    const localStorage={getItem:()=>null,setItem:()=>{}};
    const PLAYERS=[];const feedEl={};let hover=null;const refreshUI=()=>{};
    ${body}
    return {
      get S(){return S}, newState, step, addStock, sendGlove, cheer, doAct, gloveOK, mult, end,
      DECK, MODE, CFG, AG, GR, PRAC, UNITS, COINV, SKILLS,
      tick(){tick++}, setAuto(r,b){autoR=r;autoB=b}, setAutoGift(v){autoGift=v}
    };
  })`;
  SCRIPT = new vm.Script(code, { filename: "sim_core.js" });
}

function createSim(env) {
  if (!SCRIPT) load();
  const ctx = vm.createContext({ Math, JSON, setTimeout, clearTimeout, console, Set, Map, Array, Object, String, Number, isFinite });
  const factory = SCRIPT.runInContext(ctx);
  return factory(env);
}

// Snapshot: everything the browser needs to draw, with templates replaced by ids.
function snapshot(S) {
  return JSON.stringify(S, function (k, v) {
    if (k === "src" || k === "likesAcc") return undefined;
    if (k === "t" && v && typeof v === "object" && v.id && v.atk !== undefined) return v.id;
    if (typeof v === "number") return Math.round(v * 100) / 100;
    return v;
  });
}

module.exports = { createSim, snapshot, reload: load };
