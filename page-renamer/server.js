'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');
const { createWorker, PSM } = require('tesseract.js');

const execFileAsync = promisify(execFile);
const base = __dirname;
const dataDir = path.join(base, 'data');
const bridge = path.join(base, 'bridge');
const token = crypto.randomBytes(24).toString('hex');
const sessions = new Map();
let manifest;
let worker;
let busy = false;
fs.mkdirSync(dataDir, { recursive: true });

async function ps(script, args = [], timeout = 15000) {
  const { stdout } = await execFileAsync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(bridge, script), ...args],
    { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout.trim());
}
async function current() {
  manifest = await ps('manifest.ps1');
  return manifest;
}
function page(id) { return manifest?.pages.find(p => p.id === id); }
function validateZone(z) {
  if (!z || !['x','y','w','h'].every(k => Number.isFinite(z[k]))) throw Error('Draw both title block regions first.');
  if (z.x < 0 || z.y < 0 || z.w < .005 || z.h < .005 || z.x + z.w > 1.001 || z.y + z.h > 1.001) throw Error('Invalid title block region.');
}
function region(meta, z) {
  const x = Math.max(0, Math.floor(z.x * meta.width));
  const y = Math.max(0, Math.floor(z.y * meta.height));
  return { left:x, top:y, width:Math.min(meta.width-x,Math.max(1,Math.ceil(z.w*meta.width))), height:Math.min(meta.height-y,Math.max(1,Math.ceil(z.h*meta.height))) };
}
async function ocrWorker() {
  if (!worker) {
    worker = await createWorker('eng', 1, {
      langPath: path.join(base, 'assets'), gzip: false, cacheMethod: 'none',
      workerPath: path.join(base, 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
      corePath: path.join(base, 'node_modules', 'tesseract.js-core')
    });
  }
  return worker;
}
function clean(s) { return String(s || '').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim(); }
function normalizedNumber(s) {
  const raw=clean(s).toUpperCase().replace(/\s*[-–—]\s*/g,'-').replace(/\s*\.\s*/g,'.');
  const candidate=raw.replace(/[^A-Z0-9.\-]/g,'').slice(0,24);
  return candidate.replace(/^([A-Z]{1,2})O(?=[.\-]\d)/,(_,prefix)=>prefix+'0');
}
function proposed(number, title) {
  return [clean(number),clean(title)].filter(Boolean).join(' - ').slice(0,120);
}
async function recognizeZone(image, meta, z, mode) {
  const crop=region(meta,z);
  const pipeline=sharp(image,{limitInputPixels:268435456}).extract(crop).grayscale().normalize();
  const input=await pipeline.resize({width:Math.min(2500,Math.max(600,crop.width*2)),withoutEnlargement:false}).png().toBuffer();
  const w=await ocrWorker();
  await w.setParameters({ tessedit_pageseg_mode: mode === 'number' ? PSM.SINGLE_LINE : PSM.AUTO });
  const result=await w.recognize(input);
  return { text:clean(result.data.text), confidence:Math.round(result.data.confidence || 0) };
}
async function scan(body) {
  validateZone(body.numberZone);
  if (body.titleZone) validateZone(body.titleZone);
  const latest=await current();
  const ids=Array.isArray(body.ids)&&body.ids.length?body.ids:latest.pages.map(p=>p.id);
  const results=[];
  for(const id of ids) {
    const p=page(id);
    if(!p || !p.image) { results.push({id,error:'Page image unavailable'}); continue; }
    try {
      const meta=await sharp(p.image,{limitInputPixels:268435456}).metadata();
      if(!meta.width||!meta.height) throw Error('Image dimensions unavailable');
      const num=await recognizeZone(p.image,meta,body.numberZone,'number');
      const title=body.titleZone?await recognizeZone(p.image,meta,body.titleZone,'title'):{text:'',confidence:100};
      const number=normalizedNumber(num.text);
      const newName=proposed(number,title.text);
      const warnings=[];
      if(clean(num.text).toUpperCase()!==number) warnings.push(`OCR read “${num.text}”; check correction`);
      if(!/^[A-Z]{0,3}-?\d{1,4}(?:[.\-]\d{1,3})?[A-Z]?$/.test(number)) warnings.push('Check sheet number');
      if(num.confidence<60) warnings.push('Low OCR confidence');
      if(!newName) warnings.push('No text read');
      results.push({id,oldName:p.name,path:p.path,number,title:title.text,newName,
        confidence:num.confidence,warnings,apply:warnings.length===0 && p.name!==newName});
    } catch(e) { results.push({id,oldName:p.name,error:e.message}); }
  }
  const counts=new Map();
  for(const r of results) if(r.newName) counts.set(r.newName,(counts.get(r.newName)||0)+1);
  for(const r of results) if(r.newName && counts.get(r.newName)>1) {r.warnings.push('Duplicate proposed name');r.apply=false;}
  const scanId=crypto.randomUUID();
  sessions.set(scanId,{link:latest.link,jobDir:latest.jobDir,results,created:Date.now()});
  return {scanId,job:latest.job,results};
}
async function apply(body) {
  const session=sessions.get(body.scanId);
  if(!session) throw Error('Preview expired. Scan again.');
  const latest=await current();
  if(latest.link!==session.link || latest.jobDir!==session.jobDir) throw Error('Job changed. Scan again.');
  const changes=[];
  const names=new Set();
  for(const e of body.entries||[]) {
    const original=session.results.find(x=>x.id===e.id);
    const p=page(e.id);
    const newName=clean(e.newName);
    if(!original||!p||p.name!==original.oldName||p.path!==original.path) throw Error('Page changed. Scan again.');
    if(!newName||newName.length>120||/[\\/:*?"<>|]/.test(newName)) throw Error(`Invalid name: ${newName}`);
    if(names.has(newName.toLowerCase())) throw Error(`Duplicate name: ${newName}`);
    names.add(newName.toLowerCase());
    if(newName!==p.name) changes.push({id:p.id,path:p.path,oldName:p.name,newName});
  }
  if(!changes.length) throw Error('Select at least one changed page.');
  // Duplicate names in untouched pages are also unsafe in a PlanSwift page folder.
  for(const p of latest.pages) if(names.has(p.name.toLowerCase()) && !changes.some(c=>c.id===p.id && c.newName.toLowerCase()===p.name.toLowerCase())) {
    throw Error(`Name already in use: ${p.name}. Rename that page in a separate run.`);
  }
  const journal={created:new Date().toISOString(),job:latest.job,link:latest.link,changes,status:'prepared'};
  const journalPath=path.join(dataDir,`rename-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(journalPath,JSON.stringify(journal,null,2));
  const requestPath=journalPath+'.request.json';
  fs.writeFileSync(requestPath,JSON.stringify({link:latest.link,entries:changes}));
  try {
    const outcome=await ps('apply.ps1',['-InputFile',requestPath],120000);
    journal.status='applied';journal.outcome=outcome;fs.writeFileSync(journalPath,JSON.stringify(journal,null,2));
    sessions.delete(body.scanId);
    return {count:changes.length,journal:path.basename(journalPath)};
  } catch(e) {
    journal.status='uncertain';journal.error=e.message;fs.writeFileSync(journalPath,JSON.stringify(journal,null,2));
    throw Error('PlanSwift did not confirm the changes. Check its Pages list before retrying. '+e.message);
  } finally { fs.rmSync(requestPath,{force:true}); }
}
async function undo() {
  const latest=await current();
  const files=fs.readdirSync(dataDir).filter(n=>/^rename-.*\.json$/.test(n)).sort().reverse();
  let journalPath, previous;
  for(const name of files){const j=JSON.parse(fs.readFileSync(path.join(dataDir,name),'utf8'));if(j.status==='applied'&&j.link===latest.link){journalPath=path.join(dataDir,name);previous=j;break;}}
  if(!previous) throw Error('No applied run for this job was found.');
  const changes=previous.changes.map(c=>{
    const p=latest.pages.find(p=>p.id===c.id);
    if(!p||p.name!==c.newName) throw Error(`Page changed after the run: ${c.newName}. Restore it manually.`);
    return {id:c.id,path:p.path,oldName:c.newName,newName:c.oldName};
  });
  const requestPath=path.join(dataDir,`undo-${Date.now()}.request.json`);
  fs.writeFileSync(requestPath,JSON.stringify({link:latest.link,entries:changes}));
  try {
    await ps('apply.ps1',['-InputFile',requestPath],120000);
    previous.status='undone';previous.undoneAt=new Date().toISOString();
    fs.writeFileSync(journalPath,JSON.stringify(previous,null,2));
    return {count:changes.length};
  } catch(e) {throw Error('Undo was not confirmed. Check PlanSwift before retrying. '+e.message);}
  finally {fs.rmSync(requestPath,{force:true});}
}
function respond(res,status,obj) {
  const data=Buffer.from(JSON.stringify(obj));
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);
}
async function bodyOf(req) {
  let data='';for await(const chunk of req){data+=chunk;if(data.length>1024*1024)throw Error('Request too large');}
  return JSON.parse(data||'{}');
}
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.headers['x-page-renamer-token']!==token && url.searchParams.get('token')!==token) return respond(res,403,{error:'Forbidden'});
    if(req.method==='GET' && url.pathname==='/') {
      const html=fs.readFileSync(path.join(base,'ui','index.html'),'utf8').replaceAll('__TOKEN__',token);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'"});res.end(html);return;
    }
    if(req.method==='GET' && url.pathname==='/ui.js') { res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(fs.readFileSync(path.join(base,'ui','ui.js')));return; }
    if(req.method==='GET' && url.pathname==='/api/manifest') return respond(res,200,await current());
    if(req.method==='GET' && url.pathname.startsWith('/api/image/')) {
      if(!manifest) await current();
      const p=page(decodeURIComponent(url.pathname.slice('/api/image/'.length)));
      if(!p?.image) throw Error('Image unavailable');
      const data=await sharp(p.image,{limitInputPixels:268435456}).resize({width:1800,withoutEnlargement:true}).png().toBuffer();
      res.writeHead(200,{'Content-Type':'image/png','Content-Length':data.length,'Cache-Control':'no-store'});res.end(data);return;
    }
    if(req.method==='POST' && url.pathname==='/api/scan') {
      if(busy) throw Error('Another operation is running');busy=true;
      try{return respond(res,200,await scan(await bodyOf(req)));}finally{busy=false;}
    }
    if(req.method==='POST' && url.pathname==='/api/apply') {
      if(busy) throw Error('Another operation is running');busy=true;
      try{return respond(res,200,await apply(await bodyOf(req)));}finally{busy=false;}
    }
    if(req.method==='POST' && url.pathname==='/api/undo') {
      if(busy) throw Error('Another operation is running');busy=true;
      try{return respond(res,200,await undo());}finally{busy=false;}
    }
    respond(res,404,{error:'Not found'});
  } catch(e){ respond(res,400,{error:e.message}); }
});
if(require.main===module){
  server.listen(0,'127.0.0.1',()=>{
    const url=`http://127.0.0.1:${server.address().port}/?token=${token}`;
    console.log(`Precise Page Renamer: ${url}`);
    if(!process.env.PRECISE_NO_BROWSER) execFile('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true},()=>{});
  });
  process.on('SIGINT',async()=>{if(worker)await worker.terminate();server.close();});
}

module.exports={normalizedNumber,proposed,validateZone,recognizeZone,closeWorker:async()=>{if(worker)await worker.terminate();worker=undefined;}};
