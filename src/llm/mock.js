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
 * @param {Error} [opts.loadError] The error `failLoad` should throw. Lets a
 *   scenario reproduce a specific browser failure verbatim.
 * @param {number} [opts.failAt] Fraction of the download to get through before
 *   failing, so the error arrives against a part-filled progress bar rather
 *   than an empty one.
 * @param {number} [opts.totalMb] Simulated download size.
 * @returns {import('./engine.js').Engine & {calls: Array<object>, setScript: Function}}
 */
export function createMockEngine(opts = {}) {
  let script = opts.script ? [...opts.script] : ['Hello from the mock engine.'];
  const deltaMs = opts.deltaMs ?? 0;
  const loadMs = opts.loadMs ?? 0;
  const failAt = opts.failAt ?? 0.65;
  const totalMb = opts.totalMb ?? 1024;
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

    /** Nothing is cached, so the loading UI always takes its first-run path. */
    async isCached() {
      return false;
    },

    async deleteFromCache() {
      return true;
    },

    /**
     * Replay a load the way WebLLM reports one.
     *
     * The wording here is copied from WebLLM's own progress callback, including
     * the detail that the fraction restarts at zero for each of the three
     * passes. `progress.js` exists to absorb exactly that, so the mock has to
     * reproduce it or the e2e suite would be testing a tidier world than the
     * one users get.
     */
    async load(id, onProgress) {
      const STEPS = 20;
      const step = loadMs > 0 ? loadMs / STEPS : 0;
      const shards = 38;
      const emit = (text, progress) => onProgress?.({ progress, text });

      emit('Start to fetch params', 0);
      await sleep(step);

      // Download.
      for (let i = 1; i <= 12; i += 1) {
        const fraction = i / 12;
        if (opts.failLoad && fraction >= failAt) {
          throw opts.loadError || new Error('Mock engine was configured to fail loading.');
        }
        const shard = Math.round(fraction * shards);
        const mb = Math.ceil(fraction * totalMb);
        emit(
          `Fetching param cache[${shard}/${shards}]: ${mb}MB fetched. ${Math.floor(fraction * 100)}% completed, ` +
            `${Math.round((i * step) / 1000)} secs elapsed. It can take a while when we first visit this page to populate the cache.` +
            ' Later refreshes will become faster.',
          fraction
        );
        await sleep(step);
      }
      if (opts.failLoad) throw opts.loadError || new Error('Mock engine was configured to fail loading.');

      // Read back onto the GPU.
      for (let i = 1; i <= 4; i += 1) {
        const fraction = i / 4;
        const shard = Math.round(fraction * shards);
        emit(
          `Loading model from cache[${shard}/${shards}]: ${Math.ceil(fraction * totalMb)}MB loaded. ` +
            `${Math.floor(fraction * 100)}% completed, ${Math.round((12 + i) * step / 1000)} secs elapsed.`,
          fraction
        );
        await sleep(step);
      }

      // Shaders.
      for (let i = 1; i <= 3; i += 1) {
        const fraction = i / 3;
        emit(
          `Loading GPU shader modules[${i}/3]: ${Math.floor(fraction * 100)}% completed, ` +
            `${Math.round((16 + i) * step / 1000)} secs elapsed.`,
          fraction
        );
        await sleep(step);
      }

      emit('Finish loading on WebGPU - mock', 1);
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
