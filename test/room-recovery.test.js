import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, reopenHost, say } from './helpers.js';

for (const boundary of ['queued', 'claimed', 'execution_started', 'completed', 'reserved', 'published']) {
  test(`room SIGKILL after ${boundary}: preserve bounds and never replay uncertain execution`, async (t) => {
    const dir = tmpDir('room-recovery');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/crash-room.mjs', import.meta.url)), dir, boundary], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const { host, adapter } = reopenHost({ dir, script: () => [say('contribution')] });
    const before = host.scheduler.durableRuns().filter((r) => r.payload.kind === 'room_turn');
    assert.equal(before.length, 1);
    const firstId = before[0].id;
    const report = host.recover();
    assert.deepEqual(report.resumed_rooms, ['room_crash']);
    host.recover();
    await host.drain();
    const posts = host.rooms.history('room_crash').filter((e) => e.sender_id !== 'host');
    const runs = host.scheduler.durableRuns().filter((r) => r.payload.kind === 'room_turn');
    if (boundary === 'execution_started') {
      assert.equal(adapter.calls.length, 0);
      assert.equal(posts.length, 0);
      assert.equal(host.rooms.get('room_crash').discussion.status, 'recovery_required');
      assert.equal(host.scheduler.durableRuns().find((r) => r.id === firstId).status, 'recovery_required');
    } else {
      assert.equal(posts.length, 6);
      assert.equal(new Set(posts.map((p) => p.id)).size, 6);
      assert.equal(runs.length, 6);
      assert.ok(runs.some((r) => r.id === firstId));
      assert.equal(adapter.calls.length, ['queued', 'claimed'].includes(boundary) ? 6 : 5);
      assert.equal(host.rooms.get('room_crash').discussion.total_messages, 6);
      assert.deepEqual(posts.map((p) => [p.round, p.sender_id]), [[0, 'agt_a'], [0, 'agt_b'], [1, 'agt_b'], [1, 'agt_a'], [2, 'agt_a'], [2, 'agt_b']]);
    }
    const { host: again, adapter: next } = reopenHost({ dir });
    again.recover(); await again.drain();
    assert.equal(next.calls.length, 0);
    assert.equal(again.rooms.history('room_crash').filter((e) => e.sender_id !== 'host').length, posts.length);
  });
}
