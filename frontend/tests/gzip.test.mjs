import test from 'node:test';
import assert from 'node:assert/strict';
import { exportName, packFile } from '../src/lib/gzip.ts';

test('exportName accepts only the files of the Yazio export and ZIPs', () => {
  assert.equal(exportName('days.json'), 'days.json');
  assert.equal(exportName('Products.JSON'), 'products.json');
  assert.equal(exportName('/some/folder/weight.json'), 'weight.json');
  assert.equal(exportName('C:\\export\\days.json'), 'days.json');
  assert.equal(exportName('yazio-export.zip'), 'export.zip');
  assert.equal(exportName('nutrients.json'), null);
  assert.equal(exportName('days.json.exe'), null);
  assert.equal(exportName('notes.txt'), null);
  assert.equal(exportName(''), null);
});

test('packFile returns a gzip blob that unpacks to the same bytes', async () => {
  const text = JSON.stringify({ a: 'x'.repeat(5000) });
  const packed = await packFile(new Blob([text]));
  assert.ok(packed.size < text.length / 4);
  const back = await new Response(packed.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  assert.equal(back, text);
});
