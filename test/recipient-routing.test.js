import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, call, say } from './helpers.js';

const verify = 'agt_verify';
const coordinator = 'agt_coordinator';

test('a malformed coordinator ID returns an undelivered correction receipt and a corrected retry delivers once', async () => {
  const { host, adapter } = makeHost();
  host.registry.create({ id: verify, profile: { name: 'Verify', desk: 'Research' } });
  host.registry.create({ id: coordinator, profile: { name: 'Orchestrator', desk: 'Research' } });
  host.registry.create({ id: 'agt_other', profile: { name: 'Orchestrator', desk: 'Ops' } });
  let step = 0;
  adapter.script = (ctx) => {
    if (ctx.agent_id !== verify) return [say('received')];
    if (step++ === 0) return [call('SendToAgent', { target_id: `${coordinator}c`, message: 'checked evidence' })];
    if (step === 2) {
      const receipt = host.transcripts.all('agent', verify).find((r) => r.kind === 'tool_result').result;
      assert.equal(receipt.delivered, false);
      assert.equal(receipt.retryable, true);
      assert.equal(host.messages.allEnvelopes().length, 0);
      const target = receipt.recipients.find((r) => r.name === 'Orchestrator' && r.desk === 'Research');
      assert.equal(target.id, coordinator);
      assert.match(JSON.stringify(ctx.messages.at(-1)), /Nothing was sent or queued/);
      return [call('SendToAgent', { target_id: target.id, message: 'checked evidence' })];
    }
    return [say('handoff delivered')];
  };
  host.userRequest({ agent_id: verify, text: 'send the checked evidence' });
  await host.drain();
  const envelopes = host.messages.allEnvelopes();
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].target_id, coordinator);
  assert.equal(envelopes[0].status, 'delivered');
  assert.equal(host.audit.where((r) => r.type === 'message.sent').length, 1);
});

test('recipient choices follow the live registry and retain room support', () => {
  const { host } = makeHost();
  const a = host.registry.create({ id: verify });
  const choices = () => host.tools.describeFor(a).find((t) => t.name === 'SendToAgent').input_schema.properties.target_id.enum;
  assert.deepEqual(choices(), [verify]);
  host.registry.create({ id: coordinator });
  const room = host.rooms.create({ member_ids: [verify, coordinator], purpose: 'review' });
  assert.ok(choices().includes(coordinator));
  assert.ok(choices().includes(room.id));
  host.registry.delete(coordinator, { confirm: true, actor: 'user' });
  assert.ok(!choices().includes(coordinator));
  assert.ok(!choices().includes(`${coordinator}c`));
});
