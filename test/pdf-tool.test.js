import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pdfTools} from '../src/tools/pdf-tool.js';
import {tmpDir,makeHost,call} from './helpers.js';

import {fixturePDF} from './fixtures/pdf.js';

test('PDF reader extracts real pages, paginates, and reports empty pages honestly',async()=>{
 const dir=tmpDir('pdf-test');try {
  fs.writeFileSync(path.join(dir,'test.pdf'),fixturePDF());
  const [tool]=pdfTools({workspace:dir});
  const first=await tool.handler({input:{path:'test.pdf',page_count:1}});
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.total_pages,3);
  assert.equal(first.pages[0].text,'First PDF page');assert.equal(first.next_page,2);
  const rest=await tool.handler({input:{path:'test.pdf',start_page:2}});
  assert.equal(rest.pages[0].text,'Second PDF page');assert.equal(rest.next_page,null);
  assert.match((await tool.handler({input:{path:'test.pdf',start_page:3}})).notice,/OCR/);
  assert.equal((await tool.handler({input:{path:'test.pdf',start_page:4}})).error,'page_out_of_range');
  assert.equal((await tool.handler({input:{path:'test.pdf',page_count:11}})).error,'invalid_page_range');
  fs.writeFileSync(path.join(dir,'bad.pdf'),'Not a PDF');
  assert.equal((await tool.handler({input:{path:'bad.pdf'}})).error,'not_a_pdf');
  fs.writeFileSync(path.join(dir,'broken.pdf'),'%PDF-1.4\nbroken');
  assert.equal((await tool.handler({input:{path:'broken.pdf'}})).error,'pdf_read_failed');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('sandbox PDF reader cannot escape to host files; host reads retain local permissions',async()=>{
 const dir=tmpDir('pdf-boundary');const workspace=path.join(dir,'workspace');fs.mkdirSync(workspace);
 try {
  const file=path.join(dir,'host.pdf');fs.writeFileSync(file,fixturePDF());fs.symlinkSync(file,path.join(workspace,'link.pdf'));
  const [sandbox,host]=pdfTools({workspace});
  for(const target of ['../host.pdf','link.pdf',file])assert.equal((await sandbox.handler({input:{path:target}})).error,'outside_workspace');
  assert.equal(host.permission.action,'local.read_file');assert.equal(sandbox.permission.action,'sandbox.read_file');
  assert.equal((await host.handler({input:{path:file}})).ok,true);
  assert.equal((await host.handler({input:{path:'host.pdf'}})).error,'absolute_path_required');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('registered PDF tool works through an actual bot tool call',async()=>{
 const {host,dir}=makeHost({script:()=>[call('SandboxReadPDF',{path:'test.pdf',page_count:1})]});
 try {
  host.registry.create({id:'agt_pdf',profile:{name:'PDF test'}});
  fs.writeFileSync(path.join(host.workspace,'test.pdf'),fixturePDF());
  host.userRequest({agent_id:'agt_pdf',text:'Read the PDF'});await host.drain();
  const receipt=host.transcripts.all('agent','agt_pdf').find(e=>e.kind==='tool_result'&&e.name==='SandboxReadPDF');
  assert.equal(receipt.result.pages[0].text,'First PDF page');
 }finally{await host.close();fs.rmSync(dir,{recursive:true,force:true});}
});
