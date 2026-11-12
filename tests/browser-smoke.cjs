const {chromium}=require(process.env.VIDEO_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict'); const fs=require('fs'); const path=require('path'); const os=require('os');
(async()=>{
 const root=path.resolve(__dirname, '..');
 const testOrigin=process.env.VIDEO_TEST_ORIGIN || 'https://media.example.test';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'video-exporter-ui-'));
 const context=await chromium.launchPersistentContext(profile,{
  executablePath:process.env.VIDEO_CHROMIUM_PATH || undefined,
  headless:true, viewport:{width:1000,height:750}, acceptDownloads:true, downloadsPath:path.join(profile,'downloads'),
  args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]
 });
 try {
  fs.mkdirSync(path.join(root,'artifacts/ui'),{recursive:true});
  let failMedia=false;
  let worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  console.log('Extension worker connected');
  const extensionId=new URL(worker.url()).host;
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.protocol==='chrome-extension:')return route.continue();
   if(u.origin!==testOrigin)return route.abort();
   if(u.pathname==='/lab/lesson')return route.fulfill({contentType:'text/html',body:`<!doctype html><title>Storyboard to Motion · Video Test</title><h1>Storyboard to Motion</h1><video style="width:640px;height:360px" controls muted poster="/poster.svg"></video><script>(async()=>{await fetch('/master.m3u8').then(r=>r.text());const data=await fetch('/twelve-seconds.mp4').then(r=>r.blob());document.querySelector('video').src=URL.createObjectURL(data);})()</script>`});
   if(u.pathname==='/poster.svg')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#253a55"/><text x="45" y="150" fill="#9bb9dc" font-family="sans-serif" font-size="24">LESSON 03</text><text x="45" y="205" fill="white" font-family="sans-serif" font-size="32">Storyboard to Motion</text></svg>'});
   const file=path.join(root,'tests/fixtures',path.basename(u.pathname));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:'Not found'});
   if(file.endsWith('.ts')) {if(failMedia)return route.fulfill({status:404,body:'Missing media'});await new Promise(r=>setTimeout(r,500));}
   const body=fs.readFileSync(file);
   return route.fulfill({contentType:file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':file.endsWith('.ts')?'video/mp2t':'video/mp4',body,headers:{'access-control-allow-origin':'*'}});
  });
  const lesson=await context.newPage();
  await lesson.goto(testOrigin+'/lab/lesson');
  await lesson.locator('video').evaluate(v=>new Promise(resolve=>{if(v.readyState>=1)resolve();else v.addEventListener('loadedmetadata',resolve,{once:true})}));
  await lesson.evaluate(()=>fetch('/master.m3u8').then(r=>r.text()));
  const [tab]=await worker.evaluate((url)=>chrome.tabs.query({url}),testOrigin+'/lab/lesson');
  async function popup(){const page=await context.newPage();await page.setViewportSize({width:568,height:600});await page.addInitScript(({pageUrl})=>{const query=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async()=>query({url:pageUrl});},{pageUrl:testOrigin+'/lab/lesson'});await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);await page.locator('.video-card').waitFor();return page;}
  let page=await popup();
  page.on('pageerror',e=>console.log('POPUP ERROR',e.message));
  await page.locator('.app').screenshot({path:path.join(root,'artifacts/ui/popup-current.png')});
  await page.getByRole('button',{name:'Rename export',exact:true}).click();
  await page.locator('.rename-input').fill('Storyboard to Motion - Export');
  await page.locator('.rename-input').press('Enter');
  await page.getByRole('button',{name:'Hide Storyboard to Motion - Export',exact:true}).click();
  await page.getByRole('button',{name:'Restore hidden videos'}).click();
  await page.getByRole('combobox',{name:/Download quality for/}).selectOption('16');
  const downloadPromise=lesson.waitForEvent('download');
  await page.getByRole('button',{name:'Download',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.card-progress'));
  await page.locator('.app').screenshot({path:path.join(root,'artifacts/ui/popup-progress.png')});
  const running=await worker.evaluate(async()=>((await chrome.storage.session.get('videoJobs')).videoJobs||[]));
  assert.ok(['preparing','downloading'].includes(running[0]?.status));
  await page.close();
  console.log('Popup closed during task');
  let jobs;
  for(let n=0;n<100;n++){jobs=await worker.evaluate(async()=>((await chrome.storage.session.get('videoJobs')).videoJobs||[]));if(jobs[0]&&['complete','error'].includes(jobs[0].status))break;await new Promise(r=>setTimeout(r,200));}
  console.log('Job result',JSON.stringify(jobs?.map(j=>({status:j.status,error:j.error,downloadId:j.downloadId,filename:j.filename}))));
  page=await popup();
  await page.locator('.app').screenshot({path:path.join(root,'artifacts/ui/popup-history.png')});
  await page.getByRole('tab',{name:'Transcripts'}).click();
  await page.locator('.app').screenshot({path:path.join(root,'artifacts/ui/popup-transcripts.png')});
  if(jobs[0]?.status!=='complete')throw new Error('Download was not confirmed complete');
  const download=await downloadPromise;
  const toolkit=await import(require('node:url').pathToFileURL(path.join(root,'vendor/mediabunny.min.mjs')).href);
  const input=new toolkit.Input({source:new toolkit.BlobSource(new Blob([fs.readFileSync(await download.path())])),formats:toolkit.ALL_FORMATS});
  const video=await input.getPrimaryVideoTrack(); const audio=await input.getPrimaryAudioTrack();
  assert.ok(video); assert.ok(audio);
  assert.ok((await video.computeDuration())-(await video.getFirstTimestamp())>=11.9);
  assert.ok((await audio.computeDuration())-(await audio.getFirstTimestamp())>=11.9);
  input.dispose();
  assert.equal(await page.locator('#videoList .quality-select').inputValue(),'16');
  console.log('Actual extension HLS video + audio download, rename, hide/restore, close and reopen check passed');
  // Fail a second task and retry from the same loaded lesson, without a page reload.
  await page.getByRole('tab',{name:/Videos/}).click();
  failMedia=true;
  await page.locator('#videoList .primary-action').click();
  await page.waitForFunction(()=>document.querySelector('.status.error'),{},{timeout:30000});
  await page.locator('.app').screenshot({path:path.join(root,'artifacts/ui/popup-error.png')});
  assert.ok(await page.getByRole('button',{name:'Save download error details'}).isVisible());
  failMedia=false;
  await page.locator('#videoList .primary-action').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.status.complete')].length===2,{},{timeout:30000});
  console.log('Failure reporting and retry without lesson reload passed');
  // Exercise the user's GOP timestamp failure through an actual HLS download.
  await lesson.evaluate(()=>fetch('/gop-master.m3u8').then(r=>r.text()));
  await page.getByRole('button',{name:'Refresh detected videos'}).click();
  await page.waitForFunction(()=>analysis?.video?.source?.url?.includes('gop-master.m3u8'));
  const gopDownloadPromise=lesson.waitForEvent('download');
  await page.locator('#videoList .primary-action').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.status.complete')].length===3,{},{timeout:30000});
  const gopDownload=await gopDownloadPromise;
  const gopInput=new toolkit.Input({source:new toolkit.BlobSource(new Blob([fs.readFileSync(await gopDownload.path())])),formats:toolkit.ALL_FORMATS});
  const gopVideo=await gopInput.getPrimaryVideoTrack(),gopAudio=await gopInput.getPrimaryAudioTrack();
  assert.ok(gopVideo);assert.ok(gopAudio);
  assert.ok((await gopVideo.computeDuration())-(await gopVideo.getFirstTimestamp())>=11.9);
  assert.ok((await gopAudio.computeDuration())-(await gopAudio.getFirstTimestamp())>=11.9);
  gopInput.dispose();
  console.log('Overlapping-GOP HLS download completes with full video timeline and full audio');

 } finally {await context.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
