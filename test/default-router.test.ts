// The built-in router (SPEC §5, §6): a CID's locations from the page itself.
// Configured locations come first and at once; then the hints documents' —
// explicit ones always, fetched in the background from the open on, the
// default one only for a CID with nothing configured; then, for a CID still
// without a location, documents probed beside the anchor's locations.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DefaultRouter, type DefaultRouterOptions } from '../packages/core/src/default-router.ts';
import { hints } from '../packages/core/src/hints.ts';
import { withPageUrl } from './helpers/serve-hints.ts';

const ANCHOR = 'bafyreiazjnja3qydqsz7yiz6ci3xra26flodmlmry3rtafpnhwzdphl6ue';
const MAP = 'bafkr4idg5mvm2z7eqewib6ax2qajaztgeyhr2jlabieyof4rqck6ojn2pm';
const SRC = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e';
const DOC = 'https://page.example/hints.json';

// Hints documents served from a table (a missing one is a 404), every
// request logged.
function docs(table: Record<string, Record<string, string[]>>) {
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const hints = table[url];
    return hints === undefined ? new Response('nf', { status: 404 }) : new Response(JSON.stringify({ hints }));
  }) as typeof fetch;
  return { fetchFn, requests };
}

// The built-in router with hints on: `hints` names the documents, as the
// plugin takes them.
type RouterSpec = Partial<Omit<DefaultRouterOptions, 'hints'>> & Pick<DefaultRouterOptions, 'kind'> & { hints?: string | string[] };

function router(options: RouterSpec, table: Record<string, Record<string, string[]>> = {}) {
  const { fetchFn, requests } = docs(table);
  const defaults = new DefaultRouter({ anchor: ANCHOR, sources: [], proof: undefined, fetchFn, ...options, hints: hints(options.hints) });
  return { defaults, requests };
}

async function all(values: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const value of values) out.push(value);
  return out;
}

async function located(defaults: DefaultRouter, cid: string, path?: string): Promise<string[]> {
  const { configured, rest } = defaults.open(cid, path);
  return [...configured, ...(await all(rest))];
}

test('DR-01: a ranged file — its anchor at `{proof}/root`, derived from each source unless configured; its map at the sources', async () => {
  const derived = router({ kind: 'ranged', sources: ['https://a/map', 'https://b/map'] }).defaults;
  assert.deepEqual(derived.open(ANCHOR).configured, ['https://a/map.proofs/root', 'https://b/map.proofs/root']);
  assert.deepEqual(derived.open(MAP).configured, ['https://a/map', 'https://b/map']);
  const explicit = router({ kind: 'ranged', sources: ['https://a/map?v=1'], proof: ['https://p/x.proofs/', 'https://p/x.proofs'] }).defaults;
  assert.deepEqual(explicit.open(ANCHOR).configured, ['https://p/x.proofs/root']);
  assert.deepEqual(await located(explicit, MAP), ['https://a/map?v=1'], 'nothing more: configured, no explicit hints');
  assert.throws(() => router({ kind: 'ranged', sources: ['https://a/map?v=1'] }), /query string; an explicit proof URL is required/);
  assert.deepEqual(router({ kind: 'ranged', sources: ['https://a/map?v=1'], hints: DOC }).defaults.open(ANCHOR).configured, [], 'explicit hints defer it');
  assert.throws(() => router({ kind: 'ranged', proof: [] as string[] }), /proof must be a URL or a non-empty list of URLs/);
});

test('DR-02: a bundle — its anchor at `proof` or `{base}.car`, a file at `{base}/{path}`; a raw file at its sources', () => {
  const bundle = router({ kind: 'bundle', sources: ['https://a/assets', './local'] }).defaults;
  assert.deepEqual(bundle.open(ANCHOR).configured, ['https://a/assets.car', './local.car']);
  assert.deepEqual(bundle.open(SRC, 'fonts/Noto Sans/0-255.pbf').configured, ['https://a/assets/fonts/Noto%20Sans/0-255.pbf', './local/fonts/Noto%20Sans/0-255.pbf']);
  assert.deepEqual(router({ kind: 'bundle', sources: ['https://a/assets'], proof: ['mem://fonts.masl'] }).defaults.open(ANCHOR).configured, ['mem://fonts.masl']);
  assert.deepEqual(router({ kind: 'raw', sources: ['https://a/style.json'] }).defaults.open(ANCHOR).configured, ['https://a/style.json']);
});

test('DR-03: explicit documents load in the background once a CID opens, and follow the configured locations', async () => {
  const table = { [DOC]: { [ANCHOR]: ['https://m/map.proofs', 'https://q/map.proofs?sig=1'], [MAP]: ['https://m/map'] } };
  const { defaults, requests } = router({ kind: 'ranged', sources: ['https://a/map'], hints: DOC }, table);
  const { configured } = defaults.open(ANCHOR);
  assert.deepEqual(requests, [], 'not before the open returns');
  await Promise.resolve();
  assert.deepEqual(requests, [DOC], 'one microtask later');
  assert.deepEqual(configured, ['https://a/map.proofs/root']);
  assert.deepEqual(await located(defaults, ANCHOR), ['https://a/map.proofs/root', 'https://m/map.proofs/root'], 'a hinted base locates `{u}/root`; one with a query string cannot');
  assert.deepEqual(await located(defaults, MAP), ['https://a/map', 'https://m/map']);
  assert.deepEqual(requests, [DOC], 'read once');
  assert.deepEqual(defaults.consulted(), [DOC]);
});

test('DR-04: the default document is consulted only for a CID with nothing configured', async () => {
  await withPageUrl('https://page.example/app.html', async () => {
    const table = { [DOC]: { [MAP]: ['https://m/map'] } };
    const configured = router({ kind: 'ranged', sources: ['https://a/map'] }, table);
    assert.deepEqual(await located(configured.defaults, MAP), ['https://a/map']);
    assert.deepEqual(configured.requests, []);
    const bare = router({ kind: 'ranged', proof: ['https://p/map.proofs'] }, table);
    assert.deepEqual(await located(bare.defaults, MAP), ['https://m/map']);
    assert.deepEqual(bare.requests, [DOC]);
  });
});

test("DR-05: an anchor with no location probes beside each source; a file probes beside the anchor's own locations, chaining", async () => {
  const anchorProbe = router({ kind: 'bundle', sources: ['https://n/pkgs/assets?tok=1'], hints: DOC }, {
    [DOC]: {},
    'https://n/pkgs/hints.json': { [ANCHOR]: ['https://n/pkgs/assets.car'] },
  });
  assert.deepEqual(await located(anchorProbe.defaults, ANCHOR), ['https://n/pkgs/assets.car']);
  assert.deepEqual(anchorProbe.defaults.consulted(), [DOC, 'https://n/pkgs/hints.json']);

  // The configured proof base names a second one, which names the map.
  const chain = router({ kind: 'ranged', proof: ['https://p/map.proofs'] }, {
    'https://p/map.proofs/hints.json': { [ANCHOR]: ['https://p2/map.proofs'] },
    'https://p2/map.proofs/hints.json': { [MAP]: ['https://c/map'] },
  });
  assert.deepEqual(await located(chain.defaults, MAP), ['https://c/map']);
  assert.deepEqual(chain.requests, ['https://p/map.proofs/hints.json', 'https://p2/map.proofs/hints.json']);

  const src = router({ kind: 'bundle', proof: ['https://h/b/bundle.masl'] }, {
    'https://h/b/hints.json': { [SRC]: ['https://h/b/bundle/style.json'] },
  });
  assert.deepEqual(await located(src.defaults, SRC, 'style.json'), ['https://h/b/bundle/style.json']);

  const raw = router({ kind: 'raw' });
  assert.deepEqual(await located(raw.defaults, ANCHOR), []);
  assert.deepEqual(raw.requests, [], 'a raw file has nothing to probe beside');
});

test('DR-06: a missing document is fetched once per open; an anchor without sources probes nothing', async () => {
  await withPageUrl('https://page.example/app.html', async () => {
    const bare = router({ kind: 'ranged' });
    assert.deepEqual(await located(bare.defaults, ANCHOR), []);
    assert.deepEqual(bare.requests, [DOC]);
    const chained = router({ kind: 'ranged', proof: ['https://p/map.proofs'] });
    assert.deepEqual(await located(chained.defaults, MAP), []);
    assert.deepEqual(chained.requests, [DOC, 'https://p/map.proofs/hints.json'], 'the probe loop reads what it fetched');
  });
});
