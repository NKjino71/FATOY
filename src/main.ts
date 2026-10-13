/* =========================================================================
 * FA Simulator — 엔트리: 시뮬레이션 + 캔버스 렌더러 + 측면 대시보드 결합
 * ========================================================================= */

import { Line, LineConfig } from "./fa-sim";
import { TickLoop } from "./fa-tick-loop";
import { FARenderer } from "./fa-renderer";
import { Dashboard } from "./fa-dashboard";

const CONFIG: LineConfig = {
  seed: 42,
  nodes: [
    { type: "source", id: "in", name: "투입구", tact: 2 },
    { type: "conveyor", id: "cv1", name: "컨베이어 1", transitTime: 3, capacity: 4 },
    { type: "machine", id: "m1", name: "가공기 1", tact: { dist: "normal", mean: 4, sd: 0.5 } },
    { type: "buffer", id: "buf", name: "버퍼", capacity: 5 },
    { type: "machine", id: "m2", name: "가공기 2", tact: 3 },
    { type: "conveyor", id: "cv2", name: "컨베이어 2", transitTime: 2, capacity: 3 },
    { type: "sink", id: "out", name: "적재함", mode: "storage" },
  ],
  edges: [["in", "cv1"], ["cv1", "m1"], ["m1", "buf"], ["buf", "m2"], ["m2", "cv2"], ["cv2", "out"]],
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("fa");
const dashEl = $("dash");
const playBtn = $<HTMLButtonElement>("play");
const resetBtn = $<HTMLButtonElement>("reset");
const speedSel = $<HTMLSelectElement>("speed");

let loop: TickLoop;
let renderer: FARenderer;
let dash: Dashboard;
let playing = true;

const onResize = () => renderer?.resize();
window.addEventListener("resize", onResize);

function boot() {
  const line = Line.fromConfig(CONFIG);
  renderer = new FARenderer(canvas, line);
  dash = new Dashboard(dashEl, line, { windowSec: 60 });
  loop = new TickLoop(line, {
    dt: 0.05,
    speed: Number(speedSel.value),
    onTick: ({ snapshot }) => {
      renderer.render(snapshot);
      dash.update(snapshot);
    },
  });
  loop.init();
  if (playing) loop.play();
}

function teardown() {
  loop?.pause();
  renderer?.dispose();
  dash?.dispose();
}

playBtn.addEventListener("click", () => {
  playing = !playing;
  playBtn.textContent = playing ? "⏸ 일시정지" : "▶ 재생";
  if (playing) loop.play(); else loop.pause();
});

resetBtn.addEventListener("click", () => {
  teardown();
  boot();
});

speedSel.addEventListener("change", () => { loop.speed = Number(speedSel.value); });

boot();
