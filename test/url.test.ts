import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodePath } from '../src/url.ts';

test('encodePath percent-encodes each segment', () => {
  assert.equal(
    encodePath('fonts/Noto Sans Regular/0-255.pbf'),
    'fonts/Noto%20Sans%20Regular/0-255.pbf',
  );
});
