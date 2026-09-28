import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyCache } from '../main/replyCache.js';

test('stores per voice and text', () => {
  const c = new ReplyCache(10);
  c.set('af_heart', 'Opening Teams.', 1);
  assert.equal(c.get('af_heart', 'Opening Teams.'), 1);
  assert.equal(c.get('bm_george', 'Opening Teams.'), undefined);
  assert.equal(c.get('af_heart', ' Opening Teams. '), 1);
});

test('evicts the least recently used entry', () => {
  const c = new ReplyCache(2);
  c.set('v', 'a', 1); c.set('v', 'b', 2);
  c.get('v', 'a');
  c.set('v', 'c', 3);
  assert.equal(c.get('v', 'b'), undefined);
  assert.equal(c.get('v', 'a'), 1);
  assert.equal(c.get('v', 'c'), 3);
});
