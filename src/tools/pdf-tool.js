import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {protectedHostPath} from './computer-tools.js';
const exec = promisify(execFile);
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT = 60000;
const within = (root, file) => file === root || file.startsWith(root + path.sep);

export function pdfTools({workspace, dataDir = null}) {
  return ['sandbox', 'host'].map(scope => ({
    name: scope === 'sandbox' ? 'SandboxReadPDF' : 'HostReadPDF',
    description: `Read PDF text with page numbers from ${scope === 'sandbox' ? 'a path in the shared bot workspace' : 'an exact path on the machine hosting Better Bots (the VPS, not the user’s Mac, for a VPS deployment)'}. Returns total pages and up to 10 pages per call; use start_page to continue. Image-only scans need OCR; this reader reports that rather than inventing text.`,
    side_effect: 'Reads a PDF and extracts text locally; does not upload or modify the document.',
    permission: {action:scope === 'sandbox' ? 'sandbox.read_file' : 'local.read_file',target:input=>input.path},
    input_schema:{type:'object',required:['path'],properties:{path:{type:'string'},start_page:{type:'integer'},page_count:{type:'integer'}}},
    async handler({input,run}) {
      const start=input.start_page ?? 1, count=input.page_count ?? 10;
      if(!Number.isInteger(start)||start<1||!Number.isInteger(count)||count<1||count>10) return {ok:false,error:'invalid_page_range',message:'start_page must be positive; page_count must be 1–10.'};
      let temp,fd;
      try {
        const root=fs.realpathSync(workspace);
        if(scope==='host'&&!path.isAbsolute(input.path)) return {ok:false,error:'absolute_path_required'};
        if(scope==='host'&&protectedHostPath({dataDir,workspace},input.path)) return {ok:false,error:'host_data_protected',message:'That path is inside Better Bots’ own data folder. Host-machine tools cannot read it.'};
        const file=fs.realpathSync(scope==='sandbox'?path.resolve(root,input.path):input.path);
        if(scope==='sandbox'&&!within(root,file)) return {ok:false,error:'outside_workspace'};
        fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK); // O_NONBLOCK: a FIFO must fail the isFile check, not freeze the host
        if(scope==='sandbox'&&process.platform==='linux'&&!within(root,fs.realpathSync(`/proc/self/fd/${fd}`))) return {ok:false,error:'outside_workspace'};
        const stat=fs.fstatSync(fd);
        if(!stat.isFile()||stat.size>MAX_BYTES) return {ok:false,error:'pdf_too_large_or_not_file',message:'Choose a PDF file under 50 MB.'};
        const bytes=fs.readFileSync(fd);
        if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))) return {ok:false,error:'not_a_pdf'};
        temp=fs.mkdtempSync(path.join(os.tmpdir(),'better-bots-pdf-'));
        const copy=path.join(temp,'document.pdf');fs.writeFileSync(copy,bytes,{mode:0o600});
        const options={timeout:20000,maxBuffer:4*1024*1024,encoding:'utf8',signal:run?.signal?.native,env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'}};
        const info=await exec('pdfinfo',[copy],options);
        const total=Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
        if(!total) return {ok:false,error:'pdf_page_count_unavailable'};
        if(start>total) return {ok:false,error:'page_out_of_range',total_pages:total};
        const end=Math.min(total,start+count-1);
        const output=await exec('pdftotext',['-f',String(start),'-l',String(end),'-layout','-enc','UTF-8',copy,'-'],options);
        const chunks=output.stdout.split('\f');let remaining=MAX_TEXT,truncated=false;
        const pages=Array.from({length:end-start+1},(_,i)=>{
          const text=(chunks[i]??'').trim();const shown=text.slice(0,remaining);remaining-=shown.length;truncated ||= shown.length<text.length;
          return {page:start+i,text:shown};
        });
        return {ok:true,path:input.path,total_pages:total,pages,truncated,next_page:end<total?end+1:null,
          ...(!pages.some(p=>p.text)?{notice:'No extractable text on these pages. This may be a scanned/image-only PDF; OCR or visual inspection is needed.'}:{}),
          ...(truncated?{notice:'Text limit reached. Read individual pages with page_count: 1 for more detail.'}:{})};
      } catch(error) {
        return {ok:false,error:error.code==='ENOENT'?(error.path==='pdfinfo'||error.path==='pdftotext'?'pdf_reader_unavailable':'not_found'):'pdf_read_failed',message:error.code==='ENOENT'?'PDF file or Poppler reader is unavailable.':String(error.stderr||error.message).slice(0,800)};
      } finally {if(fd!==undefined)fs.closeSync(fd);if(temp)fs.rmSync(temp,{recursive:true,force:true});}
    },
  }));
}
