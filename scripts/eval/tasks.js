/**
 * Task sets for the tool-call evaluation harness.
 *
 * Two suites, for two different questions.
 *
 * **local** is hermetic and answers "does the tool contract hold": the model is
 * handed a URL and has to reproduce it, vary the method, carry a body, and
 * refrain from calling the tool when told not to. Nothing here depends on the
 * model knowing anything about the world.
 *
 * **wiki** answers the question that actually matters — can it *find* something
 * — against real Wikipedia, which needs no proxy because the Wikimedia APIs
 * send `Access-Control-Allow-Origin: *`.
 *
 * Each suite is split into `dev` and `holdout`. Iterate against dev; measure
 * against holdout only at checkpoints. A prompt tuned until the tasks in front
 * of it pass has been fitted to those tasks, and the holdout is the only thing
 * that will say so.
 *
 * @module scripts/eval/tasks
 */

/**
 * @param {string} base URL of the local test server, e.g. `http://127.0.0.1:9`.
 * @returns {{dev: object[], holdout: object[]}}
 */
export function localTasks(base) {
  const host = new URL(base).host;
  return {
    dev: [
      {
        id: 'local-get-json',
        ask: `Use the curl tool to GET ${base}/json and tell me the value of "city" in the response.`,
        expectTool: true,
        expect: { host, method: 'GET', pathIncludes: '/json' },
        answer: /bristol/i,
      },
      {
        id: 'local-status',
        ask: `Use the curl tool to GET ${base}/status/404 and tell me which HTTP status code came back.`,
        expectTool: true,
        expect: { host, method: 'GET', pathIncludes: '/status/404' },
        // The request is meant to 404; the task is to report it, so the answer
        // is graded and the HTTP status is not held against the model.
        allowHttpError: true,
        answer: /404/,
      },
      {
        id: 'local-post-body',
        ask: `Use the curl tool to POST the JSON {"hello":"world"} to ${base}/echo, then tell me what method the server said it received.`,
        expectTool: true,
        expect: { host, method: 'POST', pathIncludes: '/echo' },
        answer: /post/i,
      },
      {
        // Same ask as local-get-json, played after an unrelated turn. The
        // real-model e2e suite runs its scenarios on one page, so by the time
        // it asks for a URL there is already a conversation above it — and it
        // fails there in a way it does not fail from a clean transcript. If
        // history is the variable, this is where it shows.
        id: 'local-get-json-after-chat',
        preamble: ['Say hello in one short sentence.'],
        ask: `Use the curl tool to GET ${base}/json and tell me the value of "city" in the response.`,
        expectTool: true,
        expect: { host, method: 'GET', pathIncludes: '/json' },
        answer: /bristol/i,
      },
      {
        id: 'local-get-json-after-3-turns',
        preamble: [
          'Say hello in one short sentence.',
          'What is your name?',
          'Tell me something interesting about the number seven.',
        ],
        ask: `Use the curl tool to GET ${base}/json and tell me the value of "city" in the response.`,
        expectTool: true,
        expect: { host, method: 'GET', pathIncludes: '/json' },
        answer: /bristol/i,
      },
      {
        id: 'local-no-tool',
        ask: 'What is the capital of France? Answer from your own knowledge — do not use any tool.',
        expectTool: false,
        answer: /paris/i,
      },
    ],
    holdout: [
      {
        id: 'local-headers',
        ask: `Use the curl tool to GET ${base}/headers and tell me the value of the "host" header the server received.`,
        expectTool: true,
        expect: { host, method: 'GET', pathIncludes: '/headers' },
        answer: new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      },
      {
        id: 'local-query',
        ask: `Use the curl tool to fetch ${base}/status/503 and tell me the status code.`,
        expectTool: true,
        expect: { host, method: 'GET', pathIncludes: '/status/503' },
        allowHttpError: true,
        answer: /503/,
      },
    ],
  };
}

/**
 * Wikipedia lookups.
 *
 * The expectation is only the host and the subject — deliberately not a
 * specific endpoint. There are several legitimate ways to look a thing up on
 * Wikipedia and pinning one would score correct behaviour as failure; which
 * endpoint the model reaches for is a finding, not a requirement.
 *
 * @returns {{dev: object[], holdout: object[]}}
 */
export function wikiTasks() {
  const host = 'en.wikipedia.org';
  return {
    dev: [
      {
        id: 'wiki-telephone',
        ask: 'Look up the Wikipedia article "Telephone" and tell me who is credited with inventing the telephone.',
        expectTool: true,
        expect: { host, pathIncludes: 'telephone' },
        answer: /bell/i,
      },
      {
        id: 'wiki-clifton',
        // Obscure enough that a 0.6B model reciting from memory is unlikely,
        // so a correct answer is evidence it read the response.
        ask: 'Look up the Wikipedia article "Clifton Suspension Bridge" and tell me which engineer designed it.',
        expectTool: true,
        expect: { host, pathIncludes: 'clifton' },
        answer: /brunel/i,
      },
      {
        // A control, not a product scenario: nobody types a REST URL. It
        // isolates one question — given the right endpoint, can the model read
        // the answer out of the JSON? — from the question of whether it can
        // find the endpoint at all. Supplying endpoints is only worth building
        // if the answer here is yes.
        id: 'wiki-given-api-url',
        ask: 'Use the curl tool to GET https://en.wikipedia.org/api/rest_v1/page/summary/Telephone and then tell me who is credited with inventing the telephone.',
        expectTool: true,
        expect: { host, pathIncludes: 'summary/telephone' },
        answer: /bell/i,
      },
      {
        id: 'wiki-no-tool',
        ask: 'Without using any tool, tell me: what is the chemical symbol for gold?',
        expectTool: false,
        answer: /\bau\b/i,
      },
    ],
    holdout: [
      {
        id: 'wiki-bristol',
        ask: 'Look up the Wikipedia article "Bristol" and tell me which river the city stands on.',
        expectTool: true,
        expect: { host, pathIncludes: 'bristol' },
        answer: /avon/i,
      },
      {
        id: 'wiki-marie-curie',
        ask: 'Look up the Wikipedia article "Marie Curie" and tell me which two chemical elements she discovered.',
        expectTool: true,
        expect: { host, pathIncludes: 'curie' },
        answer: /polonium/i,
      },
    ],
  };
}

/**
 * @param {string} name `local`, `wiki` or `all`.
 * @param {string} base
 * @returns {{dev: object[], holdout: object[]}}
 */
export function suite(name, base) {
  const local = localTasks(base);
  const wiki = wikiTasks();
  if (name === 'local') return local;
  if (name === 'wiki') return wiki;
  return {
    dev: [...local.dev, ...wiki.dev],
    holdout: [...local.holdout, ...wiki.holdout],
  };
}
