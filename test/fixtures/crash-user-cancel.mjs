import fs from 'node:fs';
import path from 'node:path';
import { makeHost, call } from '../helpers.js';
const [dir, phase] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const { host, adapter } = makeHost({ dir });
host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
const run = host.userRequest({ agent_id: 'agt_a', text: 'work' });
if (phase === 'tombstone') {
  const update = host.scheduler.queues.update.bind(host.scheduler.queues);
  host.scheduler.queues.update = (fn) => { const result = update(fn); if (host.scheduler.isRunCancelled(run)) crash(); return result; };
  host.scheduler.cancelRun(run.id);
} else if (phase === 'signalled') {
  adapter.script = async function* ({ settings }) {
    settings.signal.addEventListener('abort', crash, { once: true }); host.scheduler.cancelRun(run.id);
  };
  await host.drain();
} else {
  adapter.script = () => [call('Effect', {})];
  host.tools.register({ name: 'Effect', description: 'test effect', side_effect: 'test effect', permission: null, input_schema: { type: 'object' }, handler: () => {
    fs.writeFileSync(path.join(dir, 'effect'), 'committed'); host.scheduler.cancelRun(run.id); crash();
  } });
  await host.drain();
}
throw new Error('crash not reached');
