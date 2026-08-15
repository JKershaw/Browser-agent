/**
 * Stats bar: model, throughput, token count, last tool latency, live iteration
 * counter (SPEC §8.3).
 *
 * @module ui/stats
 */

import { clear, el, formatMs } from './dom.js';

/**
 * @param {HTMLElement} root
 * @returns {{update: Function, setModel: Function, setLoading: Function}}
 */
export function createStatsBar(root) {
  const state = {
    modelId: '—',
    loading: null,
    prefill: null,
    decode: null,
    tokens: 0,
    lastToolMs: null,
    iteration: 0,
    maxIterations: 5,
    running: false,
  };

  function render() {
    clear(root);
    if (state.loading) {
      root.append(
        el('div', { class: 'stat stat-loading' }, [
          el('span', { class: 'stat-label', text: 'loading' }),
          el('span', { class: 'stat-value', text: state.loading }),
        ])
      );
      return;
    }
    const items = [
      ['model', state.modelId],
      ['prefill', state.prefill === null ? '—' : `${state.prefill.toFixed(0)} tok/s`],
      ['decode', state.decode === null ? '—' : `${state.decode.toFixed(0)} tok/s`],
      ['tokens', String(state.tokens)],
      ['last tool', formatMs(state.lastToolMs)],
      ['iteration', `${state.iteration}/${state.maxIterations}`],
    ];
    for (const [label, value] of items) {
      root.append(
        el('div', { class: `stat${label === 'iteration' && state.running ? ' stat-live' : ''}` }, [
          el('span', { class: 'stat-label', text: label }),
          el('span', { class: 'stat-value', text: value }),
        ])
      );
    }
  }

  render();

  return {
    /** @param {Partial<typeof state>} patch */
    update(patch) {
      Object.assign(state, patch);
      render();
    },
    /** @param {string} id */
    setModel(id) {
      state.modelId = id || '—';
      render();
    },
    /** @param {string|null} text Progress line, or null once loaded. */
    setLoading(text) {
      state.loading = text;
      render();
    },
  };
}
