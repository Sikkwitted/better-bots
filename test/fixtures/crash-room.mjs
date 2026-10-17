import { makeHost, say } from '../helpers.js';
const [dir, boundary] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const { host } = makeHost({ dir, script: () => [say('contribution')] });
for (const id of ['agt_a', 'agt_b']) host.registry.create({ id, profile: { name: id } });
const room = host.rooms.create({ id: 'room_crash', member_ids: ['agt_a', 'agt_b'], purpose: 'recover bounded discussion', memory: 'none' });
const enqueue = host.scheduler.enqueue.bind(host.scheduler);
host.scheduler.enqueue = (input) => {
  const result = enqueue(input);
  if (boundary === 'queued' && input.payload.kind === 'room_turn') crash();
  return result;
};
const runAgent = host.runAgent.bind(host);
host.runAgent = (...args) => {
  if (boundary === 'claimed' && args[0].payload.kind === 'room_turn') crash();
  return runAgent(...args);
};
const checkpoint = host.scheduler.checkpoint.bind(host.scheduler);
host.scheduler.checkpoint = (run, phase, detail) => {
  checkpoint(run, phase, detail);
  if (boundary === 'execution_started' && run.payload.kind === 'room_turn' && phase === boundary) crash();
};
const save = host.scheduler.save.bind(host.scheduler);
host.scheduler.save = (run) => {
  save(run);
  if (boundary === 'completed' && run.payload.kind === 'room_turn' && run.status === 'completed') crash();
};
const write = host.rooms.doc.write.bind(host.rooms.doc);
host.rooms.doc.write = (state) => {
  const result = write(state);
  if (boundary === 'reserved' && Object.keys(state.rooms.room_crash.discussion?.turns ?? {}).length) crash();
  return result;
};
const append = host.transcripts.append.bind(host.transcripts);
host.transcripts.append = (...args) => {
  const result = append(...args);
  if (boundary === 'published' && args[0] === 'room' && result.sender_id === 'agt_a') crash();
  return result;
};
await host.runRoom(room.id, { request: 'discuss' });
throw new Error('crash boundary not reached');
