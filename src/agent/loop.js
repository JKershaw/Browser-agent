/**
 * The agent iteration loop: generate -> maybe call the tool -> feed the result
 * back -> repeat, under a hard cap.
 *
 * Written against injected dependencies (engine, tool executor, confirmation
 * callback) so the whole control flow tests with a fake engine and no browser.
 *
 * @module agent/loop
 */

import { parseToolCall, repairPrompt } from './toolcall.js';
import { buildSystemPrompt, capMessage, denialMessage, toolResultMessage } from './prompts.js';

/** Why a turn ended. @enum {string} */
export const StopReason = Object.freeze({
  TEXT: 'text',
  CAP: 'cap',
  CANCELLED: 'cancelled',
  ENGINE_ERROR: 'engine_error',
  UNPARSEABLE: 'unparseable',
});

/** Hard ceiling on iterations regardless of settings (SPEC §5.3). */
export const HARD_MAX_ITERATIONS = 10;
export const DEFAULT_MAX_ITERATIONS = 5;

/** Methods that always require explicit confirmation. */
const ALWAYS_CONFIRM_METHODS = Object.freeze(['DELETE']);

/**
 * Clamp a configured iteration limit into the permitted range.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampIterations(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_ITERATIONS;
  return Math.min(n, HARD_MAX_ITERATIONS);
}

/**
 * Decide whether a call needs a confirmation card.
 *
 * DELETE always confirms, even on a host the user auto-approved this session —
 * destructive and irreversible beats convenience.
 *
 * @param {{args: {method: string, url: string}}} call
 * @param {{confirmBeforeSend?: boolean}} settings
 * @param {{autoApprovedHosts?: Set<string>}} [session]
 * @returns {boolean}
 */
export function shouldConfirm(call, settings, session = {}) {
  const method = String(call?.args?.method || 'GET').toUpperCase();
  if (ALWAYS_CONFIRM_METHODS.includes(method)) return true;
  if (!settings?.confirmBeforeSend) return false;
  let host;
  try {
    host = new URL(call.args.url).hostname.toLowerCase();
  } catch {
    return true;
  }
  return !session?.autoApprovedHosts?.has(host);
}

/**
 * Convert the internal transcript into engine-ready chat messages.
 *
 * Tool results are sent with the `user` role rather than a `tool` role: the
 * JSON-block contract (SPEC §5.1) does not use native function calling, and
 * small chat models handle a plain user message far more reliably than a role
 * their template may not define.
 *
 * @param {Array<{role: string, content: string}>} transcript
 * @param {string} systemPrompt
 * @returns {Array<{role: 'system'|'user'|'assistant', content: string}>}
 */
export function toEngineMessages(transcript, systemPrompt) {
  const out = [{ role: 'system', content: systemPrompt }];
  for (const m of transcript) {
    if (m.role === 'assistant') out.push({ role: 'assistant', content: m.content });
    else out.push({ role: 'user', content: m.content });
  }
  return out;
}

/**
 * Create an agent loop bound to an engine and a tool executor.
 *
 * @param {object} deps
 * @param {import('../llm/engine.js').Engine} deps.engine
 * @param {(call: object, ctx: object) => Promise<object>} deps.executeTool
 *        Receives the validated call; returns a curl result object.
 * @param {(result: object) => string} deps.formatResult
 *        Renders a curl result as the text the model sees.
 * @param {() => object} deps.getSettings Read current settings at each step.
 * @param {(call: object) => Promise<{approved: boolean, reason?: string, rememberHost?: boolean}>} [deps.confirm]
 *        Shows the confirmation card. Required when confirmation is enabled.
 * @param {object} [deps.hooks] Observation callbacks; all optional.
 * @param {object} [deps.session] Mutable per-session state (auto-approved hosts).
 * @returns {{run: Function, cancel: Function, getState: Function, transcript: Array, reset: Function}}
 */
export function createAgentLoop(deps) {
  const {
    engine,
    executeTool,
    formatResult,
    getSettings,
    confirm,
    hooks = {},
    session = { autoApprovedHosts: new Set() },
  } = deps;

  if (!session.autoApprovedHosts) session.autoApprovedHosts = new Set();

  /** @type {Array<{role: string, content: string}>} */
  const transcript = [];

  const state = {
    running: false,
    iteration: 0,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    pendingConfirmation: null,
    repairs: 0,
    stopReason: null,
  };

  let controller = null;

  const emit = (name, payload) => {
    const fn = hooks[name];
    if (typeof fn === 'function') fn(payload);
  };

  const setState = (patch) => {
    Object.assign(state, patch);
    emit('onStateChange', { ...state });
  };

  /** Append to the transcript and notify the UI. */
  const push = (role, content, meta) => {
    const entry = { role, content, ...(meta ? { meta } : {}) };
    transcript.push(entry);
    emit('onMessage', entry);
    return entry;
  };

  /**
   * Run one full turn for a user message.
   *
   * @param {string} userText
   * @returns {Promise<{stopReason: string, iterations: number, transcript: Array}>}
   */
  async function run(userText) {
    if (state.running) throw new Error('An agent turn is already running.');

    controller = new AbortController();
    const settings0 = getSettings();
    setState({
      running: true,
      iteration: 0,
      repairs: 0,
      pendingConfirmation: null,
      stopReason: null,
      maxIterations: clampIterations(settings0.maxIterations),
    });

    push('user', String(userText));

    try {
      // The +1 pass exists so the model can speak after its last tool result
      // instead of the turn ending on a silent truncation.
      for (let pass = 0; pass <= state.maxIterations; pass += 1) {
        if (controller.signal.aborted) return finish(StopReason.CANCELLED);

        const settings = getSettings();
        const systemPrompt = buildSystemPrompt({
          credentialNames: (settings.credentials || []).map((c) => c.name),
          allowlist: settings.allowlist || [],
          maxIterations: state.maxIterations,
          thinking: Boolean(settings.thinking),
        });

        let parsed;
        try {
          parsed = await generateAndParse(toEngineMessages(transcript, systemPrompt), settings);
        } catch (e) {
          if (controller.signal.aborted) return finish(StopReason.CANCELLED);
          emit('onNotice', { kind: 'error', text: `The model failed to generate a reply: ${e?.message || e}` });
          return finish(StopReason.ENGINE_ERROR);
        }

        if (parsed.kind === 'text') {
          push('assistant', parsed.text);
          return finish(StopReason.TEXT);
        }

        if (parsed.kind === 'error') {
          // Repair already ran inside generateAndParse; surface the raw output.
          push('assistant', parsed.raw, { parseError: parsed.error });
          emit('onNotice', {
            kind: 'warning',
            text: `The model tried to call the tool but the call could not be parsed (${parsed.error.code}: ${parsed.error.message}). Its raw reply is shown above.`,
          });
          return finish(StopReason.UNPARSEABLE);
        }

        // --- a valid tool call ---
        if (state.iteration >= state.maxIterations) {
          emit('onNotice', { kind: 'info', text: capMessage(state.maxIterations) });
          return finish(StopReason.CAP);
        }

        push('assistant', parsed.raw, { toolCall: parsed.call, prose: parsed.prose });
        setState({ iteration: state.iteration + 1 });
        emit('onToolCall', { call: parsed.call, iteration: state.iteration });

        const decision = await decide(parsed.call, settings);
        if (controller.signal.aborted) return finish(StopReason.CANCELLED);

        if (!decision.approved) {
          emit('onToolDenied', { call: parsed.call, reason: decision.reason });
          push('tool', denialMessage(parsed.call.args, decision.reason), { denied: true, call: parsed.call });
          continue;
        }

        const result = await executeTool(parsed.call, { signal: controller.signal, settings });
        if (controller.signal.aborted) return finish(StopReason.CANCELLED);
        emit('onToolResult', { call: parsed.call, result, iteration: state.iteration });
        push('tool', toolResultMessage(formatResult(result)), { call: parsed.call, result });
      }

      /* c8 ignore next 3 -- unreachable: the cap check above returns first */
      emit('onNotice', { kind: 'info', text: capMessage(state.maxIterations) });
      return finish(StopReason.CAP);
    } finally {
      setState({ running: false, pendingConfirmation: null });
    }
  }

  /** Generate once, and run at most one repair round on a parse failure. */
  async function generateAndParse(messages, settings) {
    emit('onGenerationStart', { repair: false });
    const raw = await engine.generate(messages, {
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      signal: controller.signal,
      onDelta: (d) => emit('onDelta', d),
    });

    const parsed = parseToolCall(raw);
    if (parsed.kind !== 'error') return parsed;

    emit('onNotice', {
      kind: 'info',
      text: `Malformed tool call (${parsed.error.code}); asking the model to correct it.`,
    });
    setState({ repairs: state.repairs + 1 });

    const repairMessages = [
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: repairPrompt(parsed.error) },
    ];
    emit('onGenerationStart', { repair: true });
    const retryRaw = await engine.generate(repairMessages, {
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      signal: controller.signal,
      onDelta: (d) => emit('onDelta', d),
    });

    const retry = parseToolCall(retryRaw);
    // Whatever came back second is final: no repair loops.
    return retry;
  }

  /** Apply the confirmation policy to one call. */
  async function decide(call, settings) {
    if (!shouldConfirm(call, settings, session)) return { approved: true };
    if (typeof confirm !== 'function') {
      return { approved: false, reason: 'No confirmation handler is available, so the request was not sent.' };
    }

    setState({ pendingConfirmation: call });
    let decision;
    try {
      // Race the card against cancellation: a user who presses stop while a
      // confirmation is open must not leave the turn waiting forever on a
      // promise the UI will never settle.
      decision = await Promise.race([confirm(call), abortedDecision()]);
    } finally {
      setState({ pendingConfirmation: null });
    }

    const approved = Boolean(decision && decision.approved);
    if (approved && decision.rememberHost) {
      try {
        session.autoApprovedHosts.add(new URL(call.args.url).hostname.toLowerCase());
      } catch {
        /* unparseable URL cannot be remembered; it will simply ask again */
      }
    }
    return { approved, reason: decision?.reason };
  }

  /** Resolves to a denial as soon as the turn is cancelled. */
  function abortedDecision() {
    return new Promise((resolve) => {
      const signal = controller.signal;
      if (signal.aborted) {
        resolve({ approved: false, reason: 'Cancelled.' });
        return;
      }
      signal.addEventListener('abort', () => resolve({ approved: false, reason: 'Cancelled.' }), { once: true });
    });
  }

  function finish(reason) {
    setState({ stopReason: reason });
    emit('onTurnEnd', { stopReason: reason, iterations: state.iteration });
    return { stopReason: reason, iterations: state.iteration, transcript };
  }

  return {
    run,
    cancel() {
      if (controller) controller.abort();
      emit('onNotice', { kind: 'info', text: 'Cancelled.' });
    },
    getState: () => ({ ...state, autoApprovedHosts: [...session.autoApprovedHosts] }),
    reset() {
      transcript.length = 0;
      session.autoApprovedHosts.clear();
      setState({ iteration: 0, repairs: 0, stopReason: null, pendingConfirmation: null });
    },
    transcript,
  };
}
