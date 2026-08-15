/**
 * Capability gate (SPEC §2.2).
 *
 * When WebGPU is missing the user gets an explanation of what is wrong and
 * what to do about it — never a blank page or a console-only failure.
 *
 * @module ui/gate
 */

import { el } from './dom.js';

/**
 * Advice tailored to the browser we appear to be running in.
 *
 * @param {string} ua
 * @returns {{browser: string, advice: string[]}}
 */
export function adviseForBrowser(ua = '') {
  const isEdge = /Edg\//.test(ua);
  const isChrome = /Chrome\//.test(ua) && !isEdge;
  const isFirefox = /Firefox\//.test(ua);
  const isSafari = /Safari\//.test(ua) && !/Chrome\/|Chromium\//.test(ua);
  const isAndroid = /Android/.test(ua);
  const isIOS = /iPhone|iPad|iPod/.test(ua);

  if (isChrome || isEdge) {
    return {
      browser: isEdge ? 'Edge' : 'Chrome',
      advice: [
        'WebGPU ships enabled in Chrome and Edge 113 and later, so an old version is the most likely cause — check your version and update.',
        'On Linux, or with a GPU the browser has blocklisted, WebGPU can be off even on a current version. Open chrome://gpu and look at the WebGPU line for the reason.',
        'If it says the feature is disabled, enabling chrome://flags/#enable-unsafe-webgpu often turns it on.',
        isAndroid ? 'On Android, WebGPU needs Chrome 121 or later and a reasonably recent device.' : null,
      ].filter(Boolean),
    };
  }
  if (isFirefox) {
    return {
      browser: 'Firefox',
      advice: [
        'Firefox’s WebGPU support arrived later than Chromium’s and is not a test target for this app.',
        'On a recent Firefox, set dom.webgpu.enabled to true in about:config, then reload.',
        'If that does not work, use Chrome or Edge 113+.',
      ],
    };
  }
  if (isSafari) {
    return {
      browser: 'Safari',
      advice: [
        isIOS
          ? 'On iOS, WebGPU availability varies by version and the memory limits are tight — this app is best-effort there, not a supported target.'
          : 'On macOS Safari, check Settings → Advanced → Feature Flags for WebGPU, or use Chrome or Edge.',
        'Chrome or Edge 113+ is the supported path.',
      ],
    };
  }
  return {
    browser: 'this browser',
    advice: ['This app needs WebGPU. Chromium-based browsers (Chrome, Edge) version 113 and later are the supported target.'],
  };
}

/**
 * Render the blocking explanatory screen.
 *
 * @param {HTMLElement} root
 * @param {{reason: string|null, deviceMemoryGb: number|null}} caps
 * @param {object} [opts]
 * @param {string} [opts.ua]
 * @param {() => void} [opts.onRetry]
 * @returns {HTMLElement}
 */
export function renderCapabilityGate(root, caps, opts = {}) {
  const { browser, advice } = adviseForBrowser(opts.ua ?? globalThis.navigator?.userAgent ?? '');

  const node = el('div', { class: 'gate' }, [
    el('h1', { text: 'This app needs WebGPU' }),
    el('p', {
      text: 'The whole language model runs inside this page — there is no server doing the work. That needs WebGPU, the browser API for running computations on your graphics hardware, and it is not available here.',
    }),
    caps?.reason ? el('p', { class: 'gate-reason', text: `What the browser reported: ${caps.reason}` }) : null,
    el('h2', { text: `Getting it working in ${browser}` }),
    el('ul', {}, advice.map((line) => el('li', { text: line }))),
    el('p', { class: 'muted', text: 'Nothing you type is sent anywhere while this screen is showing; the app has not loaded a model or made any request.' }),
    opts.onRetry
      ? el('button', { class: 'btn', type: 'button', onclick: opts.onRetry }, 'Check again')
      : null,
  ]);

  root.append(node);
  return node;
}
