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
    const after = req.system.includes('You speak after others');
    if (first) {
      return ok(
        `${label}${name}：針對「${task.slice(0, 40)}」，我建議先做 A，因為成本最低、最快能驗證。\nNEXT: continue`,
      );
    }
    if (after) {
      return ok(
        `${label}${name}：我同意要先驗證，但我認為 B 的風險比 A 低，理由是不依賴外部服務。\nNEXT: continue`,
      );
    }
    // Later rounds: the last speaker concedes, so the demo shows an early stop.
    return said >= 3
      ? ok(
          `${label}${name}：前面的分歧我接受「先做 A、並用 B 當備案」，沒有其他要補的了。\nNEXT: done`,
        )
      : ok(
          `${label}${name}：針對 B 依賴較少這點，我補充：A 可以用現成工具完成，所以兩者差距沒那麼大。\nNEXT: continue`,
        );
  }
  return null;
}
