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
import { closeStep, splitSteps } from './split.js';
import { describeCredentialUse } from '../tools/curl.js';
import { buildSystemPrompt, capMessage, denialMessage, repeatedCallMessage, repeatedSuccessMessage, toolResultMessage } from './prompts.js';

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
 * Two cases always confirm, whatever the settings say, because both are
 * irreversible: DELETE, and any request that would carry a stored credential.
 * A leaked long-lived token cannot be un-leaked, so it gets the same treatment
 * as a destructive method rather than riding on a general "trust this host".
 *
 * @param {{args: {method: string, url: string}}} call
 * @param {{confirmBeforeSend?: boolean}} settings
 * @param {{autoApprovedHosts?: Set<string>}} [session]
 * @param {{used?: string[]}} [credentialUse] Output of `describeCredentialUse`.
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
  const origin = originOf(call?.args?.url);
  if (origin === null) return true;
  return !session?.autoApprovedHosts?.has(origin);
}

/**
 * The key an auto-approval is remembered under: scheme, host **and** port.
 *
 * Hostname alone is too coarse. Approving `https://example.com` would then
 * silently authorise `http://example.com` — a plaintext downgrade — and
 * `http://example.com:8080/admin`, an entirely different service.
 *
 * @param {string} url
 * @returns {string|null} Null when the URL cannot be parsed.
 */
export function originOf(url) {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Identity of a request, for deciding whether the model is repeating itself.
 *
 * Tool, method and URL — not the headers or body. Two GETs to the same URL that
 * differ only in an `Accept` header will fail for the same reason, and a model
 * that varies a header while keeping an unfetchable URL is still looping.
 *
 * The `wiki` tool's URL is derived from its search term, so identical searches
 * collide here exactly as they should.
 *
 * @param {{tool?: string, args: {method?: string, url?: string}}} call
 * @returns {string}
 */
export function callKey(call) {
  const method = String(call?.args?.method || 'GET').toUpperCase();
  return `${call?.tool || 'curl'}|${method} ${call?.args?.url || ''}`;
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
   * The message is first split into sequential steps (`splitSteps`) — almost
   * always exactly one. A multi-step ask runs each step as its own user turn
   * in the shared transcript, so the model only ever holds the current step;
   * this is the deterministic chain-driver, and the measured reason for it is
   * in `split.js`. All steps share one tool budget, because the system prompt
   * promises the model "at most N tool calls for one user message" and the
   * harness keeps that promise. Any stop other than a plain text answer ends
   * the whole turn — a step that was cancelled, capped or broken is not a
   * foundation the next step can build on.
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

    try {
      const steps = splitSteps(String(userText));
      let reason = StopReason.TEXT;
      for (let i = 0; i < steps.length; i += 1) {
        const meta = steps.length > 1
          ? { step: { index: i, total: steps.length, original: String(userText) } }
          : undefined;
        // Non-final steps get a closed shape (see closeStep): a bare action
        // step wanders on its leftover budget. The last step keeps the user's
        // own reporting clause, whatever it is.
        const isFinal = i === steps.length - 1;
        push('user', isFinal ? steps[i] : closeStep(steps[i]), meta);
        reason = await runStep();
        if (reason !== StopReason.TEXT) break;
      }
      return finish(reason);
    } finally {
      setState({ running: false, pendingConfirmation: null });
    }
  }

  /**
   * Run the generate → call → result loop for one step.
   *
   * @returns {Promise<string>} A {@link StopReason}.
   */
  async function runStep() {
    /**
     * Requests already sent this turn that failed, keyed by tool, method and
     * URL. A failed request is not worth repeating: the browser refuses it for
     * a reason it will not disclose, and it refuses identically every time.
     * @type {Map<string, {retryUrl?: string}>}
     */
    const failed = new Map();

    /**
     * Successful sends this turn, by the same key. A repeat here is *not*
     * refused — the model may mean it, and a second POST is a real action —
     * but from the second identical success onward the result carries a nudge
     * to answer instead of fetching again. The holdout caught a turn spending
     * its whole budget re-fetching a URL it had already read.
     * @type {Map<string, number>}
     */
    const succeeded = new Map();

    // The +1 pass exists so the model can speak after its last tool result
    // instead of the turn ending on a silent truncation.
    for (let pass = 0; pass <= state.maxIterations; pass += 1) {
        if (controller.signal.aborted) return StopReason.CANCELLED;

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
          if (controller.signal.aborted) return StopReason.CANCELLED;
          emit('onNotice', { kind: 'error', text: `The model failed to generate a reply: ${e?.message || e}` });
          return StopReason.ENGINE_ERROR;
        }

        if (parsed.kind === 'text') {
          push('assistant', parsed.text);
          return StopReason.TEXT;
        }

        if (parsed.kind === 'error') {
          // Repair already ran inside generateAndParse; surface the raw output.
          push('assistant', parsed.raw, { parseError: parsed.error });
          emit('onNotice', {
            kind: 'warning',
            text: `The model tried to call the tool but the call could not be parsed (${parsed.error.code}: ${parsed.error.message}). Its raw reply is shown above.`,
          });
          return StopReason.UNPARSEABLE;
        }

        // --- a valid tool call ---
        if (state.iteration >= state.maxIterations) {
          emit('onNotice', { kind: 'info', text: capMessage(state.iteration, state.denials) });
          return StopReason.CAP;
        }

        push('assistant', parsed.raw, { toolCall: parsed.call, prose: parsed.prose });

        // Checked before the confirmation card, not after: asking the user to
        // approve a request we already know will fail spends their attention on
        // a decision that cannot matter, and teaches them to approve blindly.
        const key = callKey(parsed.call);
        const prior = failed.get(key);
        if (prior) {
          emit('onNotice', {
            kind: 'info',
            text: `Not sent: ${parsed.call.args.method} ${parsed.call.args.url} already failed in this turn.`,
          });
          push('tool', toolResultMessage(repeatedCallMessage(parsed.call.args, prior.retryUrl)), {
            call: parsed.call,
            repeated: true,
          });
          continue;
        }

        emit('onToolCall', { call: parsed.call, iteration: state.iteration + 1 });

        let decision;
        try {
          decision = await decide(parsed.call, settings);
        } catch (e) {
          if (controller.signal.aborted) return StopReason.CANCELLED;
          emit('onNotice', { kind: 'error', text: `The confirmation step failed: ${e?.message || e}. Nothing was sent.` });
          return StopReason.TOOL_ERROR;
        }
        if (controller.signal.aborted) return StopReason.CANCELLED;

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
          if (controller.signal.aborted) return StopReason.CANCELLED;
          // The tool contract is to return an error object, never to throw, so
          // reaching here is a bug in the executor. Report it honestly instead
          // of letting run() reject with no stopReason and no onTurnEnd.
          emit('onNotice', { kind: 'error', text: `The tool crashed: ${e?.message || e}. The turn was stopped.` });
          return StopReason.TOOL_ERROR;
        }
        if (controller.signal.aborted) return StopReason.CANCELLED;
        // Only transport failures are remembered. An HTTP 4xx/5xx is a real
        // answer from a reachable server, and re-requesting it can be perfectly
        // sensible — a 503 clears, a 429 stops rate-limiting.
        if (!result.ok) failed.set(key, { retryUrl: result.error?.retryUrl });

        const wins = result.ok ? (succeeded.get(key) || 0) + 1 : 0;
        if (result.ok) succeeded.set(key, wins);

        emit('onToolResult', { call: parsed.call, result, iteration: state.iteration });
        // The nudge goes on *after* truncation, so however large the response,
        // the last line the model reads is the instruction to answer.
        let message = truncateForModel(toolResultMessage(formatResult(result)), settings.maxBytes);
        if (wins >= 2) message += `\n\n${repeatedSuccessMessage(wins)}`;
        push('tool', message, {
          call: parsed.call,
          result,
        });
      }

    // Reachable when refusals (which cost no iteration) use up every pass.
    emit('onNotice', { kind: 'info', text: capMessage(state.iteration, state.denials) });
    return StopReason.CAP;
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
    const credentialUse = describeCredentialUse(call.args, settings.credentials || [], settings.proxyTemplate || '');
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
      const origin = originOf(call?.args?.url);
      // An unparseable URL cannot be remembered; it will simply ask again.
      if (origin !== null) session.autoApprovedHosts.add(origin);
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
