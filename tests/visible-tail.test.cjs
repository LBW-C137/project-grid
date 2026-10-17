const { test } = require('node:test');
const assert = require('node:assert/strict');
const { blocks, blockId, conversationTurns, visibleTail, prependScrollTop, VISIBLE_TAIL_PAGE } = require('../src/features/reading/useVisibleTail.ts');
const en = require('../electron/locales/en.json');
const { applyConversationPacket } = require('../src/features/reading/conversation-buffer.ts');
const message = id => ({ id: String(id), role: 'assistant', text: 'message', at: 0 });
const messages = count => Array.from({ length: count }, (_, index) => message(index));

test('an empty or short history keeps all blocks without an earlier button', () => {
  for (const count of [0, 1, 39, 40]) {
    const grouped = blocks(messages(count)), tail = visibleTail(grouped);
    assert.deepEqual(tail, { visible: grouped, earlier: 0 });
  }
});

test('opening a capped history renders exactly the last 40 blocks', () => {
  const tail = visibleTail(blocks(messages(400)));
  assert.equal(tail.visible.length, VISIBLE_TAIL_PAGE);
  assert.equal(tail.earlier, 360);
  assert.equal(blockId(tail.visible[0]), '360');
  assert.equal(blockId(tail.visible.at(-1)), '399');
});

test('each earlier page adds 40 blocks and the final page clamps to the start', () => {
  const grouped = blocks(messages(95));
  assert.deepEqual([40, 80, 120].map(count => visibleTail(grouped, count).earlier), [55, 15, 0]);
  assert.deepEqual([40, 80, 120].map(count => visibleTail(grouped, count).visible.length), [40, 80, 95]);
});

test('consecutive tools remain whole and count as one block', () => {
  const entries = [...messages(42), ...Array.from({ length: 80 }, (_, index) => ({ id: 'tool' + index, role: 'tool', at: 0 })), message('last')];
  const grouped = blocks(entries), tail = visibleTail(grouped);
  assert.equal(grouped.length, 44);
  assert.equal(tail.earlier, 4);
  assert.equal(tail.visible.at(-2).entries.length, 80);
  assert.equal(blockId(tail.visible.at(-2)), 'tool0');
  assert.deepEqual(entries.length, 123, 'grouping does not mutate the source');
});

test('messages separate tool groups and keep stable entry keys', () => {
  const entries = [{ id: 't1', role: 'tool' }, message('a'), { id: 't2', role: 'tool' }];
  assert.deepEqual(blocks(entries).map(blockId), ['t1', 'a', 't2']);
});

const user = id => ({ id, role: 'user', text: 'prompt', at: 1000 });
const tool = id => ({ id, role: 'tool', at: 2000 });
const turnIds = turns => turns.map(turn => turn.kind === 'user' ? turn.entry.id : turn.blocks.flatMap(block => block.kind === 'tools' ? block.entries.map(entry => entry.id) : [block.entry.id]));

test('leading tools, multiple replies and interleaved tool groups share one agent parent in source order', () => {
  const entries = [tool('t1'), tool('t2'), message('a1'), message('a2'), tool('t3'), message('a3')];
  const original = structuredClone(entries), turns = conversationTurns(blocks(entries));
  assert.deepEqual(turnIds(turns), [['t1', 't2', 'a1', 'a2', 't3', 'a3']]);
  assert.equal(turns[0].id, 't1'); assert.equal(turns[0].at, 2000);
  assert.deepEqual(turns[0].blocks.map(block => block.kind), ['tools', 'message', 'message', 'tools', 'message']);
  assert.deepEqual(entries, original);
});

test('user messages always break agent turns, including consecutive users and tools-only turns', () => {
  const turns = conversationTurns(blocks([user('u1'), tool('t1'), tool('t2'), user('u2'), user('u3'), message('a'), tool('t3'), user('u4')]));
  assert.deepEqual(turnIds(turns), ['u1', ['t1', 't2'], 'u2', 'u3', ['a', 't3'], 'u4']);
  assert.deepEqual(conversationTurns([]), []);
  assert.deepEqual(turnIds(conversationTurns(blocks([tool('only')]))), [['only']]);
});

test('a tail sliced inside an agent turn retains its parent identity and time without rendering hidden blocks', () => {
  const grouped = blocks([tool('leading'), ...messages(100)]), tail = visibleTail(grouped);
  const turns = conversationTurns(grouped, tail.earlier), earlier = conversationTurns(grouped, visibleTail(grouped, 80).earlier);
  assert.equal(tail.earlier, 61);
  assert.equal(turns.length, 1); assert.equal(turns[0].blocks.length, 40);
  assert.equal(turns[0].id, 'leading'); assert.equal(turns[0].at, 2000);
  assert.equal(blockId(turns[0].blocks[0]), '60');
  assert.equal(earlier[0].id, turns[0].id); assert.equal(earlier[0].at, turns[0].at);
  assert.equal(earlier[0].blocks.length, 80);
  assert.equal(earlier[0].blocks.at(-1), turns[0].blocks.at(-1), 'tool/message blocks keep their identity on prepend');
});

test('anchored grouped tails retain visible content as the current turn grows and keep later users separate', () => {
  const grouped = blocks([user('u1'), ...messages(100), tool('last'), user('u2'), tool('next')]);
  const tail = visibleTail(grouped, 40, block => blockId(block) === '60');
  const turns = conversationTurns(grouped, tail.earlier);
  assert.equal(blockId(turns[0].blocks[0]), '60'); assert.equal(turns[0].id, '0');
  assert.deepEqual(turnIds(turns).slice(1), ['u2', ['next']]);
  assert.equal(turns[0].blocks.at(-1).id, 'last');
});

test('a scrolled-up reader retains the first visible block as new entries arrive', () => {
  const grouped = blocks(messages(102));
  const tail = visibleTail(grouped, 40, block => blockId(block) === '60');
  assert.equal(tail.visible.length, 42);
  assert.equal(blockId(tail.visible[0]), '60');
  assert.equal(blockId(visibleTail(grouped).visible[0]), '62', 'a stuck reader follows the rolling tail');
});

test('an anchor survives removal of earlier entries from the capped log', () => {
  const grouped = blocks(messages(400).slice(2).concat(message(400), message(401)));
  assert.equal(blockId(visibleTail(grouped, 40, block => blockId(block) === '360').visible[0]), '360');
  assert.equal(visibleTail(grouped, 40, block => blockId(block) === 'removed').earlier, 360);
});

test('prepending compensates the scroll position by the actual added height', () => {
  assert.equal(prependScrollTop(320, 1200, 2400), 1520);
  assert.equal(prependScrollTop(0, 1200, 1180), -20, 'removing the final earlier button is included in measured layout');
});

test('the earlier button has an English translation with the same count placeholder', () => {
  assert.equal(en['显示更早的对话（{count}）'], 'Show earlier conversation ({count})');
});

const tailTurns = entries => { const grouped = blocks(entries); return conversationTurns(grouped, visibleTail(grouped).earlier); };

test('rolling eviction and refreshed snapshots retain the visible turn parent and time beyond 400 records', () => {
  for (const packet of ['changes', 'list']) {
    const source = [user('u'), ...Array.from({ length: 399 }, (_, index) => ({ ...message(index), at: 2000 + index })), tool('visible')];
    let entries = applyConversationPacket([], { list: source });
    const before = tailTurns(entries)[0];
    for (let index = 399; index < 420; index++) {
      const next = { ...message(index), at: 2000 + index };
      entries = applyConversationPacket(entries, packet === 'list' ? { list: [...entries, next].slice(-400).map(entry => ({ ...entry })) } : { changes: [next] });
      const turn = tailTurns(entries)[0];
      assert.equal(entries.length, 400); assert.equal(turn.id, before.id); assert.equal(turn.at, before.at);
      assert.ok(turn.blocks.some(block => block.id === 'visible'));
      assert.equal(turn.blocks.length, 40, 'hidden blocks stay unrendered');
    }
    const prepended = applyConversationPacket(entries, { list: [tool('earlier-leading-tool'), ...entries.slice(-50).map(entry => ({ ...entry }))] });
    assert.equal(tailTurns(prepended)[0].id, before.id); assert.equal(tailTurns(prepended)[0].at, before.at);
  }
});

test('tools-only groups keep child and parent keys as their first retained tools roll out', () => {
  let entries = applyConversationPacket([], { list: Array.from({ length: 400 }, (_, index) => tool('t' + index)) });
  const before = tailTurns(entries)[0];
  entries = applyConversationPacket(entries, { list: [...entries.slice(20).map(entry => ({ ...entry })), tool('new')] });
  const after = tailTurns(entries)[0];
  assert.equal(after.id, before.id); assert.equal(after.at, before.at);
  assert.equal(after.blocks[0].id, before.blocks[0].id);
  assert.equal(after.blocks[0].entries[0].id, 't20');
});

test('new user boundaries split retained turns, while reset and new-session snapshots get fresh parents', () => {
  let entries = applyConversationPacket([], { list: [user('u1'), tool('t1'), message('a1'), user('u2'), tool('t2'), message('a2')] });
  const before = conversationTurns(blocks(entries)).filter(turn => turn.kind === 'agent');
  entries = applyConversationPacket(entries, { list: [tool('t1'), message('a1'), user('u2'), tool('t2'), message('a2'), user('u3'), tool('t3')] });
  const after = conversationTurns(blocks(entries)).filter(turn => turn.kind === 'agent');
  assert.deepEqual(after.map(turn => turn.id), [before[0].id, before[1].id, 't3']);
  entries = applyConversationPacket(entries, { list: [tool('t1'), user('inserted'), message('a1')] });
  assert.deepEqual(conversationTurns(blocks(entries)).map(turn => turn.kind === 'agent' ? turn.id : turn.entry.id), ['t1', 'inserted', 'a1']);
  assert.equal(tailTurns(applyConversationPacket([], { list: [message('new-session')] }))[0].id, 'new-session');
  assert.deepEqual(applyConversationPacket(entries, { list: [] }), []);
  const oldBoundary = applyConversationPacket([], { list: [user('old-user'), tool('shared-tool')] });
  const newBoundary = applyConversationPacket(oldBoundary, { list: [user('new-user'), tool('shared-tool')] });
  assert.notEqual(tailTurns(oldBoundary)[1].id, tailTurns(newBoundary)[1].id, 'reassigned content cannot reuse a different user boundary');
});
