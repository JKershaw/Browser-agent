/**
 * WebLLM implementation of the `llm/engine.js` contract.
 *
 * The only file in the project that imports `@mlc-ai/web-llm`. Everything else
 * talks to the interface, which is what makes a second engine (Transformers.js,
 * Chrome's Prompt API) a drop-in rather than a rewrite.
 *
 * @module llm/webllm
 */

import { emptyStats } from './engine.js';

/**
 * The model tiers from SPEC §4.2, as concrete MLC catalog ids.
 *
 * `vramMb` values come from WebLLM's own `prebuiltAppConfig`, so the capability
 * gate compares like with like.
 */
export const MODEL_TIERS = Object.freeze([
  {
    tier: 'default',
    id: 'Qwen3-4B-q4f16_1-MLC',
    label: 'Qwen3 4B (default)',
    approxDownload: '~2.5 GB',
    vramMb: 3431.59,
    note: 'Best tool-calling reliability of the three. Desktop with a discrete or recent integrated GPU.',
  },
  {
    tier: 'small',
    id: 'Qwen3-1.7B-q4f16_1-MLC',
    label: 'Qwen3 1.7B (small)',
    approxDownload: '~1 GB',
    vramMb: 2036.66,
    note: 'Auto-selected on memory-constrained devices, including most phones.',
  },
  {
    tier: 'tiny',
    id: 'Qwen3-0.6B-q4f16_1-MLC',
    label: 'Qwen3 0.6B (tiny, fastest)',
    approxDownload: '~0.4 GB',
    vramMb: 1403.34,
    note: 'Used by the e2e suite. Fast, but needs simple prompts to call the tool reliably.',
  },
]);

/**
 * Newer Qwen3.5 builds, which appeared in the WebLLM catalog after the spec was
 * written (SPEC §4.1 assumed they were not yet compiled). Offered in the picker
 * but not default: the tier table in the spec was validated against Qwen3.
 */
export const EXTRA_MODELS = Object.freeze([
  { id: 'Qwen3.5-2B-q4f16_1-MLC', label: 'Qwen3.5 2B (newer line)', approxDownload: '~1.3 GB', vramMb: 2245.44 },
  { id: 'Qwen3.5-4B-q4f16_1-MLC', label: 'Qwen3.5 4B (newer line)', approxDownload: '~2.4 GB', vramMb: 3867.82 },
]);

/**
 * Choose a default model for this device.
 *
 * @param {{lowMemory?: boolean, maxBufferBytes?: number|null, deviceMemoryGb?: number|null}} caps
 *        Output of `detectCapabilities`.
 * @param {boolean} [isMobile]
 * @returns {{id: string, reason: string}}
 */
export function pickDefaultModel(caps = {}, isMobile = false) {
  const [big, small, tiny] = MODEL_TIERS;
  if (caps.deviceMemoryGb !== null && caps.deviceMemoryGb !== undefined && caps.deviceMemoryGb <= 2) {
    return { id: tiny.id, reason: `This device reports about ${caps.deviceMemoryGb} GB of memory, so the smallest model is pre-selected.` };
  }
  if (caps.lowMemory) {
    return { id: small.id, reason: 'This device looks memory-constrained, so the small model is pre-selected. You can change it below.' };
  }
  if (isMobile) {
    return { id: small.id, reason: 'Mobile browsers cap GPU memory tightly, so the small model is pre-selected. You can change it below.' };
  }
  return { id: big.id, reason: '' };
}

/**
 * Crude but sufficient mobile heuristic; only used to bias the default model.
 * @param {string} [ua]
 * @returns {boolean}
 */
export function looksMobile(ua = globalThis.navigator?.userAgent || '') {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

/**
 * Create the WebLLM engine.
 *
 * The `@mlc-ai/web-llm` module is imported dynamically so that a browser
 * without WebGPU can render the explanatory screen without paying for the
 * bundle's evaluation, and so unit tests can inject a fake.
 *
 * @param {object} [opts]
 * @param {() => Promise<object>} [opts.importWebLLM] Injectable module loader.
 * @param {object} [opts.navigator] Injectable navigator for capability checks.
 * @returns {import('./engine.js').Engine & {isCached: Function, catalog: Function}}
 */
export function createWebLLMEngine(opts = {}) {
  const importWebLLM = opts.importWebLLM || (() => import('@mlc-ai/web-llm'));
  const nav = opts.navigator ?? globalThis.navigator;

  /** @type {any} */
  let mlc = null;
  /** @type {any} */
  let engine = null;
  let modelId = null;
  let lastUsage = null;
  let totalTokens = 0;

  async function mod() {
    if (!mlc) mlc = await importWebLLM();
    return mlc;
  }

  return {
    async capabilities() {
      const hasGpu = Boolean(nav?.gpu);
      return {
        id: 'webllm',
        label: 'WebLLM (WebGPU)',
        available: hasGpu,
        reason: hasGpu ? undefined : 'WebGPU is not available in this browser.',
        streaming: true,
        needsDownload: true,
      };
    },

    /** The prebuilt model ids WebLLM knows about, for the advanced picker. */
    async catalog() {
      const m = await mod();
      return (m.prebuiltAppConfig?.model_list || []).map((x) => ({
        id: x.model_id,
        vramMb: x.vram_required_MB ?? null,
        lowResource: Boolean(x.low_resource_required),
      }));
    },

    /**
     * Has this model's weights already been cached by the browser?
     * Drives the "cached, loads in seconds" hint.
     * @param {string} id
     */
    async isCached(id) {
      try {
        const m = await mod();
        return await m.hasModelInCache(id);
      } catch {
        // Cache API unavailable (some file:// and private modes) — treat as
        // "unknown", which the UI renders as "will download if needed".
        return false;
      }
    },

    async load(id, onProgress) {
      const m = await mod();
      if (engine) {
        await engine.unload();
        engine = null;
      }
      engine = await m.CreateMLCEngine(id, {
        initProgressCallback: (report) => {
          onProgress?.({
            progress: typeof report.progress === 'number' ? report.progress : 0,
            text: report.text || '',
          });
        },
      });
      modelId = id;
      lastUsage = null;
      // "Tokens this conversation" (SPEC §8.3) is meaningless across a model
      // swap, so the counter starts again with the new model.
      totalTokens = 0;
    },

    async generate(messages, options = {}) {
      if (!engine) throw new Error('No model is loaded yet.');

      // Cleared per call: a stream that yields no usage chunk (interrupted
      // generation, or a runtime that omits it) would otherwise re-add the
      // previous turn's token count every time.
      lastUsage = null;

      const onAbort = () => {
        try {
          engine.interruptGenerate();
        } catch {
          /* generation already finished */
        }
      };
      if (options.signal) {
        if (options.signal.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const request = {
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: options.temperature ?? 0.6,
          max_tokens: options.maxTokens ?? 1024,
        };
        // Qwen3 hybrid thinking is off unless explicitly enabled: reasoning
        // tokens triple the latency of every tool round-trip (SPEC §4.2).
        if (options.thinking !== true) {
          request.extra_body = { enable_thinking: false };
        }

        const stream = await engine.chat.completions.create(request);

        let text = '';
        for await (const chunk of stream) {
          if (options.signal?.aborted) break;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            options.onDelta?.(delta);
          }
          if (chunk.usage) lastUsage = chunk.usage;
        }

        if (options.signal?.aborted) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        if (lastUsage?.total_tokens) totalTokens += lastUsage.total_tokens;
        return text;
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
      }
    },

    stats() {
      return {
        ...emptyStats(modelId),
        prefillTokensPerSecond: lastUsage?.extra?.prefill_tokens_per_s ?? null,
        decodeTokensPerSecond: lastUsage?.extra?.decode_tokens_per_s ?? null,
        totalTokens,
      };
    },

    async unload() {
      if (engine) {
        await engine.unload();
        engine = null;
      }
      modelId = null;
      lastUsage = null;
      totalTokens = 0;
    },
  };
}
