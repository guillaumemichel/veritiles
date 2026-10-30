# @anymirror/fisl-router

A router over a [FISL](https://dasl.ing/fisl.html) index, for the
[anymirror](https://github.com/anymirror-dev/anymirror) readers and veritiles:
given a CID, it asks the index where the bytes are and yields those URLs to
the reader beside the page's own locations. The index is untrusted: the
reader verifies every byte against the anchor, so a wrong, lying or dead URL
costs a request, never a wrong byte. It depends on the router contract,
[`@anymirror/router`](https://github.com/anymirror-dev/anymirror/tree/main/packages/router),
alone, which holds no code.

## Use

```
npm install @anymirror/fisl-router veritiles
```

```js
import { VerifiedSource } from "veritiles";
import { fisl } from "@anymirror/fisl-router";

const router = fisl({ url: "https://index.example" });
const source = new VerifiedSource({ cid: "bafyrei…", router });
```

Every anymirror reader takes it the same way, as its `router` option:
`new VerifiedFile({ cid, router })` from `@anymirror/core/file`, for one.

The page may hold only the anchor. The reader asks the router for the
anchor, reads the descriptor at the URL it gets
(`…/map.pmtiles.proofs/root`), then asks for the descriptor's `map` CID and
reads ranges of the archive.

| option    | default                            | meaning                                                                                  |
| --------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `url`     | required                           | the index; a lookup is `GET {url}/routing/locations/{cid}/jsonl`                         |
| `fetchFn` | global fetch                       | the fetch for lookups; content requests go through the reader's own `fetchFn`            |
| `select`  | each record's URLs, round by round | `(records, cid) => Iterable<string>`: the URLs to try, best first, from the live records |

`fisl()` returns a `Router`: `locate`, which yields locations, and `fetch`,
which carries the reader's requests to them.

## Where it looks

For each CID the reader asks about, the router races the page's own
locations (the reader's `defaults`: `source`, `proof` and, with hints on,
hints documents) against the lookup, and yields each location as it
arrives. A page that names its own
hosts is served by them at once — they arrive before any lookup can — and the
index's URLs wait behind them in case they fail. A page that holds only the
anchor waits for no hints document before the lookup.

The reader takes the next location only when every one it holds has
failed, and asks the router again once the stream has ended and all have
failed.

## What it reads

The answer is read line by line, as FISL asks of clients. A line that is not a
JSON object with an `addrs` list is skipped, as is a record or addr whose
`expires` has passed or is not a date, and a URL that is not absolute
`http(s)`. Reading stops after 8 MiB of answer. Each record that keeps a URL
becomes `{ urls, fields }`: its live URLs in order, and the record as sent, the
index's own extension fields included.

By default the URLs go out round by round — each record's first, then each
one's second — so one record with many URLs cannot crowd the others out.

A lookup that fails, or takes more than 10 s, yields nothing: the page's own
locations still come. A request the router carries goes out through the
reader's own fetch as it is; one whose answer has not started after 10 s
is given up, so a host that never answers costs 10 s, then sits behind the
others.

## Building on it

`select` sees the CID and every live record with all its fields, and decides
which URLs to try and in which order. It is read lazily: the reader takes
the next URL only when it needs another, so a check made as each URL is taken
sees the latest state. A router that also changes requests wraps `fetch` and
calls this one's, which keeps the deadline:

```js
const base = fisl({ url, select });
const router = {
  locate: base.locate,
  fetch: (url, init, context) =>
    base.fetch(url, withCredentials(url, init), context),
};
```

`interleave(groups)` and `readRecords(response)` are exported for such
routers.

## Develop

It is developed in the
[anymirror repository](https://github.com/anymirror-dev/anymirror), whose
README covers the tests and the build; its own tests are
`test/fisl-*.test.ts` there.

```
src/records.ts   the FISL jsonl answer: records, expiry, bounds
src/fisl.ts      the router: the lookup, the race, select, the deadline
```

## License

[MIT](LICENSE)
