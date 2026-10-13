/* =========================================================================
 * FA Discrete-Event Simulator — core architecture (TypeScript)
 *
 * Layers
 *   1. Engine   : EventQueue(min-heap) + SimulationEngine (clock, scheduling)
 *   2. Model    : SimNode (abstract) -> Source / Conveyor / Machine / Buffer / Sink
 *   3. Topology : Line (node registry, connect, build from JSON config)
 *   4. Runtime  : RealtimeRunner (rAF driver, speed control for the web UI)
 *
 * Flow protocol (push + back-pressure)
 *   - Upstream pushes an item only if downstream.canAccept() is true.
 *   - If it cannot push, the node enters Blocked and holds the item.
 *   - When a node frees capacity it calls notifyUpstreams(); upstream retries
 *     via a zero-delay event (keeps ordering deterministic, avoids deep recursion).
 * ========================================================================= */

/* ----------------------------- Basic types ------------------------------ */

export enum NodeState {
  Idle = "Idle",
  Working = "Working",
  Blocked = "Blocked",
}

export type NodeKind = "source" | "conveyor" | "machine" | "buffer" | "sink";

export interface Item {
  id: number;
  createdAt: number;
  attrs?: Record<string, unknown>;
}

const EPS = 1e-9;

/* ------------------------- Random / Tact time --------------------------- */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seconds per item. A number is deterministic; objects add variability. */
export type Duration =
  | number
  | { dist: "uniform"; min: number; max: number }
  | { dist: "normal"; mean: number; sd: number }
  | { dist: "exp"; mean: number };

export class TactTime {
  constructor(private spec: Duration, private rnd: () => number) {}

  sample(): number {
    const s = this.spec;
    if (typeof s === "number") return s;
    switch (s.dist) {
      case "uniform":
        return s.min + (s.max - s.min) * this.rnd();
      case "exp":
        return -Math.log(1 - this.rnd()) * s.mean;
      case "normal": {
        const u = 1 - this.rnd(), v = this.rnd();
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return Math.max(0.001, s.mean + s.sd * z);
      }
    }
  }

  /** Nominal items/sec (1 / mean tact). */
  get nominalThroughput(): number {
    const s = this.spec;
    const mean = typeof s === "number" ? s
      : s.dist === "uniform" ? (s.min + s.max) / 2 : s.mean;
    return 1 / mean;
  }
}

/* ------------------------------- Engine --------------------------------- */

export interface ScheduledEvent {
  time: number;
  seq: number;
  action: () => void;
  label?: string;
  cancelled: boolean;
}

class EventQueue {
  private heap: ScheduledEvent[] = [];
  get size() { return this.heap.length; }
  peek() { return this.heap[0]; }

  push(e: ScheduledEvent) {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(h[i], h[p])) { [h[i], h[p]] = [h[p], h[i]]; i = p; } else break;
    }
  }

  pop(): ScheduledEvent | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }

  clear() { this.heap.length = 0; }

  /** time first, then insertion order (FIFO tie-break => deterministic). */
  private less(a: ScheduledEvent, b: ScheduledEvent) {
    return a.time < b.time - EPS || (Math.abs(a.time - b.time) <= EPS && a.seq < b.seq);
  }
}

export interface EngineEvents {
  stateChange: { nodeId: string; from: NodeState; to: NodeState; time: number };
  itemMoved: { from: string; to: string; itemId: number; time: number };
}

type Listener<K extends keyof EngineEvents> = (e: EngineEvents[K]) => void;

export class SimulationEngine {
  now = 0;
  readonly rnd: () => number;
  private queue = new EventQueue();
  private seq = 0;
  private listeners: { [K in keyof EngineEvents]?: Listener<K>[] } = {};
  private nextItemId = 1;

  constructor(seed = 1) { this.rnd = mulberry32(seed); }

  schedule(delay: number, action: () => void, label?: string): ScheduledEvent {
    const ev: ScheduledEvent = {
      time: this.now + Math.max(0, delay), seq: this.seq++, action, label, cancelled: false,
    };
    this.queue.push(ev);
    return ev;
  }

  newItem(attrs?: Record<string, unknown>): Item {
    return { id: this.nextItemId++, createdAt: this.now, attrs };
  }

  on<K extends keyof EngineEvents>(type: K, fn: Listener<K>): () => void {
    (this.listeners[type] ??= [] as never)!.push(fn as never);
    return () => {
      const arr = this.listeners[type] as Listener<K>[];
      arr.splice(arr.indexOf(fn), 1);
    };
  }

  emit<K extends keyof EngineEvents>(type: K, payload: EngineEvents[K]) {
    (this.listeners[type] as Listener<K>[] | undefined)?.forEach((fn) => fn(payload));
  }

  /** Process exactly one event. Returns false if the queue is empty. */
  step(): boolean {
    let ev = this.queue.pop();
    while (ev?.cancelled) ev = this.queue.pop();
    if (!ev) return false;
    this.now = ev.time;
    ev.action();
    return true;
  }

  /** Run all events with time <= t, then set the clock to t. */
  runUntil(t: number) {
    for (;;) {
      const next = this.queue.peek();
      if (!next || next.time > t + EPS) break;
      this.step();
    }
    if (this.now < t) this.now = t;
  }

  reset(seed?: number) {
    this.queue.clear();
    this.now = 0;
    this.seq = 0;
    this.nextItemId = 1;
    if (seed !== undefined) (this as { rnd: () => number }).rnd = mulberry32(seed);
  }
}

/* ----------------------------- Node (base) ------------------------------ */

export type Routing = "first-available" | "round-robin";

export interface NodeStats {
  timeIn: Record<NodeState, number>;
  passed: number; // items that left this node
}

export interface NodeSnapshot {
  id: string;
  name: string;
  kind: NodeKind;
  state: NodeState;
  wip: number;
  passed: number;
  throughput: number; // measured items/sec
  utilization: number; // Working time ratio
  blockedRatio: number;
  idleRatio: number;
}

export interface NodeConfigBase {
  id: string;
  name?: string;
  routing?: Routing;
}

export abstract class SimNode {
  readonly inputs: SimNode[] = [];
  readonly outputs: SimNode[] = [];
  readonly stats: NodeStats = {
    timeIn: { [NodeState.Idle]: 0, [NodeState.Working]: 0, [NodeState.Blocked]: 0 },
    passed: 0,
  };

  protected engine!: SimulationEngine;
  private _state = NodeState.Idle;
  private lastChange = 0;
  private rr = 0;

  constructor(
    readonly id: string,
    readonly kind: NodeKind,
    readonly name: string = id,
    protected routing: Routing = "first-available",
  ) {}

  get state() { return this._state; }

  /* ---- lifecycle ---- */
  attach(engine: SimulationEngine) { this.engine = engine; }
  /** Called once when the line starts (Source schedules first arrival here). */
  start(): void {}

  /* ---- flow protocol ---- */
  abstract canAccept(): boolean;
  abstract accept(item: Item): void;
  abstract get wip(): number;
  /** Try to make progress (finish processing / push items downstream). */
  protected abstract tryAdvance(): void;

  /** Downstream signals that it has free capacity now. */
  onDownstreamReady() { this.tryAdvance(); }

  /* ---- helpers for subclasses ---- */
  protected setState(next: NodeState) {
    if (next === this._state) return;
    const now = this.engine.now;
    this.stats.timeIn[this._state] += now - this.lastChange;
    const from = this._state;
    this._state = next;
    this.lastChange = now;
    this.engine.emit("stateChange", { nodeId: this.id, from, to: next, time: now });
  }

  protected push(item: Item): boolean {
    const n = this.outputs.length;
    if (!n) return false;
    const base = this.routing === "round-robin" ? this.rr : 0;
    for (let i = 0; i < n; i++) {
      const idx = (base + i) % n;
      const target = this.outputs[idx];
      if (target.canAccept()) {
        if (this.routing === "round-robin") this.rr = (idx + 1) % n;
        this.stats.passed++;
        this.engine.emit("itemMoved", {
          from: this.id, to: target.id, itemId: item.id, time: this.engine.now,
        });
        target.accept(item);
        return true;
      }
    }
    return false;
  }

  protected notifyUpstreams() {
    for (const up of this.inputs) {
      this.engine.schedule(0, () => up.onDownstreamReady(), `ready:${this.id}->${up.id}`);
    }
  }

  snapshot(): NodeSnapshot {
    const now = this.engine.now;
    const t = { ...this.stats.timeIn };
    t[this._state] += now - this.lastChange; // include the open interval
    const total = Math.max(now, EPS);
    return {
      id: this.id, name: this.name, kind: this.kind, state: this._state, wip: this.wip,
      passed: this.stats.passed,
      throughput: this.stats.passed / total,
      utilization: t[NodeState.Working] / total,
      blockedRatio: t[NodeState.Blocked] / total,
      idleRatio: t[NodeState.Idle] / total,
    };
  }

  resetStats() {
    this.stats.timeIn = { [NodeState.Idle]: 0, [NodeState.Working]: 0, [NodeState.Blocked]: 0 };
    this.stats.passed = 0;
    this.lastChange = this.engine?.now ?? 0;
  }
}

/* ------------------------------- Source --------------------------------- */
/** 투입구: emits one item per tact time; Blocked (holding the item) if downstream is full. */
export interface SourceConfig extends NodeConfigBase {
  tact: Duration;
  maxItems?: number; // default: infinite
}

export class Source extends SimNode {
  private pending: Item | null = null;
  private emitted = 0;
  private tact: TactTime;

  constructor(private cfg: SourceConfig, rnd: () => number) {
    super(cfg.id, "source", cfg.name, cfg.routing);
    this.tact = new TactTime(cfg.tact, rnd);
  }

  get wip() { return this.pending ? 1 : 0; }
  canAccept() { return false; }
  accept(): void { throw new Error("Source does not accept items"); }

  override start() { this.scheduleNext(); }

  private scheduleNext() {
    if (this.cfg.maxItems !== undefined && this.emitted >= this.cfg.maxItems) {
      this.setState(NodeState.Idle);
      return;
    }
    this.setState(NodeState.Working);
    this.engine.schedule(this.tact.sample(), () => {
      this.pending = this.engine.newItem();
      this.emitted++;
      this.tryAdvance();
    }, `emit:${this.id}`);
  }

  protected tryAdvance() {
    if (!this.pending) return;
    if (this.push(this.pending)) {
      this.pending = null;
      this.scheduleNext();
    } else {
      this.setState(NodeState.Blocked);
    }
  }
}

/* ------------------------------ Conveyor -------------------------------- */
/** 컨베이어: accumulating FIFO transport. Each item needs `transitTime` seconds. */
export interface ConveyorConfig extends NodeConfigBase {
  transitTime: number;
  capacity: number; // max items on the belt
}

export class Conveyor extends SimNode {
  private belt: { item: Item; readyAt: number }[] = [];

  constructor(private cfg: ConveyorConfig) {
    super(cfg.id, "conveyor", cfg.name, cfg.routing);
  }

  get wip() { return this.belt.length; }
  canAccept() { return this.belt.length < this.cfg.capacity; }

  accept(item: Item) {
    this.belt.push({ item, readyAt: this.engine.now + this.cfg.transitTime });
    this.engine.schedule(this.cfg.transitTime, () => this.tryAdvance(), `arrive:${this.id}`);
    this.updateState(false);
  }

  protected tryAdvance() {
    let blocked = false;
    while (this.belt.length && this.belt[0].readyAt <= this.engine.now + EPS) {
      if (this.push(this.belt[0].item)) {
        this.belt.shift();
        this.notifyUpstreams();
      } else {
        blocked = true;
        break;
      }
    }
    this.updateState(blocked);
  }

  private updateState(blocked: boolean) {
    this.setState(blocked ? NodeState.Blocked
      : this.belt.length ? NodeState.Working : NodeState.Idle);
  }
}

/* ------------------------------- Machine -------------------------------- */
/** 가공기: single-slot processor. Idle -> Working(tact) -> Blocked if output is full. */
export interface MachineConfig extends NodeConfigBase {
  tact: Duration;
}

export class Machine extends SimNode {
  private slot: Item | null = null;
  private done = false;
  private tact: TactTime;

  constructor(cfg: MachineConfig, rnd: () => number) {
    super(cfg.id, "machine", cfg.name, cfg.routing);
    this.tact = new TactTime(cfg.tact, rnd);
  }

  get wip() { return this.slot ? 1 : 0; }
  get nominalThroughput() { return this.tact.nominalThroughput; }
  canAccept() { return this.slot === null; }

  accept(item: Item) {
    this.slot = item;
    this.done = false;
    this.setState(NodeState.Working);
    this.engine.schedule(this.tact.sample(), () => {
      this.done = true;
      this.tryAdvance();
    }, `finish:${this.id}`);
  }

  protected tryAdvance() {
    if (!this.slot || !this.done) return;
    if (this.push(this.slot)) {
      this.slot = null;
      this.done = false;
      this.setState(NodeState.Idle);
      this.notifyUpstreams();
    } else {
      this.setState(NodeState.Blocked);
    }
  }
}

/* ------------------------------- Buffer --------------------------------- */
/** 버퍼: passive FIFO queue with finite capacity, zero processing time. */
export interface BufferConfig extends NodeConfigBase {
  capacity: number;
}

export class Buffer extends SimNode {
  private queue: Item[] = [];

  constructor(private cfg: BufferConfig) {
    super(cfg.id, "buffer", cfg.name, cfg.routing);
  }

  get wip() { return this.queue.length; }
  canAccept() { return this.queue.length < this.cfg.capacity; }

  accept(item: Item) {
    this.queue.push(item);
    this.setState(NodeState.Working);
    this.engine.schedule(0, () => this.tryAdvance(), `buf:${this.id}`);
  }

  protected tryAdvance() {
    let blocked = false;
    while (this.queue.length) {
      if (this.push(this.queue[0])) {
        this.queue.shift();
        this.notifyUpstreams();
      } else {
        blocked = true;
        break;
      }
    }
    this.setState(blocked ? NodeState.Blocked
      : this.queue.length ? NodeState.Working : NodeState.Idle);
  }
}

/* -------------------------------- Sink ---------------------------------- */
/** 폐기/적재함: terminal node. `mode` distinguishes scrap vs storage for KPIs. */
export interface SinkConfig extends NodeConfigBase {
  mode?: "storage" | "scrap";
  capacity?: number; // default: unlimited
}

export class Sink extends SimNode {
  readonly collected: Item[] = [];
  readonly leadTimes: number[] = [];

  constructor(private cfg: SinkConfig) {
    super(cfg.id, "sink", cfg.name, cfg.routing);
  }

  get mode() { return this.cfg.mode ?? "storage"; }
  get wip() { return this.collected.length; }
  canAccept() { return this.collected.length < (this.cfg.capacity ?? Infinity); }

  accept(item: Item) {
    this.collected.push(item);
    this.leadTimes.push(this.engine.now - item.createdAt);
    this.stats.passed++;
    if (!this.canAccept()) this.setState(NodeState.Blocked); // storage full
  }

  protected tryAdvance() {}

  get avgLeadTime() {
    return this.leadTimes.length
      ? this.leadTimes.reduce((a, b) => a + b, 0) / this.leadTimes.length : 0;
  }
}

/* ------------------------------ Topology -------------------------------- */

export type NodeConfig =
  | ({ type: "source" } & SourceConfig)
  | ({ type: "conveyor" } & ConveyorConfig)
  | ({ type: "machine" } & MachineConfig)
  | ({ type: "buffer" } & BufferConfig)
  | ({ type: "sink" } & SinkConfig);

export interface LineConfig {
  seed?: number;
  nodes: NodeConfig[];
  edges: [from: string, to: string][];
}

export class Line {
  readonly engine: SimulationEngine;
  readonly nodes = new Map<string, SimNode>();

  constructor(seed = 1) { this.engine = new SimulationEngine(seed); }

  add<T extends SimNode>(node: T): T {
    if (this.nodes.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    node.attach(this.engine);
    this.nodes.set(node.id, node);
    return node;
  }

  connect(fromId: string, toId: string) {
    const from = this.get(fromId), to = this.get(toId);
    from.outputs.push(to);
    to.inputs.push(from);
  }

  get(id: string): SimNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Unknown node: ${id}`);
    return n;
  }

  /** Basic validation: sources have no inputs, sinks no outputs, no dangling nodes. */
  validate(): string[] {
    const errs: string[] = [];
    for (const n of this.nodes.values()) {
      if (n.kind === "source" && n.inputs.length) errs.push(`${n.id}: source has inputs`);
      if (n.kind === "sink" && n.outputs.length) errs.push(`${n.id}: sink has outputs`);
      if (n.kind !== "sink" && !n.outputs.length) errs.push(`${n.id}: no output`);
      if (n.kind !== "source" && !n.inputs.length) errs.push(`${n.id}: no input`);
    }
    return errs;
  }

  start() {
    const errs = this.validate();
    if (errs.length) throw new Error("Invalid line:\n" + errs.join("\n"));
    for (const n of this.nodes.values()) n.start();
  }

  snapshot(): NodeSnapshot[] {
    return [...this.nodes.values()].map((n) => n.snapshot());
  }

  static fromConfig(cfg: LineConfig): Line {
    const line = new Line(cfg.seed ?? 1);
    const rnd = line.engine.rnd;
    for (const c of cfg.nodes) {
      switch (c.type) {
        case "source": line.add(new Source(c, rnd)); break;
        case "conveyor": line.add(new Conveyor(c)); break;
        case "machine": line.add(new Machine(c, rnd)); break;
        case "buffer": line.add(new Buffer(c)); break;
        case "sink": line.add(new Sink(c)); break;
      }
    }
    for (const [a, b] of cfg.edges) line.connect(a, b);
    return line;
  }
}

/* ------------------------- Realtime driver (web) ------------------------ */

export class RealtimeRunner {
  speed = 1; // sim-seconds per real second
  private raf = 0;
  private last = 0;
  private running = false;

  constructor(private line: Line, private onFrame?: (snap: NodeSnapshot[]) => void) {}

  play() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = Math.min((t - this.last) / 1000, 0.1); // clamp tab-switch jumps
      this.last = t;
      this.line.engine.runUntil(this.line.engine.now + dt * this.speed);
      this.onFrame?.(this.line.snapshot());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() { this.running = false; cancelAnimationFrame(this.raf); }
}

/* -------------------------------- Example ------------------------------- */
/*
const line = Line.fromConfig({
  seed: 42,
  nodes: [
    { type: "source",   id: "in",   name: "투입구",  tact: 2 },
    { type: "conveyor", id: "cv1",  name: "컨베이어 1", transitTime: 3, capacity: 4 },
    { type: "machine",  id: "m1",   name: "가공기 1", tact: { dist: "normal", mean: 4, sd: 0.5 } },
    { type: "buffer",   id: "buf",  name: "버퍼",    capacity: 5 },
    { type: "machine",  id: "m2",   name: "가공기 2", tact: 3 },
    { type: "sink",     id: "out",  name: "적재함",  mode: "storage" },
  ],
  edges: [["in","cv1"],["cv1","m1"],["m1","buf"],["buf","m2"],["m2","out"]],
});
line.start();
line.engine.runUntil(600);
console.table(line.snapshot());   // m1(tact 4s)이 병목 -> in/cv1 Blocked 비율 상승
*/
