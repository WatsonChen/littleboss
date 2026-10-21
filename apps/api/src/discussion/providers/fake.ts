import type { ModelProvider, ProviderRequest, ProviderResult } from './types.js';

export type FakeBehaviour = (req: ProviderRequest) => ProviderResult | Promise<ProviderResult>;

/**
 * Stands in for a real model: in tests (with scripted behaviour) and for trying the app without
 * keys (LB_FAKE_PROVIDERS=1). The default answer says plainly that it is not a real model.
 */
export class FakeProvider implements ModelProvider {
  readonly calls: ProviderRequest[] = [];
  constructor(private readonly behaviour?: FakeBehaviour) {}

  async call(req: ProviderRequest): Promise<ProviderResult> {
    this.calls.push(req);
    if (this.behaviour) return this.behaviour(req);
    if (req.system.includes('<flow_task>')) {
      return {
        text: JSON.stringify(demoDraft(req.user)),
        finish: 'complete',
        usage: { inputTokens: Math.ceil(req.user.length / 2), outputTokens: 200 },
      };
    }
    if (req.system.includes('<capture_task>')) {
      return {
        text: JSON.stringify(demoCapture(req.user)),
        finish: 'complete',
        usage: { inputTokens: Math.ceil(req.user.length / 2), outputTokens: 120 },
      };
    }
    const demo = demoDiscussion(req);
    if (demo) return demo;
    const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(req.user)?.[1] ?? '';
    return {
      text: `（示範回覆，不是真的 AI）收到：${task.slice(0, 120)}`,
      finish: 'complete',
      usage: { inputTokens: Math.ceil(req.user.length / 2), outputTokens: 40 },
    };
  }
}

/**
 * Demo replies for the automatic discussion, so it can be tried without keys. They read like a short
 * conversation: the first speaker answers, the next reacts, a later turn says it is done, the
 * summary lists agreed points, and a reviewer gives a check. Plainly labelled as demo.
 */
function demoDiscussion(req: ProviderRequest): ProviderResult | null {
  const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(req.user)?.[1] ?? '';
  const name = /You are (.+?), an AI employee/.exec(req.system)?.[1] ?? 'AI';
  const usage = { inputTokens: Math.ceil(req.user.length / 2), outputTokens: 80 };
  const said = (req.user.match(/^\[(?!boss\])[^\]\n]+\]$/gm) ?? []).length;
  const label = '（示範回覆，不是真的 AI）';
  const ok = (text: string): ProviderResult => ({ text, finish: 'complete', usage });
  if (req.system.includes('You are the reviewer')) {
    return ok(
      `${label}${name} 檢核：結論的方向可行。我檢查了：有沒有互相矛盾、有沒有漏掉風險。建議補上「第一步要驗證什麼」。`,
    );
  }
  if (req.system.includes('is over. Write the summary')) {
    return ok(
      `${label}${name} 小結\n共識：先小範圍驗證再投入。\n分歧：優先順序（先做 A 還是先做 B）。\n未解決：預算與時程。\n建議下一步：先用一週驗證 A。`,
    );
  }
  if (req.system.includes('This is a discussion among AI employees')) {
    const first = req.system.includes('You speak first');
    if (first) {
      return ok(
        `${label}${name}：針對「${task.slice(0, 40)}」，我建議先做 A，因為成本最低、最快能驗證。\nNEXT: continue`,
      );
    }
    // Second speaker: challenges the first speaker's claim instead of giving its own answer.
    if (said === 1) {
      return ok(
        `${label}${name}：我質疑上一位的主張 1：「A 成本最低」是假設不用外部服務，若要接外部服務成本會翻倍。我同意要先驗證，但風險上 B 較低。我現在的立場：先驗證 B。\nNEXT: continue`,
      );
    }
    // Later turns: the last speaker concedes, so the demo shows an early stop.
    return said >= 3
      ? ok(
          `${label}${name}：前面的分歧我接受「先做 A、並用 B 當備案」，沒有其他要補的了。我現在的立場：同上。\nNEXT: done`,
        )
      : ok(
          `${label}${name}：回應「B 依賴較少」這點：A 可以用現成工具完成，所以兩者差距沒那麼大。我現在的立場：A、B 都可，先 A。\nNEXT: continue`,
        );
  }
  return null;
}

/**
 * A few plain rules that turn a typed note into the JSON a real model would return, so the capture
 * flow can be tried without keys. Not smart: "買…" becomes shopping items, a sentence with a
 * meeting-like word becomes an event, and a missing day or time stays empty (never guessed).
 */
export function demoCapture(user: string) {
  const now = /<now>(.*?)<\/now>/.exec(user)?.[1] ?? '';
  const text = /<capture_text>\n([\s\S]*?)\n<\/capture_text>/.exec(user)?.[1] ?? '';
  const items: Record<string, unknown>[] = [];
  for (const seg of text
    .split(/[。\n;；]/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const buy = /買(.+)/.exec(seg);
    if (buy) {
      for (const part of buy[1]!
        .split(/[、,，和跟及]/)
        .map((x) => x.trim())
        .filter(Boolean)) {
        items.push({
          kind: 'shopping',
          origin: 'said',
          title: part,
          note: '',
          quantity: '',
          startsAt: null,
          endsAt: null,
          allDay: false,
          assumptions: [],
          question: '',
        });
      }
      continue;
    }
    if (/會|約|看診|聚餐|面試|開會|見面|吃飯/.test(seg)) {
      const start = demoTime(seg, now);
      items.push({
        kind: 'event',
        origin: 'said',
        title: seg.slice(0, 40),
        note: '',
        quantity: '',
        startsAt: start,
        endsAt: null,
        allDay: false,
        assumptions: start ? ['（示範）時間由簡單規則換算'] : [],
        question: start ? '' : '什麼時候？',
      });
    }
  }
  return {
    items,
    questions:
      items.length === 0 ? ['（示範）我沒看出要買的東西或要排的行程，可以再說清楚一點嗎？'] : [],
  };
}

function demoTime(seg: string, now: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T[\d:]+([+-]\d{2}:\d{2})$/.exec(now);
  if (!m) return null;
  const offset = m[2]!;
  const day = /今天/.test(seg) ? 0 : /明天/.test(seg) ? 1 : /後天/.test(seg) ? 2 : null;
  const CN: Record<string, string> = {
    一: '1',
    二: '2',
    兩: '2',
    三: '3',
    四: '4',
    五: '5',
    六: '6',
    七: '7',
    八: '8',
    九: '9',
    十: '10',
    十一: '11',
    十二: '12',
  };
  const num = seg.replace(
    /(十[一二]|[一二兩三四五六七八九十])點/g,
    (_m, c: string) => `${CN[c]}點`,
  );
  const t = /(\d{1,2})(?:[:點](\d{2})?)/.exec(num);
  if (day === null || !t) return null;
  let hour = Number(t[1]);
  if (/下午|晚上/.test(seg) && hour < 12) hour += 12;
  if (hour > 23) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + day);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.toISOString().slice(0, 10)}T${pad(hour)}:${pad(Number(t[2] ?? 0))}:00${offset}`;
}

/** Three plainly labelled sample options built from the first words of the notes. */
export function demoDraft(user: string) {
  const notes = /<notes>\n([\s\S]*?)\n<\/notes>/.exec(user)?.[1] ?? '';
  const topic = notes.replace(/\s+/g, ' ').trim().slice(0, 18) || '這一集';
  return {
    options: [
      {
        title: `（示範）${topic}：我們聊了什麼`,
        description: `（示範，不是真的 AI）這一集聊到：${notes.slice(0, 80)}`,
      },
      {
        title: `（示範）關於${topic}，最大的收穫`,
        description: '（示範，不是真的 AI）本集的重點整理與心得。',
      },
      {
        title: `（示範）${topic}？我們的看法`,
        description: '（示範，不是真的 AI）想知道我們怎麼想嗎？收聽本集。',
      },
    ],
  };
}
