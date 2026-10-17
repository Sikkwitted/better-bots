import fs from 'node:fs';
import path from 'node:path';
import { makeHost, call } from '../helpers.js';
const [dir, phase] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const { host, adapter } = makeHost({ dir });
host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
const item = host.scheduleAutomation({ agent_id: 'agt_a', text: 'work' });
host.tickAutomations();
if (phase === 'tombstone') {
  const update = host.scheduler.queues.update.bind(host.scheduler.queues);
  host.scheduler.queues.update = (fn) => { const result = update(fn); if (host.scheduler.isAutomationCancelled(item.id)) crash(); return result; };
  host.cancelAutomation(item.id);
} else if (phase === 'signalled') {
  adapter.script = async function* ({ settings }) {
    settings.signal.addEventListener('abort', crash, { once: true });
    host.cancelAutomation(item.id);
  };
  await host.drain();
} else {
  adapter.script = () => [call('Effect', {})];
  host.tools.register({ name: 'Effect', description: 'test', side_effect: 'test effect', permission: null, input_schema: { type: 'object' }, handler: () => {
    fs.writeFileSync(path.join(dir, 'effect'), 'committed'); host.cancelAutomation(item.id); crash();
  } });
  await host.drain();
}
throw new Error('crash not reached');
