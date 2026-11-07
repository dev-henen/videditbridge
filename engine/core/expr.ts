/**
 * FFmpeg's expression language (libavutil/eval.c), evaluated in doubles as FFmpeg evaluates it.
 * The renderers write per-frame values as expressions (camera moves, keyframes, zoom paths); the
 * GPU engine computes the same values from the same strings with this, so both give the same
 * numbers. Covers the operators (+ - * / ^, unary signs), constants (PI, E, PHI), variables, `st`
 * and `ld`, `;` sequences and the functions the effects and keyframes use.
 */

export type ExprVars = Record<string, number>;

type Node = (vars: ExprVars, mem: number[]) => number;

const CONSTANTS: Record<string, number> = { PI: Math.PI, E: Math.E, PHI: 1.61803398874989484820 };

/** C's round(): halves away from zero. */
const cRound = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  sin: ([a]) => Math.sin(a!),
  cos: ([a]) => Math.cos(a!),
  tan: ([a]) => Math.tan(a!),
  asin: ([a]) => Math.asin(a!),
  acos: ([a]) => Math.acos(a!),
  atan: ([a]) => Math.atan(a!),
  atan2: ([a, b]) => Math.atan2(a!, b!),
  sinh: ([a]) => Math.sinh(a!),
  cosh: ([a]) => Math.cosh(a!),
  tanh: ([a]) => Math.tanh(a!),
  exp: ([a]) => Math.exp(a!),
  log: ([a]) => Math.log(a!),
  sqrt: ([a]) => Math.sqrt(a!),
  abs: ([a]) => Math.abs(a!),
  pow: ([a, b]) => Math.pow(a!, b!),
  floor: ([a]) => Math.floor(a!),
  ceil: ([a]) => Math.ceil(a!),
  round: ([a]) => cRound(a!),
  trunc: ([a]) => Math.trunc(a!),
  hypot: ([a, b]) => Math.hypot(a!, b!),
  // eval.c: d - floor(d / d2) * d2 (the sign of the divisor).
  mod: ([a, b]) => a! - Math.floor(b ? a! / b : a! * Infinity) * b!,
  max: ([a, b]) => Math.max(a!, b!),
  min: ([a, b]) => Math.min(a!, b!),
  gt: ([a, b]) => (a! > b! ? 1 : 0),
  gte: ([a, b]) => (a! >= b! ? 1 : 0),
  lt: ([a, b]) => (a! < b! ? 1 : 0),
  lte: ([a, b]) => (a! <= b! ? 1 : 0),
  eq: ([a, b]) => (a === b ? 1 : 0),
  not: ([a]) => (a ? 0 : 1),
  isnan: ([a]) => (Number.isNaN(a) ? 1 : 0),
  isinf: ([a]) => (a === Infinity || a === -Infinity ? 1 : 0),
  between: ([x, lo, hi]) => (x! >= lo! && x! <= hi! ? 1 : 0),
  clip: ([x, lo, hi]) => (Number.isNaN(lo) || Number.isNaN(hi) || lo! > hi! ? NaN : Math.min(hi!, Math.max(lo!, x!))),
  squish: ([a]) => 1 / (1 + Math.exp(4 * a!)),
  gauss: ([a]) => Math.exp((-a! * a!) / 2) / Math.sqrt(2 * Math.PI),
  sgn: ([a]) => (a! > 0 ? 1 : a! < 0 ? -1 : 0),
};

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): Node {
    const node = this.sequence();
    this.space();
    if (this.i < this.s.length) throw new Error(`Unexpected "${this.s.slice(this.i, this.i + 10)}" in expression ${this.s}`);
    return node;
  }

  private space() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  private peek(c: string): boolean {
    this.space();
    return this.s[this.i] === c;
  }

  private take(c: string): boolean {
    if (!this.peek(c)) return false;
    this.i++;
    return true;
  }

  /** a;b;c: each evaluated in turn, the value is the last. */
  private sequence(): Node {
    const parts = [this.sum()];
    while (this.take(";")) parts.push(this.sum());
    if (parts.length === 1) return parts[0]!;
    return (v, m) => {
      let r = 0;
      for (const p of parts) r = p(v, m);
      return r;
    };
  }

  private sum(): Node {
    let left = this.product();
    for (;;) {
      if (this.take("+")) {
        const [a, b] = [left, this.product()];
        left = (v, m) => a(v, m) + b(v, m);
      } else if (this.take("-")) {
        const [a, b] = [left, this.product()];
        left = (v, m) => a(v, m) - b(v, m);
      } else return left;
    }
  }

  private product(): Node {
    let left = this.signed();
    for (;;) {
      if (this.take("*")) {
        const [a, b] = [left, this.signed()];
        left = (v, m) => a(v, m) * b(v, m);
      } else if (this.take("/")) {
        const [a, b] = [left, this.signed()];
        left = (v, m) => a(v, m) / b(v, m);
      } else return left;
    }
  }

  /** Unary signs bind looser than ^, as in eval.c (-2^2 is -4). */
  private signed(): Node {
    if (this.take("-")) {
      const a = this.signed();
      return (v, m) => -a(v, m);
    }
    if (this.take("+")) return this.signed();
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (this.take("^")) {
      const e = this.signed();
      return (v, m) => Math.pow(base(v, m), e(v, m));
    }
    return base;
  }

  private primary(): Node {
    this.space();
    if (this.take("(")) {
      const inner = this.sequence();
      if (!this.take(")")) throw new Error(`Missing ) in expression ${this.s}`);
      return inner;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      const value = Number(num[0]);
      return () => value;
    }
    const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(this.s.slice(this.i));
    if (!name) throw new Error(`Unexpected "${this.s.slice(this.i, this.i + 10)}" in expression ${this.s}`);
    this.i += name[0].length;
    const id = name[0];
    if (this.take("(")) {
      const args: Node[] = [];
      if (!this.peek(")")) {
        do args.push(this.sequence());
        while (this.take(","));
      }
      if (!this.take(")")) throw new Error(`Missing ) after the arguments of ${id} in expression ${this.s}`);
      return this.call(id, args);
    }
    if (id in CONSTANTS) {
      const c = CONSTANTS[id]!;
      return () => c;
    }
    return (v) => {
      const value = v[id];
      if (value === undefined) throw new Error(`Unknown variable ${id} in expression ${this.s}`);
      return value;
    };
  }

  private call(id: string, args: Node[]): Node {
    // Lazy ones: only the branch taken is evaluated (st() inside a branch must not run otherwise).
    if (id === "if") {
      const [c, a, b] = args;
      return (v, m) => (c!(v, m) ? a!(v, m) : b ? b(v, m) : 0);
    }
    if (id === "ifnot") {
      const [c, a, b] = args;
      return (v, m) => (!c!(v, m) ? a!(v, m) : b ? b(v, m) : 0);
    }
    if (id === "st") {
      const [k, x] = args;
      return (v, m) => {
        const value = x!(v, m);
        m[Math.trunc(k!(v, m))] = value;
        return value;
      };
    }
    if (id === "ld") {
      const [k] = args;
      return (v, m) => m[Math.trunc(k!(v, m))] ?? 0;
    }
    const f = FUNCTIONS[id];
    if (!f) throw new Error(`Unknown function ${id} in expression ${this.s}`);
    return (v, m) => f(args.map((a) => a(v, m)));
  }
}

const cache = new Map<string, Node>();

/** Compile an FFmpeg expression once; the result evaluates it with the given variables. */
export function compileExpr(expr: string): (vars?: ExprVars) => number {
  let node = cache.get(expr);
  if (!node) {
    node = new Parser(expr).parse();
    cache.set(expr, node);
  }
  const n = node;
  return (vars = {}) => n(vars, []);
}

/** Evaluate an FFmpeg expression with the given variables. */
export function evalExpr(expr: string, vars: ExprVars = {}): number {
  return compileExpr(expr)(vars);
}
