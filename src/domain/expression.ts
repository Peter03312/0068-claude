// 表达式语言：
//   叶子：边指示量 xAB（A,B 为成员字母），deg(A) 度数，
//         within() 组内边数，cross() 跨组边数，非负整数常量
//   运算：整数加/减（Add/Sub）、二倍项 Mul2(X)
// 语法限制：Mul2 只允许一层（不允许 2(2(...))，也不允许 Mul2 再被数值相乘）。
// 解析支持文本：xAB、deg(A)、within()、cross()、数字、+、-、括号、
//   2Y / 2*Y / 2(Y)（且仅一层）。允许一元负号（-xAB 等）。

export type Expr =
  | { type: 'edge'; a: number; b: number }
  | { type: 'deg'; v: number }
  | { type: 'within' }
  | { type: 'cross' }
  | { type: 'num'; value: number }
  | { type: 'add'; left: Expr; right: Expr }
  | { type: 'sub'; left: Expr; right: Expr }
  | { type: 'mul2'; inner: Expr };

export interface ParseOk {
  ok: true;
  expr: Expr;
}
export interface ParseErr {
  ok: false;
  message: string;
  position: number;
}
export type ParseResult = ParseOk | ParseErr;

interface Token {
  kind: 'ident' | 'num' | 'plus' | 'minus' | 'star' | 'lparen' | 'rparen';
  text: string;
  pos: number;
}

function isLetter(ch: string): boolean {
  return /[A-Za-z]/.test(ch);
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function tokenize(input: string): Token[] | ParseErr {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    const pos = i;
    if (ch === '+') {
      tokens.push({ kind: 'plus', text: ch, pos });
      i += 1;
    } else if (ch === '-') {
      tokens.push({ kind: 'minus', text: ch, pos });
      i += 1;
    } else if (ch === '*') {
      tokens.push({ kind: 'star', text: ch, pos });
      i += 1;
    } else if (ch === '(') {
      tokens.push({ kind: 'lparen', text: ch, pos });
      i += 1;
    } else if (ch === ')') {
      tokens.push({ kind: 'rparen', text: ch, pos });
      i += 1;
    } else if (isDigit(ch)) {
      let j = i;
      while (j < input.length && isDigit(input[j])) j += 1;
      tokens.push({ kind: 'num', text: input.slice(i, j), pos });
      i = j;
    } else if (isLetter(ch)) {
      let j = i;
      while (j < input.length && isLetter(input[j])) j += 1;
      tokens.push({ kind: 'ident', text: input.slice(i, j), pos });
      i = j;
    } else {
      return { ok: false, message: `无法识别的字符 “${ch}”`, position: pos };
    }
  }
  return tokens;
}

/**
 * 成员字母转序号：A=0, B=1, ... （11-14 岁展签，最多 H）。
 * 此处不做成员数越界检查，交由项目层统一报告。
 */
export function letterToIndex(letter: string): number {
  return letter.toUpperCase().charCodeAt(0) - 65;
}
export function indexToLetter(i: number): string {
  return String.fromCharCode(65 + i);
}

/** 递归下降解析：Expr := Term (('+' | '-') Term)* */
export function parseExpression(input: string): ParseResult {
  if (input.trim() === '') {
    return { ok: false, message: '表达式为空', position: 0 };
  }
  const lexed = tokenize(input);
  if ('ok' in lexed && lexed.ok === false) return lexed;
  const tokens = lexed as Token[];
  let p = 0;

  const peek = (): Token | undefined => tokens[p];
  const next = (): Token => tokens[p++];

  function parseExpr(): Expr | ParseErr {
    let acc = parseTerm();
    if ('ok' in acc && acc.ok === false) return acc;
    acc = acc as Expr;
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.kind === 'plus') {
        next();
        const rhs = parseTerm();
        if ('ok' in rhs && rhs.ok === false) return rhs;
        acc = { type: 'add', left: acc, right: rhs as Expr };
      } else if (t.kind === 'minus') {
        next();
        const rhs = parseTerm();
        if ('ok' in rhs && rhs.ok === false) return rhs;
        acc = { type: 'sub', left: acc, right: rhs as Expr };
      } else break;
    }
    return acc;
  }

  function parseTerm(): Expr | ParseErr {
    let negate = false;
    const t0 = peek();
    if (t0 && t0.kind === 'minus') {
      negate = true;
      next();
    }
    // 二倍项：数字 2 后紧跟一个原子/括号，且该因子不是表达式加减
    const t = peek();
    if (t && t.kind === 'num' && t.text === '2') {
      const save = p;
      next();
      const sep = peek();
      if (sep && (sep.kind === 'lparen' || sep.kind === 'ident')) {
        // 2*Y、2*（...）：* 仅在 2 后允许
        if (sep.kind === 'lparen') {
          const inner = parseParenAtom();
          if ('ok' in inner && inner.ok === false) return inner;
          return wrapNegate({ type: 'mul2', inner: inner as Expr }, negate);
        }
        const inner = parseAtom();
        if ('ok' in inner && inner.ok === false) return inner;
        return wrapNegate({ type: 'mul2', inner: inner as Expr }, negate);
      }
      // 2*...（先 * 再原子）
      if (sep && sep.kind === 'star') {
        next();
        const factor = parseFactor();
        if ('ok' in factor && factor.ok === false) return factor;
        const f = factor as Expr;
        if (f.type === 'mul2') {
          return { ok: false, message: '二倍项只能嵌套一层，不能写 2(2Y)', position: t.pos };
        }
        return wrapNegate({ type: 'mul2', inner: f }, negate);
      }
      p = save; // 普通常量 2
    }
    const factor = parseFactor();
    if ('ok' in factor && factor.ok === false) return factor;
    return wrapNegate(factor as Expr, negate);
  }

  function wrapNegate(e: Expr, negate: boolean): Expr | ParseErr {
    if (!negate) return e;
    if (e.type === 'num') return { type: 'num', value: -e.value };
    return { type: 'sub', left: { type: 'num', value: 0 }, right: e };
  }

  function parseFactor(): Expr | ParseErr {
    const t = peek();
    if (!t) return { ok: false, message: '此处应有一个量（边、deg、数字或括号）', position: 0 };
    if (t.kind === 'lparen') return parseParenAtom();
    if (t.kind === 'minus') {
      next();
      const f = parseFactor();
      if ('ok' in f && f.ok === false) return f;
      const e = f as Expr;
      return e.type === 'num' ? { type: 'num', value: -e.value } : { type: 'sub', left: { type: 'num', value: 0 }, right: e };
    }
    return parseAtom();
  }

  function parseParenAtom(): Expr | ParseErr {
    const lp = next();
    if (!lp || lp.kind !== 'lparen') {
      return { ok: false, message: '缺少左括号 “(”', position: p };
    }
    const inner = parseExpr();
    if ('ok' in inner && inner.ok === false) return inner;
    const rp = next();
    if (!rp || rp.kind !== 'rparen') {
      return { ok: false, message: '缺少右括号 “)”', position: p };
    }
    return inner;
  }

  function parseAtom(): Expr | ParseErr {
    const t = next();
    if (!t) return { ok: false, message: '表达式不完整', position: 0 };
    if (t.kind === 'num') {
      const value = Number(t.text);
      if (!Number.isSafeInteger(value)) {
        return { ok: false, message: '整数超出安全范围', position: t.pos };
      }
      return { type: 'num', value };
    }
    if (t.kind === 'ident') {
      const name = t.text.toLowerCase();
      if (name === 'deg') {
        const lp = next();
        if (!lp || lp.kind !== 'lparen') return { ok: false, message: 'deg 后应为 (成员)，如 deg(A)', position: t.pos };
        const v = next();
        if (!v || v.kind !== 'ident' || v.text.length !== 1 || !isLetter(v.text)) {
          return { ok: false, message: 'deg( ) 中应为一个成员字母，如 deg(A)', position: t.pos };
        }
        const rp = next();
        if (!rp || rp.kind !== 'rparen') return { ok: false, message: 'deg(A) 缺少右括号', position: t.pos };
        return { type: 'deg', v: letterToIndex(v.text) };
      }
      if (name === 'within' || name === 'cross') {
        const lp = next();
        if (!lp || lp.kind !== 'lparen') {
          return { ok: false, message: `${name} 后应为 ()`, position: t.pos };
        }
        const rp = next();
        if (!rp || rp.kind !== 'rparen') {
          return { ok: false, message: `${name}() 缺少右括号`, position: t.pos };
        }
        return { type: name === 'within' ? 'within' : 'cross' };
      }
      // 边指示量：xAB（不区分大小写）；成员字母按规范序存储
      if (name.length === 3 && name[0] === 'x' && isLetter(name[1]) && isLetter(name[2])) {
        const a = letterToIndex(name[1]);
        const b = letterToIndex(name[2]);
        if (a === b) {
          return { ok: false, message: `边指示量 ${t.text} 的两个端点不能相同`, position: t.pos };
        }
        return { type: 'edge', a: Math.min(a, b), b: Math.max(a, b) };
      }
      return {
        ok: false,
        message: `无法识别 “${t.text}”：应为 xAB（边）、deg(A)、within()、cross() 或整数`,
        position: t.pos
      };
    }
    return { ok: false, message: '此处结构不完整，缺少一个量', position: t.pos };
  }

  const result = parseExpr();
  if ('ok' in result && result.ok === false) return result;
  if (p < tokens.length) {
    const bad = tokens[p];
    return { ok: false, message: `多余的符号 “${bad.text}”`, position: bad.pos };
  }
  const expr = result as Expr;
  // AST 层禁止二倍项嵌套两层
  let nestedMul2 = false;
  const walk = (e: Expr, insideMul2: boolean): void => {
    if (e.type === 'mul2') {
      if (insideMul2) nestedMul2 = true;
      walk(e.inner, true);
    } else if (e.type === 'add' || e.type === 'sub') {
      walk(e.left, insideMul2);
      walk(e.right, insideMul2);
    }
  };
  walk(expr, false);
  if (nestedMul2) {
    return { ok: false, message: '二倍项只能有一层，不能写 2(2Y)', position: 0 };
  }
  return { ok: true, expr };
}

// ---------- 打印（可被解析器再次解析） ----------

export function printExpr(e: Expr): string {
  switch (e.type) {
    case 'edge':
      return `x${indexToLetter(e.a)}${indexToLetter(e.b)}`;
    case 'deg':
      return `deg(${indexToLetter(e.v)})`;
    case 'within':
      return 'within()';
    case 'cross':
      return 'cross()';
    case 'num':
      return String(e.value);
    case 'add':
      return `${printExpr(e.left)} + ${printExpr(e.right)}`;
    case 'sub':
      return `${printExpr(e.left)} - ${printExpr(e.right)}`;
    case 'mul2':
      return `2*${printAtomForMul2(e.inner)}`;
  }
}
function printAtomForMul2(e: Expr): string {
  if (e.type === 'add' || e.type === 'sub') return `(${printExpr(e)})`;
  return printExpr(e);
}

// ---------- 结构合法性（成员数越界等） ----------

export interface ValidateIssue {
  message: string;
  position: number;
}
export function validateExprBounds(e: Expr, n: number, positionHint = 0): ValidateIssue | null {
  let issue: ValidateIssue | null = null;
  const walk = (x: Expr): void => {
    if (issue) return;
    switch (x.type) {
      case 'edge':
        if (x.a >= n || x.b >= n) {
          issue = {
            message: `端点 ${indexToLetter(Math.max(x.a, x.b))} 超出当前成员数（${n} 名，A–${indexToLetter(n - 1)}）`,
            position: positionHint
          };
        }
        return;
      case 'deg':
        if (x.v >= n) {
          issue = {
            message: `deg(${indexToLetter(x.v)}) 超出当前成员数（${n} 名，A–${indexToLetter(n - 1)}）`,
            position: positionHint
          };
        }
        return;
      case 'add':
      case 'sub':
        walk(x.left);
        walk(x.right);
        return;
      case 'mul2':
        walk(x.inner);
        return;
      default:
        return;
    }
  };
  walk(e);
  return issue;
}
