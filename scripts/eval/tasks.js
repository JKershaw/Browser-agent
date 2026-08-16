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
        // Port 1 refuses the connection, so this fails at the transport layer
        // exactly as a CORS block does — and unlike Wikipedia there is no hint
        // naming a URL that works and no second tool to fall back to. It is the
        // case the loop breaker exists for, and the only one left where a small
        // model can burn its whole budget re-sending the same dead request.
        //
        // Graded on the answer, because the request cannot succeed: the job is
        // to report the failure rather than invent a response.
        id: 'local-unreachable',
        ask: 'Use the curl tool to GET http://127.0.0.1:1/nope and tell me what happened.',
        expectTool: true,
        expect: { host: '127.0.0.1:1' },
        allowRequestFailure: true,
        // What is being graded is that the agent did not claim success, so the
        // pattern has to cover every way it says so. The first version wanted
        // "fail|error|could not|unable|refus" and marked four answers wrong for
        // saying "I cannot use the curl tool" and "not being able to fulfil the
        // request" — the fourth grader in this project to mismark a correct
        // answer, and the fourth to do it by imagining one phrasing.
        answer: /fail|error|could ?n[o']t|cannot|can't|unable|not able|refus|unreachable|not reach|no response|did ?n[o']t work/i,
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
        // The question must be answerable from what the page actually says.
        // This task originally pointed at "Telephone" and asked who invented
        // it — a fact that article's summary does not contain — so twenty
        // correct fetches were scored as twenty wrong answers. `oracleUrl` and
        // scripts/eval/verify-tasks.js exist because of that.
        id: 'wiki-telephone',
        ask: 'Look up the Wikipedia article "Alexander Graham Bell" and tell me what he is credited with patenting.',
        expectTool: true,
        expect: { host, pathIncludes: 'bell' },
        answer: /telephone/i,
        oracleUrl: 'https://en.wikipedia.org/api/rest_v1/page/summary/Alexander_Graham_Bell',
      },
      {
        id: 'wiki-clifton',
        // Obscure enough that a 0.6B model reciting from memory is unlikely,
        // so a correct answer is evidence it read the response. It used to ask
        // which engineer designed the bridge; the source says Barlow and
        // Hawkshaw, "based on an earlier design by Brunel", and the model's
        // faithful answer was marked wrong six times out of six for not saying
        // Brunel. Ask things the source answers once.
        ask: 'Look up the Wikipedia article "Clifton Suspension Bridge" and tell me in which year it opened.',
        expectTool: true,
        expect: { host, pathIncludes: 'clifton' },
        answer: /1864/,
        oracleUrl: 'https://en.wikipedia.org/api/rest_v1/page/summary/Clifton_Suspension_Bridge',
      },
      {
        // A control, not a product scenario: nobody types a REST URL. It
        // isolates one question — given the right endpoint, can the model read
        // the answer out of the JSON? — from the question of whether it can
        // find the endpoint at all. Supplying endpoints is only worth building
        // if the answer here is yes.
        id: 'wiki-given-api-url',
        ask: 'Use the curl tool to GET https://en.wikipedia.org/api/rest_v1/page/summary/Clifton_Suspension_Bridge and then tell me in which year it opened.',
        expectTool: true,
        expect: { host, pathIncludes: 'summary/clifton' },
        answer: /1864/,
        oracleUrl: 'https://en.wikipedia.org/api/rest_v1/page/summary/Clifton_Suspension_Bridge',
      },
      {
        // Reported from the deployed app on a phone: the model fetched
        // `https://wikipedia.org/wiki/Alan_Turing`, was handed the working REST
        // URL by the failure hint, and re-sent the identical broken URL — twice.
        //
        // Deliberately not `en.wikipedia.org`: the whole point is which host it
        // reaches for, so pinning one would hide the finding. Any host counts;
        // `pathIncludes` alone keeps it on-subject.
        //
        // Read the *buckets*, not just the rate. Turing is famous enough that a
        // 0.6B model can produce a passing answer from memory, so `answer` is
        // weak evidence of grounding here — but grading requires a successful
        // on-target request first, so `request_failed` vs `ok` still measures
        // exactly the thing this task exists for: does it recover?
        id: 'wiki-turing-open',
        ask: 'Look up Alan Turing on Wikipedia and tell me about his life.',
        expectTool: true,
        expect: { pathIncludes: 'turing' },
        // Every descriptor the summary actually offers. An earlier version of
        // this regex wanted "computer scientist" and the model wrote "father of
        // theoretical computer science" — the source says both, so the answer
        // was right and the grader was wrong. That is the third grader in this
        // project to mismark a faithful answer, so the rule is now: enumerate
        // what the source supports by reading the source, never by reading the
        // failures.
        answer: /mathematician|computer scien|cryptanalyst|logician|philosopher|biologist|turing machine/i,
        oracleUrl: 'https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing',
      },
      {
        // Same subject, house phrasing — names the article, asks one fact. The
        // only variable against `wiki-turing-open` is how the question is put,
        // which is the cheapest explanation for why the deployed app failed on
        // a subject the suite never covered in the user's own words.
        id: 'wiki-turing-fact',
        ask: 'Look up the Wikipedia article "Alan Turing" and tell me which field he is widely considered the father of.',
        expectTool: true,
        expect: { pathIncludes: 'turing' },
        answer: /computer science/i,
        oracleUrl: 'https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing',
      },
      {
        // Forces the failing first request rather than waiting for the model to
        // choose it, so every sample exercises the recovery path and the rate
        // is a measurement of the hint itself instead of a measurement of how
        // often the model happens to pick a doomed URL. The highest-signal of
        // the three, and the one a fix has to move.
        id: 'wiki-turing-recover',
        ask: 'Use the curl tool to GET https://wikipedia.org/wiki/Alan_Turing and tell me what Alan Turing is described as.',
        expectTool: true,
        expect: { pathIncludes: 'turing' },
        // Same enumeration as wiki-turing-open, and for the same reason: seven
        // of this task's twenty samples were marked wrong for answering "father
        // of theoretical computer science", which is what the article says.
        answer: /mathematician|computer scien|cryptanalyst|logician|philosopher|biologist/i,
        oracleUrl: 'https://en.wikipedia.org/api/rest_v1/page/summary/Alan_Turing',
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
        oracleUrl: 'https://en.wikipedia.org/api/rest_v1/page/summary/Bristol',
      },
      {
        id: 'wiki-marie-curie',
        ask: 'Look up the Wikipedia article "Marie Curie" and tell me which two chemical elements she discovered.',
        expectTool: true,
        expect: { host, pathIncludes: 'curie' },
        answer: /polonium/i,
        oracleUrl: 'https://en.wikipedia.org/api/rest_v1/page/summary/Marie_Curie',
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
