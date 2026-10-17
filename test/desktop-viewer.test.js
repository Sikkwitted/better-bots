import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';
import { makeHost } from './helpers.js';

test('desktop stream authenticates, bridges VNC, and releases exclusive user control on disconnect', async () => {
  const tcp = net.createServer(socket => { socket.write('RFB 003.008\n'); socket.on('data', data => socket.write(data)); });
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const {host} = makeHost();
  host.registry.create({id:'agt_screen', profile:{name:'Screen'}});
  host.computer.backend = { shutdown:async()=>{}, vncUrl:()=>`vnc://127.0.0.1:${tcp.address().port}`, ensureMonitor:async()=>({real:true,vnc_url:`vnc://127.0.0.1:${tcp.address().port}`}), perform:async()=>({ok:true}) };
  const assignment = host.computer.assignWindow('agt_screen').assignment;
  const server = createServer({host, live:false, token:'test-token'});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  const connect=(query, auth=true, site=origin)=>new WebSocket(`${origin.replace('http:','ws:')}/api/desktop/stream?${query}`, {origin:site, headers:auth?{Authorization:'Bearer test-token'}:{}});
  const rejected=async(ws)=>{const [error]=await once(ws,'error'); assert.match(error.message,/403|404|409/);};
  try {
    await rejected(connect('agent_id=agt_screen',false));
    await rejected(connect('agent_id=agt_screen',true,'https://evil.example'));
    await rejected(connect('agent_id=missing'));
    const ws=connect('agent_id=agt_screen&control=1');
    const first=once(ws,'message'); await once(ws,'open');
    assert.equal(String((await first)[0]),'RFB 003.008\n');
    assert.ok(host.computer.userControllers.has('agt_screen'));
    assert.equal(host.computer.viewers.get('agt_screen'),1);
    await assert.rejects(host.computer.performWindowAction('agt_screen',{...assignment,action:'click'}), /user is controlling/);
    assert.equal((await host.computer.performWindowAction('agt_screen',{...assignment,action:'screenshot'})).ok,true);
    await rejected(connect('agent_id=agt_screen&control=1'));
    const echo=once(ws,'message'); ws.send('input'); assert.equal(String((await echo)[0]),'input');
    ws.close(); await once(ws,'close'); await new Promise(r=>setTimeout(r,20));
    assert.equal(host.computer.userControllers.size,0);
    assert.equal(host.computer.viewers.has('agt_screen'),false);
    assert.equal((await host.computer.performWindowAction('agt_screen',{...assignment,action:'click'})).ok,true);
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); await new Promise(r=>tcp.close(r)); await host.close(); }
});
