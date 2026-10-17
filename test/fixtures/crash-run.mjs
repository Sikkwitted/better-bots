import fs from 'node:fs';
import path from 'node:path';
import { makeHost, call } from '../helpers.js';

const [dir, boundary] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const { host } = makeHost({ dir, script: () => [call('CrashEffect', {})] });
host.registry.create({ id: 'agt_a', profile: { name: 'Ada' } });
host.registry.create({ id: 'agt_b', profile: { name: 'Bo' } });
host.tools.register({
  name: 'CrashEffect', description: 'Test external receipt', input_schema: { type: 'object', properties: {} },
  side_effect: 'Append test receipt', permission: { action: 'sandbox.run_command' },
  handler: () => {
    fs.appendFileSync(path.join(dir, 'effect.txt'), 'effect\n');
    if (boundary === 'effect') crash();
    return { ok: true };
  },
});
const save = host.scheduler.save.bind(host.scheduler);
host.scheduler.save = (run) => {
  save(run);
  if (boundary === 'completed' && run.status === 'completed') crash();
};
const checkpoint = host.scheduler.checkpoint.bind(host.scheduler);
host.scheduler.checkpoint = (run, phase, detail) => {
  checkpoint(run, phase, detail);
  if (boundary === phase) crash();
};
const append = host.transcripts.append.bind(host.transcripts);
host.transcripts.append = (...args) => {
  if (boundary === 'before_transcript' && args[2].kind === 'peer_message_in') crash();
  const entry = append(...args);
  if (boundary === 'transcript' && entry.kind === 'peer_message_in') crash();
  return entry;
};
const deliver = host.messages.drainInbox.bind(host.messages);
host.messages.drainInbox = (...args) => {
  const result = deliver(...args);
  if (boundary === 'delivery_committed') crash();
  return result;
};
const runAgent = host.runAgent.bind(host);
host.runAgent = async (...args) => {
  if (boundary === 'claimed') crash();
  return runAgent(...args);
};
host.deliverPeerMessage({ sender_id: 'agt_a', target_id: 'agt_b', text: 'preserve this work', message_id: 'msg_crash' });
await host.drain();
throw new Error('crash boundary was not reached');
