/* =========================================================================
 * FA Simulator — Stage 2: Tick loop + QueuedMachine
 *
 * 구성
 *   1. QueuedMachine : 대기 큐(FIFO) + 단일 가공 슬롯. 큐에서 꺼내 tact 동안 가공 -> 다음 노드로 푸시
 *   2. TickLoop      : 고정 간격(dt) 메인 루프. 매 틱마다 engine.runUntil(목표시각) 호출
 *   3. 실행 예제     : Source(1s) -> QueuedMachine(3s) -> Sink  (가공기가 병목)
 *
 * 틱과 이벤트의 관계
 *   - 가공 완료/푸시 같은 실제 동작은 1단계의 이벤트 큐가 정확한 시각 순서로 처리한다.
 *   - 틱은 "시계를 dt씩 전진시키며 관측/렌더링 훅을 호출하는 단위"이다.
 *     (dt가 3초보다 커도 틱 안에서 이벤트가 시각 순서대로 모두 처리되므로 결과가 변하지 않는다.)
 * ========================================================================= */

import {
  Duration,
  Item,
  Line,
  NodeSnapshot,
  NodeState,
  SimNode,
  Sink,
  Source,
  TactTime,
} from "./fa-sim";

/* ------------------------------ QueuedMachine --------------------------- */

export interface QueuedMachineConfig {
  id: string;
  name?: string;
  tact: Duration; // 예: 3 (고정 3초)
  queueCapacity: number; // 대기 큐 최대 길이
}

/**
 * 대기 큐 + 가공 설비.
 *   accept()  : 큐에 적재 (설비가 비어 있으면 즉시 가공 시작)
 *   가공 완료 : tact 후 done=true -> 다음 노드가 받을 수 있으면 푸시, 아니면 Blocked
 *   푸시 성공 : 큐에서 다음 자재를 꺼내 가공 시작
 */
export class QueuedMachine extends SimNode {
  private queue: Item[] = [];
  private processing: Item | null = null;
  private done = false;
  private tact: TactTime;

  constructor(private cfg: QueuedMachineConfig, rnd: () => number) {
    super(cfg.id, "machine", cfg.name, "first-available");
    this.tact = new TactTime(cfg.tact, rnd);
  }

  get wip() { return this.queue.length + (this.processing ? 1 : 0); }
  get queueLength() { return this.queue.length; }
  get isProcessing() { return this.processing !== null; }
  canAccept() { return this.queue.length < this.cfg.queueCapacity; }

  accept(item: Item) {
    this.queue.push(item);
    this.tryStart();
  }

  /** 설비가 비어 있고 큐에 자재가 있으면 가공 시작. */
  private tryStart() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = this.queue.shift()!;
    this.done = false;
    this.setState(NodeState.Working);
    this.notifyUpstreams(); // 큐에 빈자리가 생겼음을 상류에 알림
    this.engine.schedule(this.tact.sample(), () => {
      this.done = true;
      this.tryAdvance();
    }, `finish:${this.id}`);
  }

  protected tryAdvance() {
    if (!this.processing) {
      this.tryStart();
      return;
    }
    if (!this.done) return; // 아직 가공 중

    if (this.push(this.processing)) {
      this.processing = null;
      this.done = false;
      if (this.queue.length) this.tryStart();
      else this.setState(NodeState.Idle);
    } else {
      this.setState(NodeState.Blocked); // 출력이 가득 참 -> 완성품을 쥔 채 대기
    }
  }
}

/* -------------------------------- TickLoop ------------------------------ */

export interface TickInfo {
  tick: number;
  time: number; // 시뮬레이션 시각(초)
  snapshot: NodeSnapshot[];
}

export interface TickLoopOptions {
  dt?: number; // 틱 간격(sim-초). 기본 0.1
  speed?: number; // 배속 (sim-초 / real-초). 기본 1
  onTick?: (info: TickInfo) => void;
}

export class TickLoop {
  readonly dt: number;
  speed: number;
  private tickCount = 0;
  private acc = 0; // 실시간 모드용 시간 누적기
  private lastReal = 0;
  private timer: ReturnType<typeof setTimeout> | number = 0;
  private running = false;

  constructor(private line: Line, private opts: TickLoopOptions = {}) {
    this.dt = opts.dt ?? 0.1;
    this.speed = opts.speed ?? 1;
  }

  get time() { return this.line.engine.now; }
  get ticks() { return this.tickCount; }

  /** 라인 시작 (Source 첫 도착 스케줄). */
  init() {
    this.line.start();
    this.tickCount = 0;
    this.acc = 0;
  }

  /** 한 틱: 시계를 dt만큼 전진시키며 그 구간의 모든 이벤트를 시각 순으로 처리. */
  tick() {
    this.tickCount++;
    // 누적 덧셈 대신 곱셈으로 목표 시각을 계산해 부동소수점 드리프트를 방지
    this.line.engine.runUntil(this.tickCount * this.dt);
    this.opts.onTick?.({
      tick: this.tickCount,
      time: this.line.engine.now,
      snapshot: this.line.snapshot(),
    });
  }

  /** 헤드리스 실행: 실시간 대기 없이 duration(sim-초)만큼 최대 속도로 진행. */
  runFor(duration: number) {
    const target = Math.round(duration / this.dt);
    for (let i = 0; i < target; i++) this.tick();
  }

  /** 실시간 실행: 실제 경과 시간 x speed 만큼 sim 시간을 쌓아 dt 단위로 소비. */
  play() {
    if (this.running) return;
    this.running = true;
    this.lastReal = performance.now();

    const frame = (nowReal: number) => {
      if (!this.running) return;
      const realDt = Math.min((nowReal - this.lastReal) / 1000, 0.25); // 탭 전환 점프 방지
      this.lastReal = nowReal;
      this.acc += realDt * this.speed;

      let guard = 0;
      while (this.acc >= this.dt - 1e-9 && guard++ < 1000) {
        this.tick();
        this.acc -= this.dt;
      }
      this.schedule(frame);
    };
    this.schedule(frame);
  }

  pause() {
    this.running = false;
    if (typeof cancelAnimationFrame === "function" && typeof this.timer === "number") {
      cancelAnimationFrame(this.timer);
    } else {
      clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    }
  }

  private schedule(cb: (t: number) => void) {
    if (typeof requestAnimationFrame === "function") {
      this.timer = requestAnimationFrame(cb);
    } else {
      this.timer = setTimeout(() => cb(performance.now()), 16); // Node 환경 대체
    }
  }
}

/* ------------------------------- 실행 예제 ------------------------------- */
/** Source(1초 간격) -> QueuedMachine(가공 3초, 큐 5) -> Sink : 가공기가 병목이므로 큐가 차고 Source가 Blocked. */
export function runExample() {
  const line = new Line(42);
  const rnd = line.engine.rnd;

  line.add(new Source({ id: "in", name: "투입구", tact: 1 }, rnd));
  const m1 = line.add(
    new QueuedMachine({ id: "m1", name: "가공기 1", tact: 3, queueCapacity: 5 }, rnd),
  );
  const out = line.add(new Sink({ id: "out", name: "적재함", mode: "storage" }));
  line.connect("in", "m1");
  line.connect("m1", "out");

  const loop = new TickLoop(line, {
    dt: 0.5,
    onTick: ({ time }) => {
      if (Math.abs(time % 10) < 1e-6) {
        console.log(
          `t=${time.toFixed(0).padStart(3)}s | 큐=${m1.queueLength} | 가공기=${m1.state.padEnd(7)} | 완성=${out.collected.length}`,
        );
      }
    },
  });

  loop.init();
  loop.runFor(60);
  console.table(line.snapshot());
  // 기대: 가공 3초/개 -> 60초 동안 약 19~20개 완성, 큐는 5로 포화, in 노드 Blocked 비율 높음
}

// Node에서 직접 실행할 때만 예제 구동 (예: npx tsx fa-tick-loop.ts)
if (typeof process !== "undefined" && process.argv[1]?.includes("fa-tick-loop")) {
  runExample();
}
