import fs from 'node:fs';
import path from 'node:path';
import { Host } from '../../src/host.js';
import { ScriptedAdapter } from '../../src/model/scripted-adapter.js';
import { fixedClock } from '../../src/core/clock.js';
import { say } from '../helpers.js';
const [dir, phase] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const engine = { name: 'fake', ensureBank: async () => true, recall: async () => [], retain: async () => {
  fs.writeFileSync(path.join(dir, 'remote-receipt'), 'accepted');
  if (phase === 'accepted') crash();
  return { success: true };
} };
const host = new Host({ dir, adapter: new ScriptedAdapter(() => [say('The delivery is Friday.')]), clock: fixedClock(), memory_engine: engine });
host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
if (phase === 'run_intent') {
  const save = host.scheduler.save.bind(host.scheduler);
  host.scheduler.save = (run) => { save(run); if (run.memory_intents) crash(); };
  host.userRequest({ agent_id: 'agt_a', text: 'When is delivery?' }); await host.drain();
} else if (phase === 'room_intent') {
  host.registry.create({ id: 'agt_b', profile: { name: 'B' } });
  const room = host.createRoom({ member_ids: ['agt_a', 'agt_b'], purpose: 'delivery', memory: 'project' });
  const write = host.rooms.doc.write.bind(host.rooms.doc);
  host.rooms.doc.write = (state) => { const result = write(state); if (state.rooms[room.id].discussion?.memory_intents) crash(); return result; };
  await host.runRoom(room.id, { request: 'Decide delivery date' });
} else {
  const write = host.memory.retention.doc.write.bind(host.memory.retention.doc);
  host.memory.retention.doc.write = (state) => { const result = write(state); if (phase === 'prepared' && Object.values(state.jobs).some((j) => j.status === 'prepared')) crash(); return result; };
  const save = host.memory.retention.save.bind(host.memory.retention);
  host.memory.retention.save = (job) => {
    if (phase === 'local_append' && job.status === 'pending') crash();
    save(job);
    if (phase === job.phase || phase === job.status) crash();
  };
  host.memory.remember({ scope: 'agent', owner_id: 'agt_a', writer_agent_id: 'agt_a', text: 'delivery Friday' });
  await host.memory.flush();
}
throw new Error('crash boundary not reached');
