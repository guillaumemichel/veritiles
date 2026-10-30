# @anymirror/router

The router contract for [anymirror](https://github.com/anymirror-dev/anymirror)
readers, and for veritiles, built on them. A router says where a CID's bytes
may live: an index, a gateway, a lookup table. This package holds the types
alone, no code, so a router that depends on it costs a page nothing beyond
its own code.

```sh
npm install @anymirror/router
```

## The contract

```ts
interface Router {
  locate(cid: string, context: { defaults: AsyncIterable<string> }):
    AsyncIterable<string> | Iterable<string> | Promise<Iterable<string>>;
  fetch?(url: string, init: RequestInit, context: FetchContext): Promise<Response>;
}

type RouterOption = Router | Router["locate"]; // a function alone is `{ locate }`
```

`locate` yields URLs of a CID's bytes, best first; the reader takes the next
one only when the ones it holds have failed. `defaults` yields the locations
the page itself names: configured, then, with hints on, hinted and probed. The
order is the router's strategy: the page's own locations first, its own
first, or whichever answer first.

A router that also has `fetch` carries every request to a location. Its
`FetchContext` names the `cid` and the `location`, gives the reader's own
fetch as `next`, and holds a `verdict` promise that settles once the reader
has judged the response: `verified`, `rejected` (bad bytes), `failed` (the
request failed, or the host answered with an error) or `unused` (dropped
unread).

A router is outside the root of trust: every byte fetched from a location it
yields verifies against the anchor, so a wrong URL costs a request, never a
wrong byte.

## A router

```ts
import type { Router } from "@anymirror/router";

// The page's own locations first; an index only if they fail.
export const router: Router = {
  async *locate(cid, { defaults }) {
    yield* defaults;
    const res = await fetch(`https://index.example/locations/${cid}`);
    if (res.ok) yield* (await res.json()) as string[];
  },
};
```

Pass it to any reader as its `router` option.
[`@anymirror/fisl-router`](https://github.com/anymirror-dev/anymirror/tree/main/packages/fisl-router) is a router for an index that speaks
[FISL](https://dasl.ing/fisl.html).

## Versions

This package changes only when the contract does, so a router written for it
keeps working across anymirror releases. The contract is
[SPEC.md §6](https://github.com/anymirror-dev/anymirror/blob/main/SPEC.md#6-routers).

## License

[MIT](LICENSE)
