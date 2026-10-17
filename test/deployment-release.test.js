import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { releaseManifest, verifyRelease } from '../deploy/release-manifest.mjs';
import { waitForReadiness } from '../deploy/readiness.mjs';

test('deployment refuses unreviewed source drift, including remote-only files', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bb-release-'));
  try {
    fs.writeFileSync(path.join(root,'server.js'),'old');
    assert.throws(()=>verifyRelease(root),/needs review/);
    const baseline=releaseManifest(root);
    fs.writeFileSync(path.join(root,'.better-bots-release.json'),JSON.stringify(baseline));
    assert.equal(verifyRelease(root),baseline.fingerprint);
    fs.writeFileSync(path.join(root,'remote-only.js'),'keep me');
    assert.throws(()=>verifyRelease(root),/remote-only.js/);
    assert.equal(verifyRelease(root,releaseManifest(root).fingerprint),releaseManifest(root).fingerprint);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

for(const kind of ['healthy','degraded','missing memory','restart loop','malformed'])test(`readiness: ${kind}`,async()=>{
  let time=0, checks=0;
  const options={now:()=>time,sleep:async ms=>{time+=ms;},intervalMs:10,timeoutMs:60,
    health:async()=>kind==='malformed'?null:{status:kind==='degraded'?'degraded':'ok',dependencies:{memory:{required:true,configured:kind!=='missing memory',healthy:true}}},
    service:async()=>({active:'active',pid:kind==='restart loop'?++checks:20,restarts:checks})};
  if(kind==='healthy')await waitForReadiness(options);
  else await assert.rejects(waitForReadiness(options),/readiness failed/);
});

for(const outcome of ['success','install failure','activation failure','switch failure'])test(`staged deployment ${outcome} preserves code and matching dependencies`,()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bb-activate-'));
  const active=path.join(root,'active'),stage=path.join(root,'source'),bin=path.join(root,'bin');
  const write=(file,text,mode)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,{mode:mode??0o644});};
  try {
    write(path.join(active,'src/server.js'),'old code');write(path.join(active,'node_modules/old-dependency'),'old dependency');
    write(path.join(active,'.better-bots-release.json'),JSON.stringify(releaseManifest(active)));
    write(path.join(stage,'src/server.js'),'new code');write(path.join(stage,'package-lock.json'),'new lock');
    fs.cpSync(new URL('../deploy/',import.meta.url),path.join(stage,'deploy'),{recursive:true});
    write(path.join(bin,'id'),'#!/bin/sh\necho 0\n',0o755);
    write(path.join(bin,'flock'),'#!/bin/sh\nexit 0\n',0o755);
    write(path.join(bin,'chown'),'#!/bin/sh\nprintf "chown %s\\n" "$*" >> "$TEST_CALLS"\n',0o755);
    write(path.join(bin,'systemctl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_CALLS"\n',0o755);
    write(path.join(bin,'sudo'),'#!/bin/sh\nshift 2\nexec "$@"\n',0o755);
    write(path.join(bin,'npm'),`#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CALLS"
[ "$TEST_OUTCOME" != 'install failure' ] || exit 1
mkdir -p node_modules/@novnc/novnc/core
printf 'new dependency' > node_modules/@novnc/novnc/core/rfb.js
`,0o755);
    if(outcome==='switch failure')write(path.join(bin,'mv'),'#!/bin/sh\nexit 1\n',0o755);
    fs.chmodSync(stage,0o700);
    write(path.join(bin,'node'),`#!/bin/sh
case "$1" in
  --input-type=module) exit 0 ;;
  */readiness.mjs)
    if [ "$TEST_OUTCOME" = 'activation failure' ] && [ ! -e "$TEST_READY" ]; then touch "$TEST_READY"; exit 1; fi
    exit 0 ;;
esac
exec "$TEST_NODE" "$@"
`,0o755);
    const result=spawnSync('bash',['deploy/activate.sh',stage],{encoding:'utf8',env:{...process.env,
      PATH:`${bin}:${process.env.PATH}`,BETTER_BOTS_APP_DIR:active,TEST_OUTCOME:outcome,TEST_NODE:process.execPath,
      TEST_READY:path.join(root,'readiness'),TEST_CALLS:path.join(root,'calls')}});
    assert.equal(result.status,outcome==='success'?0:1,result.stderr);
    assert.equal(fs.readFileSync(path.join(active,'src/server.js'),'utf8'),outcome==='success'?'new code':'old code');
    if(outcome!=='success')assert.equal(fs.readFileSync(path.join(active,'node_modules/old-dependency'),'utf8'),'old dependency');
    if(outcome==='success') {
      assert.equal(fs.statSync(active).mode & 0o777, 0o755, 'service user can traverse a release copied from private staging');
      assert.equal(fs.readFileSync(path.join(active,'node_modules/@novnc/novnc/core/rfb.js'),'utf8'),'new dependency');
      assert.ok(fs.readdirSync(root).some(name=>name.startsWith('better-bots-previous-')));
    }
    // Root never runs a package's install script, and the release tree is root-owned.
    assert.match(fs.readFileSync(path.join(root,'calls'),'utf8'),/ci --ignore-scripts --no-audit --no-fund/);
    assert.match(fs.readFileSync(path.join(root,'calls'),'utf8'),/chown -R root:root /);
    if(outcome==='switch failure')assert.match(fs.readFileSync(path.join(root,'calls'),'utf8'),/stop better-bots\nstart better-bots/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
