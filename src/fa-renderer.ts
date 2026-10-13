/* =========================================================================
 * FA Simulator — Stage 3: Canvas Renderer
 *
 * 표현 규칙
 *   - 컨베이어 : 선 (회색=Idle, 녹색=Working, 적색=Blocked)
 *   - 기계     : 사각형 (녹색=Working, 적색=Blocked/병목, 회색=Idle)
 *   - 자재     : 움직이는 원 (컨베이어 위에서는 진행률만큼 이동, 막히면 앞 자재 뒤에 쌓임)
 *
 * 데이터 흐름
 *   - 노드 상태/가동률 : render(snapshot) 로 전달받음 (TickLoop.onTick 에서 호출)
 *   - 자재 위치        : engine 의 "itemMoved" 이벤트를 구독해 노드별 자재 목록을 추적
 *                        (NodeSnapshot 에는 개별 자재 정보가 없으므로)
 *   - 위치(레이아웃)   : 생략하면 연결 그래프 깊이 기준으로 좌->우 자동 배치
 * ========================================================================= */

import {
  Buffer,
  Conveyor,
  Line,
  Machine,
  NodeSnapshot,
  NodeState,
  Sink,
  Source,
  TactTime,
} from "./fa-sim";
import { QueuedMachine, TickLoop } from "./fa-tick-loop";

/* ------------------------------ 타입/상수 ------------------------------- */

export interface NodeLayout {
  x: number; // 중심 x (CSS px)
  y: number; // 중심 y
  w?: number;
  h?: number;
  len?: number; // 컨베이어 길이
}

export interface RendererOptions {
  layout?: Record<string, NodeLayout>;
  /** 컨베이어 id -> 이송 시간(초). 생략 시 노드 내부 설정값을 읽음. */
  transitTimes?: Record<string, number>;
  background?: string;
}

const COLOR = {
  working: "#2ecc71",
  blocked: "#e74c3c",
  idle: "#7f8c8d",
  item: "#3498db",
  itemStroke: "#1b4f72",
  text: "#ecf0f1",
  edge: "#4a5560",
  bg: "#1e2329",
};

const HOP_TIME = 0.3; // 노드 간 이동 애니메이션(sim-초)
const ITEM_R = 6;
const BELT_GAP = 0.09; // 컨베이어 위 자재 간 최소 간격(진행률 단위)

function stateColor(s: NodeState): string {
  return s === NodeState.Working ? COLOR.working
    : s === NodeState.Blocked ? COLOR.blocked : COLOR.idle;
}

interface Pt { x: number; y: number }
interface Box { cx: number; cy: number; w: number; h: number; len: number }
interface Tracked { id: number; enteredAt: number; from: Pt }

/* ------------------------------- Renderer ------------------------------- */

export class FARenderer {
  private ctx: CanvasRenderingContext2D;
  private boxes = new Map<string, Box>();
  private items = new Map<string, Tracked[]>(); // nodeId -> 입장 순서대로 자재
  private where = new Map<number, string>(); // itemId -> nodeId
  private transit = new Map<string, number>();
  private offs: (() => void)[] = [];
  private cssW = 0;
  private cssH = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private line: Line,
    private opts: RendererOptions = {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    this.layoutNodes();
    for (const [id, n] of line.nodes) {
      if (n instanceof Conveyor) {
        const t = opts.transitTimes?.[id]
          ?? (n as unknown as { cfg?: { transitTime?: number } }).cfg?.transitTime
          ?? 3;
        this.transit.set(id, t);
      }
      this.items.set(id, []);
    }
    this.offs.push(line.engine.on("itemMoved", (e) => this.onItemMoved(e)));
  }

  dispose() { this.offs.forEach((f) => f()); this.offs = []; }

  /** 캔버스 크기를 CSS 크기에 맞추고 HiDPI 대응. 창 크기 변경 시 다시 호출. */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.cssW = r.width || this.canvas.width;
    this.cssH = r.height || this.canvas.height;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.boxes.size) this.layoutNodes();
  }

  /* ------------------------------ 자재 추적 ------------------------------ */

  private onItemMoved(e: { from: string; to: string; itemId: number; time: number }) {
    const prev = this.items.get(e.from);
    if (prev) {
      const i = prev.findIndex((t) => t.id === e.itemId);
      if (i >= 0) prev.splice(i, 1);
    }
    const dest = this.line.get(e.to);
    if (dest instanceof Sink) { // 적재함/폐기장 도착 -> 화면에서 제거(개수는 텍스트로 표시)
      this.where.delete(e.itemId);
      return;
    }
    this.items.get(e.to)!.push({
      id: e.itemId,
      enteredAt: e.time,
      from: this.outAnchor(e.from),
    });
    this.where.set(e.itemId, e.to);
  }

  /* ------------------------------- 레이아웃 ------------------------------ */

  private layoutNodes() {
    this.boxes.clear();
    const nodes = [...this.line.nodes.values()];

    // 깊이(최장 경로) 계산 -> 열 번호
    const depth = new Map<string, number>();
    const visit = (id: string, d: number) => {
      if ((depth.get(id) ?? -1) >= d) return;
      depth.set(id, d);
      for (const o of this.line.get(id).outputs) visit(o.id, d + 1);
    };
    nodes.filter((n) => !n.inputs.length).forEach((n) => visit(n.id, 0));

    const cols = Math.max(1, ...[...depth.values()].map((d) => d + 1));
    const rowsInCol = new Map<number, string[]>();
    for (const n of nodes) {
      const d = depth.get(n.id) ?? 0;
      (rowsInCol.get(d) ?? rowsInCol.set(d, []).get(d)!).push(n.id);
    }

    const colW = this.cssW / cols;
    for (const n of nodes) {
      const d = depth.get(n.id) ?? 0;
      const col = rowsInCol.get(d)!;
      const row = col.indexOf(n.id);
      const auto: NodeLayout = {
        x: colW * (d + 0.5),
        y: (this.cssH / (col.length + 1)) * (row + 1),
      };
      const l = { ...auto, ...this.opts.layout?.[n.id] };
      const size = n.kind === "machine" ? [96, 60]
        : n.kind === "buffer" ? [96, 40]
        : n.kind === "conveyor" ? [0, 0] : [64, 44];
      this.boxes.set(n.id, {
        cx: l.x, cy: l.y,
        w: l.w ?? size[0], h: l.h ?? size[1],
        len: l.len ?? colW * 0.7,
      });
    }
  }

  private isConveyor(id: string) { return this.line.get(id) instanceof Conveyor; }

  private inAnchor(id: string): Pt {
    const b = this.boxes.get(id)!;
    return this.isConveyor(id) ? { x: b.cx - b.len / 2, y: b.cy } : { x: b.cx - b.w / 2, y: b.cy };
  }
  private outAnchor(id: string): Pt {
    const b = this.boxes.get(id)!;
    return this.isConveyor(id) ? { x: b.cx + b.len / 2, y: b.cy } : { x: b.cx + b.w / 2, y: b.cy };
  }

  /* -------------------------------- 렌더링 ------------------------------- */

  render(snapshot: NodeSnapshot[]) {
    const ctx = this.ctx;
    const now = this.line.engine.now;
    ctx.fillStyle = this.opts.background ?? COLOR.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // 1) 연결선
    ctx.strokeStyle = COLOR.edge;
    ctx.lineWidth = 2;
    for (const n of this.line.nodes.values()) {
      for (const o of n.outputs) {
        const a = this.outAnchor(n.id), b = this.inAnchor(o.id);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    // 2) 노드
    for (const s of snapshot) {
      const b = this.boxes.get(s.id)!;
      const color = stateColor(s.state);
      if (s.kind === "conveyor") this.drawConveyor(b, color);
      else this.drawBox(b, color, s);
      this.drawLabel(b, s);
    }

    // 3) 자재(원)
    ctx.fillStyle = COLOR.item;
    ctx.strokeStyle = COLOR.itemStroke;
    ctx.lineWidth = 1.5;
    for (const [id, list] of this.items) {
      list.forEach((t, i) => this.drawItem(this.itemPos(id, t, i, now)));
    }
    // Source 가 쥐고 있는 대기 자재(Blocked 시)
    for (const s of snapshot) {
      if (s.kind === "source" && s.wip > 0) {
        const b = this.boxes.get(s.id)!;
        this.drawItem({ x: b.cx, y: b.cy });
      }
    }
    this.drawHud(now);
  }

  private drawConveyor(b: Box, color: string) {
    const ctx = this.ctx;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#2c333a"; // 벨트 바닥
    ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(b.cx - b.len / 2, b.cy); ctx.lineTo(b.cx + b.len / 2, b.cy); ctx.stroke();
    ctx.strokeStyle = color; // 상태 선
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(b.cx - b.len / 2, b.cy); ctx.lineTo(b.cx + b.len / 2, b.cy); ctx.stroke();
    ctx.lineCap = "butt";
  }

  private drawBox(b: Box, color: string, s: NodeSnapshot) {
    const ctx = this.ctx;
    const x = b.cx - b.w / 2, y = b.cy - b.h / 2;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y, b.w, b.h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#0b0e11";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, b.w, b.h);
    if (s.kind === "machine") { // 가동률 바
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x + 6, y + b.h - 10, b.w - 12, 5);
      ctx.fillStyle = COLOR.text;
      ctx.fillRect(x + 6, y + b.h - 10, (b.w - 12) * Math.min(1, s.utilization), 5);
    }
  }

  private drawLabel(b: Box, s: NodeSnapshot) {
    const ctx = this.ctx;
    ctx.fillStyle = COLOR.text;
    ctx.textAlign = "center";
    ctx.font = "12px sans-serif";
    const top = s.kind === "conveyor" ? b.cy + 18 : b.cy + b.h / 2 + 15;
    ctx.fillText(s.name, b.cx, top);
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#aab4be";
    let sub = "";
    if (s.kind === "machine") sub = `가동 ${(s.utilization * 100).toFixed(0)}% · 막힘 ${(s.blockedRatio * 100).toFixed(0)}%`;
    else if (s.kind === "sink") sub = `누적 ${s.passed}`;
    else if (s.kind === "conveyor" || s.kind === "buffer") sub = `재공 ${s.wip}`;
    if (sub) ctx.fillText(sub, b.cx, top + 14);
  }

  private drawItem(p: Pt) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ITEM_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawHud(now: number) {
    const ctx = this.ctx;
    ctx.fillStyle = COLOR.text;
    ctx.textAlign = "left";
    ctx.font = "12px monospace";
    ctx.fillText(`t = ${now.toFixed(1)} s`, 10, 18);
    // 범례
    const legend: [string, string][] = [[COLOR.working, "가동"], [COLOR.blocked, "병목(Blocked)"], [COLOR.idle, "대기"]];
    let x = this.cssW - 10;
    ctx.textAlign = "right";
    for (const [c, label] of legend.reverse()) {
      ctx.fillStyle = COLOR.text; ctx.fillText(label, x, 18);
      x -= ctx.measureText(label).width + 6;
      ctx.fillStyle = c; ctx.fillRect(x - 10, 9, 10, 10);
      x -= 24;
    }
  }

  /* ----------------------------- 자재 위치 계산 --------------------------- */

  private itemPos(nodeId: string, t: Tracked, index: number, now: number): Pt {
    const b = this.boxes.get(nodeId)!;

    if (this.isConveyor(nodeId)) {
      const T = this.transit.get(nodeId)!;
      // 앞(index 작은 쪽) 자재 뒤에는 최소 간격을 두고 쌓임
      const progress = Math.min(1, (now - t.enteredAt) / T);
      const p = Math.max(0, Math.min(progress, 1 - index * BELT_GAP));
      return { x: b.cx - b.len / 2 + b.len * p, y: b.cy };
    }

    // 기계/버퍼: 입장 직후 HOP_TIME 동안 이전 노드 출구에서 부드럽게 이동
    let target: Pt;
    if (index === 0 && this.line.get(nodeId) instanceof Buffer === false) {
      target = { x: b.cx, y: b.cy }; // 기계: 가공 슬롯
    } else if (this.line.get(nodeId) instanceof Buffer) {
      target = { x: b.cx - b.w / 2 + 12 + index * 15, y: b.cy };
    } else {
      // QueuedMachine 대기열: 기계 위쪽에 한 줄
      target = { x: b.cx - b.w / 2 + 8 + (index - 1) * 15, y: b.cy - b.h / 2 - 12 };
    }
    const k = Math.min(1, Math.max(0, (now - t.enteredAt) / HOP_TIME));
    const e = k * k * (3 - 2 * k); // smoothstep
    return { x: t.from.x + (target.x - t.from.x) * e, y: t.from.y + (target.y - t.from.y) * e };
  }
}

/* ------------------------------ 사용 예제 ------------------------------- */
/**
 * HTML:  <canvas id="fa" style="width:100%;height:360px"></canvas>
 * TS  :  mountDemo(document.getElementById("fa") as HTMLCanvasElement);
 */
export function mountDemo(canvas: HTMLCanvasElement) {
  const line = Line.fromConfig({
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
  });

  const renderer = new FARenderer(canvas, line);
  // dt 를 작게(0.05) 잡아야 애니메이션이 부드럽다. speed 로 배속 조절.
  const loop = new TickLoop(line, {
    dt: 0.05,
    speed: 2,
    onTick: ({ snapshot }) => renderer.render(snapshot),
  });
  window.addEventListener("resize", () => renderer.resize());
  loop.init();
  loop.play();
  return { line, loop, renderer };
}

// 사용하지 않는 import 경고 방지용 (타입 참조)
export type _Unused = Machine | QueuedMachine | Source | TactTime;
