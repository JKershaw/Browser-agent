/**
 * The loading card: what the app shows for the several minutes before it can
 * do anything at all.
 *
 * This is the first screen every new user sees and, on a phone, the one they
 * see for longest. It previously said `62% — Fetching param cache[24/38]…` in
 * the corner of a stats bar, which understates the wait, restarts from zero
 * three times (see `llm/progress.js`), and offers nothing to judge whether
 * staying is worth it.
 *
 * So: a real bar, the phase in words, bytes against bytes, the observed rate,
 * and an estimate — updated on a timer between WebLLM's reports so it reads as
 * live rather than stuck. And when it fails, the same card becomes the
 * diagnosis, because that is where the user is already looking.
 *
 * @module ui/loading
 */

import { copyText, el } from './dom.js';
import { formatDuration, formatEta, formatRate, formatSize } from '../llm/format.js';

/**
 * @param {HTMLElement} host Container the card is appended to.
 * @returns {object}
 */
export function createLoadingPanel(host) {
  /** @type {HTMLElement|null} */
  let card = null;
  let announced = '';

  // Held so updates can write to one text node each instead of rebuilding the
  // card four times a second.
  let refs = {};

  function build(modelId) {
    const bar = el('div', {
      class: 'loading-bar',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
      'aria-valuetext': 'Starting',
    }, [el('div', { class: 'loading-fill' })]);

    const phase = el('strong', { class: 'loading-phase', text: 'Preparing' });
    const percent = el('span', { class: 'loading-percent', text: '' });
    const facts = el('div', { class: 'loading-facts', text: '' });
    const timing = el('div', { class: 'loading-timing', text: '' });
    const note = el('p', { class: 'loading-note', hidden: true });
    const live = el('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });

    refs = { bar, fill: bar.firstChild, phase, percent, facts, timing, note, live };

    return el('div', { class: 'loading-card' }, [
      el('div', { class: 'loading-head' }, [phase, el('span', { class: 'spacer' }), percent]),
      bar,
      facts,
      timing,
      el('p', { class: 'loading-model', text: modelId || '' }),
      note,
      live,
    ]);
  }

  /** Replace `node`'s text only when it differs — avoids pointless reflow. */
  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  return {
    /**
     * Show the card.
     * @param {{modelId?: string, cached?: boolean}} [info]
     */
    start(info = {}) {
      this.destroy();
      card = build(info.modelId);
      host.append(card);
      // The note line, not the timing line: `update()` rewrites the timing on
      // every snapshot, so a message put there is overwritten within
      // milliseconds of the load starting — visible to nobody.
      refs.note.hidden = false;
      setText(
        refs.note,
        info.cached
          ? 'Already downloaded — this should take seconds.'
          : 'The model downloads once and is then cached, so only this first run is slow.'
      );
      return card;
    },

    /**
     * Render a progress snapshot from `llm/progress.js`.
     * @param {object} snapshot
     */
    update(snapshot) {
      if (!card || !snapshot) return;
      const pct = Math.round((snapshot.overall || 0) * 100);

      setText(refs.phase, snapshot.phaseLabel);
      setText(refs.percent, `${pct}%`);
      refs.fill.style.width = `${pct}%`;
      refs.bar.setAttribute('aria-valuenow', String(pct));

      const eta = formatEta(snapshot.etaMs);
      refs.bar.setAttribute('aria-valuetext', `${snapshot.phaseLabel}, ${pct} per cent${eta ? `, ${eta}` : ''}`);

      // Bytes are only known during the download; the later passes have no
      // equivalent number and inventing one would be worse than a short line.
      const parts = [];
      if (snapshot.fetchedBytes !== null && snapshot.totalBytes !== null) {
        parts.push(`${formatSize(snapshot.fetchedBytes)} of ${formatSize(snapshot.totalBytes)}`);
      } else if (snapshot.detail) {
        parts.push(snapshot.detail);
      }
      if (snapshot.bytesPerSecond) parts.push(formatRate(snapshot.bytesPerSecond));
      setText(refs.facts, parts.join(' · '));

      const timing = [
        snapshot.stalled
          ? `nothing for ${formatDuration(snapshot.sinceReportMs)} — still waiting on the network`
          : eta || (pct > 0 ? 'estimating time remaining…' : null),
        `${formatDuration(snapshot.elapsedMs)} so far`,
      ].filter(Boolean);
      setText(refs.timing, timing.join(' · '));

      // Announced only when the phase changes: a live region that fires every
      // quarter-second is unusable with a screen reader.
      if (snapshot.phaseLabel !== announced) {
        announced = snapshot.phaseLabel;
        setText(refs.live, `${snapshot.phaseLabel}, ${pct} per cent`);
      }
    },

    /**
     * Add an advisory line to the card — used by the pre-flight storage check.
     * @param {string} message
     */
    warn(message) {
      if (!card || !message) return;
      refs.note.hidden = false;
      refs.note.className = 'loading-note loading-note-warn';
      setText(refs.note, message);
    },

    /**
     * Turn the card into a failure report.
     *
     * @param {object} diagnosis From `llm/load-error.js`.
     * @param {object} [handlers]
     * @param {() => void} [handlers.onRetry]
     * @param {() => void} [handlers.onSmallerModel]
     * @param {() => void} [handlers.onFreeSpace]
     */
    fail(diagnosis, handlers = {}) {
      if (!card) {
        card = build('');
        host.append(card);
      }

      const details = el('pre', { class: 'code loading-debug', text: diagnosis.debug });
      const copyBtn = el('button', {
        class: 'btn btn-small',
        type: 'button',
        onclick: async () => {
          const ok = await copyText(diagnosis.debug);
          copyBtn.textContent = ok ? 'Copied' : 'Press and hold to copy';
          setTimeout(() => {
            copyBtn.textContent = 'Copy details';
          }, 2000);
        },
      }, 'Copy details');

      const actions = [
        diagnosis.actions?.retry && handlers.onRetry
          ? el('button', { class: 'btn btn-primary', type: 'button', onclick: handlers.onRetry }, 'Try again')
          : null,
        diagnosis.actions?.smallerModel && handlers.onSmallerModel
          ? el('button', { class: 'btn', type: 'button', onclick: handlers.onSmallerModel }, 'Choose a smaller model')
          : null,
        diagnosis.actions?.freeSpace && handlers.onFreeSpace
          ? el('button', { class: 'btn', type: 'button', onclick: handlers.onFreeSpace }, 'Clear stored model data')
          : null,
      ].filter(Boolean);

      const replacement = el('div', { class: 'loading-card loading-card-failed', role: 'alert' }, [
        el('h2', { class: 'loading-fail-title', text: diagnosis.title }),
        el('p', { class: 'loading-fail-explain', text: diagnosis.explain }),
        diagnosis.advice?.length
          ? el('ul', { class: 'loading-advice' }, diagnosis.advice.map((line) => el('li', { text: line })))
          : null,
        actions.length ? el('div', { class: 'loading-actions' }, actions) : null,
        el('details', { class: 'loading-details' }, [
          el('summary', { text: 'Details for a bug report' }),
          el('div', { class: 'disclosure-body' }, [details, el('div', { class: 'loading-actions' }, [copyBtn])]),
        ]),
      ]);

      card.replaceWith(replacement);
      card = replacement;
      refs = {};
      return replacement;
    },

    /** @returns {HTMLElement|null} */
    node() {
      return card;
    },

    destroy() {
      card?.remove();
      card = null;
      refs = {};
      announced = '';
    },
  };
}
