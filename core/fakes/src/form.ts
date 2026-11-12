/**
 * Decode Stripe-style bracketed form/query encoding:
 *   items[0][price]=p&expand[]=x&metadata[k]=v  ->  {items:[{price:'p'}], expand:['x'], metadata:{k:'v'}}
 */
type Node = Record<string, unknown>;

function segments(key: string): string[] {
  const first = key.indexOf('[');
  if (first === -1) return [key];
  const segs = [key.slice(0, first)];
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(key.slice(first)))) segs.push(m[1]!);
  return segs;
}

function arrayify(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return Array.isArray(v) ? v.map(arrayify) : v;
  }
  const obj = v as Node;
  const keys = Object.keys(obj);
  const out: Node = {};
  for (const k of keys) out[k] = arrayify(obj[k]);
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    return keys
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => out[String(k)]);
  }
  return out;
}

export function decodeForm(input: string | URLSearchParams): Record<string, unknown> {
  const params = typeof input === 'string' ? new URLSearchParams(input) : input;
  const root: Node = {};
  for (const [key, value] of params) {
    const segs = segments(key);
    let cur: Node = root;
    for (let i = 0; i < segs.length; i++) {
      let seg = segs[i]!;
      const last = i === segs.length - 1;
      if (seg === '') seg = String(Object.keys(cur).length); // "[]" appends
      if (last) {
        cur[seg] = value;
      } else {
        if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {};
        cur = cur[seg] as Node;
      }
    }
  }
  return arrayify(root) as Record<string, unknown>;
}

/** Inverse of decodeForm (used by tests and the GitHub/Stripe clients in fakes tests). */
export function encodeForm(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (v === undefined) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${key}[${k}]`);
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v === null ? '' : String(v))}`);
  };
  for (const [k, v] of Object.entries(obj)) walk(v, prefix ? `${prefix}[${k}]` : k);
  return parts.join('&');
}
