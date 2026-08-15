/**
 * A scripted engine implementing the `llm/engine.js` contract.
 *
 * Two jobs:
 * - unit tests drive the agent loop deterministically with it;
 * - the e2e suite uses it to exercise the whole UI on machines without a GPU,
 *   which is every CI runner. The real-model e2e run (`npm run test:e2e:real`)
 *   covers what this cannot.
 *
 * It is bundled in the shipped artifact but only reachable via the
 * `?mockEngine=1` URL flag, so normal users never touch it.
 *
 * @module llm/mock
 */

import { emptyStats } from './engine.js';

/**
 * @param {object} [opts]
 * @param {Array<string|((messages: Array<object>, callIndex: number) => string)>} [opts.script]
 *   Replies, one per `generate` call. A function receives the messages so a
 *   scenario can branch on what the loop sent. The last entry repeats once the
 *   script runs out.
 * @param {number} [opts.deltaMs] Delay between streamed chunks.
 * @param {number} [opts.loadMs] Simulated load duration.
 * @param {boolean} [opts.failLoad] Make `load` reject.
 * @returns {import('./engine.js').Engine & {calls: Array<object>, setScript: Function}}
 */
export function createMockEngine(opts = {}) {
  let script = opts.script ? [...opts.script] : ['Hello from the mock engine.'];
  const deltaMs = opts.deltaMs ?? 0;
  const loadMs = opts.loadMs ?? 0;
  const calls = [];
  let modelId = null;
  let callIndex = 0;
  let totalTokens = 0;

  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  return {
    calls,

    /** Replace the remaining script (used by e2e scenarios between turns). */
    setScript(next) {
      script = [...next];
      callIndex = 0;
    },

    async capabilities() {
      return {
        id: 'mock',
        label: 'Mock engine (testing)',
        available: true,
        streaming: true,
        needsDownload: false,
      };
    },

    async load(id, onProgress) {
      if (opts.failLoad) throw new Error('Mock engine was configured to fail loading.');
      for (const p of [0, 0.5, 1]) {
        onProgress?.({ progress: p, text: `mock load ${Math.round(p * 100)}%` });
        await sleep(loadMs / 3);
      }
      modelId = id;
    },

    async generate(messages, options = {}) {
      const entry = script[Math.min(callIndex, script.length - 1)];
      callIndex += 1;
      calls.push({ messages, options });

      const text = typeof entry === 'function' ? entry(messages, callIndex - 1) : String(entry ?? '');

      // Stream in word-sized chunks so UI streaming is genuinely exercised.
      const chunks = text.match(/\S+\s*/g) || [];
      let out = '';
      for (const chunk of chunks) {
        if (options.signal?.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        out += chunk;
        options.onDelta?.(chunk);
        await sleep(deltaMs);
      }
      totalTokens += Math.ceil(text.length / 4);
      return out;
    },

    stats() {
      return {
        ...emptyStats(modelId),
        prefillTokensPerSecond: 123.4,
        decodeTokensPerSecond: 56.7,
        totalTokens,
      };
    },

    async unload() {
      modelId = null;
    },
  };
}
