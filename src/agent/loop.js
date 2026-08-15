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
import { describeCredentialUse } from '../tools/curl.js';
import { buildSystemPrompt, capMessage, denialMessage, toolResultMessage } from './prompts.js';

/** Why a turn ended. @enum {string} */
export const StopReason = Object.freeze({
  TEXT: 'text',
  CAP: 'cap',
  CANCELLED: 'cancelled',
  ENGINE_ERROR: 'engine_error',
  TOOL_ERROR: 'tool_error',
  UNPARSEABLE: 'unparseable',
});

/**
 * Absolute ceiling on the tool-result text appended to the transcript.
 *
 * `curl.js` caps the HTTP *body*, but the status line, headers and truncation
 * marker are added on top of that, and a different executor might not cap at
 * all. SPEC §5.3 puts the limit on the tool result, so it is enforced here too.
 *
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function truncateForModel(text, maxBytes = 8 * 1024) {
  // Allow headroom for the wrapper the tool result adds around the body.
  const cap = Math.max(256, Math.floor(Number(maxBytes) || 0)) + 1024;
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= cap) return text;
  const cut = new TextDecoder().decode(encoded.slice(0, cap));
  return `${cut}\n[TRUNCATED: the tool result exceeded ${cap} bytes and was cut here.]`;
}

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
  if (!Number.isFinite(n)) return DEFAULT_MAX_ITERATIONS;
  return Math.min(Math.max(n, 1), HARD_MAX_ITERATIONS);
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
export function shouldConfirm(call, settings, session = {}, credentialUse = null) {
  const method = String(call?.args?.method || 'GET').toUpperCase();
  if (ALWAYS_CONFIRM_METHODS.includes(method)) return true;

  // Auto-approving a host must not auto-approve *credentialled* requests to it.
  // Otherwise the natural flow — "read this page for me", approve once, tick
  // the box — lets injected instructions on that page attach a stored token to
  // a follow-up request with no further prompt.
  if (credentialUse && credentialUse.used.length > 0) return true;

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
    denials: 0,
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
      denials: 0,
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
          emit('onNotice', { kind: 'info', text: capMessage(state.iteration, state.denials) });
          return finish(StopReason.CAP);
        }

        push('assistant', parsed.raw, { toolCall: parsed.call, prose: parsed.prose });
        emit('onToolCall', { call: parsed.call, iteration: state.iteration + 1 });

        let decision;
        try {
          decision = await decide(parsed.call, settings);
        } catch (e) {
          if (controller.signal.aborted) return finish(StopReason.CANCELLED);
          emit('onNotice', { kind: 'error', text: `The confirmation step failed: ${e?.message || e}. Nothing was sent.` });
          return finish(StopReason.TOOL_ERROR);
        }
        if (controller.signal.aborted) return finish(StopReason.CANCELLED);

        if (!decision.approved) {
          // A refusal costs no iteration: the user denying three suggestions
          // must not silently exhaust a budget meant for requests that were
          // actually sent. The pass loop still bounds the turn.
          setState({ denials: state.denials + 1 });
          emit('onToolDenied', { call: parsed.call, reason: decision.reason });
          push('tool', denialMessage(parsed.call.args, decision.reason), { denied: true, call: parsed.call });
          continue;
        }

        setState({ iteration: state.iteration + 1 });

        let result;
        try {
          result = await executeTool(parsed.call, { signal: controller.signal, settings });
        } catch (e) {
          if (controller.signal.aborted) return finish(StopReason.CANCELLED);
          // The tool contract is to return an error object, never to throw, so
          // reaching here is a bug in the executor. Report it honestly instead
          // of letting run() reject with no stopReason and no onTurnEnd.
          emit('onNotice', { kind: 'error', text: `The tool crashed: ${e?.message || e}. The turn was stopped.` });
          return finish(StopReason.TOOL_ERROR);
        }
        if (controller.signal.aborted) return finish(StopReason.CANCELLED);
        emit('onToolResult', { call: parsed.call, result, iteration: state.iteration });
        push('tool', truncateForModel(toolResultMessage(formatResult(result)), settings.maxBytes), {
          call: parsed.call,
          result,
        });
      }

      // Reachable when refusals (which cost no iteration) use up every pass.
      emit('onNotice', { kind: 'info', text: capMessage(state.iteration, state.denials) });
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
      thinking: Boolean(settings.thinking),
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
      thinking: Boolean(settings.thinking),
      signal: controller.signal,
      onDelta: (d) => emit('onDelta', d),
    });

    const retry = parseToolCall(retryRaw);
    // Whatever came back second is final: no repair loops.
    return retry;
  }

  /** Apply the confirmation policy to one call. */
  async function decide(call, settings) {
    const credentialUse = describeCredentialUse(call.args, settings.credentials || []);
    if (!shouldConfirm(call, settings, session, credentialUse)) return { approved: true };
    if (typeof confirm !== 'function') {
      return { approved: false, reason: 'No confirmation handler is available, so the request was not sent.' };
    }

    setState({ pendingConfirmation: call });
    const aborted = abortedDecision();
    let decision;
    try {
      // Race the card against cancellation: a user who presses stop while a
      // confirmation is open must not leave the turn waiting forever on a
      // promise the UI will never settle.
      decision = await Promise.race([confirm(call, credentialUse), aborted.promise]);
    } finally {
      aborted.release();
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

  /**
   * Resolves to a denial as soon as the turn is cancelled.
   * Returns a `release` so the listener is removed when the confirmation wins
   * the race — otherwise every card leaves one attached for the turn's life.
   *
   * @returns {{promise: Promise<object>, release: () => void}}
   */
  function abortedDecision() {
    const signal = controller.signal;
    let release = () => {};
    const promise = new Promise((resolve) => {
      const onAbort = () => resolve({ approved: false, reason: 'Cancelled.' });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      release = () => signal.removeEventListener('abort', onAbort);
    });
    return { promise, release };
  }

  function finish(reason) {
    setState({ stopReason: reason });
    emit('onTurnEnd', { stopReason: reason, iterations: state.iteration });
    return { stopReason: reason, iterations: state.iteration, transcript };
  }

  return {
    run,
    cancel() {
      if (!state.running) return;
      controller?.abort();
      emit('onNotice', { kind: 'info', text: 'Cancelled.' });
    },
    getState: () => ({ ...state, autoApprovedHosts: [...session.autoApprovedHosts] }),
    reset() {
      transcript.length = 0;
      session.autoApprovedHosts.clear();
      setState({ iteration: 0, repairs: 0, denials: 0, stopReason: null, pendingConfirmation: null });
    },
    transcript,
  };
}
