/**
 * The engine contract the rest of the app is written against.
 *
 * Nothing outside `src/llm/` may import a concrete engine. WebLLM is the only
 * v1 implementation; the interface exists so Transformers.js or Chrome's
 * built-in Prompt API can be added without touching the agent loop or the UI
 * (see SPEC §4.3).
 *
 * @module llm/engine
 */

/**
 * @typedef {object} EngineCapabilities
 * @property {string} id           Short identifier, e.g. `webllm`.
 * @property {string} label        Human-readable name.
 * @property {boolean} available   Whether this engine can run here right now.
 * @property {string} [reason]     Why it cannot, when `available` is false.
 * @property {boolean} streaming   Whether `generate` yields incremental deltas.
 * @property {boolean} needsDownload Whether loading fetches model weights.
 */

/**
 * @typedef {object} ChatMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {object} GenerateOptions
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {AbortSignal} [signal]
 * @property {(delta: string) => void} [onDelta] Called per streamed chunk.
 */

/**
 * @typedef {object} EngineStats
 * @property {number|null} prefillTokensPerSecond
 * @property {number|null} decodeTokensPerSecond
 * @property {number} totalTokens
 * @property {string|null} modelId
 */

/**
 * @typedef {object} Engine
 * @property {() => Promise<EngineCapabilities>} capabilities
 * @property {(modelId: string, onProgress?: (p: {progress: number, text: string}) => void) => Promise<void>} load
 * @property {(messages: ChatMessage[], options?: GenerateOptions) => Promise<string>} generate
 * @property {() => EngineStats} stats
 * @property {() => Promise<void>} unload
 */

/** Methods every engine implementation must provide. */
export const ENGINE_METHODS = Object.freeze(['capabilities', 'load', 'generate', 'stats', 'unload']);

/**
 * Throw unless `candidate` implements the full contract. Called by the app at
 * wiring time so a partial engine fails loudly at startup rather than three
 * screens into a conversation.
 *
 * @param {unknown} candidate
 * @returns {Engine}
 */
export function assertEngine(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('Engine must be an object.');
  }
  const missing = ENGINE_METHODS.filter((m) => typeof candidate[m] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`Engine is missing required method(s): ${missing.join(', ')}.`);
  }
  return /** @type {Engine} */ (candidate);
}

/** Empty stats, for engines that have not run yet. */
export function emptyStats(modelId = null) {
  return { prefillTokensPerSecond: null, decodeTokensPerSecond: null, totalTokens: 0, modelId };
}

/**
 * Detect WebGPU support and gather what we can about device capacity.
 *
 * Adapter enumeration is async and can reject on locked-down configurations,
 * so every step is guarded; the caller gets a verdict, never an exception.
 *
 * @param {object} [nav] Injectable `navigator` for tests.
 * @returns {Promise<{webgpu: boolean, reason: string|null, deviceMemoryGb: number|null,
 *                    maxBufferBytes: number|null, lowMemory: boolean}>}
 */
export async function detectCapabilities(nav = globalThis.navigator) {
  const out = {
    webgpu: false,
    reason: null,
    deviceMemoryGb: null,
    maxBufferBytes: null,
    lowMemory: false,
  };

  if (!nav) {
    out.reason = 'No navigator object is available in this environment.';
    return out;
  }

  if (typeof nav.deviceMemory === 'number') out.deviceMemoryGb = nav.deviceMemory;

  if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
    out.reason = 'This browser does not expose WebGPU (navigator.gpu is missing).';
    out.lowMemory = out.deviceMemoryGb !== null && out.deviceMemoryGb <= 4;
    return out;
  }

  let adapter = null;
  try {
    adapter = await nav.gpu.requestAdapter();
  } catch (e) {
    out.reason = `Requesting a WebGPU adapter failed: ${e?.message || e}`;
    return out;
  }

  if (!adapter) {
    out.reason = 'WebGPU is present but no GPU adapter was granted (often a headless, virtualised or blocklisted GPU).';
    return out;
  }

  out.webgpu = true;
  const limit = adapter.limits?.maxBufferSize;
  if (typeof limit === 'number' && Number.isFinite(limit)) out.maxBufferBytes = limit;

  // Either signal being small means the 4B default will not fit comfortably.
  const tightRam = out.deviceMemoryGb !== null && out.deviceMemoryGb <= 4;
  const tightBuffer = out.maxBufferBytes !== null && out.maxBufferBytes < 1_000_000_000;
  out.lowMemory = tightRam || tightBuffer;

  return out;
}
