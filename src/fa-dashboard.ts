/* =========================================================================
 * FA Simulator — Stage 4: Live Dashboard
 *
 * 표시 지표
 *   - 전체 처리량(Throughput) : 누적(개/분) + 최근 윈도우(개/분) + 스파크라인
 *   - 기계별 가동률(%)        : NodeSnapshot.utilization (누적) + 막힘 비율, 병목 후보 강조
 *   - 평균 대기(체류) 시간    : 노드별 "입장 -> 퇴장" 평균 시간 + 전체 평균 리드타임
 *
 * 데이터 수집
 *   - 처리량/가동률 : 스냅샷과 Sink 에서 계산 (엔진 수정 없음)
 *   - 체류 시간     : engine 의 "itemMoved" 이벤트로 자재가 각 노드에 들어온/나간 시각을 추적
 *     (Source 는 입장 기록이 없으므로 제외, Sink 는 도착 시점에 종료)
 *
 * 사용: const dash = new Dashboard(el, line);  TickLoop onTick 에서 dash.update(snapshot)
 * ========================================================================= */

import { Line, NodeSnapshot, Sink } from "./fa-sim";

export interface DashboardOptions {
  windowSec?: number; // 최근 처리량 윈도우(sim-초). 기본 60
  refreshMs?: number; // DOM 갱신 주기(real-ms). 기본 100
  historyLen?: number; // 스파크라인 포인트 수. 기본 120
}

interface Residence { sum: number; count: number }

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");

export class Dashboard {
  private readonly windowSec: number;
  private readonly refreshMs: number;
  private readonly historyLen: number;

  private residence = new Map<string, Residence>();
  private entered = new Map<number, { node: string; t: number }>();
  private samples: { t: number; n: number }[] = [];
  private spark: number[] = [];
  private lastSampleT = -Infinity;
  private lastDraw = -Infinity;
  private off: () => void;

  // Sink 리드타임 증분 집계 (O(n) 재계산 방지)
  private sinks: Sink[];
  private sinkCursor = new Map<string, number>();
  private leadSum = 0;
  private leadCount = 0;

  private el = new Map<string, HTMLElement>();
  private sparkCanvas!: HTMLCanvasElement;

  constructor(private root: HTMLElement, private line: Line, opts: DashboardOptions = {}) {
    this.windowSec = opts.windowSec ?? 60;
    this.refreshMs = opts.refreshMs ?? 100;
    this.historyLen = opts.historyLen ?? 120;

    this.sinks = [...line.nodes.values()].filter((n): n is Sink => n instanceof Sink && n.mode === "storage");
    this.sinks.forEach((s) => this.sinkCursor.set(s.id, 0));

    this.off = line.engine.on("itemMoved", (e) => this.onItemMoved(e));
    this.build();
  }

  dispose() {
    this.off();
    this.root.innerHTML = "";
  }

  /* ------------------------------ 데이터 수집 ----------------------------- */

  private onItemMoved(e: { from: string; to: string; itemId: number; time: number }) {
    const prev = this.entered.get(e.itemId);
    if (prev && prev.node === e.from) {
      const r = this.residence.get(e.from) ?? { sum: 0, count: 0 };
      r.sum += e.time - prev.t;
      r.count++;
      this.residence.set(e.from, r);
    }
    if (this.line.get(e.to) instanceof Sink) this.entered.delete(e.itemId);
    else this.entered.set(e.itemId, { node: e.to, t: e.time });
  }

  private collected(): number {
    let n = 0;
    for (const s of this.sinks) n += s.collected.length;
    return n;
  }

  private updateLeadTime() {
    for (const s of this.sinks) {
      let i = this.sinkCursor.get(s.id)!;
      for (; i < s.leadTimes.length; i++) { this.leadSum += s.leadTimes[i]; this.leadCount++; }
      this.sinkCursor.set(s.id, i);
    }
  }

  /** 최근 windowSec 구간의 처리량(개/분). */
  private recentThroughput(now: number, n: number): number {
    const from = now - this.windowSec;
    let base = this.samples[0];
    for (const s of this.samples) { if (s.t <= from) base = s; else break; }
    if (!base || now - base.t < 1e-6) return 0;
    return ((n - base.n) / (now - base.t)) * 60;
  }

  /* ------------------------------- 갱신 ---------------------------------- */

  /** 매 틱 호출. 샘플링은 매번, DOM 갱신은 refreshMs 로 제한. */
  update(snapshot: NodeSnapshot[]) {
    const now = this.line.engine.now;
    const n = this.collected();

    if (now - this.lastSampleT >= 1 - 1e-9) {
      this.lastSampleT = now;
      this.samples.push({ t: now, n });
      while (this.samples.length > 2 && this.samples[1].t <= now - this.windowSec) this.samples.shift();
      this.spark.push(this.recentThroughput(now, n));
      if (this.spark.length > this.historyLen) this.spark.shift();
    }

    const real = performance.now();
    if (real - this.lastDraw < this.refreshMs) return;
    this.lastDraw = real;
    this.draw(snapshot, now, n);
  }

  private draw(snapshot: NodeSnapshot[], now: number, n: number) {
    this.updateLeadTime();
    const tpAll = now > 0 ? (n / now) * 60 : 0;
    const tpRecent = this.recentThroughput(now, n);
    const lead = this.leadCount ? this.leadSum / this.leadCount : NaN;
    const wip = snapshot.filter((s) => s.kind !== "sink").reduce((a, s) => a + (s.kind === "source" ? 0 : s.wip), 0);

    this.set("tpAll", fmt(tpAll));
    this.set("tpRecent", fmt(tpRecent));
    this.set("done", String(n));
    this.set("lead", fmt(lead));
    this.set("wip", String(wip));
    this.set("clock", `${now.toFixed(1)} s`);

    // 기계별 가동률
    const machines = snapshot.filter((s) => s.kind === "machine");
    const maxU = Math.max(0, ...machines.map((m) => m.utilization));
    for (const m of machines) {
      const u = m.utilization * 100, b = m.blockedRatio * 100;
      (this.el.get(`u:${m.id}`) as HTMLElement).style.width = `${u.toFixed(1)}%`;
      (this.el.get(`b:${m.id}`) as HTMLElement).style.width = `${b.toFixed(1)}%`;
      this.set(`up:${m.id}`, `${u.toFixed(0)}%`);
      this.set(`bp:${m.id}`, `막힘 ${b.toFixed(0)}%`);
      const row = this.el.get(`mrow:${m.id}`)!;
      row.dataset.state = m.state;
      row.classList.toggle("bn", machines.length > 1 && m.utilization === maxU && m.utilization > 0.5);
    }

    // 노드별 평균 체류(대기) 시간
    let maxW = 0;
    for (const r of this.residence.values()) if (r.count) maxW = Math.max(maxW, r.sum / r.count);
    for (const s of snapshot) {
      const bar = this.el.get(`w:${s.id}`);
      if (!bar) continue;
      const r = this.residence.get(s.id);
      const avg = r && r.count ? r.sum / r.count : NaN;
      this.set(`wv:${s.id}`, Number.isFinite(avg) ? `${avg.toFixed(1)} s` : "–");
      bar.style.width = Number.isFinite(avg) && maxW > 0 ? `${((avg / maxW) * 100).toFixed(1)}%` : "0%";
    }

    this.drawSpark();
  }

  private set(key: string, text: string) {
    const e = this.el.get(key);
    if (e && e.textContent !== text) e.textContent = text;
  }

  /* -------------------------------- DOM ---------------------------------- */

  private build() {
    const snap = this.line.snapshot();
    const machines = snap.filter((s) => s.kind === "machine");
    const waits = snap.filter((s) => s.kind === "conveyor" || s.kind === "machine" || s.kind === "buffer");

    this.root.innerHTML = `
      <div class="dash-head"><h2>실시간 대시보드</h2><span data-k="clock" class="mono">0.0 s</span></div>
      <section class="kpis">
        <div class="kpi main"><label>전체 처리량 (누적)</label><b data-k="tpAll">0.0</b><small>개/분</small></div>
        <div class="kpi"><label>최근 ${this.windowSec}s 처리량</label><b data-k="tpRecent">0.0</b><small>개/분</small></div>
        <div class="kpi"><label>완성 수량</label><b data-k="done">0</b><small>개</small></div>
        <div class="kpi"><label>평균 리드타임</label><b data-k="lead">–</b><small>초 (투입→적재)</small></div>
        <div class="kpi"><label>라인 재공(WIP)</label><b data-k="wip">0</b><small>개</small></div>
      </section>
      <section>
        <h3>처리량 추이 <small>(최근 ${this.windowSec}s 윈도우)</small></h3>
        <canvas class="spark"></canvas>
      </section>
      <section>
        <h3>기계별 가동률</h3>
        <div class="legend"><i class="lg u"></i>가동 <i class="lg b"></i>막힘</div>
        ${machines.map((m) => `
          <div class="mrow" data-id="${esc(m.id)}">
            <div class="mtop"><span class="dot"></span><span class="nm">${esc(m.name)}</span>
              <span class="pct mono" data-k="up:${esc(m.id)}">0%</span></div>
            <div class="track"><div class="fill u" data-k="u:${esc(m.id)}"></div><div class="fill b" data-k="b:${esc(m.id)}"></div></div>
            <div class="sub mono" data-k="bp:${esc(m.id)}">막힘 0%</div>
          </div>`).join("")}
      </section>
      <section>
        <h3>평균 대기(체류) 시간 <small>(노드 입장→퇴장)</small></h3>
        ${waits.map((w) => `
          <div class="wrow">
            <span class="nm">${esc(w.name)}</span>
            <div class="track thin"><div class="fill w" data-k="w:${esc(w.id)}"></div></div>
            <span class="mono val" data-k="wv:${esc(w.id)}">–</span>
          </div>`).join("")}
      </section>`;

    // data-k 요소 캐시 (+ 행 요소)
    this.root.querySelectorAll<HTMLElement>("[data-k]").forEach((e) => this.el.set(e.dataset.k!, e));
    this.root.querySelectorAll<HTMLElement>(".mrow").forEach((e) => this.el.set(`mrow:${e.dataset.id}`, e));
    this.sparkCanvas = this.root.querySelector("canvas.spark") as HTMLCanvasElement;
  }

  private drawSpark() {
    const c = this.sparkCanvas;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    const w = r.width, h = r.height;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const data = this.spark;
    if (data.length < 2) return;
    const max = Math.max(1, ...data) * 1.15;
    const pad = 4;
    const step = (w - pad * 2) / (data.length - 1);
    const Y = (v: number) => h - pad - ((h - pad * 2) * v) / max;

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, Y(0)); ctx.lineTo(w - pad, Y(0)); ctx.stroke();

    ctx.beginPath();
    data.forEach((v, i) => (i ? ctx.lineTo(pad + step * i, Y(v)) : ctx.moveTo(pad + step * i, Y(v))));
    ctx.strokeStyle = "#2ecc71";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(pad + step * (data.length - 1), Y(0));
    ctx.lineTo(pad, Y(0));
    ctx.closePath();
    ctx.fillStyle = "rgba(46,204,113,0.15)";
    ctx.fill();

    ctx.fillStyle = "#aab4be";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.fillText(`max ${max.toFixed(0)}`, w - pad, 11);
  }
}
