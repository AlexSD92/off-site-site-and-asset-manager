/* YardMap: a dependency-free, offline auction-site planner.
   All project data stays in browser localStorage unless explicitly exported. */
(() => {
  'use strict';

  const STORE_KEY = 'yardmap.projects.v1';
  const EXPORT_SIGNATURE = 'yardmap-site';
  const CELL_PX = 30;
  const MAX_UNDO = 80;
  const STATUS = {
    pending: {label: 'Pending', color: '#e8b44d'},
    cleared: {label: 'Cleared', color: '#1caf73'},
    hold: {label: 'On hold', color: '#916add'},
    issue: {label: 'Issue', color: '#e46570'},
    reserved: {label: 'Reserved', color: '#5a9ee7'}
  };
  const TOOLS = {
    select: 'Select & move items. Drag a lot corner to resize it.',
    pan: 'Drag to move around the site. Pinch to zoom on a touchscreen.',
    wall: 'Drag from one grid point to another to create a wall.',
    door: 'Drag along an opening to mark a doorway, or tap to add a 1-square door.',
    shutter: 'Drag along the entrance to draw a roller shutter.',
    lot: 'Drag across the grid to draw a lot footprint. Tap to create a 3 × 2 lot.',
    box: 'Drag to draw a coloured area or hazard box. Customise its label, colour and notes in Details; no invoice required.',
    green: 'Tap any lot to mark it cleared (or tap again to undo).',
    delete: 'Tap an item to delete it. Undo restores it. Dragging the view won’t delete anything.',
    lock: 'Tap the grid to mark a lock. Add its key reference in Details.',
    label: 'Tap the grid to place a location label.'
  };
  const $ = id => document.getElementById(id);
  const canvas = $('siteCanvas');
  const wrap = $('canvasWrap');
  const ctx = canvas.getContext('2d');
  const panel = $('panelContent');
  const COLORS = { wall:'#354963', door:'#307fc9', shutter:'#bf8636', lock:'#d19827', label:'#314969' };
  const minmax = (x,min,max) => Math.min(max,Math.max(min,x));
  const clone = value => JSON.parse(JSON.stringify(value));
  const nextId = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeName = s => String(s || 'site').replace(/[^a-z0-9 _-]/gi, '_').trim().replace(/\s+/g,'-').slice(0,70) || 'site';
  const fmt = n => Number(n.toFixed(2)).toString();
  const settings = { tab:'properties', tool:'select', lotFilter:'all', lotSearch:'', selected:null, panFromSpace:false };
  const view = {zoom:1, offsetX:0, offsetY:0, width:900, height:580, fitted:false};
  const pointers = new Map();
  let drawing = null;
  let pinch = null;
  let toolBeforeSpace = null;
  let history = [];
  let future = [];
  let raf = 0;
  let saveTimer = null;
  let toastTimer = null;
  let state = { activeId:null, projects:[] };
  let project;
  let recoveryBlocked=false;

  const createProject = (name='Untitled auction site') => ({
    id:nextId(), name, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    cols:48, rows:32, cellMeters:1, nextLot:1, textScale:1, showText:true, objects:[]
  });

  function toast(msg) {
    const el=$('toast'); el.textContent=msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2600);
  }
  function storageStatus(message, error=false, saving=false) {
    const s=$('saveState');s.innerHTML=`<span class="save-dot ${error?'error':''}"></span> ${e(message)}`;
    const banner=$('saveBanner');
    banner.dataset.state=error?'error':saving?'saving':'saved';
    $('saveBannerText').textContent=`${error?'⚠':saving?'◌':'✓'} ${message}`;
    $('saveBannerHint').textContent=error
      ? 'Your changes may not be stored. Export JSON now to make a backup.'
      : 'Changes stay on this device. Export JSON to keep a backup.';
  }
  function storeNow() {
    clearTimeout(saveTimer);saveTimer=null;
    if(recoveryBlocked){
      storageStatus('Local data needs recovery — export your existing backup', true);
      return false;
    }
    try {
      localStorage.setItem(STORE_KEY,JSON.stringify(state));
      storageStatus(`Saved locally at ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`);
      return true;
    } catch (err) {
      storageStatus('Not saved — browser storage unavailable', true);
      toast('Local browser storage is unavailable. Export JSON to back up your plan.');
      return false;
    }
  }
  function scheduleSave() {
    storageStatus('Saving changes…', false, true); clearTimeout(saveTimer);
    saveTimer=setTimeout(storeNow,200);
  }

  function sanitizeProject(src, importMode=false) {
    if (!src || typeof src !== 'object' || !Array.isArray(src.objects)) throw new Error('Not a valid YardMap site file.');
    const cols=Number(src.cols), rows=Number(src.rows), cellMeters=Number(src.cellMeters);
    if (!Number.isFinite(cols)||!Number.isFinite(rows)||cols<8||cols>250||rows<8||rows>250) throw new Error('Invalid site dimensions.');
    if (!Number.isFinite(cellMeters)||cellMeters<.1||cellMeters>100) throw new Error('Invalid grid scale.');
    if (src.objects.length>8000) throw new Error('The site file contains too many objects.');
    const accepted = new Set(['wall','door','shutter','lot','box','lock','label']);
    const objects=[];
    const unique=new Set();
    for (const raw of src.objects) {
      if (!raw || !accepted.has(raw.type)) continue;
      const obj={type:raw.type,id: typeof raw.id==='string' && !unique.has(raw.id) ? raw.id.slice(0,100) : nextId()};
      unique.add(obj.id);
      const numericKeys = ['lot','box'].includes(obj.type) ? ['x','y','w','h'] :
        ['wall','door','shutter'].includes(obj.type) ? ['x1','y1','x2','y2'] : ['x','y'];
      if (numericKeys.some(key=>!Number.isFinite(Number(raw[key]))||Math.abs(Number(raw[key]))>100000)) continue;
      for (const key of numericKeys) obj[key]=Math.round(Number(raw[key]));
      if (['lot','box'].includes(obj.type)) {
        obj.w=minmax(obj.w,1,250);obj.h=minmax(obj.h,1,250);
      }
      if (obj.type==='lot') {
        obj.number=String(raw.number ?? '').slice(0,90);
        obj.invoice=String(raw.invoice ?? '').slice(0,200);
        obj.status=STATUS[raw.status] ? raw.status:'pending';
        obj.color=/^#[0-9a-f]{6}$/i.test(raw.color||'') ? raw.color : '';
      }
      if (['wall','door','shutter','lock'].includes(obj.type)) obj.label=String(raw.label??'').slice(0,140);
      if(obj.type==='box'){
        obj.label=String(raw.label??'Area').slice(0,140);
        obj.color=/^#[0-9a-f]{6}$/i.test(raw.color||'')?raw.color:'#e99d3e';
      }
      if (obj.type==='label') obj.text=String(raw.text??'Area').slice(0,150);
      if (raw.fontSize !== undefined) {
        const size=Number(raw.fontSize);
        if (Number.isFinite(size)) obj.fontSize=minmax(size,.15,2.5);
      }
      if (obj.type==='lock') {
        obj.keyRef=String(raw.keyRef??'').slice(0,140);
        obj.keyHolder=String(raw.keyHolder??'').slice(0,140);
      }
      obj.notes=String(raw.notes??'').slice(0,3000);
      objects.push(obj);
    }
    return {
      id:importMode ? nextId() : (String(src.id || nextId()).slice(0,120)),
      name:String(src.name||'Imported site').slice(0,140),
      createdAt:typeof src.createdAt==='string'?src.createdAt:new Date().toISOString(),
      updatedAt:typeof src.updatedAt==='string'?src.updatedAt:new Date().toISOString(),
      cols:Math.round(cols),rows:Math.round(rows),cellMeters,
      nextLot:minmax(Math.round(Number(src.nextLot)||1),1,1000000),
      textScale:Number.isFinite(Number(src.textScale)) && src.textScale!=null ? minmax(Number(src.textScale),.5,2.5) : 1,
      showText:src.showText!==false,objects
    };
  }
  function load() {
    let storedText=null;
    try {
      storedText=localStorage.getItem(STORE_KEY);
      if(storedText){
        const saved=JSON.parse(storedText);
        if(!saved||!Array.isArray(saved.projects)||!saved.projects.length)throw new Error('Invalid saved project list');
        const restored=saved.projects.slice(0,100).map(p=>sanitizeProject(p));
        if(!restored.length)throw new Error('No readable projects');
        state.projects=restored;
        state.activeId=saved.activeId;
      }
    }catch(err){
      console.error('YardMap could not read its existing browser data; it will not overwrite it.',err);
      recoveryBlocked=storedText!==null;
    }
    if(!state.projects.length){
      project=createProject('My first auction site');state.projects.push(project);state.activeId=project.id;
      if(!recoveryBlocked)storeNow();
      else storageStatus('Existing save unreadable — original data protected', true);
    }else{
      project=state.projects.find(p=>p.id===state.activeId)||state.projects[0];
      state.activeId=project.id;
      storageStatus('Loaded locally — autosave active');
    }
  }
  function refreshProjectSelector() {
    const s=$('projectSelect');s.replaceChildren();
    for(const p of state.projects){const opt=document.createElement('option');opt.value=p.id;opt.textContent=p.name;s.append(opt);}
    s.value=state.activeId;
  }
  function restore(snapshot) {
    const restored=JSON.parse(snapshot);
    const idx=state.projects.findIndex(p=>p.id===project.id);
    state.projects[idx]=sanitizeProject(restored);
    project=state.projects[idx];
    if (!project.objects.find(o=>o.id===settings.selected)) settings.selected=null;
    scheduleSave();refreshAll();
  }
  function commit(before) {
    if (!before) return;
    const after=JSON.stringify(project);
    if(before===after) return;
    history.push(before);if(history.length>MAX_UNDO)history.shift();future=[];
    project.updatedAt=new Date().toISOString();
    scheduleSave();refreshAll();
  }
  const snapshot=()=>JSON.stringify(project);
  function undo() {
    if(!history.length)return;
    future.push(snapshot());restore(history.pop());toast('Undid last change');
  }
  function redo() {
    if(!future.length)return;
    history.push(snapshot());restore(future.pop());toast('Redid change');
  }
  function getSelected(){return project.objects.find(o=>o.id===settings.selected)||null;}
  function changeProject(id){
    const target=state.projects.find(p=>p.id===id);if(!target)return;
    storeNow();project=target;state.activeId=id;settings.selected=null;history=[];future=[];
    refreshProjectSelector();refreshAll();fitView();storeNow();toast(`Opened ${project.name}`);
  }
  function newSite(){
    const name=prompt('Name this auction site:',`New auction site ${state.projects.length+1}`);
    if(name===null)return;
    project=createProject(name.trim().slice(0,140)||`New auction site ${state.projects.length+1}`);
    state.projects.push(project);state.activeId=project.id;history=[];future=[];settings.selected=null;
    refreshProjectSelector();refreshAll();fitView();storeNow();toast('New site created');
  }
  function renameSite(){
    const name=prompt('Site name:',project.name);if(name===null||!name.trim())return;
    const before=snapshot();project.name=name.trim().slice(0,140);commit(before);refreshProjectSelector();
  }
  function duplicateSite(){
    const copy=clone(project);copy.id=nextId();copy.name=`${copy.name} — copy`;copy.createdAt=new Date().toISOString();
    state.projects.push(copy);changeProject(copy.id);toast('Created a local copy');
  }
  function confirmAction(title,description,confirmLabel='Delete') {
    return new Promise(resolve=>{
      const dialog=$('confirmDialog');$('confirmTitle').textContent=title;$('confirmText').textContent=description;
      $('confirmAccept').textContent=confirmLabel;
      const onClose=()=>{dialog.removeEventListener('close',onClose);resolve(dialog.returnValue==='confirm');};
      dialog.addEventListener('close',onClose);dialog.showModal();
    });
  }
  function requestClearCanvas(){
    if(!project.objects.length){toast('This canvas is already empty.');return;}
    if(recoveryBlocked){toast('Existing browser storage needs recovery. Do not clear this canvas.');return;}
    const lots=project.objects.filter(o=>o.type==='lot').length;
    const other=project.objects.length-lots;
    $('clearCanvasScope').textContent=`Site: “${project.name}”. This will permanently remove ${project.objects.length} item(s): ${lots} lot(s) and ${other} other item(s), including invoice references, locks and their keys, structures and labels.`;
    $('clearCanvasPhrase').value='';
    $('clearCanvasUnderstand').checked=false;
    $('clearCanvasConfirm').disabled=true;
    $('clearCanvasDialog').showModal();
    $('clearCanvasPhrase').focus();
  }
  function checkClearCanvasConfirmation(){
    $('clearCanvasConfirm').disabled=$('clearCanvasPhrase').value!=='CLEAR'||!$('clearCanvasUnderstand').checked;
  }
  function clearCanvasPermanently(){
    if(!$('clearCanvasDialog').open || $('clearCanvasPhrase').value!=='CLEAR' || !$('clearCanvasUnderstand').checked)return false;
    if(recoveryBlocked){toast('Unable to clear: stored site needs recovery.');return false;}
    if(!project.objects.length){$('clearCanvasDialog').close();return false;}
    const oldObjects=project.objects,oldNextLot=project.nextLot,oldUpdatedAt=project.updatedAt;
    project.objects=[];
    project.nextLot=1;
    project.updatedAt=new Date().toISOString();
    // This operation is intentionally outside normal Undo history. Save
    // synchronously before discarding the previous state or the Undo stack.
    if(!storeNow()){
      project.objects=oldObjects;
      project.nextLot=oldNextLot;
      project.updatedAt=oldUpdatedAt;
      refreshAll();
      toast('Nothing was cleared: the browser could not save this change.');
      return false;
    }
    history=[];future=[];settings.selected=null;drawing=null;pinch=null;pointers.clear();
    refreshAll();
    setTool('select');
    $('clearCanvasDialog').close();
    toast('Canvas cleared. This operation cannot be undone.');
    return true;
  }
  async function deleteSite(){
    if(!await confirmAction('Delete this site?',`Permanently remove “${project.name}” from this browser? Export a JSON backup first if you might need it.`))return;
    const index=state.projects.findIndex(p=>p.id===project.id);state.projects.splice(index,1);
    if(!state.projects.length)state.projects.push(createProject('My auction site'));
    project=state.projects[Math.min(index,state.projects.length-1)];state.activeId=project.id;
    history=[];future=[];settings.selected=null;refreshProjectSelector();refreshAll();fitView();storeNow();toast('Site deleted from this browser');
  }
  function downloadBlob(blob,filename){
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);
  }
  function exportJSON(){
    storeNow();
    const payload={format:EXPORT_SIGNATURE,formatVersion:1,exportedAt:new Date().toISOString(),project};
    downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),`${safeName(project.name)}.yardmap.json`);
    toast('Site plan exported as JSON');
  }
  async function importJSON(file){
    if(!file)return;
    if(file.size>8*1024*1024){toast('File too large (8 MB maximum).');return;}
    try{
      const parsed=JSON.parse(await file.text());
      if(parsed.format && parsed.format!==EXPORT_SIGNATURE)throw new Error('Not a YardMap export.');
      const p=sanitizeProject(parsed.project||parsed,true);
      if(state.projects.some(old=>old.name===p.name))p.name+= ' (imported)';
      state.projects.push(p);changeProject(p.id);toast(`Imported “${p.name}” successfully`);
    }catch(err){toast(`Import failed: ${err.message}`);}
  }
  function exportCSV(){
    const rows=[['Lot number','Invoice number','Status','Colour','X (m)','Y (m)','Width (m)','Depth (m)','Notes']];
    for(const l of project.objects.filter(o=>o.type==='lot'))rows.push([
      l.number,l.invoice,STATUS[l.status]?.label||l.status,l.color||STATUS[l.status].color,
      fmt(l.x*project.cellMeters),fmt(l.y*project.cellMeters),fmt(l.w*project.cellMeters),fmt(l.h*project.cellMeters),l.notes||''
    ]);
    const csv=rows.map(row=>row.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
    downloadBlob(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),`${safeName(project.name)}-lots.csv`);
    toast('Lot and invoice register exported as CSV');
  }

  function refreshStats(){
    const lots=project.objects.filter(o=>o.type==='lot');
    const count=s=>lots.filter(o=>o.status===s).length;
    const cleared=count('cleared');
    $('statTotal').textContent=lots.length;$('statCleared').textContent=cleared;
    $('statPending').textContent=count('pending')+count('reserved');
    $('statHold').textContent=count('hold');$('statIssue').textContent=count('issue');
    const percentage=lots.length?Math.round(cleared/lots.length*100):0;
    $('progressLabel').textContent=percentage+'%';$('progressFill').style.width=percentage+'%';
    $('lotsTabCount').textContent=lots.length;
    $('canvasTitle').textContent=project.name;
    $('siteDimensions').textContent=`${fmt(project.cols*project.cellMeters)} × ${fmt(project.rows*project.cellMeters)} m`;
    $('undoBtn').disabled=!history.length;$('redoBtn').disabled=!future.length;
    const visible=project.showText!==false;
    $('textToggleBtn').textContent=visible?'Aa · Show':'Aa · Hidden';
    $('textToggleBtn').setAttribute('aria-pressed',String(visible));
    $('textToggleBtn').classList.toggle('text-muted',!visible);
    if(document.activeElement!==$('textScaleInput'))$('textScaleInput').value=Math.round((project.textScale??1)*100);
  }
  function setTool(tool){
    if(!TOOLS[tool])return;
    settings.tool=tool;
    wrap.dataset.tool=tool;
    for(const el of document.querySelectorAll('button[data-tool]')){
      el.classList.toggle('active',el.dataset.tool===tool);
      el.setAttribute('aria-pressed',el.dataset.tool===tool?'true':'false');
    }
    $('canvasNote').textContent=project.objects.length===0 && tool==='select'
      ? 'Empty site — choose Draw Lot, Wall or another tool to start.' : TOOLS[tool];
    $('activeToolHelp').textContent=TOOLS[tool];
    $('mobilePan').classList.toggle('active',tool==='pan');$('mobileGreen').classList.toggle('green-active',tool==='green');
    $('mobileDelete').classList.toggle('delete-active',tool==='delete');
    drawSoon();
  }
  function switchTab(tab){
    settings.tab=tab;
    for(const b of document.querySelectorAll('[data-tab]')){
      b.classList.toggle('active',b.dataset.tab===tab);
      b.setAttribute('aria-selected',String(b.dataset.tab===tab));
    }
    renderPanel();
  }
  function selectObject(id,showDetails=true,focus=false){
    settings.selected=id;
    if(showDetails)switchTab('properties');else renderPanel();
    if(focus){const o=getSelected();if(o)centerOn(o);}
    drawSoon();
  }
  function refreshAll(){
    const panelScroll=panel.scrollTop;
    refreshStats();renderPanel();refreshProjectSelector();
    panel.scrollTop=panelScroll;
    drawSoon();
  }

  // Coordinates are stored in whole grid units; physical distance is cellMeters per unit.
  const scale=()=>CELL_PX*view.zoom;
  const toWorld=(clientX,clientY)=>{
    const r=canvas.getBoundingClientRect();
    return {x:(clientX-r.left-view.offsetX)/scale(),y:(clientY-r.top-view.offsetY)/scale()};
  };
  const snapCell=p=>({x:minmax(Math.round(p.x),0,project.cols),y:minmax(Math.round(p.y),0,project.rows)});
  const toScreen=p=>({x:view.offsetX+p.x*scale(),y:view.offsetY+p.y*scale()});
  function fitView(){
    if(!view.width||!view.height)return;
    view.zoom=minmax(Math.min((view.width-70)/(project.cols*CELL_PX),(view.height-70)/(project.rows*CELL_PX)),.1,5);
    view.offsetX=(view.width-project.cols*scale())/2;
    view.offsetY=(view.height-project.rows*scale())/2;
    view.fitted=true;drawSoon();
  }
  function centerOn(o){
    let x,y;
    if(o.type==='lot'||o.type==='box'){x=o.x+o.w/2;y=o.y+o.h/2;}
    else if(['wall','door','shutter'].includes(o.type)){x=(o.x1+o.x2)/2;y=(o.y1+o.y2)/2;}
    else{x=o.x;y=o.y;}
    view.offsetX=view.width/2-x*scale();view.offsetY=view.height/2-y*scale();drawSoon();
  }
  function zoomAt(factor,sx,sy){
    const old=scale();const wx=(sx-view.offsetX)/old,wy=(sy-view.offsetY)/old;
    view.zoom=minmax(view.zoom*factor,.1,7);
    view.offsetX=sx-wx*scale();view.offsetY=sy-wy*scale();
    view.fitted=false;drawSoon();
  }
  function resizeCanvas(){
    const r=wrap.getBoundingClientRect();
    const width=Math.round(r.width),height=Math.round(r.height);
    if(width<2||height<2)return; // Ignore transient sizes while the page is loading.
    const dpr=Math.min(window.devicePixelRatio||1,2);
    const pixelW=Math.round(width*dpr),pixelH=Math.round(height*dpr);
    if(width===view.width&&height===view.height&&canvas.width===pixelW&&canvas.height===pixelH)return;
    const oldW=view.width,oldH=view.height;
    const centreX=(oldW/2-view.offsetX)/scale(),centreY=(oldH/2-view.offsetY)/scale();
    view.width=width;view.height=height;
    if(canvas.width!==pixelW)canvas.width=pixelW;
    if(canvas.height!==pixelH)canvas.height=pixelH;
    if(view.fitted)fitView();
    else{
      view.offsetX=width/2-centreX*scale();
      view.offsetY=height/2-centreY*scale();
      drawSoon();
    }
  }
  function drawSoon(){if(!raf)raf=requestAnimationFrame(()=>{raf=0;draw();});}
  function line(ctx,x1,y1,x2,y2){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();}
  function roundRect(c,x,y,w,h,r){
    r=Math.max(0,Math.min(r,Math.abs(w)/2,Math.abs(h)/2));
    c.beginPath();c.moveTo(x+r,y);c.lineTo(x+w-r,y);c.quadraticCurveTo(x+w,y,x+w,y+r);
    c.lineTo(x+w,y+h-r);c.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    c.lineTo(x+r,y+h);c.quadraticCurveTo(x,y+h,x,y+h-r);
    c.lineTo(x,y+r);c.quadraticCurveTo(x,y,x+r,y);c.closePath();
  }
  function fontFor(o, defaultSize) {
 return (o.fontSize ?? defaultSize) * (project.textScale ?? 1);
}
  function baseFont(o) {
 if(o.type==='lot')return Math.min(.56,Math.max(.26,o.w/5));
 if(o.type==='label'||o.type==='box')return .44;
 if(o.type==='lock')return .27;
 return .28;
}
  function drawStructure(c,o,showText=true) {
 if(o.type==='wall'){
   c.strokeStyle=COLORS.wall;c.lineWidth=.17;c.lineCap='square';line(c,o.x1,o.y1,o.x2,o.y2);
 }
 if(o.type==='door'){
   c.lineCap='butt';c.strokeStyle='#fafcfe';c.lineWidth=.28;line(c,o.x1,o.y1,o.x2,o.y2);
   c.strokeStyle=COLORS.door;c.lineWidth=.065;line(c,o.x1,o.y1,o.x2,o.y2);
   const a=Math.atan2(o.y2-o.y1,o.x2-o.x1),d=Math.hypot(o.x2-o.x1,o.y2-o.y1);
   if(d>0){
     c.strokeStyle=COLORS.door;c.lineWidth=.045;c.setLineDash([.09,.09]);
     c.beginPath();c.arc(o.x1,o.y1,Math.min(1.8,d),a,a+.85);c.stroke();c.setLineDash([]);
     c.fillStyle=COLORS.door;c.beginPath();c.arc(o.x1,o.y1,.11,0,Math.PI*2);c.fill();
   }
 }
 if(o.type==='shutter'){
   c.strokeStyle='#fafcfe';c.lineWidth=.35;line(c,o.x1,o.y1,o.x2,o.y2);
   c.strokeStyle=COLORS.shutter;c.lineCap='butt';c.lineWidth=.14;line(c,o.x1,o.y1,o.x2,o.y2);
   const len=Math.hypot(o.x2-o.x1,o.y2-o.y1);
   if(len>.1){
     const dx=(o.x2-o.x1)/len,dy=(o.y2-o.y1)/len;
     c.strokeStyle='#a06a27';c.lineWidth=.06;
     for(let i=.28;i<len;i+=.37){let x=o.x1+dx*i,y=o.y1+dy*i;line(c,x-dy*.15,y+dx*.15,x+dy*.15,y-dx*.15);}
   }
 }
 if(showText && o.label?.trim()){
   const midX=(o.x1+o.x2)/2,midY=(o.y1+o.y2)/2;
   const size=fontFor(o,baseFont(o));
   c.font=`750 ${size}px system-ui,sans-serif`;c.textAlign='center';c.textBaseline='bottom';
   c.fillStyle=o.type==='shutter'?'#916322':o.type==='wall'?'#405b76':'#2875ac';
   c.fillText(o.label.slice(0,40),midX,midY-.17,Math.max(1.2,Math.hypot(o.x2-o.x1,o.y2-o.y1)+1));
 }
}
  function drawBox(c,o,showText=true){
    if(o.w<=0||o.h<=0)return;
    const color=/^#[0-9a-f]{6}$/i.test(o.color||'')?o.color:'#e99d3e';
    c.save();
    c.fillStyle=color;c.globalAlpha=.22;
    roundRect(c,o.x+.04,o.y+.04,Math.max(.1,o.w-.08),Math.max(.1,o.h-.08),.12);c.fill();
    c.globalAlpha=1;c.strokeStyle=color;c.lineWidth=.11;
    roundRect(c,o.x+.04,o.y+.04,Math.max(.1,o.w-.08),Math.max(.1,o.h-.08),.12);c.stroke();
    c.fillStyle=color;roundRect(c,o.x+.07,o.y+.07,Math.min(.18,o.w*.2),Math.min(.18,o.h*.2),.04);c.fill();
    if(showText&&o.label?.trim()){
      c.beginPath();c.rect(o.x+.1,o.y+.12,Math.max(.1,o.w-.2),Math.max(.1,o.h-.24));c.clip();
      c.fillStyle='#24354a';c.font=`750 ${fontFor(o,baseFont(o))}px system-ui,sans-serif`;
      c.textAlign='center';c.textBaseline='middle';
      c.fillText(o.label.slice(0,90),o.x+o.w/2,o.y+o.h/2,Math.max(.2,o.w-.25));
    }
    c.restore();
  }
  function drawLot(c,o,showText=true) {
 if(o.w<=0||o.h<=0)return;
 const color=o.color||STATUS[o.status]?.color||STATUS.pending.color;
 c.fillStyle=color;c.globalAlpha=.2;roundRect(c,o.x+.06,o.y+.06,o.w-.12,o.h-.12,.17);c.fill();c.globalAlpha=1;
 c.lineWidth=.085;c.strokeStyle=color;roundRect(c,o.x+.045,o.y+.045,o.w-.09,o.h-.09,.13);c.stroke();
 if(o.status==='cleared'){
   c.fillStyle=color;roundRect(c,o.x+.05,o.y+.05,Math.min(.22,o.w/4),o.h-.1,.06);c.fill();
 }
 if(!showText)return;
 const f=fontFor(o,baseFont(o));
 c.textAlign='center';c.textBaseline='middle';c.fillStyle='#263a52';c.font=`800 ${f}px system-ui,sans-serif`;
 const main=o.number?`LOT ${o.number}`:'LOT';
 const label=main.length>18?main.slice(0,17)+'…':main;
 c.save();c.beginPath();c.rect(o.x+.08,o.y+.1,Math.max(0,o.w-.16),Math.max(0,o.h-.2));c.clip();
 c.fillText(label,o.x+o.w/2,o.y+o.h/2-(o.invoice?.length? .17:0),Math.max(.2,o.w-.2));
 if(o.invoice){
   c.fillStyle='#61768d';c.font=`600 ${Math.min(.45,f*.65)}px system-ui,sans-serif`;
   c.fillText(`INV ${o.invoice.slice(0,24)}`,o.x+o.w/2,o.y+o.h/2+.25,Math.max(.2,o.w-.18));
 }
 if(o.status==='cleared'&&o.w>=2){c.fillStyle='#118c5d';c.font='800 .32px system-ui,sans-serif';c.fillText('✓',o.x+o.w-.32,o.y+.35);}
 c.restore();
}
  function drawLock(c,o,showText=true) {
 c.fillStyle='#fff8ea';c.strokeStyle='#bf8534';c.lineWidth=.065;
 c.beginPath();c.arc(o.x,o.y,.29,0,Math.PI*2);c.fill();c.stroke();
 c.strokeStyle='#ac741f';c.lineWidth=.068;
 roundRect(c,o.x-.12,o.y-.03,.24,.16,.035);c.stroke();
 c.beginPath();c.arc(o.x,o.y-.045,.08,Math.PI,0);c.stroke();
 if(showText&&(o.label||o.keyRef)){
   c.font=`750 ${fontFor(o,.27)}px system-ui,sans-serif`;
   c.fillStyle='#806334';c.textAlign='center';c.textBaseline='top';
   c.fillText((o.label||o.keyRef).slice(0,30),o.x,o.y+.39,4.5);
 }
}
  function labelDimensions(c,o) {
 const size=fontFor(o,.44);
 const text=(o.text||'Area').slice(0,80);
 c.save();
 c.font=`750 ${size}px system-ui,sans-serif`;
 const width=Math.min(30,Math.max(1.1,c.measureText(text).width+size*.8));
 c.restore();
 return {size,text,width,height:Math.max(.7,size*1.7)};
}
  function drawLabel(c,o) {
 const d=labelDimensions(c,o);
 c.font=`750 ${d.size}px system-ui,sans-serif`;
 c.textAlign='center';c.textBaseline='middle';
 c.fillStyle='#eff5fbaa';c.strokeStyle='#9baec0';c.lineWidth=.042;
 roundRect(c,o.x-d.width/2,o.y-d.height/2,d.width,d.height,.15);c.fill();c.stroke();
 c.fillStyle=COLORS.label;c.fillText(d.text,o.x,o.y,d.width-.2);
}
  function drawSelection(c,o){
    c.save();c.strokeStyle='#2479f0';c.lineWidth=2/scale();c.setLineDash([5/scale(),4/scale()]);
    if(o.type==='lot'||o.type==='box'){
      c.strokeRect(o.x-.08,o.y-.08,o.w+.16,o.h+.16);c.setLineDash([]);
      c.fillStyle='#fff';c.strokeStyle='#2577e9';c.lineWidth=1.4/scale();
      for(const [x,y] of [[o.x,o.y],[o.x+o.w,o.y],[o.x,o.y+o.h],[o.x+o.w,o.y+o.h]]){
        const r=5/scale();c.fillRect(x-r,y-r,r*2,r*2);c.strokeRect(x-r,y-r,r*2,r*2);
      }
    } else if(['wall','door','shutter'].includes(o.type)){
      line(c,o.x1,o.y1,o.x2,o.y2);c.setLineDash([]);
      c.fillStyle='#2577e9';for(const [x,y] of [[o.x1,o.y1],[o.x2,o.y2]]){c.beginPath();c.arc(x,y,5/scale(),0,Math.PI*2);c.fill();}
    }else{
      c.beginPath();c.arc(o.x,o.y,16/scale(),0,Math.PI*2);c.stroke();
    }
    c.restore();
  }
  function objectsInDrawOrder(){
    const weights={wall:0,door:1,shutter:1,box:1.5,lot:2,lock:3,label:4};
    return [...project.objects].sort((a,b)=>weights[a.type]-weights[b.type]);
  }
  function paint(c,width,height,ox,oy,px,options={}){
    c.fillStyle='#e8edf4';c.fillRect(0,0,width,height);
    c.save();c.translate(ox,oy);c.scale(px,px);
    c.fillStyle='#fafcfe';c.fillRect(0,0,project.cols,project.rows);
    c.save();c.beginPath();c.rect(0,0,project.cols,project.rows);c.clip();
    if(options.grid!==false){
      c.strokeStyle='#e7ecf3';c.lineWidth=.8/px;c.beginPath();
      for(let x=0;x<=project.cols;x++){c.moveTo(x,0);c.lineTo(x,project.rows);}
      for(let y=0;y<=project.rows;y++){c.moveTo(0,y);c.lineTo(project.cols,y);}
      c.stroke();
      c.strokeStyle='#cbd8e6';c.lineWidth=1.15/px;c.beginPath();
      for(let x=0;x<=project.cols;x+=5){c.moveTo(x,0);c.lineTo(x,project.rows);}
      for(let y=0;y<=project.rows;y+=5){c.moveTo(0,y);c.lineTo(project.cols,y);}
      c.stroke();
    }
    const showText=options.showText ?? (project.showText!==false);
    const arr=objectsInDrawOrder();
    for(const o of arr){
      c.save();
      if(['wall','door','shutter'].includes(o.type))drawStructure(c,o,showText);
      else if(o.type==='lot')drawLot(c,o,showText);
      else if(o.type==='box')drawBox(c,o,showText);
      else if(o.type==='lock')drawLock(c,o,showText);
      else if(o.type==='label'&&showText)drawLabel(c,o);
      c.restore();
    }
    if(!options.export){
      const selected=getSelected();if(selected)drawSelection(c,selected);
      if(drawing && drawing.preview && ['wall','door','shutter','lot','box'].includes(drawing.preview.type)){
        c.save();c.globalAlpha=.7;c.setLineDash([.15,.12]);
        if(drawing.preview.type==='lot')drawLot(c,{...drawing.preview,number:'NEW',status:'reserved',invoice:''});
        else if(drawing.preview.type==='box')drawBox(c,{...drawing.preview,color:'#e99d3e',label:'Area'},project.showText!==false);
        else drawStructure(c,drawing.preview);
        c.setLineDash([]);c.restore();
      }
    }
    c.restore();
    c.strokeStyle='#acbdcf';c.lineWidth=Math.max(1,1/px);
    c.strokeRect(0,0,project.cols,project.rows);
    c.restore();
  }
  function draw(){
    const dpr=canvas.width/Math.max(view.width,1);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,view.width,view.height);
    paint(ctx,view.width,view.height,view.offsetX,view.offsetY,scale());
    $('zoomLabel').textContent=`${Math.round(view.zoom*100)}%`;
    const measure=project.cellMeters*5;
    const scaleLength=Math.max(1,5*scale());
    $('scaleMeasure').textContent=`${fmt(measure)} m`;
    $('scaleLine').style.width=`${scaleLength}px`;
    $('scaleHint').textContent=`1 square = ${fmt(project.cellMeters)} m`;
  }
  function exportPNG(){
    const padding=60;
    const px=Math.min(45,Math.max(8,2200/Math.max(project.cols,project.rows)));
    const width=Math.round(project.cols*px+padding*2),height=Math.round(project.rows*px+padding*2);
    const copy=document.createElement('canvas');copy.width=width;copy.height=height;
    const c=copy.getContext('2d');paint(c,width,height,padding,padding,px,{export:true});
    c.fillStyle='#1f354e';c.textAlign='left';c.font='bold 22px system-ui,sans-serif';
    c.fillText(project.name.slice(0,95),padding,32);
    c.font='14px system-ui,sans-serif';c.textAlign='right';
    c.fillText(`1 square = ${fmt(project.cellMeters)} m`,width-padding,32);
    copy.toBlob(blob=>{if(blob){downloadBlob(blob,`${safeName(project.name)}-plan.png`);toast('Site plan exported as PNG');}},'image/png');
  }

  function closestLineDistance(p,o){
    const vx=o.x2-o.x1,vy=o.y2-o.y1,wx=p.x-o.x1,wy=p.y-o.y1;
    const t=minmax((wx*vx+wy*vy)/(vx*vx+vy*vy||1),0,1);
    return Math.hypot(p.x-(o.x1+vx*t),p.y-(o.y1+vy*t));
  }
  function hitObject(p,type=null){
    const a=objectsInDrawOrder().reverse();
    for(const o of a){
      if(type&&o.type!==type)continue;
      if(['lot','box'].includes(o.type)&&p.x>=o.x-.07&&p.x<=o.x+o.w+.07&&p.y>=o.y-.07&&p.y<=o.y+o.h+.07)return o;
      if(['wall','door','shutter'].includes(o.type)&&closestLineDistance(p,o)<=Math.max(.22,9/scale()))return o;
      if(o.type==='lock'&&Math.hypot(p.x-o.x,p.y-o.y)<=Math.max(.4,12/scale()))return o;
      if(o.type==='label'){
        const d=labelDimensions(ctx,o);
        if(Math.abs(p.x-o.x)<=d.width/2+.1&&Math.abs(p.y-o.y)<=d.height/2+.1)return o;
      }
    }
    return null;
  }
  function removeObject(o){
    if(!o)return false;
    const before=snapshot();
    project.objects=project.objects.filter(item=>item.id!==o.id);
    if(settings.selected===o.id)settings.selected=null;
    commit(before);
    toast(`${o.type==='lot'?`Lot ${o.number||'—'}`:o.label||o.type} deleted · Undo to restore`);
    return true;
  }
  function isRectangleCorner(p,o){return ['lot','box'].includes(o?.type)&&Math.hypot(p.x-(o.x+o.w),p.y-(o.y+o.h))<Math.max(.3,12/scale());}
  function segment(start,end,type){
    let a=snapCell(start),b=snapCell(end);
    if(a.x===b.x&&a.y===b.y){b={x:minmax(a.x+(type==='shutter'?3:type==='wall'?4:1),0,project.cols),y:a.y};}
    // Doors, shutters and walls follow a horizontal or vertical structural axis.
    if(Math.abs(b.x-a.x)>=Math.abs(b.y-a.y))b.y=a.y;
    else b.x=a.x;
    if(a.x===b.x&&a.y===b.y){b.y=minmax(a.y+1,0,project.rows);}
    if(a.x===b.x&&a.y===b.y)return null;
    return {x1:a.x,y1:a.y,x2:b.x,y2:b.y};
  }
  function rectFromPoints(start,end){
    const a=snapCell(start),b=snapCell(end);
    if(a.x===b.x&&a.y===b.y){
      return {x:minmax(a.x,0,project.cols-1),y:minmax(a.y,0,project.rows-1),w:Math.max(1,Math.min(3,project.cols-a.x)),h:Math.max(1,Math.min(2,project.rows-a.y))};
    }
    let x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);
    if(!w)w=1;if(!h)h=1;
    return {x:minmax(x,0,project.cols-1),y:minmax(y,0,project.rows-1),w:minmax(w,1,project.cols-x),h:minmax(h,1,project.rows-y)};
  }
  function makeNewObject(type,a,b){
    const obj={id:nextId(),type,notes:''};
    if(type==='lot'){
      Object.assign(obj,rectFromPoints(a,b),{number:String(project.nextLot++),invoice:'',status:'pending',color:''});
    }else if(type==='box'){
      Object.assign(obj,rectFromPoints(a,b),{label:'Area',color:'#e99d3e'});
    }else if(['wall','door','shutter'].includes(type)){
      const s=segment(a,b,type);if(!s)return null;
      Object.assign(obj,s,{label:type==='shutter'?'Roller shutter':type==='door'?'Doorway':''});
    }else if(type==='lock'){
      Object.assign(obj,snapCell(a),{label:`Lock ${project.objects.filter(o=>o.type==='lock').length+1}`,keyRef:'',keyHolder:''});
    }else if(type==='label'){
      Object.assign(obj,snapCell(a),{text:'New area'});
    }
    return obj;
  }
  function moveObject(o,original,dx,dy){
    if(o.type==='lot'||o.type==='box'){
      o.x=minmax(original.x+dx,0,Math.max(0,project.cols-o.w));
      o.y=minmax(original.y+dy,0,Math.max(0,project.rows-o.h));
    } else if(['wall','door','shutter'].includes(o.type)){
      dx=minmax(dx,-Math.min(original.x1,original.x2),project.cols-Math.max(original.x1,original.x2));
      dy=minmax(dy,-Math.min(original.y1,original.y2),project.rows-Math.max(original.y1,original.y2));
      o.x1=original.x1+dx;o.y1=original.y1+dy;o.x2=original.x2+dx;o.y2=original.y2+dy;
    }else{o.x=minmax(original.x+dx,0,project.cols);o.y=minmax(original.y+dy,0,project.rows);}
  }
  function startPinch(){
    if(pointers.size<2)return;
    const pts=[...pointers.values()].slice(0,2);
    const a=pts[0],b=pts[1];const midpoint={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    const rect=canvas.getBoundingClientRect();midpoint.x-=rect.left;midpoint.y-=rect.top;
    pinch={initialDistance:Math.max(8,Math.hypot(a.x-b.x,a.y-b.y)),initialZoom:view.zoom,
      worldX:(midpoint.x-view.offsetX)/scale(),worldY:(midpoint.y-view.offsetY)/scale()};
    drawing=null;
  }
  function updatePinch(){
    if(!pinch||pointers.size<2)return;
    const pts=[...pointers.values()].slice(0,2);
    const a=pts[0],b=pts[1],r=canvas.getBoundingClientRect();
    const midX=(a.x+b.x)/2-r.left,midY=(a.y+b.y)/2-r.top;
    const distance=Math.max(8,Math.hypot(a.x-b.x,a.y-b.y));
    view.zoom=minmax(pinch.initialZoom*distance/pinch.initialDistance,.1,7);
    view.offsetX=midX-pinch.worldX*scale();view.offsetY=midY-pinch.worldY*scale();
    view.fitted=false;drawSoon();
  }
  function onPointerDown(ev){
    if(ev.button!==0&&ev.button!==1)return;
    if(ev.cancelable)ev.preventDefault();
    try{canvas.setPointerCapture(ev.pointerId);}catch{}
    pointers.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
    if(pointers.size>=2){startPinch();return;}
    const p=toWorld(ev.clientX,ev.clientY);
    if(ev.button===1||settings.tool==='pan'){
      drawing={action:'pan',startClient:{x:ev.clientX,y:ev.clientY},startOffset:{x:view.offsetX,y:view.offsetY}};return;
    }
    if(settings.tool==='green'){
      const l=hitObject(p,'lot');
      if(l){const before=snapshot();l.status=l.status==='cleared'?'pending':'cleared';commit(before);
        toast(`Lot ${l.number||'?'} ${l.status==='cleared'?'cleared ✓':'set back to pending'}`);}
      return;
    }
    if(settings.tool==='delete'){
      drawing={action:'delete',startClient:{x:ev.clientX,y:ev.clientY}};
      return;
    }
    if(settings.tool==='select'){
      const target=hitObject(p);
      if(!target){selectObject(null);drawing=null;return;}
      const resize=target.id===settings.selected&&isRectangleCorner(p,target);
      selectObject(target.id);
      drawing={action:resize?'resize':'move',id:target.id,original:clone(target),before:snapshot(),startWorld:p};
      return;
    }
    drawing={action:'create',type:settings.tool,startWorld:p,endWorld:p,preview:null};
  }
  function onPointerMove(ev){
    if(!pointers.has(ev.pointerId))return;
    pointers.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});
    if(pointers.size>=2){updatePinch();return;}
    if(!drawing)return;
    if(drawing.action==='pan'){
      view.offsetX=drawing.startOffset.x+ev.clientX-drawing.startClient.x;
      view.offsetY=drawing.startOffset.y+ev.clientY-drawing.startClient.y;view.fitted=false;drawSoon();return;
    }
    const p=toWorld(ev.clientX,ev.clientY);
    if(drawing.action==='create'){
      drawing.endWorld=p;
      if(['lot','box'].includes(drawing.type))drawing.preview={type:drawing.type,...rectFromPoints(drawing.startWorld,p)};
      else if(['wall','door','shutter'].includes(drawing.type)){
        const s=segment(drawing.startWorld,p,drawing.type);drawing.preview=s?{type:drawing.type,...s}:null;
      }
      drawSoon();return;
    }
    const o=project.objects.find(x=>x.id===drawing.id);if(!o)return;
    const dx=Math.round(p.x-drawing.startWorld.x),dy=Math.round(p.y-drawing.startWorld.y);
    if(drawing.action==='move')moveObject(o,drawing.original,dx,dy);
    else if(drawing.action==='resize'){
      o.w=minmax(drawing.original.w+dx,1,project.cols-o.x);
      o.h=minmax(drawing.original.h+dy,1,project.rows-o.y);
    }
    drawSoon();
  }
  function onPointerUp(ev,cancelled=false){
    pointers.delete(ev.pointerId);
    if(pinch){if(pointers.size<2)pinch=null;drawing=null;return;}
    if(!drawing)return;
    const d=drawing;drawing=null;
    if(d.action==='delete'){
      // Delete only on a completed tap; moving a finger or cancelling a gesture
      // cannot accidentally erase something.
      if(!cancelled&&Math.hypot(ev.clientX-d.startClient.x,ev.clientY-d.startClient.y)<12){
        removeObject(hitObject(toWorld(ev.clientX,ev.clientY)));
      }
      return;
    }
    if(d.action==='move'||d.action==='resize'){
      if(cancelled){const o=project.objects.find(x=>x.id===d.id);if(o)Object.assign(o,d.original);drawSoon();return;}
      commit(d.before);return;
    }
    if(d.action!=='create'||cancelled)return;
    const point=toWorld(ev.clientX,ev.clientY);
    const before=snapshot();
    const object=makeNewObject(d.type,d.startWorld,point);
    if(!object)return;
    project.objects.push(object);
    commit(before);selectObject(object.id);
    // Keep a drawing tool active so the user can create several items in a row.
    if(object.type==='lot')toast(`Lot ${object.number} added — set invoice details in the panel`);
    else if(object.type==='box')toast('Area box added — choose a label and colour in Details');
    else if(object.type==='lock')toast('Lock added — record its key reference in Details');
  }

  function optionsHtml(values,selected){
    return values.map(([v,t])=>`<option value="${e(v)}" ${String(v)===String(selected)?'selected':''}>${e(t)}</option>`).join('');
  }
  function field(label,name,val,type='text',extra=''){
    if(type==='textarea')return `<div class="field"><label for="fld-${e(name)}">${e(label)}</label><textarea id="fld-${e(name)}" data-field="${e(name)}" rows="3" ${extra}>${e(val)}</textarea></div>`;
    if(type==='select')return `<div class="field"><label for="fld-${e(name)}">${e(label)}</label><select id="fld-${e(name)}" data-field="${e(name)}" ${extra}>${val}</select></div>`;
    return `<div class="field"><label for="fld-${e(name)}">${e(label)}</label><input id="fld-${e(name)}" data-field="${e(name)}" type="${type}" value="${e(val)}" ${extra}></div>`;
  }
  function fontControlHtml(o) {
 const base=baseFont(o);
 const custom=o.fontSize!==undefined;
 return `<div class="font-tools-title">INDIVIDUAL MAP TEXT</div>
   <div class="font-controls"><button class="btn btn-light" data-action="labelSmaller" title="Decrease this object's text size" aria-label="Smaller text for selected item">A−</button>
   <span>${custom?'Custom size':'Automatic size'} · global ${Math.round((project.textScale??1)*100)}%</span>
   <button class="btn btn-light" data-action="labelLarger" title="Increase this object's text size" aria-label="Larger text for selected item">A+</button></div>
   ${field('This item’s font size (grid squares)','fontSize',custom?o.fontSize:base,'number','min="0.15" max="2.5" step="0.05"')}
   <button class="font-reset" data-action="resetFont" ${custom?'':'disabled'}>Reset this item to automatic size</button>
   <p class="field-help">Site-wide text size applies on top. These settings affect only the selected item.</p>`;
}
  function fieldsXY(o,keys){
    return `<div class="field-grid">${keys.map(key=>field(key.toUpperCase()+' (grid)',key,o[key],'number','step="1"')).join('')}</div>`;
  }
  function renderPanel(){
    if(settings.tab==='lots'){renderLotsPanel();return;}
    if(settings.tab==='access'){renderAccessPanel();return;}
    const o=getSelected();
    if(!o){
      panel.innerHTML=`<h2 class="panel-title">Site Settings</h2><p class="panel-description">Set up the site to match your building. All measurements and object positions use this grid.</p>
        ${field('Site name','siteName',project.name)}
        <div class="field-grid">${field('Grid width (squares)','cols',project.cols,'number','min="8" max="250"')}${field('Grid height (squares)','rows',project.rows,'number','min="8" max="250"')}</div>
        ${field('Metres per square','cellMeters',project.cellMeters,'number','min="0.1" max="100" step="0.1"')}
        <p class="field-help">Current site footprint: ${fmt(project.cols*project.cellMeters)} m × ${fmt(project.rows*project.cellMeters)} m. Existing drawings remain at their grid coordinates if you change the scale.</p>
        <div class="divider"></div><h3 class="panel-title">Map text</h3>
        ${field('Size of all map text (%)','textScalePercent',Math.round((project.textScale??1)*100),'number','min="50" max="250" step="5"')}
        <p class="field-help">Scales lot numbers, invoices, labels and access references together. Individual font adjustments remain independent.</p>
        <div class="panel-actions"><button class="btn btn-light" data-action="toggleText">${project.showText===false?'Show all map text':'Hide all map text'}</button><button class="btn btn-light" data-action="printPreview">Print preview</button></div>
        <div class="divider"></div><h3 class="panel-title">Areas & hazards</h3>
        <p class="field-help">Draw boxes using Area / Hazard Box (B). Select one below to edit it, even if it overlaps another object.</p>
        ${project.objects.some(x=>x.type==='box') ?
          `<div class="box-register">${project.objects.filter(x=>x.type==='box').map(x=>
            `<button type="button" class="box-register-item" data-select="${e(x.id)}"><span class="box-swatch" style="background:${x.color}"></span><span>${e(x.label||'Unlabelled area')}</span><span class="box-register-size">${x.w} × ${x.h}</span></button>`).join('')}</div>`
          : '<p class="field-help">No area boxes yet.</p>'}
        <div class="divider"></div><h3 class="panel-title">Lot Colour Key</h3><div class="legend-grid">${Object.values(STATUS).map(s=>`<div class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.label}</div>`).join('')}</div>
        <div class="helper-card"><strong>How local saving works</strong><p>Every edit is saved automatically in this browser on this device. Export JSON to share your plan, transfer it to another device or keep a backup. Clearing browser data can erase local copies.</p></div>
        <div class="panel-actions"><button class="btn btn-light" data-action="png">Save plan as PNG</button><button class="btn btn-light" data-action="csv">Export lots CSV</button><button class="btn btn-light" data-action="duplicateSite">Duplicate site</button></div>
        <div class="divider"></div>
        <div class="clear-canvas-settings">
          <strong>Start this site again</strong>
          <p>Erase every placed lot, invoice link, wall, lock, key and label. Clearing the canvas cannot be undone. Back up your site first.</p>
          <button class="danger-link" data-action="clearCanvas">Clear canvas permanently…</button>
        </div>
        <button class="danger-link" data-action="deleteSite">Delete entire site from browser</button>`;
      return;
    }
    const title={lot:`Lot ${o.number||'—'}`,box:`Area: ${o.label||'Untitled'}`,wall:'Wall',door:'Doorway',shutter:'Roller Shutter',lock:'Lock & Key',label:'Text Label'}[o.type];
    let html=`<h2 class="panel-title">${e(title)} <span style="font-size:10px;font-weight:600;color:#a2b0c0">· EDIT</span></h2><p class="panel-description">Changes save automatically when you finish editing a field.</p>`;
    if(o.type==='lot'){
      html+=field('Lot number','number',o.number)+field('Invoice number(s)','invoice',o.invoice,'text','placeholder="e.g. INV-1042"');
      html+=field('Clearance status','status',optionsHtml(Object.entries(STATUS).map(([k,v])=>[k,v.label]),o.status),'select');
      html+=`<div class="field-grid">${field('Custom colour','color',o.color||STATUS[o.status].color,'color')}
        <div class="field"><label>Use status colour</label><button class="btn btn-light" data-action="resetColor" style="width:100%;min-height:40px">Reset colour</button></div></div>`;
      html+=`<p class="field-help">Colour can be customised independently of clearance status. Green means cleared in the progress dashboard.</p>`;
      html+=`<div class="divider"></div><h3 class="panel-title">Footprint</h3>${fieldsXY(o,['x','y','w','h'])}`;
      html+=`<p class="field-help">Physical size: ${fmt(o.w*project.cellMeters)} × ${fmt(o.h*project.cellMeters)} metres.</p>`;
      html+=fontControlHtml(o);
      html+=field('Notes / buyer / collection details','notes',o.notes,'textarea');
      html+=`<div class="panel-actions"><button class="btn btn-success" data-action="clearSelected">✓ ${o.status==='cleared'?'Reopen lot':'Green off lot'}</button><button class="btn btn-light" data-action="duplicateObject">Duplicate</button></div>`;
    }else if(o.type==='box'){
      html+=field('Area / hazard label','label',o.label,'text','placeholder="e.g. Hazard, Obstruction, Keep Clear"');
      html+=`<div class="field"><label>Optional quick presets</label><div class="box-presets">
        <button type="button" data-box-preset="hazard">Hazard</button>
        <button type="button" data-box-preset="obstruction">Obstruction</button>
        <button type="button" data-box-preset="keepclear">Keep clear</button>
        <button type="button" data-box-preset="storage">Storage</button>
        <button type="button" data-box-preset="workarea">Work area</button>
      </div></div>`;
      html+=field('Box colour','color',o.color||'#e99d3e','color');
      html+=`<p class="field-help">A box has no invoice, lot number or clearance status. Presets are optional: you can freely change its text and colour.</p>`;
      html+=`<div class="divider"></div><h3 class="panel-title">Area dimensions</h3>${fieldsXY(o,['x','y','w','h'])}`;
      html+=`<p class="field-help">Physical size: ${fmt(o.w*project.cellMeters)} × ${fmt(o.h*project.cellMeters)} m. Drag to move, or select then drag the bottom-right corner to resize.</p>`;
      html+=fontControlHtml(o)+field('Area / safety notes','notes',o.notes,'textarea');
      html+=`<div class="panel-actions"><button class="btn btn-light" data-action="duplicateObject">Duplicate box</button></div>`;
    }else if(o.type==='lock'){
      html+=field('Lock label / reference','label',o.label)+field('Associated key ID','keyRef',o.keyRef,'text','placeholder="e.g. Key K-03"');
      html+=field('Key held by / location','keyHolder',o.keyHolder,'text','placeholder="e.g. Site manager / key safe"');
      html+=fontControlHtml(o)+fieldsXY(o,['x','y'])+field('Access notes','notes',o.notes,'textarea');
    }else if(o.type==='label'){
      html+=field('Text to display','text',o.text);
      html+=fontControlHtml(o);
      html+=fieldsXY(o,['x','y'])+field('Notes','notes',o.notes,'textarea');
    }else{
      html+=field('Name / reference','label',o.label)+fontControlHtml(o)+fieldsXY(o,['x1','y1','x2','y2']);
      html+=`<p class="field-help">Length: ${fmt(Math.hypot(o.x2-o.x1,o.y2-o.y1)*project.cellMeters)} metres. Draw or move on the grid to reposition.</p>`;
      html+=field('Notes','notes',o.notes,'textarea');
    }
    html+=`<div class="divider"></div><div class="panel-actions"><button class="btn btn-light" data-action="deselect">Deselect</button><button class="btn btn-light" data-action="focus">Centre on plan</button></div><button class="danger-link" data-action="deleteObject">Delete ${e(o.type)} from plan</button>`;
    panel.innerHTML=html;
  }
  function renderLotsPanel(){
    panel.innerHTML=`<h2 class="panel-title">Lot Register</h2><p class="panel-description">Select a lot to edit its invoice, location or collection status. Use ✓ to green it off immediately.</p>
      <div class="lot-tools"><input id="lotSearch" class="search-input" type="search" placeholder="Search lot, invoice or notes…" value="${e(settings.lotSearch)}" aria-label="Search lots"><div class="filter-row" id="lotFilters">${[['all','All'],['pending','Pending'],['cleared','Cleared'],['hold','Hold'],['issue','Issues'],['reserved','Reserved']].map(([k,v])=>`<button class="filter-chip ${settings.lotFilter===k?'active':''}" data-filter="${k}">${v}</button>`).join('')}</div></div>
      <div id="lotList"></div>
      <div class="divider"></div><div class="panel-actions"><button class="btn btn-light" data-action="csv">Export lot register CSV</button><button class="btn btn-primary" data-action="drawLot">+ Draw lot</button></div>`;
    renderLotList();
  }
  function renderLotList(){
    const target=$('lotList');if(!target)return;
    const query=settings.lotSearch.toLowerCase().trim();
    const lots=project.objects.filter(o=>o.type==='lot'&&(settings.lotFilter==='all'||o.status===settings.lotFilter))
      .filter(o=>[o.number,o.invoice,o.notes,o.status].join(' ').toLowerCase().includes(query));
    if(!lots.length){target.innerHTML='<div class="empty-list">No matching lots yet. Choose <b>Draw Lot</b> to place one on the site plan.</div>';return;}
    target.innerHTML=lots.map(o=>{
      const cleared=o.status==='cleared';const c=o.color||STATUS[o.status].color;
      return `<div class="list-item-card ${settings.selected===o.id?'selected':''}" data-select="${e(o.id)}" tabindex="0" role="button" aria-label="Edit lot ${e(o.number)}">
      <div class="list-card-top"><span class="lot-swatch" style="background:${c}"></span><div class="lot-card-main"><strong>Lot ${e(o.number||'—')}</strong><small>${o.invoice?`Invoice: ${e(o.invoice)}`:'No invoice linked'} · ${e(STATUS[o.status].label)}</small></div>
      <div class="lot-card-actions"><button class="quick-clear ${cleared?'is-cleared':''}" data-clear="${e(o.id)}" title="${cleared?'Mark pending':'Mark cleared'}" aria-label="${cleared?'Reopen':'Clear'} lot ${e(o.number)}">${cleared?'↶':'✓'}</button></div></div></div>`;
    }).join('');
  }
  function renderAccessPanel(){
    const accesses=project.objects.filter(o=>['lock','door','shutter'].includes(o.type));
    const locks=accesses.filter(o=>o.type==='lock'),entries=accesses.filter(o=>o.type!=='lock');
    panel.innerHTML=`<h2 class="panel-title">Keys & Access</h2><p class="panel-description">A quick reference for your site crew during viewing, collection and clearance.</p>
      <h3 class="panel-title">Locks & Keys <span class="chip">${locks.length}</span></h3>
      ${locks.length?locks.map(o=>`<div class="list-item-card" data-select="${e(o.id)}" tabindex="0" role="button"><div class="key-row"><span class="key-icon">⚿</span><div class="lot-card-main"><strong>${e(o.label||'Unlabelled lock')}</strong><small>Key: ${e(o.keyRef||'Not assigned')}</small></div></div>${o.keyHolder?`<div class="key-sub">Held by: ${e(o.keyHolder)}</div>`:''}${o.notes?`<div class="key-sub">${e(o.notes.slice(0,100))}</div>`:''}</div>`).join(''):'<div class="empty-list">No locks marked on this site yet.</div>'}
      <div class="divider"></div><h3 class="panel-title">Entrances <span class="chip">${entries.length}</span></h3>
      ${entries.length?entries.map(o=>`<div class="list-item-card" data-select="${e(o.id)}" tabindex="0" role="button"><div class="lot-card-main"><strong>${o.type==='shutter'?'▥':'⇥'} ${e(o.label||o.type)}</strong><small>${fmt(Math.hypot(o.x2-o.x1,o.y2-o.y1)*project.cellMeters)} m opening</small></div>${o.notes?`<div class="key-sub">${e(o.notes.slice(0,100))}</div>`:''}</div>`).join(''):'<div class="empty-list">No entrances marked yet.</div>'}
      <div class="panel-actions"><button class="btn btn-light" data-action="drawLock">+ Add lock</button><button class="btn btn-light" data-action="drawShutter">+ Add shutter</button></div>`;
  }
  function updateField(input){
    const key=input.dataset.field;if(!key)return;
    const obj=getSelected();
    const before=snapshot();
    let value=input.value;
    if(!obj){
      if(key==='siteName')project.name=value.trim().slice(0,140)||project.name;
      else if(['cols','rows'].includes(key)){
        const num=Number(value);if(!Number.isFinite(num)||num<8||num>250){toast('Grid dimensions must be between 8 and 250.');renderPanel();return;}
        project[key]=Math.round(num);
      }else if(key==='cellMeters'){
        const num=Number(value);if(!Number.isFinite(num)||num<.1||num>100){toast('Scale must be between 0.1 and 100 metres per square.');renderPanel();return;}
        project.cellMeters=Math.round(num*100)/100;
      }else if(key==='textScalePercent'){
        const num=Number(value);if(!Number.isFinite(num)||num<50||num>250){toast('Text size must be 50–250%.');renderPanel();return;}
        project.textScale=Math.round(num)/100;
      }
      commit(before);
      if(['cols','rows'].includes(key))fitView();
      return;
    }
    if(['x','y','w','h','x1','y1','x2','y2'].includes(key)){
      if(value.trim()===''||!Number.isFinite(Number(value))) {renderPanel();return;}
      value=Math.round(Number(value));
      if(obj.type==='lot'||obj.type==='box'){
        if(key==='w')value=minmax(value,1,project.cols-obj.x);
        else if(key==='h')value=minmax(value,1,project.rows-obj.y);
        else if(key==='x')value=minmax(value,0,project.cols-obj.w);
        else if(key==='y')value=minmax(value,0,project.rows-obj.h);
      }else if(['x1','x2'].includes(key))value=minmax(value,0,project.cols);
      else if(['y1','y2'].includes(key))value=minmax(value,0,project.rows);
      else if(key==='x')value=minmax(value,0,project.cols);
      else if(key==='y')value=minmax(value,0,project.rows);
    }
    if(key==='fontSize'){
      const parsed=Number(value);
      if(!Number.isFinite(parsed)||parsed<.15||parsed>2.5){toast('Font size must be 0.15 to 2.5 grid squares.');renderPanel();return;}
      value=Math.round(parsed*100)/100;
    }
    if(key==='color'&&!/^#[0-9a-f]{6}$/i.test(value))return;
    obj[key]=value;
    commit(before);
  }
  function setBoxPreset(key){
    const o=getSelected();if(!o||o.type!=='box')return;
    const options={
      hazard:['Hazard','#e36b5f'],obstruction:['Obstruction','#e6a044'],
      keepclear:['Keep Clear','#e9c658'],storage:['Storage Area','#4c91cb'],
      workarea:['Work Area','#8b75c8']
    };
    const chosen=options[key];if(!chosen)return;
    const before=snapshot();o.label=chosen[0];o.color=chosen[1];commit(before);
    toast(`Area labelled ${o.label}; you can customise it further.`);
  }
  async function handleAction(action){
    const o=getSelected();
    if(action==='csv'){exportCSV();return;}
    if(action==='png'){exportPNG();return;}
    if(action==='printPreview'){openPrintPreview();return;}
    if(action==='toggleText'){setTextVisibility();return;}
    if(action==='duplicateSite'){duplicateSite();return;}
    if(action==='deleteSite'){await deleteSite();return;}
    if(action==='clearCanvas'){requestClearCanvas();return;}
    if(action==='drawLot'){setTool('lot');return;}
    if(action==='drawLock'){setTool('lock');return;}
    if(action==='drawShutter'){setTool('shutter');return;}
    if(action==='deselect'){selectObject(null);return;}
    if(action==='focus'){if(o)centerOn(o);return;}
    if(!o)return;
    if(action==='deleteObject'){
      if(!await confirmAction('Delete this item?',`Remove ${o.type==='lot'?`lot ${o.number}`:o.label||o.type} from the site plan?`))return;
      removeObject(o);return;
    }
    const before=snapshot();
    if(['labelSmaller','labelLarger'].includes(action)){
      const direction=action==='labelLarger'?1:-1;
      o.fontSize=Math.round(minmax((o.fontSize??baseFont(o))+direction*.1,.15,2.5)*100)/100;
      commit(before);return;
    }
    if(action==='resetFont'){
      delete o.fontSize;commit(before);return;
    }
    if(action==='resetColor')o.color='';
    if(action==='clearSelected')o.status=o.status==='cleared'?'pending':'cleared';
    if(action==='duplicateObject'){
      const copy=clone(o);copy.id=nextId();
      if(copy.type==='lot')copy.number=String(project.nextLot++);
      if(copy.type==='lot'||copy.type==='box'){
        copy.x=minmax(copy.x+1,0,Math.max(0,project.cols-copy.w));
        copy.y=minmax(copy.y+1,0,Math.max(0,project.rows-copy.h));
      }
      project.objects.push(copy);settings.selected=copy.id;
    }
    commit(before);
  }
  function setGlobalTextPercent(raw) {
 const percent=Number(raw);
 if(!Number.isFinite(percent)||percent<50||percent>250){
   toast('Choose a text size between 50% and 250%.');
   refreshStats();renderPanel();return;
 }
 const before=snapshot();
 project.textScale=Math.round(percent)/100;
 commit(before);
}

  function setTextVisibility() {
 const before=snapshot();
 project.showText=project.showText===false;
 commit(before);
 toast(project.showText===false?'Map text hidden (data preserved)':'Map text visible');
}

  function openPrintPreview() {
 const dialog=$('printDialog');
 $('printPaper').value='A4';
 $('printOrientation').value=project.cols>=project.rows?'landscape':'portrait';
 $('printText').checked=project.showText!==false;
 $('printGrid').checked=true;
 dialog.showModal();
 renderPrintPreview();
}

  function renderPrintPreview() {
 const paper=$('printPaper').value==='A3'?'A3':'A4';
 const orientation=$('printOrientation').value==='portrait'?'portrait':'landscape';
 const showText=$('printText').checked;
 const grid=$('printGrid').checked;
 const sizes=paper==='A3'?[297,420]:[210,297];
 const mmW=orientation==='landscape'?sizes[1]:sizes[0],mmH=orientation==='landscape'?sizes[0]:sizes[1];
 const mapW=Math.max(1,Math.round((mmW-24)*5));
 const mapH=Math.max(1,Math.round((mmH-52)*5));
 const render=document.createElement('canvas');render.width=mapW;render.height=mapH;
 const c=render.getContext('2d');
 const px=Math.min((mapW-10)/project.cols,(mapH-10)/project.rows);
 const ox=(mapW-project.cols*px)/2,oy=(mapH-project.rows*px)/2;
 paint(c,mapW,mapH,ox,oy,px,{export:true,grid,showText});
 $('printMap').src=render.toDataURL('image/png');
 $('printPage').style.aspectRatio=`${mmW} / ${mmH}`;
 $('printSiteName').textContent=project.name;
 $('printMeta').textContent=`${fmt(project.cols*project.cellMeters)} m × ${fmt(project.rows*project.cellMeters)} m · ${paper} ${orientation}`;
 $('printScale').textContent=`1 grid square = ${fmt(project.cellMeters)} m · diagram fitted to page (not a measured print scale)`;
 const total=project.objects.filter(x=>x.type==='lot');
 const done=total.filter(x=>x.status==='cleared').length;
 $('printCounts').textContent=`Lots: ${total.length} · Cleared: ${done} · Pending: ${total.length-done}`;
 $('printSheetSize').textContent=`${paper} ${orientation} · labels ${showText?'on':'off'} · grid ${grid?'on':'off'}`;
 $('printPageRules').textContent=`@media print{@page{size:${paper} ${orientation};margin:0}}`;
}

  function printPlan() {
 renderPrintPreview();
 requestAnimationFrame(()=>window.print());
}
  function wireUI(){
    for(const btn of document.querySelectorAll('button[data-tool]'))btn.addEventListener('click',()=>setTool(btn.dataset.tool));
    for(const btn of document.querySelectorAll('[data-tab]'))btn.addEventListener('click',()=>switchTab(btn.dataset.tab));
    $('projectSelect').addEventListener('change',event=>changeProject(event.target.value));
    $('renameBtn').addEventListener('click',renameSite);$('newBtn').addEventListener('click',newSite);
    $('exportBtn').addEventListener('click',exportJSON);
    $('importBtn').addEventListener('click',()=>$('importFile').click());
    $('importFile').addEventListener('change',event=>{importJSON(event.target.files[0]);event.target.value='';});
    $('undoBtn').addEventListener('click',undo);$('redoBtn').addEventListener('click',redo);
    $('clearCanvasBackup').addEventListener('click',exportJSON);
    $('clearCanvasCancel').addEventListener('click',()=>$('clearCanvasDialog').close());
    $('clearCanvasPhrase').addEventListener('input',checkClearCanvasConfirmation);
    $('clearCanvasUnderstand').addEventListener('change',checkClearCanvasConfirmation);
    $('clearCanvasConfirm').addEventListener('click',clearCanvasPermanently);
    $('fitBtn').addEventListener('click',fitView);
    $('textScaleInput').addEventListener('change',ev=>setGlobalTextPercent(ev.target.value));
    $('textToggleBtn').addEventListener('click',setTextVisibility);
    $('printPreviewBtn').addEventListener('click',openPrintPreview);
    $('printCloseBtn').addEventListener('click',()=>$('printDialog').close());
    for(const id of ['printPaper','printOrientation','printText','printGrid']){
      $(id).addEventListener('change',renderPrintPreview);
    }
    $('printGoBtn').addEventListener('click',printPlan);
    $('printDialog').addEventListener('click',ev=>{
      if(ev.target===$('printDialog'))$('printDialog').close();
    });
    $('zoomIn').addEventListener('click',()=>zoomAt(1.25,view.width/2,view.height/2));
    $('zoomOut').addEventListener('click',()=>zoomAt(.8,view.width/2,view.height/2));
    $('mobilePan').addEventListener('click',()=>setTool(settings.tool==='pan'?'select':'pan'));
    $('mobileGreen').addEventListener('click',()=>setTool(settings.tool==='green'?'select':'green'));
    $('mobileDelete').addEventListener('click',()=>setTool(settings.tool==='delete'?'select':'delete'));
    canvas.addEventListener('pointerdown',onPointerDown);
    canvas.addEventListener('pointermove',onPointerMove);
    canvas.addEventListener('pointerup',event=>onPointerUp(event));
    canvas.addEventListener('pointercancel',event=>onPointerUp(event,true));
    canvas.addEventListener('contextmenu',event=>event.preventDefault());
    canvas.addEventListener('wheel',event=>{
      event.preventDefault();const r=canvas.getBoundingClientRect();
      zoomAt(event.deltaY<0?1.12:1/1.12,event.clientX-r.left,event.clientY-r.top);
    },{passive:false});
    panel.addEventListener('change',event=>{
      if(event.target.matches('[data-field]'))updateField(event.target);
    });
    panel.addEventListener('input',event=>{
      if(event.target.id==='lotSearch'){settings.lotSearch=event.target.value;renderLotList();}
    });
    panel.addEventListener('click',event=>{
      const clear=event.target.closest('[data-clear]');
      if(clear){event.stopPropagation();
        const lot=project.objects.find(o=>o.id===clear.dataset.clear&&o.type==='lot');
        if(lot){const before=snapshot();lot.status=lot.status==='cleared'?'pending':'cleared';commit(before);}return;
      }
      const filter=event.target.closest('[data-filter]');
      if(filter){settings.lotFilter=filter.dataset.filter;for(const b of panel.querySelectorAll('[data-filter]'))b.classList.toggle('active',b===filter);renderLotList();return;}
      const card=event.target.closest('[data-select]');if(card){selectObject(card.dataset.select,true,true);return;}
      const preset=event.target.closest('[data-box-preset]');
      if(preset){setBoxPreset(preset.dataset.boxPreset);return;}
      const action=event.target.closest('[data-action]');if(action)handleAction(action.dataset.action);
    });
    panel.addEventListener('keydown',event=>{
      if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-select]')){
        event.preventDefault();selectObject(event.target.dataset.select,true,true);
      }
    });
    document.addEventListener('keydown',event=>{
      const target=event.target;
      if(target instanceof HTMLElement && (target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(target.tagName)))return;
      if($('confirmDialog').open||$('printDialog').open||$('clearCanvasDialog').open)return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){
        event.preventDefault();if(event.shiftKey)redo();else undo();return;
      }
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){
        event.preventDefault();redo();return;
      }
      if(['Delete','Backspace'].includes(event.key)&&getSelected()){
        event.preventDefault();removeObject(getSelected());return;
      }
      if(event.key==='Escape'){selectObject(null);setTool('select');return;}
      if(event.code==='Space'&&!toolBeforeSpace){
        event.preventDefault();toolBeforeSpace=settings.tool;setTool('pan');return;
      }
      const map={v:'select',e:'delete',p:'pan',w:'wall',d:'door',s:'shutter',l:'lot',b:'box',g:'green',k:'lock',t:'label'};
      if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&map[event.key.toLowerCase()])setTool(map[event.key.toLowerCase()]);
    });
    document.addEventListener('keyup',event=>{
      if(event.code==='Space'&&toolBeforeSpace){setTool(toolBeforeSpace);toolBeforeSpace=null;}
    });
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&saveTimer)storeNow();});
    window.addEventListener('beforeunload',()=>{if(saveTimer)storeNow();});
    let resizeQueued=false;
    new ResizeObserver(()=>{
      if(resizeQueued)return;
      resizeQueued=true;
      requestAnimationFrame(()=>{resizeQueued=false;resizeCanvas();});
    }).observe(wrap);
  }
  load();wireUI();refreshProjectSelector();refreshStats();renderPanel();setTool('select');
  requestAnimationFrame(()=>{resizeCanvas();fitView();});
})();
