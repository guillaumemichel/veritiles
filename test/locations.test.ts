// Locations (SPEC §4, §6): one CID's endpoints as its router yields them,
// read lazily and kept. A custom router's values are checked like hints
// entries; the built-in router's pass as they are. A router that fails only
// ends its stream, and once every location has failed, the next pull asks
// the router again.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type DefaultLocations, Locator } from '../packages/anymirror/src/locations.ts';
import type { Router } from '../packages/router/src/index.ts';

const CID = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e';
const turn = () => new Promise((resolve) => setImmediate(resolve));

// A built-in router naming `configured` at once and `rest` on demand,
// counting its opens.
function defaults(configured: string[] = [], rest: string[] = [], consulted: string[] = []) {
  const opens: string[] = [];
  const router: DefaultLocations = {
    open: (cid) => {
      opens.push(cid);
      return { configured, rest: (async function* () { yield* rest; })() };
    },
    consulted: () => consulted,
  };
  return { router, opens };
}

// Pull until the stream ends; the locations held then.
async function drain(locations: { pull(): Promise<void>; ended(): boolean; held(): readonly string[] }) {
  while (!locations.ended()) await locations.pull();
  return [...locations.held()];
}

test('LO-01: a router\'s values are checked like hints entries: http(s), capped, trailing slash cut, first wins', async () => {
  const long = `https://h.example/${'a'.repeat(5000)}`;
  const router: Router = {
    locate: () => ['https://a.example/x', 42, null, './relative', 'ftp://b.example/x', 'not a url', long, 'https://a.example/x', 'https://c.example/dir/', 'http://127.0.0.1:8080/x'] as string[],
  };
  const locations = new Locator(router, defaults().router).for(CID, { kind: 'content' });
  assert.deepEqual(await drain(locations), ['https://a.example/x', 'https://c.example/dir', 'http://127.0.0.1:8080/x']);
});

test('LO-02: an anchor that roots a proof tree takes only `{proof}/root` without a query string', async () => {
  const router: Router = { locate: () => ['https://h/x.proofs', 'https://h/x.proofs/root?sig=1', 'https://h/x.proofs/notroot', 'https://h/x.proofs/root'] };
  const locations = new Locator(router, defaults().router).for(CID, { kind: 'proof', accept: (url) => url.endsWith('/root') && !url.includes('?') });
  assert.deepEqual(await drain(locations), ['https://h/x.proofs/root']);
});

test('LO-03: what the built-in router names passes as it is, alone or through a custom router', async () => {
  const page = defaults(['./assets/fonts', 'mem://fonts'], ['./hinted']);
  const alone = new Locator(undefined, page.router).for(CID, { kind: 'content' });
  assert.deepEqual(alone.held(), ['./assets/fonts', 'mem://fonts'], 'configured locations are there at once');
  assert.deepEqual(await drain(alone), ['./assets/fonts', 'mem://fonts', './hinted']);

  const router: Router = {
    async *locate(_cid, { defaults }) {
      yield './forged';
      yield* defaults;
    },
  };
  const through = new Locator(router, defaults(['./assets/fonts', 'mem://fonts'], ['./hinted']).router).for(CID, { kind: 'content' });
  assert.deepEqual(through.held(), [], 'a custom router is asked on the first pull');
  assert.deepEqual(await drain(through), ['./assets/fonts', 'mem://fonts', './hinted'], 'its own relative value is not a location');
});

test('LO-04: pulled lazily, one location at a time; concurrent pulls share one read', async () => {
  const asked: string[] = [];
  let yielded = 0;
  const router: Router = {
    async *locate(cid) {
      asked.push(cid);
      for (const url of ['https://a.example/x', 'https://b.example/x', 'https://c.example/x']) {
        yielded++;
        yield url;
      }
    },
  };
  const locator = new Locator(router, defaults().router);
  const locations = locator.for(CID, { kind: 'content' });
  assert.equal(locator.for(CID, { kind: 'content' }), locations, 'one per CID');
  assert.deepEqual(asked, [], 'nothing asked before a pull');
  await Promise.all([locations.pull(), locations.pull()]);
  assert.deepEqual(locations.held(), ['https://a.example/x']);
  assert.equal(yielded, 1, 'two callers, one value read');
  await locations.pull();
  assert.deepEqual(locations.held(), ['https://a.example/x', 'https://b.example/x']);
  assert.deepEqual(asked, [CID]);
});

test('LO-05: an aborted caller stops waiting; the read goes on for the others', async () => {
  let answer!: (url: string) => void;
  const router: Router = {
    async *locate() {
      yield await new Promise<string>((resolve) => (answer = resolve));
    },
  };
  const locations = new Locator(router, defaults().router).for(CID, { kind: 'content' });
  const controller = new AbortController();
  const aborted = locations.pull(controller.signal);
  const waiting = locations.pull();
  await turn();
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  answer('https://a.example/x');
  await waiting;
  assert.deepEqual(locations.held(), ['https://a.example/x']);
});

test('LO-06: a failing router ends its stream with what it yielded; a promise of a list is read too', async () => {
  const cases: [Router['locate'], string[]][] = [
    [() => { throw new Error('down'); }, []],
    [async () => { throw new Error('down'); }, []],
    [async function* () { yield 'https://a.example/x'; throw new Error('down'); }, ['https://a.example/x']],
    [() => ({ urls: ['https://a.example/x'] }) as unknown as string[], []],
    [() => 'https://a.example/x' as unknown as string[], []],
    [async () => ['https://a.example/x', 'https://b.example/x'], ['https://a.example/x', 'https://b.example/x']],
  ];
  for (const [locate, held] of cases) {
    const locations = new Locator({ locate }, defaults().router).for(CID, { kind: 'content' });
    assert.deepEqual(await drain(locations), held);
  }
});

test('LO-07: at most 64 values are read per ask, skipped ones included; then the stream is closed', async () => {
  let read = 0;
  let closed = false;
  const router: Router = {
    async *locate() {
      try {
        for (let i = 0; ; i++) {
          read++;
          yield i % 2 ? `https://h${i}.example/x` : 'not a url';
        }
      } finally {
        closed = true;
      }
    },
  };
  const locations = new Locator(router, defaults().router).for(CID, { kind: 'content' });
  assert.equal((await drain(locations)).length, 32);
  assert.equal(read, 64);
  assert.equal(closed, true);
});

test('LO-08: once every location failed after the stream ended, the next pull asks again', async () => {
  const asked: number[] = [];
  const router: Router = {
    locate: () => {
      asked.push(asked.length);
      return asked.length === 1 ? ['https://a.example/x'] : ['https://a.example/x', 'https://b.example/x'];
    },
  };
  const locations = new Locator(router, defaults().router).for(CID, { kind: 'content' });
  await drain(locations);
  locations.exhausted();
  assert.equal(locations.ended(), false, 'a pull would ask again');
  assert.deepEqual(await drain(locations), ['https://a.example/x', 'https://b.example/x'], 'kept, and the new one added');
  assert.equal(asked.length, 2);

  const open = new Locator({ locate: async function* () { yield 'https://a.example/x'; yield 'https://b.example/x'; } }, defaults().router).for(CID, { kind: 'content' });
  await open.pull();
  open.exhausted();
  assert.equal(open.ended(), false);
  await open.pull();
  assert.deepEqual(open.held(), ['https://a.example/x', 'https://b.example/x'], 'a stream still open is read on, not asked again');
});

test('LO-09: the built-in router reopens on a second ask; a custom one reads its defaults only if it wants them', async () => {
  const page = defaults(['https://own.example/x']);
  const alone = new Locator(undefined, page.router).for(CID, { kind: 'content' });
  await drain(alone);
  alone.exhausted();
  await drain(alone);
  assert.deepEqual(page.opens, [CID, CID]);

  const ignoring = defaults(['https://own.example/x']);
  const custom = new Locator({ locate: () => ['https://a.example/x'] }, ignoring.router).for(CID, { kind: 'content' });
  assert.deepEqual(await drain(custom), ['https://a.example/x']);
  assert.deepEqual(ignoring.opens, [], 'defaults unread: the built-in router never opened');
});

test('LO-10: the error for an unlocated CID names its class, the documents consulted and the router', async () => {
  const page = defaults([], [], ['https://page.example/hints.json']);
  assert.equal(new Locator(undefined, page.router).for(CID, { kind: 'proof', label: 'anchor-as-given' }).unlocated().message,
    'no proof location for anchor-as-given; consulted https://page.example/hints.json');
  assert.equal(new Locator({ locate: () => [] }, defaults().router).for(CID, { kind: 'content' }).unlocated().message,
    `no content location for ${CID}; consulted the router`);
  assert.equal(new Locator(undefined, defaults().router).for(CID, { kind: 'content' }).unlocated().message,
    `no content location for ${CID}; consulted no hints documents`);
});
