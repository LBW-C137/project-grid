const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConversationLog, codexConversation, questionReply } = require('../electron/conversation.cjs');
const { roundsOf } = require('../electron/features/agents/project-memory.cjs');

// What Codex writes when the user answers its request_user_input questions (as in a real rollout).
const reply = '<send_user_message_question_reply>\n' + JSON.stringify([
  { answer: '允许替换分析节点，明确标注算法差异', question: '优化后的工作流目前使用哪个分析节点？', questionItemId: '["request_user_input_async","call_x",0]' },
  { answer: '先写 reports 目录', question: '结果写到哪里？', questionItemId: '["request_user_input_async","call_x",1]' },
]) + '\n</send_user_message_question_reply>';

test('an answer to a Codex question reads as question and answer, never as JSON', () => {
  assert.equal(questionReply(reply), '优化后的工作流目前使用哪个分析节点？\n→ 允许替换分析节点，明确标注算法差异\n\n结果写到哪里？\n→ 先写 reports 目录');
  assert.equal(questionReply('普通的消息'), null);
  assert.equal(questionReply('<send_user_message_question_reply>not json</send_user_message_question_reply>'), '');
});

test('the conversation marks it as an answer, so it is neither a prompt nor an ask in the memory', () => {
  const log = new ConversationLog();
  const at = new Date().toISOString();
  const message = (type, id, text) => ({ type: 'event_msg', timestamp: at, payload: { type: 'item_completed', item: { type, id, content: [{ type: 'text', text }] } } });
  for (const record of [message('UserMessage', 'u1', 'reports 目录里新建一个算法目录，写上测试结果'), message('AgentMessage', 'a1', '先问两个问题。'), message('UserMessage', 'u2', reply), message('AgentMessage', 'a2', '好的，已经写好。')])
    codexConversation(log, record, 'C:/work');
  const answer = log.list.find(entry => entry.id === 'u:u2');
  assert.equal(answer.answer, true);
  assert.ok(!answer.text.includes('{') && answer.text.includes('→ 允许替换分析节点'));
  // The memory keeps one round: the ask, with the reply that came after the answer.
  const rounds = roundsOf(log.list, 'codex', 's1');
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].ask, 'reports 目录里新建一个算法目录，写上测试结果');
  assert.equal(rounds[0].reply, '好的，已经写好。');
  // Older Codex reports it as an event message: the same.
  const old = new ConversationLog();
  codexConversation(old, { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: reply } }, 'C:/work');
  assert.equal(old.list[0].answer, true);
});
