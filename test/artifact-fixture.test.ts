import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CID } from 'multiformats/cid';
import { buildArtifact } from './helpers/artifact.ts';
import { buildRaw, buildRawEmpty, buildTree, TREE_ENTRIES } from './helpers/fixtures.ts';

test('asset fixture builders produce raw files and dag-cbor manifests', async () => {
  const raw = await buildRaw(); const empty = await buildRawEmpty(); const bundle = await buildTree();
  assert.equal(CID.parse(raw.anchor).code, 0x55); assert.equal(empty.proof, undefined);
  assert.equal(CID.parse(bundle.anchor).code, 0x71); assert.ok(bundle.proof);
});

test('bundle fixture generation is deterministic', async () => {
  const a = await buildArtifact(TREE_ENTRIES); const b = await buildArtifact(TREE_ENTRIES);
  assert.equal(a.anchor, b.anchor); assert.deepEqual(a.proof, b.proof);
});
