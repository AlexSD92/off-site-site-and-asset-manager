/* YardMap: a dependency-free, offline auction-site planner.
   All project data stays in browser localStorage unless explicitly exported. */
(() => {
  'use strict';

  const STORE_KEY = 'yardmap.projects.v1';
  const ADMIN_STORE_KEY = 'yardmap.adminReports.v1';
  const COLLECTION_STORE_KEY = 'yardmap.collections.v1';
  const UI_PREFS_KEY = 'yardmap.ui.v1';
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
    select: 'Select or move individual objects. Drag blank grid space to pan the view.',
    'move-all': 'Drag anywhere to move every item together. Undo reverses the whole movement.',
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
  const panelHome = panel.parentNode; // move the real editor, not a cloned copy
  function syncFullscreenDetails(){
    const drawer=$('fullscreenDetailsDrawer'),host=$('fullscreenDetailsHost');
    const selected=isMapFullscreen()&&settings.mode==='map'?getSelected():null;
    if(selected){
      if(panel.parentNode!==host)host.appendChild(panel);
      drawer.hidden=false;
      $('fullscreenDrawerTitle').textContent=selected.type==='lot'
        ?'Lot '+(selected.number||'—')+' · Details'
        :selected.type[0].toUpperCase()+selected.type.slice(1)+' details';
    }else{
      drawer.hidden=true;
      if(panel.parentNode!==panelHome)panelHome.appendChild(panel);
    }
  }
  const COLORS = { wall:'#354963', door:'#307fc9', shutter:'#bf8636', lock:'#d19827', label:'#314969' };
  const minmax = (x,min,max) => Math.min(max,Math.max(min,x));
  const clone = value => JSON.parse(JSON.stringify(value));
  const nextId = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeName = s => String(s || 'site').replace(/[^a-z0-9 _-]/gi, '_').trim().replace(/\s+/g,'-').slice(0,70) || 'site';
  const fmt = n => Number(n.toFixed(2)).toString();
  const settings = { tab:'properties', mode:'map', lastAdminTab:'admin', tool:'select',
    lotFilter:'all', lotSearch:'', selected:null, panFromSpace:false,
    collectionsView:'list', collectionsSelectedKey:null, collectionsSearch:'',
    collectionsSort:'lotAsc',lotSort:'numberAsc' };
  const view = {zoom:1, offsetX:0, offsetY:0, width:900, height:580, fitted:false, rotation:0};
  let uiPrefs={theme:'system',largerText:false,mapToolsCollapsed:false,mapDetailsCollapsed:false};
  let mapFocusRestore=null;
  function applyMapPanelState(){
    const shell=$('appShell');
    shell.classList.toggle('map-tools-collapsed',uiPrefs.mapToolsCollapsed===true);
    shell.classList.toggle('map-details-collapsed',uiPrefs.mapDetailsCollapsed===true);
    const tools=$('toggleToolsBtn'),details=$('toggleDetailsBtn'),focus=$('focusMapBtn');
    const toolsShown=!uiPrefs.mapToolsCollapsed,detailsShown=!uiPrefs.mapDetailsCollapsed;
    tools.textContent=toolsShown?'☰ Hide tools':'☰ Show tools';
    tools.setAttribute('aria-expanded',String(toolsShown));
    tools.setAttribute('aria-label',toolsShown?'Hide drawing tools':'Show drawing tools');
    details.textContent=detailsShown?'▣ Hide details':'▣ Show details';
    details.setAttribute('aria-expanded',String(detailsShown));
    details.setAttribute('aria-label',detailsShown?'Hide map details':'Show map details');
    const focused=!toolsShown&&!detailsShown;
    focus.textContent=focused?'▣ Restore panels':'▣ Focus map';
    focus.setAttribute('aria-pressed',String(focused));
    focus.setAttribute('aria-label',focused?'Restore map panels':'Hide both map sidebars to maximise the canvas');
    syncSettingsControls();
    if(settings.mode==='map')requestAnimationFrame(resizeCanvas);
  }
  function toggleMapPanel(which){
    const key=which==='tools'?'mapToolsCollapsed':'mapDetailsCollapsed';
    uiPrefs[key]=!uiPrefs[key];
    mapFocusRestore=null;
    applyMapPanelState();
    saveUiPreferences();
  }
  function toggleMapFocus(){
    const focused=uiPrefs.mapToolsCollapsed&&uiPrefs.mapDetailsCollapsed;
    if(focused){
      uiPrefs.mapToolsCollapsed=mapFocusRestore?.mapToolsCollapsed??false;
      uiPrefs.mapDetailsCollapsed=mapFocusRestore?.mapDetailsCollapsed??false;
      mapFocusRestore=null;
    }else{
      mapFocusRestore={mapToolsCollapsed:uiPrefs.mapToolsCollapsed,mapDetailsCollapsed:uiPrefs.mapDetailsCollapsed};
      uiPrefs.mapToolsCollapsed=true;
      uiPrefs.mapDetailsCollapsed=true;
    }
    applyMapPanelState();
    saveUiPreferences();
  }
  // Native Fullscreen API fills the actual display. A CSS-only expanded
  // workspace is provided for browsers that do not permit native fullscreen.
  // Neither mode modifies site data or persisted sidebar preferences.
  let fullscreenFallback=false;
  let fullscreenToolsOpen=true;
  function isMapFullscreen(){
    return document.fullscreenElement===$('mapWorkspace')||fullscreenFallback;
  }
  function refreshFullscreenPresentation(){
    const active=isMapFullscreen();
    const button=$('fullscreenMapBtn'),palette=$('fullscreenToolsBtn'),strip=$('fullscreenToolstrip');
    button.textContent=active?'⤢ Exit Full Screen':'⛶ Full Screen';
    button.setAttribute('aria-pressed',String(active));
    button.setAttribute('aria-label',active?'Exit full-screen map':'Enter full-screen map');
    button.title=active?'Exit full screen (Esc)':'Make the map fill the screen';
    palette.textContent=fullscreenToolsOpen?'☰ Hide tools':'☰ Show tools';
    palette.setAttribute('aria-expanded',String(fullscreenToolsOpen));
    strip.classList.toggle('is-collapsed',!fullscreenToolsOpen);
    syncFullscreenDetails();
    if(settings.mode==='map')requestAnimationFrame(()=>{resizeCanvas();drawSoon();});
  }
  async function exitMapFullscreen(){
    const workspace=$('mapWorkspace');
    if(document.fullscreenElement===workspace&&typeof document.exitFullscreen==='function'){
      try{await document.exitFullscreen();}catch(err){
        console.warn('Fullscreen exit was blocked by the browser.',err);
      }
    }
    if(fullscreenFallback){
      fullscreenFallback=false;
      workspace.classList.remove('map-fullscreen-fallback');
      document.body.classList.remove('map-fullscreen-active');
    }
    refreshFullscreenPresentation();
  }
  async function toggleMapFullscreen(){
    if(settings.mode!=='map')return;
    if(isMapFullscreen()){await exitMapFullscreen();return;}
    const workspace=$('mapWorkspace');
    fullscreenToolsOpen=true;
    if(typeof workspace.requestFullscreen==='function'){
      try{
        // Directly called from the Full Screen button: user activation is
        // preserved for the browser's native Fullscreen API.
        await workspace.requestFullscreen();
        refreshFullscreenPresentation();
        return;
      }catch(err){
        console.warn('Native fullscreen was unavailable; expanding the map inside the window.',err);
      }
    }
    fullscreenFallback=true;
    workspace.classList.add('map-fullscreen-fallback');
    document.body.classList.add('map-fullscreen-active');
    refreshFullscreenPresentation();
    toast('Expanded map view. Press Esc or Exit Full Screen to return.');
  }
  function toggleFullscreenTools(){
    fullscreenToolsOpen=!fullscreenToolsOpen;
    refreshFullscreenPresentation();
  }
  function syncSettingsControls(){
    $('settingsTheme').value=uiPrefs.theme;
    $('settingsLargerText').checked=uiPrefs.largerText===true;
    $('settingsShowTools').checked=uiPrefs.mapToolsCollapsed!==true;
    $('settingsShowDetails').checked=uiPrefs.mapDetailsCollapsed!==true;
  }
  function applyUiPreferences(){
    const systemDark=typeof window.matchMedia==='function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark=uiPrefs.theme==='dark'||(uiPrefs.theme==='system'&&systemDark);
    document.documentElement.classList.toggle('theme-dark',dark);
    document.documentElement.classList.toggle('larger-text',uiPrefs.largerText===true);
    document.documentElement.style.colorScheme=dark?'dark':'light';
    syncSettingsControls();
  }
  function openSettings(){
    syncSettingsControls();
    $('settingsDialog').showModal();
    $('settingsTheme').focus();
  }
  function setThemePreference(value){
    if(!['system','light','dark'].includes(value))return;
    uiPrefs.theme=value;
    applyUiPreferences();
    saveUiPreferences();
  }
  function setLargerTextPreference(enabled){
    uiPrefs.largerText=Boolean(enabled);
    applyUiPreferences();
    saveUiPreferences();
    if(settings.mode==='map')requestAnimationFrame(resizeCanvas);
  }
  function setPanelPreference(which,visible){
    const key=which==='tools'?'mapToolsCollapsed':'mapDetailsCollapsed';
    uiPrefs[key]=!Boolean(visible);
    mapFocusRestore=null;
    applyMapPanelState();
    saveUiPreferences();
  }
  function resetDisplayPreferences(){
    uiPrefs={theme:'system',largerText:false,mapToolsCollapsed:false,mapDetailsCollapsed:false};
    mapFocusRestore=null;
    applyUiPreferences();
    applyMapPanelState();
    saveUiPreferences();
    toast('Display preferences reset on this device.');
  }
  function loadUiPreferences(){
    try{
      const value=JSON.parse(localStorage.getItem(UI_PREFS_KEY)||'null');
      if(value&&typeof value==='object'){
        if(['dark','light','system'].includes(value.theme))uiPrefs.theme=value.theme;
        if(typeof value.largerText==='boolean')uiPrefs.largerText=value.largerText;
        if(typeof value.mapToolsCollapsed==='boolean')uiPrefs.mapToolsCollapsed=value.mapToolsCollapsed;
        if(typeof value.mapDetailsCollapsed==='boolean')uiPrefs.mapDetailsCollapsed=value.mapDetailsCollapsed;
      }
    }catch(err){
      console.warn('Display preferences could not be read. Using defaults.',err);
    }
    applyUiPreferences();
    applyMapPanelState();
  }
  function saveUiPreferences(){
    try{
      localStorage.setItem(UI_PREFS_KEY,JSON.stringify(uiPrefs));
    }catch(err){
      console.warn('Display preferences could not be saved in this browser.',err);
      toast('Display preference changed for this session only.');
    }
  }
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
  let adminReports=Object.create(null);
  let adminReportsBlocked=false;
  let collectionsBySite=Object.create(null);
  let collectionsBlocked=false;
  let liveEditKey=null;
  let printView='site';
  let highlightedMapLots=[];
  let highlightedMapLabel='';
  let highlightedMapKey=null;
  let highlightPreviewTarget=null;
  let highlightTimer=null;
  const ADMIN=()=>window.YardMapReport;
  const localAdminAllowed=()=>{
    const u=window.location;
    if(u.protocol==='file:')return true;
    return ['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  };
  function adminReport(){
    return localAdminAllowed()?adminReports[project.id]||null:null;
  }
  function loadAdminReports(){
    if(!localAdminAllowed())return;
    let text=null;
    try{
      text=localStorage.getItem(ADMIN_STORE_KEY);
      if(!text)return;
      const found=JSON.parse(text);
      if(!found||typeof found!=='object'||Array.isArray(found))throw Error('Invalid saved admin report map.');
      const clean=Object.create(null);
      for(const [id,item] of Object.entries(found).slice(0,100)){
        clean[id]=ADMIN().validateReport(item);
      }
      adminReports=clean;
    }catch(err){
      console.error('Could not load local admin data. Existing data will not be overwritten.',err);
      adminReportsBlocked=text!==null;
    }
  }
  function storeAdminReports(next){
    if(!localAdminAllowed()||adminReportsBlocked)return false;
    try{
      localStorage.setItem(ADMIN_STORE_KEY,JSON.stringify(next));
      adminReports=next;
      return true;
    }catch(err){
      console.error('Could not save local admin report.',err);
      toast('Import not saved: browser storage is unavailable. The old report is intact.');
      return false;
    }
  }
  // Keep confidential daily-report data separate from structural JSON.
  // Derived fields resolve live and never modify project objects automatically.
  let cachedReport=null;
  let cachedReportIndex=null;
  const COLLECTION=()=>window.YardMapCollections;
  function loadCollections(){
    if(!localAdminAllowed())return;
    let source=null;
    try{
      source=localStorage.getItem(COLLECTION_STORE_KEY);
      if(!source)return;
      const data=JSON.parse(source);
      if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid collections data');
      const safe=Object.create(null);
      for(const [id,records] of Object.entries(data).slice(0,100)){
        if(id.length<=120)safe[id]=COLLECTION().cleanRecords(records);
      }
      collectionsBySite=safe;
    }catch(err){
      console.error('Saved collection records were unreadable and have been protected.',err);
      collectionsBlocked=source!==null;
    }
  }
  function storeCollections(next){
    if(!localAdminAllowed()||collectionsBlocked){toast('Collection storage is unavailable or needs recovery.');return false;}
    try{
      localStorage.setItem(COLLECTION_STORE_KEY,JSON.stringify(next));
      collectionsBySite=next;
      return true;
    }catch(err){
      console.error('Failed to store local collection data.',err);
      toast('Collection change not saved; check available browser storage.');
      return false;
    }
  }
  function collectionKeyForLot(lot){
    const invoice=effectiveInvoiceFor(lot);
    if(invoice)return COLLECTION().keyFor(lot,invoice);
    const num=ADMIN().lotKey(lot.number);
    // Without an invoice, a uniquely matched spreadsheet lot (or a list-
    // created record) shares its collection record with a drawn lot.
    if(num&&(reportForLot(lot)?.row||currentCollections()['reportlot:'+num]))
      return 'reportlot:'+num;
    return COLLECTION().keyFor(lot,'');
  }
  function currentCollections(){
    return localAdminAllowed()?collectionsBySite[project.id]||Object.create(null):Object.create(null);
  }
  function collectionForLot(lot){
    if(lot?.type!=='lot')return COLLECTION().makeDefault();
    const saved=currentCollections();
    // A lot may have been annotated before any invoice was available.
    return COLLECTION().cleanRecord(saved[collectionKeyForLot(lot)]||saved['lot:'+lot.id]);
  }
  function migrateUnlinkedCollections(){
    if(!localAdminAllowed()||collectionsBlocked)return 0;
    const current=currentCollections(),candidates=new Map();
    const offer=(from,to)=>{
      if(from===to||!current[from]||current[to])return;
      if(!candidates.has(to))candidates.set(to,new Set());
      candidates.get(to).add(from);
    };
    for(const lot of project.objects.filter(o=>o.type==='lot')){
      offer('lot:'+lot.id,collectionKeyForLot(lot));
    }
    const report=adminReport();
    if(report){
      const index=ADMIN().indexReport(report);
      for(const row of report.rows){
        const number=ADMIN().lotKey(row.LotNumber);
        const invoice=ADMIN().invoiceKey(row['dbo.RWX_Invoices::Id']);
        if(number&&invoice&&!index.duplicates.has(number))
          offer('reportlot:'+number,'inv:'+invoice);
      }
    }
    // Keep ambiguous or conflicting legacy records intact; never merge notes
    // automatically or overwrite another invoice's collection history.
    const records=Object.assign(Object.create(null),current);
    let moved=0;
    for(const [to,sources] of candidates){
      if(sources.size!==1||records[to])continue;
      const from=[...sources][0];
      if(!records[from])continue;
      records[to]=COLLECTION().cleanRecord(records[from]);
      delete records[from];
      moved++;
    }
    if(!moved)return 0;
    const next=Object.assign(Object.create(null),collectionsBySite);
    next[project.id]=records;
    return storeCollections(next)?moved:0;
  }
  function updateCollectionForKey(key,fields){
    if(!key||!localAdminAllowed()||collectionsBlocked)return false;
    const all=Object.assign(Object.create(null),collectionsBySite);
    const records=Object.assign(Object.create(null),currentCollections());
    records[key]=COLLECTION().cleanRecord({...records[key],...fields});
    all[project.id]=records;
    const saved=storeCollections(all);
    if(saved){
      const status=panel.querySelector('.collection-save-status');
      if(status)status.textContent='✓ Saved locally on this device';
    }
    return saved;
  }
  function activeCollectionKey(){
    if(settings.tab==='collections')return settings.collectionsSelectedKey;
    const lot=getSelected();
    return lot?.type==='lot'?collectionKeyForLot(lot):null;
  }
  function updateCollectionField(input){
    const recordKey=activeCollectionKey();
    if(!recordKey)return false;
    const key=input.dataset.collectionField;
    if(![...COLLECTION().BOOL_FIELDS,...COLLECTION().TEXT_FIELDS,'bookingDate','bookingTime'].includes(key))return false;
    let value=input.value;
    if(COLLECTION().BOOL_FIELDS.includes(key))value=Boolean(input.checked);
    else if(key==='bookingDate'&&!COLLECTION().validDate(value))value='';
    else if(key==='bookingTime'&&value&&!COLLECTION().halfHourTime(value)){
      // Legacy times remain readable, but new bookings must use the 30-minute slots.
      const previous=COLLECTION().cleanRecord(currentCollections()[recordKey]).bookingTime;
      if(value!==previous){toast('Choose a half-hour time such as 13:00 or 13:30.');return false;}
    }
    return updateCollectionForKey(recordKey,{[key]:value});
  }
  function addCollectionNote(){
    const key=activeCollectionKey();if(!key)return;
    const rec=COLLECTION().cleanRecord(currentCollections()[key]);
    const message=rec.draft.trim();
    if(!message){toast('Type a note before adding it to the log.');return;}
    const note={id:nextId(),at:new Date().toISOString(),text:message};
    // Notes are append-only in the interface. Never silently prune older entries.
    if(updateCollectionForKey(key,{notes:[...rec.notes,note],draft:''})){
      renderPanel();
      const activity=panel.querySelector('.collection-activity');
      if(activity)activity.open=true;
      toast('Timestamped collection note added.');
    }
  }
  function collectionSchedule(){
    const report=adminReport();
    const index=report?ADMIN().indexReport(report):null;
    return COLLECTION().scheduleEntries(currentCollections(),project.objects,
      lot=>effectiveInvoiceFor(lot),lot=>reportForLot(lot)?.row||null,
      v=>ADMIN().lotKey(v),index?.byInvoice||null,report?.rows||[]);
  }
  function exportCollectionsJson(){
    if(!localAdminAllowed())return;
    const payload={format:COLLECTION().FORMAT,formatVersion:COLLECTION().VERSION,
      siteName:project.name,exportedAt:new Date().toISOString(),records:currentCollections()};
    downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),
      `${safeName(project.name)}-collections-CONFIDENTIAL.json`);
    toast('Confidential collections backup downloaded locally.');
  }
  async function importCollectionsJson(file){
    if(!file||!localAdminAllowed()||collectionsBlocked)return;
    if(file.size>5*1024*1024){toast('Collections JSON exceeds 5 MB.');return;}
    try{
      const data=COLLECTION().deserialize(JSON.parse(await file.text()));
      const count=Object.keys(data).length;
      if(!window.confirm(`Import ${count} collection records into “${project.name}”? This replaces only this site's collection records. The site plan and daily spreadsheet are not modified.`))return;
      const all=Object.assign(Object.create(null),collectionsBySite);all[project.id]=data;
      if(storeCollections(all)){refreshAll();toast(`Imported ${count} collection records.`);}
    }catch(err){toast('Collection import failed: '+String(err?.message||err).slice(0,140));}
  }
  function collectionField(label,name,value,type='text',extra=''){
    return `<div class="field"><label for="col-${e(name)}">${e(label)}</label>
      <input id="col-${e(name)}" data-collection-field="${e(name)}" type="${type}" value="${e(value??'')}" ${extra}></div>`;
  }
  function collectionTimeField(value){
    const chosen=String(value||'');
    const legacy=chosen&&!COLLECTION().halfHourTime(chosen);
    return `<div class="field"><label for="col-bookingTime">Collection time (30-minute slots)</label>
      <select id="col-bookingTime" data-collection-field="bookingTime">
        <option value="">Select time / TBC</option>
        ${legacy?`<option value="${e(chosen)}" selected>Existing time: ${e(chosen)} (choose a new slot)</option>`:''}
        ${COLLECTION().timeSlots.map(slot=>`<option value="${slot}" ${chosen===slot?'selected':''}>${slot}</option>`).join('')}
      </select></div>`;
  }
  function collectionCheck(label,name,checked){
    return `<label class="collection-check"><input type="checkbox" data-collection-field="${e(name)}" ${checked?'checked':''}><span>${e(label)}</span></label>`;
  }
  function collectionEditorHtml(lot){
    if(!localAdminAllowed())return '';
    const invoice=effectiveInvoiceFor(lot),key=collectionKeyForLot(lot);
    const siblings=project.objects.filter(o=>o.type==='lot'&&collectionKeyForLot(o)===key);
    const context=invoice?`Invoice ${e(invoice)} · shared across ${siblings.length} drawn lot(s)`:'Not yet invoiced · linked to this lot';
    return collectionEditorForKey(key,context);
  }
  function collectionEditorForKey(key,context){
    const record=COLLECTION().cleanRecord(currentCollections()[key]);
    const notes=[...record.notes].reverse();
    const noteHtml=n=>`<div class="collection-note"><time datetime="${e(n.at)}">${e(new Date(n.at).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'}))}</time><p>${e(n.text)}</p></div>`;
    return `<section class="collection-editor">
      <header><h3>Collection checklist</h3><small>${context}</small></header>
      <div class="collection-save-status" role="status" aria-live="polite">Changes save automatically on this device.</div>
      <div class="collection-checks">
        ${collectionCheck('Contacted for payment','contactedForPayment',record.contactedForPayment)}
        ${collectionCheck('Booked in for collection','bookedIn',record.bookedIn)}
        ${collectionCheck('RAMS checked','ramsChecked',record.ramsChecked)}
      </div>
      <div class="field-grid">
        ${collectionField('Collection date','bookingDate',record.bookingDate,'date')}
        ${collectionTimeField(record.bookingTime)}
      </div>
      <p class="field-help">Appointments appear on the schedule once Booked In and a date are set. A missing time is shown as TBC.</p>
      <details class="collection-disclosure" ${record.recoveryName||record.recoveryCompany?'open':''}>
        <summary>Recovering party / transport details</summary>
        ${collectionField('Contact name','recoveryName',record.recoveryName,'text')}
        ${collectionField('Company (optional)','recoveryCompany',record.recoveryCompany,'text')}
        ${collectionField('Phone number','recoveryPhone',record.recoveryPhone,'tel')}
        ${collectionField('Email','recoveryEmail',record.recoveryEmail,'email')}
      </details>
      <details class="collection-disclosure collection-activity">
        <summary>Notes & activity log <span class="chip">${notes.length}</span></summary>
        <div class="field"><label for="collectionNoteDraft">New note (draft autosaves)</label>
          <textarea id="collectionNoteDraft" data-collection-field="draft" rows="3" maxlength="1500" placeholder="E.g. Buyer called about arranging payment…">${e(record.draft)}</textarea></div>
        <button type="button" class="btn btn-primary" data-action="addCollectionNote">Add timestamped note</button>
        <div class="collection-log">${notes.length?notes.slice(0,2).map(noteHtml).join(''):'<p class="field-help">No notes yet.</p>'}
          ${notes.length>2?`<details class="older-collection-notes"><summary>Show ${notes.length-2} older notes</summary>${notes.slice(2).map(noteHtml).join('')}</details>`:''}
        </div>
      </details>
    </section>`;
  }
  function scheduleEntryHTML(item){
    const r=item.record;
    const invoice=item.invoice?`Invoice ${e(item.invoice)}`:'Unlinked lot booking';
    const numbers=item.lots.length?item.lots.join(', '):'Not on current drawing';
    const first=item.lotIds[0];
    const current=collectionsListEntries().some(entry=>entry.key===item.key);
    return `<article class="schedule-item">
      ${current?'':'<p class="stale-invoice-warning">Not in the current Excel report. Historical booking retained for reference; verify with admin before arranging collection.</p>'}
      <div class="schedule-item-head"><b>${e(item.time||'Time TBC')}</b><strong>${invoice}</strong></div>
      <div class="schedule-item-lots">Lots: ${e(numbers)}</div>
      <div class="schedule-item-info">
        <div><span>Buyer</span><b>${e(item.buyer||'Not supplied')}</b></div>
        <div><span>Buyer telephone</span><b>${e([item.mobile,item.telephone].filter(Boolean).join(' / ')||'Not supplied')}</b></div>
        <div><span>Recovering contact</span><b>${e(r.recoveryName||'Not supplied')}</b></div>
        <div><span>Company</span><b>${e(r.recoveryCompany||'—')}</b></div>
        <div><span>Recovery telephone</span><b>${e(r.recoveryPhone||'Not supplied')}</b></div>
        <div><span>Recovery email</span><b>${e(r.recoveryEmail||'Not supplied')}</b></div>
      </div>
      <div class="schedule-foot">Payment contacted: ${r.contactedForPayment?'Yes':'No'} · RAMS: ${r.ramsChecked?'Checked':'Not checked'} · Notes: ${r.notes.length}</div>
      ${current?`<button type="button" class="btn btn-light schedule-edit" data-collection-select="${e(item.key)}">Edit collection / notes</button>`:''}
      ${current&&first?`<button type="button" class="btn btn-light schedule-edit" data-view-collection-map="${e(item.key)}">Preview / download highlighted site plan</button>`:''}
    </article>`;
  }
  function scheduleHTML(){
    const entries=collectionSchedule(),groups=new Map();
    for(const entry of entries){
      if(!groups.has(entry.date))groups.set(entry.date,[]);
      groups.get(entry.date).push(entry);
    }
    if(!entries.length)return '<p class="empty-list">No booked collections with dates yet. Tick Booked In and enter a collection date against the relevant lot.</p>';
    return [...groups.entries()].map(([date,bookings])=>
      `<section class="schedule-day"><h3>${e(COLLECTION().formatDate(date))}<span>${bookings.length} appointment(s)</span></h3>
       ${bookings.map(scheduleEntryHTML).join('')}</section>`).join('');
  }
  // Admin lists are sourced exclusively from the latest local Excel report.
  // Existing orphaned collection records remain preserved but cannot create
  // new visible lots or invoices without a matching Excel row.
  function mappedLotForNumber(number,invoice){
    const key=ADMIN().lotKey(number);
    const matches=project.objects.filter(o=>o.type==='lot'&&ADMIN().lotKey(o.number)===key);
    if(matches.length!==1)return null; // An ambiguous lot cannot be cleared by guesswork.
    const lot=matches[0],actual=effectiveInvoiceFor(lot);
    return (invoice?actual===invoice:!actual)?lot:null;
  }
  function collectionsListEntries(){
    const report=adminReport();
    if(!report)return [];
    return COLLECTION().listEntries(report.rows,[],()=>'',v=>ADMIN().lotKey(v),{}).
      filter(item=>!!item.row).map(item=>{
        const matched=item.lots.map(n=>mappedLotForNumber(n,item.invoice)).filter(Boolean);
        return {...item,drawnIds:matched.map(o=>o.id),
          drawnArea:matched.reduce((sum,o)=>sum+o.w*o.h*project.cellMeters*project.cellMeters,0),
          clearedDrawnCount:matched.filter(o=>o.status==='cleared').length};
      });
  }
  const numericLot=(a,b)=>String(a||'').localeCompare(String(b||''),undefined,{numeric:true,sensitivity:'base'});
  function sortCollectionEntries(entries){
    const results=[...entries],sort=settings.collectionsSort;
    const number=(item)=>item.lots[0]||'';
    const checked=(item,key)=>COLLECTION().cleanRecord(currentCollections()[item.key])[key]===true?1:0;
    const cleared=item=>item.drawnIds.length>0&&item.clearedDrawnCount===item.drawnIds.length?1:0;
    results.sort((a,b)=>{
      let d=0;
      switch(sort){
        case 'lotDesc':d=numericLot(number(b),number(a));break;
        case 'countDesc':d=b.lots.length-a.lots.length;break;
        case 'areaDesc':d=b.drawnArea-a.drawnArea;break;
        case 'booked':d=checked(b,'bookedIn')-checked(a,'bookedIn');break;
        case 'rams':d=checked(b,'ramsChecked')-checked(a,'ramsChecked');break;
        case 'contacted':d=checked(b,'contactedForPayment')-checked(a,'contactedForPayment');break;
        case 'cleared':d=cleared(b)-cleared(a);break;
        default:d=numericLot(number(a),number(b));
      }
      return d||numericLot(number(a),number(b))||numericLot(a.key,b.key);
    });
    return results;
  }
  function filteredCollectionEntries(){
    const query=settings.collectionsSearch.trim().toLocaleLowerCase();
    const tokens=query.split(/\s+/).filter(Boolean);
    const rows=adminReport()?.rows||[];
    return sortCollectionEntries(collectionsListEntries().filter(item=>{
      if(!tokens.length)return true;
      const invoiceRows=rows.filter(row=>item.invoice?
        ADMIN().invoiceKey(row['dbo.RWX_Invoices::Id'])===item.invoice:
        item.lots.some(n=>ADMIN().lotKey(row.LotNumber)===ADMIN().lotKey(n))&&!ADMIN().invoiceKey(row['dbo.RWX_Invoices::Id']));
      const haystack=[item.key,item.invoice,...item.lots,
        ...invoiceRows.flatMap(r=>[r.LotNumber,r['dbo.RWX_Invoices::Full Billing Name'],
          r['dbo.RWX_Users 2::UserName'],r['dbo.RWX_Listings::Title']])]
        .map(v=>ADMIN().asText(v)).join(' ').toLocaleLowerCase();
      return tokens.every(t=>haystack.includes(t));
    }));
  }
  function updateCollectionListResults(){
    const target=panel.querySelector('#collectionsListResults');
    if(!target)return;
    const visible=filteredCollectionEntries();
    target.innerHTML=visible.length?visible.map(collectionListCard).join(''):
      '<p class="empty-list">No matching invoice, buyer or lot in the imported Excel report.</p>';
    const count=panel.querySelector('#collectionsSearchCount');
    if(count)count.textContent=`${visible.length} of ${collectionsListEntries().length} invoice / lot records`;
  }
  function collectionStatusChips(item){
    const rec=COLLECTION().cleanRecord(currentCollections()[item.key]);
    const chips=[
      ['Payment contacted',rec.contactedForPayment],
      [rec.bookedIn&&rec.bookingDate?`Booked · ${rec.bookingDate} ${rec.bookingTime||'TBC'}`:'Booked in',rec.bookedIn],
      ['RAMS checked',rec.ramsChecked]
    ];
    if(item.drawnIds.length){
      chips.push([`Cleared ${item.clearedDrawnCount}/${item.drawnIds.length} on map`,
        item.clearedDrawnCount===item.drawnIds.length]);
    }
    return `<div class="collection-progress">${chips.map(([label,done])=>
      `<span class="progress-chip ${done?'is-done':'is-pending'}">${done?'✓ ':'○ '}${e(label)}</span>`).join('')}</div>`;
  }
  function collectionListCard(item){
    const rec=COLLECTION().cleanRecord(currentCollections()[item.key]);
    const buyer=ADMIN().asText(item.row?.['dbo.RWX_Invoices::Full Billing Name']);
    const title=item.invoice?'Invoice '+item.invoice:'Uninvoiced lot '+(item.lots[0]||'—');
    const area=item.drawnIds.length?` · Drawn area: ${fmt(item.drawnArea)} m²`:'';
    return `<button type="button" class="collection-list-card ${item.drawnIds.length&&item.clearedDrawnCount===item.drawnIds.length?'invoice-cleared':''}"
      data-collection-select="${e(item.key)}" aria-label="Open ${e(title)} for ${e(buyer||'unknown buyer')}">
      <strong>${e(title)}</strong>
      <span>${e(buyer||'No buyer name in report')}</span>
      <small>Lots: ${e(item.lots.join(', ')||'Not supplied')} · ${item.lots.length} item(s)${e(area)}</small>
      ${collectionStatusChips(item)}
      <small>${rec.notes.length} timestamped note(s)</small>
    </button>`;
  }
  function selectedCollectionHtml(item){
    const rows=adminReport()?.rows||[];
    const row=item.row||null;
    const buyer=ADMIN().asText(row?.['dbo.RWX_Invoices::Full Billing Name']);
    const mobile=ADMIN().asText(row?.['mobile::StringNativeValue']);
    const telephone=ADMIN().asText(row?.['tel::StringNativeValue']);
    const email=ADMIN().asText(row?.['dbo.RWX_Users 2::UserName']);
    const title=item.invoice?'Invoice '+item.invoice:
      item.lots.length?'Uninvoiced lot '+item.lots.join(', '):'Previous collection record';
    const descriptionRows=rows.filter(r=>{
      const inv=ADMIN().invoiceKey(r['dbo.RWX_Invoices::Id']);
      return item.invoice?inv===item.invoice:
        item.lots.some(n=>ADMIN().lotKey(r.LotNumber)===ADMIN().lotKey(n))&&!inv;
    }).slice(0,100);
    const lotDetails=descriptionRows.length?descriptionRows.map(r=>{
      const drawn=mappedLotForNumber(r.LotNumber,item.invoice);
      const status=drawn?.status==='cleared'?'<span class="lot-cleared-badge">✓ Cleared on map</span>':
        drawn?'<span class="lot-map-pending">On map · not cleared</span>':
        '<span class="lot-not-drawn">Not drawn</span>';
      return `<div class="collection-report-lot ${drawn?.status==='cleared'?'lot-row-cleared':''}">
        <div class="collection-lot-title"><strong>Lot ${e(r.LotNumber)}</strong>${status}</div>
        <span>${e(ADMIN().asText(r['dbo.RWX_Listings::Title'])||'No description supplied')}</span>
      </div>`;
    }).join(''):'<p class="field-help">No matching lot descriptions are present in today’s Excel report.</p>';
    return `<div class="collection-list-editor">
      <button type="button" class="btn btn-light" data-collection-back>← Back to invoice / lot list</button>
      <h2 class="panel-title">${e(title)}</h2>
      <p class="panel-description">${e(item.lots.length?item.lots.length+' associated lot(s): '+item.lots.join(', '):'No lots linked')}</p>
      <p class="field-help">Invoice number, buyer details, lot numbers and descriptions come from the Excel file and are read-only here.</p>
      ${collectionStatusChips(item)}
      ${item.drawnIds.length?`<button type="button" class="btn btn-light collection-view-map" data-view-collection-map="${e(item.key)}">Preview / download ${item.drawnIds.length} highlighted lot(s)</button>`:''}
      <div class="collection-buyer-info">
        <strong>${e(buyer||'Buyer not supplied')}</strong>
        ${mobile||telephone?`<span>Buyer contact: ${e([mobile,telephone].filter(Boolean).join(' / '))}</span>`:''}
        ${email?`<span>Username: ${e(email)}</span>`:''}
      </div>
      ${collectionEditorForKey(item.key,item.invoice?
         `Invoice ${e(item.invoice)} · works without drawing the lots`:
         'Lot-based collection record · no invoice required')}
      <details class="collection-disclosure collection-lot-details"><summary>Lots and descriptions (${item.lots.length})</summary>
        <div class="collection-lot-roster">${lotDetails}</div>
      </details>
    </div>`;
  }
  function renderCollectionsPanel(){
    if(!localAdminAllowed()){
      panel.innerHTML='<h2 class="panel-title">Collections · Local only</h2><p class="admin-unmatched">Customer collection records are disabled on hosted sites. Open YardMap on localhost instead.</p>';
      return;
    }
    const entries=collectionsListEntries(),booked=collectionSchedule();
    if(settings.tab==='schedule'){
      panel.innerHTML=`<section class="admin-step-page">
        <span class="admin-step-label">STEP 3 OF 3 · COLLECTION SCHEDULE</span>
        <h2>Review upcoming collections</h2>
        <p class="admin-step-intro">Appointments are grouped by date, then sorted by time. Each invoice appears once, even if it covers several lots. You can print the schedule without drawing a map.</p>
        <div class="schedule-top-actions">
          <button type="button" class="btn btn-primary" data-action="printCollectionSchedule" ${booked.length?'':'disabled'}>Print schedule / Save PDF</button>
          <button type="button" class="btn btn-light" data-admin-next="collections">Edit invoices and notes</button>
        </div>
        <div class="schedule-summary-count"><strong>${booked.length}</strong><span>booked collection${booked.length===1?'':'s'}</span></div>
        ${scheduleHTML()}
      </section>`;
      return;
    }
    const selected=entries.find(x=>x.key===settings.collectionsSelectedKey);
    if(selected){
      panel.innerHTML=`<section class="admin-step-page">
        <span class="admin-step-label">STEP 2 OF 3 · UPDATE COLLECTION</span>
        ${selectedCollectionHtml(selected)}
        <div class="admin-next-step">
          <span>NEXT STEP</span>
          <strong>When you've recorded the arrangements, review the date-ordered schedule.</strong>
          <button type="button" class="btn btn-primary" data-admin-next="schedule">Review collection schedule</button>
        </div>
      </section>`;
      return;
    }
    const visible=filteredCollectionEntries();
    const hasReport=!!adminReport();
    panel.innerHTML=`<section class="admin-step-page">
      <span class="admin-step-label">STEP 2 OF 3 · INVOICES & COLLECTIONS</span>
      <h2>Find an invoice and record the arrangements</h2>
      <p class="admin-step-intro">Search for a buyer, invoice or lot number. Open the record, tick the collection checklist, enter the booking date and add notes as you go. Everything saves locally as you type.</p>
      <div class="admin-collection-counts">
        <span><b>${entries.length}</b> invoice / lot records</span>
        <span><b>${booked.length}</b> booked collections</span>
        <span>${hasReport?'✓ Daily Excel loaded':'Excel not yet imported'}</span>
      </div>
      ${collectionsBlocked?'<p class="admin-unmatched">Saved collection records need recovery. Existing records are protected against overwrite.</p>':''}
      ${!hasReport?`<div class="admin-import-prompt"><strong>Import Excel to start</strong>
        <p>The collection list is read-only until the daily spreadsheet is imported. No lots can be added manually.</p>
        <button type="button" class="btn btn-primary" data-admin-next="admin">Import daily Excel</button>
      </div>`:''}
      <div class="collection-search-sort">
        <div><label class="collections-search-label" for="collectionsSearch">Search invoices, buyers, lots or descriptions</label>
          <input type="search" id="collectionsSearch" class="search-input" autocomplete="off"
            placeholder="Search all invoice lots and descriptions…" value="${e(settings.collectionsSearch)}"></div>
        <div><label class="collections-search-label" for="collectionsSort">Sort results by</label>
          <select id="collectionsSort" class="search-input">
            ${optionsHtml([['lotAsc','Lot number · low to high'],['lotDesc','Lot number · high to low'],
              ['countDesc','Size · most lots first'],['areaDesc','Size · largest drawn area'],
              ['booked','Booked in first'],['rams','RAMS checked first'],
              ['contacted','Payment contacted first'],['cleared','Fully cleared on map first']],settings.collectionsSort)}
          </select></div>
      </div>
      <p class="collection-results-count" id="collectionsSearchCount" role="status">${visible.length} of ${entries.length} invoice / lot records</p>
      <div class="collections-list-results" id="collectionsListResults">
        ${visible.length?visible.map(collectionListCard).join(''):
          '<p class="empty-list">No matching invoices in the imported Excel report.</p>'}
      </div>
      <div class="admin-next-inline">
        <span>Finished updating the day's invoices?</span>
        <button type="button" class="btn btn-primary" data-admin-next="schedule">Go to collection schedule</button>
      </div>
    </section>`;
  }
  function reportForLot(lot){
    const report=adminReport();
    if(!report||lot?.type!=='lot')return null;
    if(cachedReport!==report){
      cachedReport=report;cachedReportIndex=ADMIN().indexReport(report);
    }
    const key=ADMIN().lotKey(lot.number);
    const duplicateOnMap=project.objects.some(o=>o.type==='lot'&&o.id!==lot.id&&ADMIN().lotKey(o.number)===key);
    const duplicateInReport=cachedReportIndex.duplicates.has(key);
    return {report,index:cachedReportIndex,duplicateOnMap,duplicateInReport,
      row:!duplicateOnMap&&!duplicateInReport?(cachedReportIndex.byLot.get(key)||null):null};
  }
  function importedInvoiceFor(lot){
    const row=reportForLot(lot)?.row;
    return row?ADMIN().invoiceKey(row['dbo.RWX_Invoices::Id']):'';
  }
  function effectiveInvoiceFor(lot){
    return String(lot?.invoice??'').trim()||importedInvoiceFor(lot);
  }

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
    liveEditKey=null;
    const restored=JSON.parse(snapshot);
    const idx=state.projects.findIndex(p=>p.id===project.id);
    state.projects[idx]=sanitizeProject(restored);
    project=state.projects[idx];
    if (!project.objects.find(o=>o.id===settings.selected)) settings.selected=null;
    scheduleSave();refreshAll();
  }
  function commit(before,liveKey=null) {
    if(!before)return;
    const after=JSON.stringify(project);
    if(before===after)return;
    if(!liveKey||liveEditKey!==liveKey){
      history.push(before);if(history.length>MAX_UNDO)history.shift();
    }
    future=[];
    liveEditKey=liveKey;
    project.updatedAt=new Date().toISOString();
    scheduleSave();
    if(liveKey){
      // Do not replace the editor while someone is typing: it would discard
      // focus, cursor selection and the remainder of the input.
      refreshStats();drawSoon();
    }else refreshAll();
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
    storeNow();dismissMapHighlights();project=target;state.activeId=id;settings.selected=null;settings.collectionsSelectedKey=null;history=[];future=[];
    if(settings.tool==='move-all')setTool('select');
    refreshProjectSelector();refreshAll();fitView();storeNow();toast(`Opened ${project.name}`);
  }
  function newSite(){
    const name=prompt('Name this auction site:',`New auction site ${state.projects.length+1}`);
    if(name===null)return;
    project=createProject(name.trim().slice(0,140)||`New auction site ${state.projects.length+1}`);
    dismissMapHighlights();state.projects.push(project);state.activeId=project.id;history=[];future=[];settings.selected=null;settings.collectionsSelectedKey=null;
    if(settings.tool==='move-all')setTool('select');
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
    history=[];future=[];settings.selected=null;settings.collectionsSelectedKey=null;refreshProjectSelector();refreshAll();fitView();storeNow();toast('Site deleted from this browser');
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
      l.number,effectiveInvoiceFor(l),STATUS[l.status]?.label||l.status,l.color||STATUS[l.status].color,
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
    $('moveAllBtn').disabled=!project.objects.length;
    const visible=project.showText!==false;
    $('textToggleBtn').textContent=visible?'Aa · Show':'Aa · Hidden';
    $('textToggleBtn').setAttribute('aria-pressed',String(visible));
    $('textToggleBtn').classList.toggle('text-muted',!visible);
    if(document.activeElement!==$('textScaleInput'))$('textScaleInput').value=Math.round((project.textScale??1)*100);
  }
  function setTool(tool){
    if(!TOOLS[tool])return;
    if(tool==='move-all'&&!project.objects.length){toast('Add at least one item before selecting all.');return;}
    const previousTool=settings.tool;
    settings.tool=tool;
    if(tool==='move-all')settings.selected=null;
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
    $('moveAllBtn').classList.toggle('move-all-active',tool==='move-all');
    $('moveAllBtn').setAttribute('aria-pressed',String(tool==='move-all'));
    if(tool==='move-all'||previousTool==='move-all')renderPanel();
    drawSoon();
  }
  function switchTab(tab){
    const allowed=settings.mode==='admin'?['admin','collections','schedule']:['properties','lots','access'];
    if(!allowed.includes(tab))return;
    const changed=settings.tab!==tab;
    settings.tab=tab;
    if(settings.mode==='admin')settings.lastAdminTab=tab;
    for(const b of document.querySelectorAll('[data-tab]')){
      const active=b.dataset.tab===tab;
      b.classList.toggle('active',active);
      b.setAttribute('aria-selected',String(active));
      b.tabIndex=active?0:-1;
    }
    panel.setAttribute('aria-label',({
      properties:'Site details',lots:'Drawn lot register',access:'Keys and access',
      admin:'Daily Excel import',collections:'Invoice and collection records',schedule:'Collection schedule'
    })[tab]);
    renderPanel();
    if(changed){
      panel.scrollTop=0;
      if(settings.mode==='admin'&&typeof window.scrollTo==='function')window.scrollTo(0,0);
    }
  }
  function focusPanelHeading(){
    const heading=panel.querySelector('h2');
    if(!heading)return;
    heading.tabIndex=-1;
    heading.focus();
  }
  function switchMode(mode){
    if(mode!=='map'&&mode!=='admin')return;
    if(settings.mode===mode)return;
    if(mode==='admin'&&isMapFullscreen())exitMapFullscreen();
    settings.mode=mode;
    if(mode==='admin')syncFullscreenDetails();
    const shell=$('appShell');
    shell.classList.toggle('mode-map',mode==='map');
    shell.classList.toggle('mode-admin',mode==='admin');
    for(const [id,isActive] of [['modeMapBtn',mode==='map'],['modeAdminBtn',mode==='admin']]){
      const button=$(id);
      button.classList.toggle('active',isActive);
      button.setAttribute('aria-pressed',String(isActive));
    }
    $('saveBannerHint').textContent=mode==='map'
      ? 'Changes stay in this browser. Use Import / Export Site JSON above for a map backup.'
      : 'Collection records and daily Excel stay on this device. Keep the original Excel report securely.';
    panel.scrollTop=0;
    if(typeof window.scrollTo==='function')window.scrollTo(0,0);
    if(mode==='admin'){
      if(settings.tool!=='select')setTool('select');
      switchTab(settings.lastAdminTab||'admin');
    }else{
      switchTab('properties');
      requestAnimationFrame(()=>{resizeCanvas();drawSoon();});
    }
  }
  function selectObject(id,showDetails=true,focus=false){
    if(id&&settings.tool==='move-all')setTool('select');
    settings.selected=id;
    if(showDetails)switchTab('properties');else renderPanel();
    syncFullscreenDetails();
    if(focus){const o=getSelected();if(o)centerOn(o);}
    drawSoon();
  }
  function refreshAll(){
    const panelScroll=panel.scrollTop;
    refreshStats();renderPanel();refreshProjectSelector();
    syncFullscreenDetails();
    panel.scrollTop=panelScroll;
    drawSoon();
  }

  // Coordinates are stored in whole grid units; physical distance is cellMeters per unit.
  const scale=()=>CELL_PX*view.zoom;
  // Rotation is view-only. Site coordinates, lot geometry, keys and saved
  // structural JSON stay in their original orientation.
  function quarterTurnPoint(x,y,rotation=view.rotation){
    switch((rotation%4+4)%4){
      case 1:return {x:-y,y:x};
      case 2:return {x:-x,y:-y};
      case 3:return {x:y,y:-x};
      default:return {x,y};
    }
  }
  function unrotatePoint(x,y,rotation=view.rotation){
    return quarterTurnPoint(x,y,4-(rotation%4+4)%4);
  }
  function rotatedSiteBounds(rotation=view.rotation){
    const corners=[[0,0],[project.cols,0],[0,project.rows],[project.cols,project.rows]]
      .map(([x,y])=>quarterTurnPoint(x,y,rotation));
    const xs=corners.map(p=>p.x),ys=corners.map(p=>p.y);
    return {minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys),
      width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
  }
  function viewWorldAt(sx,sy){
    return unrotatePoint((sx-view.offsetX)/scale(),(sy-view.offsetY)/scale());
  }
  const toWorld=(clientX,clientY)=>{
    const r=canvas.getBoundingClientRect();
    return viewWorldAt(clientX-r.left,clientY-r.top);
  };
  const snapCell=p=>({x:minmax(Math.round(p.x),0,project.cols),y:minmax(Math.round(p.y),0,project.rows)});
  const toScreen=p=>{
    const r=quarterTurnPoint(p.x,p.y);
    return {x:view.offsetX+r.x*scale(),y:view.offsetY+r.y*scale()};
  };
  function rotateMap(steps){
    view.rotation=((view.rotation+steps)%4+4)%4;
    $('mapRotationLabel').textContent=`${view.rotation*90}°`;
    fitView();
  }
  function fitView(){
    if(!view.width||!view.height)return;
    const b=rotatedSiteBounds();
    view.zoom=minmax(Math.min((view.width-70)/(b.width*CELL_PX),(view.height-70)/(b.height*CELL_PX)),.1,5);
    view.offsetX=(view.width-b.width*scale())/2-b.minX*scale();
    view.offsetY=(view.height-b.height*scale())/2-b.minY*scale();
    view.fitted=true;drawSoon();
  }
  function centerOn(o){
    let x,y;
    if(o.type==='lot'||o.type==='box'){x=o.x+o.w/2;y=o.y+o.h/2;}
    else if(['wall','door','shutter'].includes(o.type)){x=(o.x1+o.x2)/2;y=(o.y1+o.y2)/2;}
    else{x=o.x;y=o.y;}
    const rotated=quarterTurnPoint(x,y);
    view.offsetX=view.width/2-rotated.x*scale();
    view.offsetY=view.height/2-rotated.y*scale();drawSoon();
  }
  function zoomAt(factor,sx,sy){
    const old=scale(),rotatedX=(sx-view.offsetX)/old,rotatedY=(sy-view.offsetY)/old;
    view.zoom=minmax(view.zoom*factor,.1,7);
    view.offsetX=sx-rotatedX*scale();view.offsetY=sy-rotatedY*scale();
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
    const oldCentre=viewWorldAt(oldW/2,oldH/2);
    view.width=width;view.height=height;
    if(canvas.width!==pixelW)canvas.width=pixelW;
    if(canvas.height!==pixelH)canvas.height=pixelH;
    if(view.fitted)fitView();
    else{
      const centre=quarterTurnPoint(oldCentre.x,oldCentre.y);
      view.offsetX=width/2-centre.x*scale();
      view.offsetY=height/2-centre.y*scale();
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
  function drawLot(c,o,showText=true,printContacts=false) {
 if(o.w<=0||o.h<=0)return;
 const color=o.color||STATUS[o.status]?.color||STATUS.pending.color;
 c.fillStyle=color;c.globalAlpha=.2;roundRect(c,o.x+.06,o.y+.06,o.w-.12,o.h-.12,.17);c.fill();c.globalAlpha=1;
 c.lineWidth=.085;c.strokeStyle=color;roundRect(c,o.x+.045,o.y+.045,o.w-.09,o.h-.09,.13);c.stroke();
 if(o.status==='cleared'){
   c.fillStyle=color;roundRect(c,o.x+.05,o.y+.05,Math.min(.22,o.w/4),o.h-.1,.06);c.fill();
 }
 if(!showText)return;
 if(printContacts){
   const row=reportForLot(o)?.row;
   const recovery=collectionForLot(o);
   const buyer=ADMIN().asText(row?.['dbo.RWX_Invoices::Full Billing Name']);
   const phone=ADMIN().asText(row?.['mobile::StringNativeValue'])||
               ADMIN().asText(row?.['tel::StringNativeValue']);
   const lines=[`LOT ${o.number||'—'}`,`INV ${effectiveInvoiceFor(o)||'—'}`];
   if(buyer)lines.push(buyer);
   if(phone)lines.push(phone);
   if(recovery.recoveryName)lines.push(`Collect: ${recovery.recoveryName}`);
   if(recovery.recoveryPhone)lines.push(recovery.recoveryPhone);
   // Max-width scaling keeps concise contact text in the lot footprint;
   // the dedicated print directory below preserves full-size legibility.
   const maxLines=Math.min(lines.length,Math.max(2,Math.floor(o.h/.24)));
   const fontSize=Math.max(.12,Math.min(.38,o.h/(maxLines+1),o.w/Math.max(5,Math.min(12,lines[0].length))));
   c.save();c.beginPath();c.rect(o.x+.1,o.y+.1,Math.max(.12,o.w-.2),Math.max(.12,o.h-.2));c.clip();
   c.textAlign='center';c.textBaseline='middle';
   const top=o.y+o.h/2-((maxLines-1)*fontSize*1.17)/2;
   for(let k=0;k<maxLines;k++){
     c.fillStyle=k===0?'#1b344e':'#354c64';
     c.font=`${k===0?'800':'650'} ${fontSize}px system-ui,sans-serif`;
     c.fillText(lines[k].slice(0,140),o.x+o.w/2,top+k*fontSize*1.17,Math.max(.12,o.w-.28));
   }
   c.restore();
   return;
 }
 const f=fontFor(o,baseFont(o));
 c.textAlign='center';c.textBaseline='middle';c.fillStyle='#263a52';c.font=`800 ${f}px system-ui,sans-serif`;
 const main=o.number?`LOT ${o.number}`:'LOT';
 const label=main.length>18?main.slice(0,17)+'…':main;
 const effectiveInvoice=effectiveInvoiceFor(o);
 c.save();c.beginPath();c.rect(o.x+.08,o.y+.1,Math.max(0,o.w-.16),Math.max(0,o.h-.2));c.clip();
 c.fillText(label,o.x+o.w/2,o.y+o.h/2-(effectiveInvoice.length? .17:0),Math.max(.2,o.w-.2));
 if(effectiveInvoice){
   c.fillStyle='#61768d';c.font=`600 ${Math.min(.45,f*.65)}px system-ui,sans-serif`;
   c.fillText(`INV ${effectiveInvoice.slice(0,24)}`,o.x+o.w/2,o.y+o.h/2+.25,Math.max(.2,o.w-.18));
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
  // A temporary editor selection: move all objects using grid coordinates,
  // not screen pixels. The data schema and serialized project stay unchanged.
  function boundsOf(o){
    if(['lot','box'].includes(o.type))return {minX:o.x,minY:o.y,maxX:o.x+o.w,maxY:o.y+o.h};
    if(['wall','door','shutter'].includes(o.type))return {
      minX:Math.min(o.x1,o.x2),minY:Math.min(o.y1,o.y2),
      maxX:Math.max(o.x1,o.x2),maxY:Math.max(o.y1,o.y2)
    };
    return {minX:o.x,minY:o.y,maxX:o.x,maxY:o.y};
  }
  function groupBounds(items=project.objects){
    if(!items.length)return null;
    const b={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
    for(const o of items){
      const q=boundsOf(o);
      b.minX=Math.min(b.minX,q.minX);b.minY=Math.min(b.minY,q.minY);
      b.maxX=Math.max(b.maxX,q.maxX);b.maxY=Math.max(b.maxY,q.maxY);
    }
    return b;
  }
  function translateGroup(originals,requestedX,requestedY){
    const b=groupBounds(originals);
    if(!b)return {dx:0,dy:0};
    const lx=Math.ceil(-b.minX),rx=Math.floor(project.cols-b.maxX);
    const ly=Math.ceil(-b.minY),ry=Math.floor(project.rows-b.maxY);
    if(lx>rx||ly>ry)return null;
    const dx=minmax(requestedX,lx,rx),dy=minmax(requestedY,ly,ry);
    for(let i=0;i<originals.length;i++){
      const a=originals[i],o=project.objects[i];
      if(!o||o.id!==a.id)throw new Error('Objects changed while dragging a group.');
      if(['wall','door','shutter'].includes(o.type)){
        o.x1=a.x1+dx;o.x2=a.x2+dx;o.y1=a.y1+dy;o.y2=a.y2+dy;
      }else{o.x=a.x+dx;o.y=a.y+dy;}
    }
    return {dx,dy};
  }
  function cancelGroupDrag(d){
    if(d?.action==='move-all'){
      project.objects=d.originals;
      drawSoon();
    }
  }
  function drawGroupOutline(c){
    const b=groupBounds();if(!b)return;
    c.save();c.strokeStyle='#246dea';c.lineWidth=2/scale();
    c.setLineDash([.2,.12]);
    c.strokeRect(b.minX-.15,b.minY-.15,b.maxX-b.minX+.3,b.maxY-b.minY+.3);
    c.restore();
  }
  function paintTemporaryLotHighlights(c,px,lotIds=highlightedMapLots){
    if(!lotIds.length)return;
    const ids=new Set(lotIds);
    c.save();
    c.strokeStyle='#e9a400';
    c.lineWidth=5/px;
    c.setLineDash([12/px,5/px]);
    for(const o of project.objects){
      if(o.type!=='lot'||!ids.has(o.id))continue;
      c.strokeRect(o.x-.18,o.y-.18,o.w+.36,o.h+.36);
      c.save();c.setLineDash([]);
      c.fillStyle='#ffd45d';c.strokeStyle='#805002';
      c.lineWidth=1.2/px;
      c.beginPath();c.arc(o.x+.12,o.y+.12,9/px,0,Math.PI*2);
      c.fill();c.stroke();
      c.restore();
    }
    c.restore();
  }
  function dismissMapHighlights(){
    if(highlightTimer!==null){clearTimeout(highlightTimer);highlightTimer=null;}
    highlightedMapLots=[];
    highlightedMapLabel='';
    highlightedMapKey=null;
    const banner=$('mapHighlightNotice');
    if(banner)banner.hidden=true;
    drawSoon();
  }
  function collectionMapIds(key){
    if(!localAdminAllowed())return [];
    const item=collectionsListEntries().find(entry=>entry.key===key);
    if(!item)return [];
    return [...new Set(item.drawnIds||[])].filter(id=>
      project.objects.some(o=>o.type==='lot'&&o.id===id));
  }
  function highlightCollectionOnMap(key){
    // Only mapped lots from the current imported report are highlighted.
    // This is ephemeral UI state and NEVER written into the site JSON.
    const ids=collectionMapIds(key);
    if(!ids.length){toast('No drawn lots for this invoice. The schedule record remains available.');return false;}
    dismissMapHighlights();
    highlightedMapLots=ids;
    highlightedMapKey=key;
    highlightedMapLabel=key.startsWith('inv:')?'Invoice '+key.slice(4):'Selected lot';
    settings.selected=null;
    switchMode('map');
    setTool('select');
    const text=$('mapHighlightText'),notice=$('mapHighlightNotice');
    text.textContent=`${highlightedMapLabel}: ${ids.length} lot${ids.length===1?'':'s'} outlined for 15 seconds`;
    notice.hidden=false;
    const focus=()=>{
      resizeCanvas();
      const lots=project.objects.filter(o=>o.type==='lot'&&ids.includes(o.id));
      const box=groupBounds(lots);
      if(box){
        const w=Math.max(1,box.maxX-box.minX),h=Math.max(1,box.maxY-box.minY);
        const rw=view.rotation%2?h:w,rh=view.rotation%2?w:h;
        view.zoom=minmax(Math.min((view.width-140)/(rw*CELL_PX),(view.height-140)/(rh*CELL_PX)),.15,5);
        const rotated=quarterTurnPoint((box.minX+box.maxX)/2,(box.minY+box.maxY)/2);
        view.offsetX=view.width/2-rotated.x*scale();
        view.offsetY=view.height/2-rotated.y*scale();
        view.fitted=false;
      }
      drawSoon();
    };
    requestAnimationFrame(focus);
    highlightTimer=setTimeout(dismissMapHighlights,15000);
    return true;
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
    c.save();c.translate(ox,oy);c.rotate(((options.rotation||0)%4)*Math.PI/2);c.scale(px,px);
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
      else if(o.type==='lot')drawLot(c,o,showText,options.printContacts===true);
      else if(o.type==='box')drawBox(c,o,showText);
      else if(o.type==='lock')drawLock(c,o,showText);
      else if(o.type==='label'&&showText)drawLabel(c,o);
      c.restore();
    }
    if(!options.export){
      if(settings.tool==='move-all')drawGroupOutline(c);
      const selected=getSelected();if(selected)drawSelection(c,selected);
      paintTemporaryLotHighlights(c,px);
      if(drawing && drawing.preview && ['wall','door','shutter','lot','box'].includes(drawing.preview.type)){
        c.save();c.globalAlpha=.7;c.setLineDash([.15,.12]);
        if(drawing.preview.type==='lot')drawLot(c,{...drawing.preview,number:'NEW',status:'reserved',invoice:''});
        else if(drawing.preview.type==='box')drawBox(c,{...drawing.preview,color:'#e99d3e',label:'Area'},project.showText!==false);
        else drawStructure(c,drawing.preview);
        c.setLineDash([]);c.restore();
      }
    }
    // Explicit export opt-in only: ordinary site PNGs and print plans do not
    // automatically inherit the temporary highlighted invoice.
    if(options.export&&Array.isArray(options.highlightIds)&&options.highlightIds.length){
      paintTemporaryLotHighlights(c,px,options.highlightIds);
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
    paint(ctx,view.width,view.height,view.offsetX,view.offsetY,scale(),{rotation:view.rotation});
    $('zoomLabel').textContent=`${Math.round(view.zoom*100)}%`;
    const measure=project.cellMeters*5;
    const scaleLength=Math.max(1,5*scale());
    $('scaleMeasure').textContent=`${fmt(measure)} m`;
    $('scaleLine').style.width=`${scaleLength}px`;
    $('scaleHint').textContent=`1 square = ${fmt(project.cellMeters)} m`;
  }
  function exportPNG(){
    const padding=60;
    const bounds=rotatedSiteBounds(view.rotation);
    const px=Math.min(45,Math.max(8,2200/Math.max(bounds.width,bounds.height)));
    const width=Math.round(bounds.width*px+padding*2),height=Math.round(bounds.height*px+padding*2);
    const copy=document.createElement('canvas');copy.width=width;copy.height=height;
    const c=copy.getContext('2d');
    const ox=padding-bounds.minX*px,oy=padding-bounds.minY*px;
    paint(c,width,height,ox,oy,px,{export:true,rotation:view.rotation});
    c.fillStyle='#1f354e';c.textAlign='left';c.font='bold 22px system-ui,sans-serif';
    c.fillText(project.name.slice(0,95),padding,32);
    c.font='14px system-ui,sans-serif';c.textAlign='right';
    c.fillText(`1 square = ${fmt(project.cellMeters)} m`,width-padding,32);
    copy.toBlob(blob=>{if(blob){downloadBlob(blob,`${safeName(project.name)}-plan.png`);toast('Site plan exported as PNG');}},'image/png');
  }

  function buildHighlightedPlanCanvas(target,maxSize=2600){
    if(!target||target.projectId!==project.id)throw Error('The selected site has changed.');
    const ids=target.ids.filter(id=>project.objects.some(o=>o.type==='lot'&&o.id===id));
    if(!ids.length)throw Error('No matching lots are drawn on this site.');
    const padding=72;
    const bounds=rotatedSiteBounds(view.rotation);
    const px=Math.max(3,Math.min(48,(maxSize-padding*2)/Math.max(bounds.width,bounds.height)));
    const width=Math.round(bounds.width*px+padding*2);
    const height=Math.round(bounds.height*px+padding*2);
    const out=document.createElement('canvas');
    out.width=width;out.height=height;
    const context=out.getContext('2d');
    if(!context)throw Error('Cannot create the highlighted map image in this browser.');
    paint(context,width,height,padding-bounds.minX*px,padding-bounds.minY*px,px,{export:true,grid:true,
      showText:true,highlightIds:ids,rotation:view.rotation});
    context.textAlign='left';context.fillStyle='#1f354e';
    context.font='bold 21px system-ui,sans-serif';
    context.fillText(project.name.slice(0,75),padding,30,Math.max(150,width-padding*2));
    context.font='bold 15px system-ui,sans-serif';
    context.fillStyle='#775000';
    context.fillText(`HIGHLIGHTED · ${target.label}`,padding,53,Math.max(150,width-padding*2));
    context.font='12px system-ui,sans-serif';context.fillStyle='#425871';
    context.fillText(`${ids.length} highlighted lot${ids.length===1?'':'s'} · 1 square = ${fmt(project.cellMeters)} m · Created locally`,
      padding,height-22,Math.max(150,width-padding*2));
    return out;
  }
  function highlightedTargetForKey(key){
    const ids=collectionMapIds(key);
    if(!ids.length)return null;
    return {projectId:project.id,key,ids,
      label:key.startsWith('inv:')?'Invoice '+key.slice(4):'Lot collection'};
  }
  function openHighlightedPlanPreview(key){
    const target=highlightedTargetForKey(key);
    if(!target){toast('No mapped lots available for this invoice.');return false;}
    const dialog=$('highlightPreviewDialog');
    highlightPreviewTarget=target;
    try{
      const rendered=buildHighlightedPlanCanvas(target,1600);
      $('highlightPreviewImage').src=rendered.toDataURL('image/png');
      $('highlightPreviewTitle').textContent=target.label+' · highlighted site plan';
      dialog.showModal();
    }catch(err){
      highlightPreviewTarget=null;
      toast('Unable to preview the highlighted plan: '+String(err?.message||err));
      return false;
    }
    return true;
  }
  function closeHighlightedPlanPreview(){
    const dialog=$('highlightPreviewDialog');
    if(dialog.open)dialog.close();
  }
  function downloadHighlightedPlan(target){
    if(!target){toast('Open a highlighted invoice preview first.');return false;}
    try{
      const canvas=buildHighlightedPlanCanvas(target,2800);
      const filename=`${safeName(project.name)}-${safeName(target.label)}-highlighted.png`;
      canvas.toBlob(blob=>{
        if(blob){
          downloadBlob(blob,filename);
          toast('Highlighted PNG downloaded locally. Treat invoice details as confidential.');
        }else toast('Unable to save the highlighted image on this device.');
      },'image/png');
      return true;
    }catch(err){
      toast('Unable to export the highlighted map: '+String(err?.message||err));
      return false;
    }
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
    const anchor=viewWorldAt(midpoint.x,midpoint.y);
    pinch={initialDistance:Math.max(8,Math.hypot(a.x-b.x,a.y-b.y)),initialZoom:view.zoom,
      worldX:anchor.x,worldY:anchor.y};
    cancelGroupDrag(drawing);
    drawing=null;
  }
  function updatePinch(){
    if(!pinch||pointers.size<2)return;
    const pts=[...pointers.values()].slice(0,2);
    const a=pts[0],b=pts[1],r=canvas.getBoundingClientRect();
    const midX=(a.x+b.x)/2-r.left,midY=(a.y+b.y)/2-r.top;
    const distance=Math.max(8,Math.hypot(a.x-b.x,a.y-b.y));
    view.zoom=minmax(pinch.initialZoom*distance/pinch.initialDistance,.1,7);
    const anchored=quarterTurnPoint(pinch.worldX,pinch.worldY);
    view.offsetX=midX-anchored.x*scale();view.offsetY=midY-anchored.y*scale();
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
    if(settings.tool==='move-all'){
      if(!project.objects.length){setTool('select');return;}
      drawing={action:'move-all',originals:clone(project.objects),before:snapshot(),startWorld:p};
      return;
    }
    if(settings.tool==='select'){
      const target=hitObject(p);
      if(!target){
        selectObject(null);
        drawing={action:'pan',startClient:{x:ev.clientX,y:ev.clientY},startOffset:{x:view.offsetX,y:view.offsetY}};
        return;
      }
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
    if(drawing.action==='move-all'){
      const dx=Math.round(p.x-drawing.startWorld.x),dy=Math.round(p.y-drawing.startWorld.y);
      if(!translateGroup(drawing.originals,dx,dy)){
        cancelGroupDrag(drawing);drawing=null;
        toast('An item is outside the grid; move it inside before moving the group.');
      }
      drawSoon();return;
    }
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
    if(d.action==='move-all'){
      if(cancelled){cancelGroupDrag(d);return;}
      commit(d.before);return;
    }
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

  function fmtAdminValue(v){
    const text=ADMIN().asText(v);
    return text?e(text):'<span class="missing">Not supplied</span>';
  }
  function invoiceEditorHtml(lot){
    const found=reportForLot(lot);
    const imported=importedInvoiceFor(lot);
    const manual=String(lot.invoice||'').trim();
    let note;
    if(found?.duplicateOnMap)note='Duplicate lot number on the drawing: automatic invoice matching has been disabled.';
    else if(found?.duplicateInReport)note='Duplicate LotNumber in today’s spreadsheet: automatic invoice matching has been disabled.';
    else if(imported&&manual&&manual!==imported)note='Manual invoice differs from the daily spreadsheet. The existing manual value is preserved.';
    else if(imported&&manual)note='Existing manual invoice matches today’s report. Switch to automatic linking to follow future reports.';
    else if(imported)note='Auto-filled from the daily spreadsheet; this value is not written into structural site JSON.';
    else if(found?.row)note='Lot matched, but today’s spreadsheet has no invoice ID.';
    else if(found)note='No exact lot match in the daily report. Any manual invoice is preserved.';
    else note='Manual entry. Import an Excel report under Admin Data to auto-fill this field.';
    return field('Invoice number(s)','invoice',effectiveInvoiceFor(lot),'text','placeholder="Auto-filled from Excel or type manually"')+
      `<div class="invoice-link-state ${found?.duplicateOnMap||found?.duplicateInReport||imported&&manual&&manual!==imported?'conflict':imported&&!manual?'linked':''}">
        <span>${e(note)}</span>
        ${imported&&manual?`<button type="button" class="btn btn-light" data-action="followAdminInvoice">Use daily invoice (${e(imported)})</button>`:''}
      </div>`;
  }
  function linkedContactFields(lot){
    const row=reportForLot(lot)?.row;
    if(!row)return '';
    const values=[
      ['Buyer / billing name','dbo.RWX_Invoices::Full Billing Name'],
      ['Mobile','mobile::StringNativeValue'],
      ['Telephone','tel::StringNativeValue'],
      ['Billing postcode','dbo.RWX_Invoices::BillingZipPostal'],
      ['Username','dbo.RWX_Users 2::UserName']
    ];
    return `<div class="linked-contact-fields">
      <div class="linked-contact-heading"><strong>Buyer & contact details</strong><span>Daily spreadsheet · read only</span></div>
      ${values.map(([label,key])=>field(label,'linked_'+key,ADMIN().asText(row[key]),'text','readonly autocomplete="off"')).join('')}
      <p class="field-help">Shown from the local admin report; never copied to site-plan JSON. Import a newer report to refresh.</p>
    </div>`;
  }
  function adminInfoCard(lot){
    if(!localAdminAllowed())return '';
    const found=reportForLot(lot);
    if(!found){
      return '<div class="admin-lot-card"><h3>Admin invoice report</h3><p class="field-help">No admin report linked to this site. Use the Admin Data tab to import the daily Excel report locally.</p></div>';
    }
    const {row,index}=found;
    if(!row){
      const why=found.duplicateOnMap?'Multiple drawn lots share the same lot number. Correct the duplicate before linking customer details.':
        found.duplicateInReport?'The spreadsheet has duplicate rows for this LotNumber. Auto-linking is disabled to avoid displaying the wrong customer.':
        `No exact LotNumber match found for lot ${lot.number}. Check the auction and lot number before using the details.`;
      return `<div class="admin-lot-card"><h3>Admin invoice report</h3><p class="admin-unmatched">${e(why)}</p></div>`;
    }
    const inv=ADMIN().invoiceKey(row['dbo.RWX_Invoices::Id']);
    const siblings=inv?index.byInvoice.get(inv)||[]:[];
    const formattedPrice=row['dbo.RWX_Listings::CurrentPrice']===''?'Not supplied':
      new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(Number(row['dbo.RWX_Listings::CurrentPrice'])||0);
    const linked=siblings.map(other=>{
      const key=ADMIN().lotKey(other.LotNumber);
      const match=project.objects.find(o=>o.type==='lot'&&ADMIN().lotKey(o.number)===key);
      return match
        ? `<button type="button" class="admin-sibling" data-select="${e(match.id)}"><b>Lot ${e(other.LotNumber)}</b><span>${e(String(other['dbo.RWX_Listings::Title']||'').slice(0,65))}</span></button>`
        : `<div class="admin-sibling not-drawn"><b>Lot ${e(other.LotNumber)}</b><span>Not placed on site plan</span></div>`;
    }).join('');
    const paid=ADMIN().formatPaid(row['dbo.RWX_Invoices::PaidDTTM']);
    return `<section class="admin-lot-card">
      <div class="admin-lot-head"><h3>Admin invoice report</h3><span>Matched lot</span></div>
      <dl class="admin-detail-grid">
        <div><dt>Invoice ID</dt><dd>${fmtAdminValue(row['dbo.RWX_Invoices::Id'])}</dd></div>
        <div><dt>Lot status</dt><dd>${fmtAdminValue(row['dbo.RWX_LineItems::Lot Status'])}</dd></div>
        <div class="admin-full"><dt>Lot description</dt><dd>${fmtAdminValue(row['dbo.RWX_Listings::Title'])}</dd></div>
        <div><dt>Winning price</dt><dd>${e(formattedPrice)}</dd></div>
        <div><dt>Payment recorded</dt><dd>${paid?e(paid):'<span class="missing">Not supplied</span>'}</dd></div>
        <div class="admin-full"><dt>Billing name</dt><dd>${fmtAdminValue(row['dbo.RWX_Invoices::Full Billing Name'])}</dd></div>
        <div><dt>Billing postcode</dt><dd>${fmtAdminValue(row['dbo.RWX_Invoices::BillingZipPostal'])}</dd></div>
        <div><dt>Username</dt><dd>${fmtAdminValue(row['dbo.RWX_Users 2::UserName'])}</dd></div>
        <div><dt>Mobile</dt><dd>${fmtAdminValue(row['mobile::StringNativeValue'])}</dd></div>
        <div><dt>Telephone</dt><dd>${fmtAdminValue(row['tel::StringNativeValue'])}</dd></div>
        <div><dt>Payer ID</dt><dd>${fmtAdminValue(row['dbo.RWX_Invoices::PayerId'])}</dd></div>
      </dl>
      <h3 class="admin-group-title">Lots on this invoice ${inv?'('+siblings.length+')':''}</h3>
      ${inv?`<div class="admin-sibling-list">${linked}</div>`:'<p class="admin-unmatched">No invoice ID in the Excel row; other lots cannot be grouped reliably.</p>'}
      <p class="field-help">These values are read from the locally imported daily report. Manual notes and clearance status remain unchanged; invoice values auto-link only when no manual override is present.</p>
    </section>`;
  }
  function renderAdminPanel(){
    if(!localAdminAllowed()){
      panel.innerHTML=`<section class="admin-step-page"><h2>Daily Excel report</h2>
        <p class="admin-unmatched">Customer data is blocked on hosted websites. Run YardMap locally at http://localhost:8000 before importing the daily Excel file.</p></section>`;
      return;
    }
    const report=adminReport();
    const count=report?ADMIN().countMatch(report,project.objects):null;
    const groups=report?collectionsListEntries().length:0;
    panel.innerHTML=`<section class="admin-step-page">
      <span class="admin-step-label">STEP 1 OF 3 · DAILY REPORT</span>
      <h2>Import the daily sales spreadsheet</h2>
      <p class="admin-step-intro">Choose the Excel file sent by the admin team. YardMap reads the report on this computer and builds a list of invoices and lots automatically. <strong>You do not need to draw anything on the map.</strong></p>
      <div class="admin-upload-card">
        <div class="admin-upload-icon" aria-hidden="true">XLSX</div>
        <div><h3>${report?'Update today’s report':'Select the daily Excel report'}</h3>
          <p>Use the original .xlsx file with its existing column headings. Importing a newer report keeps your collection notes and bookings.</p></div>
        <button type="button" class="btn btn-primary admin-upload-action" data-action="adminExcel">${report?'Replace Excel report':'Choose Excel file (.xlsx)'}</button>
      </div>
      ${report?`<div class="admin-report-status" role="status">
        <strong>✓ Spreadsheet loaded</strong>
        <p><b>${e(report.sourceName||'Admin report')}</b> · ${e(report.auctionEventId||'Auction ID not supplied')}</p>
        <p>${e(new Date(report.importedAt).toLocaleString('en-GB'))} · ${count.reportRows} Excel lots · ${groups} invoice/lot records</p>
        ${count.duplicateLotKeys.length?`<p class="admin-unmatched">Warning: ${count.duplicateLotKeys.length} duplicate lot number(s) need checking before matching.</p>`:''}
      </div>
      <div class="admin-next-step">
        <span>READY FOR STEP 2</span>
        <strong>Find a buyer, open their invoice, then record their collection arrangements.</strong>
        <button type="button" class="btn btn-primary" data-admin-next="collections">Go to invoice list</button>
      </div>
      <p class="admin-local-footnote">Report contents are read-only. To correct sales data, request an amended Excel file from the admin team and reimport it.</p>`:
      `<div class="admin-next-step admin-next-empty"><span>AFTER IMPORT</span><strong>You'll be guided to the invoice list to update bookings and notes.</strong></div>`}
      <p class="admin-local-footnote">Private, local-only processing. The Excel file is never sent to GitHub, a server or cloud storage.</p>
    </section>`;
  }
  async function importAdminFile(file,format){
    if(!file)return;
    if(format!=='excel'){toast('Import the daily Excel spreadsheet (.xlsx) in Admin Mode.');return;}
    if(!localAdminAllowed()){toast('For safety, open YardMap on localhost to import admin data.');return;}
    if(adminReportsBlocked){toast('Admin storage needs recovery. Existing data is protected from overwrite.');return;}
    if(file.size>15*1024*1024){toast('Report exceeds the 15 MB file limit.');return;}
    try{
      const incoming=format==='excel'
        ? await ADMIN().parseXlsx(await file.arrayBuffer(),file.name)
        : ADMIN().validateReport(JSON.parse(await file.text()));
      const counts=ADMIN().countMatch(incoming,project.objects);
      const existing=adminReport();
      const mismatch=existing?.auctionEventId&&incoming.auctionEventId&&existing.auctionEventId!==incoming.auctionEventId;
      const warning=mismatch?'\nWARNING: AuctionEventID differs from the current site report.':'';
      if(!window.confirm(`Load the daily Excel report for “${project.name}”?\n\nAuctionEventID: ${incoming.auctionEventId||'(unknown)'}\n${counts.reportRows} Excel lots · ${counts.matched} already drawn on the map.\n\nThe new report will replace the previous spreadsheet, but your drawings, collection bookings and notes remain saved on this device.${warning}`))return;
      const next=Object.assign(Object.create(null),adminReports);
      next[project.id]=incoming;
      if(!storeAdminReports(next))return;
      const migrated=migrateUnlinkedCollections();
      settings.collectionsSelectedKey=null;
      switchTab('collections');
      panel.scrollTop=0;
      toast(`Excel report imported. ${counts.reportRows} lots ready to work through.${migrated?` ${migrated} existing collection record(s) linked.`:''}`);
    }catch(err){
      console.warn('Local admin import failed:',err?.message||'Unknown error');
      toast('Admin import failed: '+String(err?.message||err).slice(0,150));
    }
  }
  function exportAdminJson(){
    const report=adminReport();if(!report){toast('No admin report has been imported for this site.');return;}
    const json=JSON.stringify(report,null,2);
    downloadBlob(new Blob([json],{type:'application/json'}),`${safeName(project.name)}-admin-confidential.json`);
    toast('Confidential admin JSON downloaded locally.');
  }
  function removeAdminData(){
    const report=adminReport();if(!report)return;
    if(!window.confirm('Remove the imported Excel report for this site from this browser? You will need the original Excel file to restore it. The map and collection notes remain untouched.'))return;
    const next=Object.assign(Object.create(null),adminReports);
    delete next[project.id];
    if(storeAdminReports(next)){refreshAll();toast('Local admin report removed. Site plan unchanged.');}
  }

  function renderPanel(){
    if(settings.tab==='lots'){renderLotsPanel();return;}
    if(settings.tab==='access'){renderAccessPanel();return;}
    if(settings.mode==='admin'){
      if(settings.tab==='admin'){renderAdminPanel();return;}
      if(settings.tab==='collections'||settings.tab==='schedule'){renderCollectionsPanel();return;}
      renderAdminPanel();return;
    }
    const o=getSelected();
    if(!o){
      panel.innerHTML=`<h2 class="panel-title">Site Settings</h2><p class="panel-description">Set up the site to match your building. All measurements and object positions use this grid.</p>
        ${field('Site name','siteName',project.name)}
        <div class="field-grid">${field('Grid width (squares)','cols',project.cols,'number','min="8" max="250"')}${field('Grid height (squares)','rows',project.rows,'number','min="8" max="250"')}</div>
        ${field('Metres per square','cellMeters',project.cellMeters,'number','min="0.1" max="100" step="0.1"')}
        <p class="field-help">Current site footprint: ${fmt(project.cols*project.cellMeters)} m × ${fmt(project.rows*project.cellMeters)} m. Existing drawings remain at their grid coordinates if you change the scale.</p>
        <div class="group-move-panel">
          <strong>${settings.tool==='move-all'?'Move All active':'Reposition the whole drawing'}</strong>
          <p>${settings.tool==='move-all'
            ? `All ${project.objects.length} items are selected. Drag anywhere on the map to move everything together. One Undo restores the old positions.`
            : 'Move all items together, or drag blank space with Select to pan the view without changing coordinates.'}</p>
          <button type="button" class="btn btn-light" data-action="moveAll" ${project.objects.length?'':'disabled'}>Select all / Move all</button>
          ${settings.tool==='move-all'?'<button type="button" class="btn btn-subtle" data-action="stopMoveAll">Finish moving</button>':''}
        </div>
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
    let html=`<h2 class="panel-title">${e(title)} <span style="font-size:10px;font-weight:600;color:#a2b0c0">· EDIT</span></h2><p class="panel-description">Changes save as you type, even when you click directly onto the site plan.</p>`;
    if(o.type==='lot'){
      html+=field('Lot number','number',o.number)+invoiceEditorHtml(o);
      if(reportForLot(o)?.row){
        html+=`<details class="map-linked-data"><summary>Buyer contact from daily Excel</summary>${linkedContactFields(o)}</details>`;
      }
      html+=field('Clearance status','status',optionsHtml(Object.entries(STATUS).map(([k,v])=>[k,v.label]),o.status),'select');
      html+=`<div class="field-grid">${field('Custom colour','color',o.color||STATUS[o.status].color,'color')}
        <div class="field"><label>Use status colour</label><button class="btn btn-light" data-action="resetColor" style="width:100%;min-height:40px">Reset colour</button></div></div>`;
      html+=`<p class="field-help">Colour can be customised independently of clearance status. Green means cleared in the progress dashboard.</p>`;
      html+=`<div class="divider"></div><h3 class="panel-title">Footprint</h3>${fieldsXY(o,['x','y','w','h'])}`;
      html+=`<p class="field-help">Physical size: ${fmt(o.w*project.cellMeters)} × ${fmt(o.h*project.cellMeters)} metres.</p>`;
      html+=fontControlHtml(o);
      html+=field('Map / asset notes','notes',o.notes,'textarea');
      html+=`<div class="map-admin-link"><strong>Buyer, collection booking and activity notes</strong>
        <p>Manage the payment, recovery details, RAMS and timestamped collection notes in Admin Mode.</p>
        <button class="btn btn-primary" type="button" data-action="openAdminForLot">Open collection record</button>
      </div>`;
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
    panel.innerHTML=`<h2 class="panel-title">Lot Register</h2><p class="panel-description">Select a lot to edit its invoice, location or collection status. Linked invoice IDs come from the most recently imported daily spreadsheet, while manually entered values take priority. The exported CSV may contain confidential imported invoice IDs.</p>
      <div class="lot-tools"><input id="lotSearch" class="search-input" type="search" placeholder="Search lot, invoice or notes…" value="${e(settings.lotSearch)}" aria-label="Search lots">
        <label for="lotSort" class="sort-label">Sort drawn lots</label>
        <select id="lotSort" class="search-input">${optionsHtml([
          ['numberAsc','Lot number · low to high'],['numberDesc','Lot number · high to low'],
          ['sizeDesc','Size · largest area first'],['sizeAsc','Size · smallest area first'],
          ['booked','Booked in first'],['rams','RAMS checked first'],
          ['contacted','Payment contacted first'],['cleared','Cleared lots first']
        ],settings.lotSort)}</select>
        <div class="filter-row" id="lotFilters">${[['all','All'],['pending','Pending'],['cleared','Cleared'],['hold','Hold'],['issue','Issues'],['reserved','Reserved']].map(([k,v])=>`<button class="filter-chip ${settings.lotFilter===k?'active':''}" data-filter="${k}">${v}</button>`).join('')}</div></div>
      <div id="lotList"></div>
      <div class="divider"></div><div class="panel-actions"><button class="btn btn-light" data-action="csv">Export lot register CSV</button><button class="btn btn-primary" data-action="drawLot">+ Draw lot</button></div>`;
    renderLotList();
  }
  function renderLotList(){
    const target=$('lotList');if(!target)return;
    const query=settings.lotSearch.toLowerCase().trim();
    const lots=project.objects.filter(o=>o.type==='lot'&&(settings.lotFilter==='all'||o.status===settings.lotFilter))
      .filter(o=>[o.number,effectiveInvoiceFor(o),o.notes,o.status].join(' ').toLowerCase().includes(query));
    const tick=(lot,key)=>collectionForLot(lot)[key]===true?1:0;
    lots.sort((a,b)=>{
      let delta=0;
      switch(settings.lotSort){
        case 'numberDesc':delta=numericLot(b.number,a.number);break;
        case 'sizeDesc':delta=b.w*b.h-a.w*a.h;break;
        case 'sizeAsc':delta=a.w*a.h-b.w*b.h;break;
        case 'booked':delta=tick(b,'bookedIn')-tick(a,'bookedIn');break;
        case 'rams':delta=tick(b,'ramsChecked')-tick(a,'ramsChecked');break;
        case 'contacted':delta=tick(b,'contactedForPayment')-tick(a,'contactedForPayment');break;
        case 'cleared':delta=Number(b.status==='cleared')-Number(a.status==='cleared');break;
        default:delta=numericLot(a.number,b.number);
      }
      return delta||numericLot(a.number,b.number);
    });
    if(!lots.length){target.innerHTML='<div class="empty-list">No matching lots yet. Choose <b>Draw Lot</b> to place one on the site plan.</div>';return;}
    target.innerHTML=lots.map(o=>{
      const cleared=o.status==='cleared';const c=o.color||STATUS[o.status].color;
      const shownInvoice=effectiveInvoiceFor(o);
      return `<div class="list-item-card ${settings.selected===o.id?'selected':''}" data-select="${e(o.id)}" tabindex="0" role="button" aria-label="Edit lot ${e(o.number)}">
      <div class="list-card-top"><span class="lot-swatch" style="background:${c}"></span><div class="lot-card-main"><strong>Lot ${e(o.number||'—')}</strong><small>${shownInvoice?`Invoice: ${e(shownInvoice)}`:'No invoice linked'} · ${e(STATUS[o.status].label)} · ${fmt(o.w*o.h*project.cellMeters*project.cellMeters)} m²</small></div>
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
  function updateField(input,live=false){
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
      commit(before,live?`${project.id}:site:${key}`:null);
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
    if(key.startsWith('linked_'))return;
    if(key==='invoice'&&obj.type==='lot'){
      value=String(value).trim().slice(0,200);
      // Even if the imported invoice is visible in the input, do not copy
      // it to structural JSON when the user has not actually overridden it.
      if(value===importedInvoiceFor(obj))value='';
    }
    if(key==='fontSize'){
      const parsed=Number(value);
      if(!Number.isFinite(parsed)||parsed<.15||parsed>2.5){toast('Font size must be 0.15 to 2.5 grid squares.');renderPanel();return;}
      value=Math.round(parsed*100)/100;
    }
    if(key==='color'&&!/^#[0-9a-f]{6}$/i.test(value))return;
    obj[key]=value;
    commit(before,live?`${project.id}:${obj.id}:${key}`:null);
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
    if(action==='adminExcel'){$('adminExcelFile').click();return;}
    if(action==='openAdminForLot'){
      if(o?.type!=='lot')return;
      if(!collectionsListEntries().some(item=>item.key===collectionKeyForLot(o))){
        toast('This lot is not linked to the current Excel report. Import or correct the source spreadsheet first.');
        return;
      }
      settings.collectionsSelectedKey=collectionKeyForLot(o);
      switchMode('admin');
      switchTab('collections');
      panel.scrollTop=0;focusPanelHeading();
      return;
    }
    if(action==='addCollectionNote'){addCollectionNote();return;}
    if(action==='printCollectionSchedule'){openPrintPreview('schedule');return;}
    if(action==='followAdminInvoice'){
      if(o?.type!=='lot'||!importedInvoiceFor(o))return;
      const before=snapshot();o.invoice='';commit(before);
      toast('Invoice now updates automatically from the daily spreadsheet.');
      return;
    }
    if(action==='csv'){exportCSV();return;}
    if(action==='png'){exportPNG();return;}
    if(action==='printPreview'){openPrintPreview();return;}
    if(action==='toggleText'){setTextVisibility();return;}
    if(action==='duplicateSite'){duplicateSite();return;}
    if(action==='deleteSite'){await deleteSite();return;}
    if(action==='clearCanvas'){requestClearCanvas();return;}
    if(action==='moveAll'){setTool('move-all');return;}
    if(action==='stopMoveAll'){setTool('select');return;}
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

  function printBuyerGroups(){
    const groups=new Map();
    const report=adminReport();
    const reportIndex=report?ADMIN().indexReport(report):null;
    for(const lot of project.objects.filter(o=>o.type==='lot')){
      const invoice=effectiveInvoiceFor(lot);
      const key=invoice?'invoice:'+invoice:'unlinked:'+lot.id;
      if(!groups.has(key))groups.set(key,{invoice,lots:[],rows:[],drawn:[],buyer:'',mobile:'',telephone:'',email:'',username:'',recoveryName:'',recoveryPhone:'',recoveryEmail:'',recoveryCompany:''});
      const item=groups.get(key);
      item.drawn.push(lot);
      item.lots.push(String(lot.number||'—'));
      const found=reportForLot(lot)?.row;
      // Never mix two buyers if a manual invoice override disagrees with
      // today's report. Buyer data is added only for matching invoices.
      const matching=found&&ADMIN().invoiceKey(found['dbo.RWX_Invoices::Id'])===invoice;
      if(matching)item.rows.push(found);
      const booking=collectionForLot(lot);
      if(!item.recoveryName&&booking.recoveryName)item.recoveryName=booking.recoveryName;
      if(!item.recoveryPhone&&booking.recoveryPhone)item.recoveryPhone=booking.recoveryPhone;
      if(!item.recoveryEmail&&booking.recoveryEmail)item.recoveryEmail=booking.recoveryEmail;
      if(!item.recoveryCompany&&booking.recoveryCompany)item.recoveryCompany=booking.recoveryCompany;
    }
    for(const item of groups.values()){
      if(item.invoice&&reportIndex?.byInvoice?.has(item.invoice)){
        const rows=reportIndex.byInvoice.get(item.invoice);
        item.rows=rows;
        for(const row of rows)item.lots.push(String(row.LotNumber||'—'));
      }
      item.lots=[...new Set(item.lots)].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
      const row=item.rows[0];
      if(row){
        item.buyer=ADMIN().asText(row['dbo.RWX_Invoices::Full Billing Name']);
        item.mobile=ADMIN().asText(row['mobile::StringNativeValue']);
        item.telephone=ADMIN().asText(row['tel::StringNativeValue']);
        const username=ADMIN().asText(row['dbo.RWX_Users 2::UserName']);
        // The report has a username field, NOT a dedicated email field.
        item.email=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)?username:'';
        item.username=item.email?'':username;
      }
    }
    return [...groups.values()].sort((a,b)=>
      String(a.lots[0]||'').localeCompare(String(b.lots[0]||''),undefined,{numeric:true}));
  }
  function buyerPrintCard(item){
    const contacts=[item.mobile,item.telephone].filter(Boolean).join(' / ');
    const missingEmail=item.email?'': 'Buyer email not supplied in Excel';
    return `<article class="buyer-print-card">
      <h3>${e(item.buyer||'Buyer not supplied')} <span>· ${e(item.invoice?'Invoice '+item.invoice:'Unlinked lot')}</span></h3>
      <p class="buyer-lots"><strong>Lots:</strong> ${e(item.lots.join(', '))}</p>
      <p><strong>Telephone:</strong> ${e(contacts||'Not supplied')}</p>
      <p><strong>Buyer email:</strong> ${e(item.email||missingEmail)}</p>
      ${item.username?`<p><strong>Username:</strong> ${e(item.username)}</p>`:''}
      ${item.recoveryName||item.recoveryCompany||item.recoveryPhone||item.recoveryEmail?
        `<p class="buyer-recovery"><strong>Recovery:</strong> ${e([item.recoveryName,item.recoveryCompany,item.recoveryPhone,item.recoveryEmail].filter(Boolean).join(' · '))}</p>`:''}
    </article>`;
  }
  // An invoice is fully collected ONLY if every lot listed for it in the
  // imported daily Excel has a unique matching drawn lot marked 'cleared'.
  // Unknown/undrawn/duplicate lots keep the invoice in the contact directory.
  function isFullyCollectedInvoice(group,reportIndex){
    if(!group?.invoice||!reportIndex?.byInvoice)return false;
    const rows=reportIndex.byInvoice.get(group.invoice);
    if(!rows||!rows.length)return false;
    return rows.every(row=>{
      const key=ADMIN().lotKey(row.LotNumber);
      if(!key||reportIndex.duplicates?.has(key))return false;
      const lot=mappedLotForNumber(row.LotNumber,group.invoice);
      return !!lot&&lot.status==='cleared';
    });
  }
  function printBuyerContinuation(items,excluded=0){
    return `<header class="directory-head"><h2>${e(project.name)} · Buyer / invoice directory</h2>
      <p>Confidential · locally generated · ${e(new Date().toLocaleString('en-GB'))}</p>
      <p>${items.length} buyer / invoice group${items.length===1?'':'s'} included${excluded?` · ${excluded} fully collected invoice${excluded===1?'':'s'} excluded`:''}.
      Each entry lists the buyer, invoice, associated lots and available contact details. Buyer email is only shown when supplied as an email address.</p></header>
      ${items.length?`<div class="buyer-print-continuation">${items.map(buyerPrintCard).join('')}</div>`:
       '<p class="buyer-directory-empty">No outstanding buyer groups to list. The site plan on the preceding page remains complete.</p>'}`;
  }
  function printContactDirectory(excludedInvoices=new Set()){
    const lots=project.objects.filter(o=>o.type==='lot'&&!excludedInvoices.has(effectiveInvoiceFor(o))).sort((a,b)=>
      ADMIN().lotKey(a.number).localeCompare(ADMIN().lotKey(b.number),undefined,{numeric:true}));
    if(!lots.length){
      return `<header class="directory-head"><h2>${e(project.name)} · Lot contact directory</h2></header>
        <p class="buyer-directory-empty">No outstanding mapped lots remain in this contact list. The full site plan is on the preceding page.</p>`;
    }
    const rows=lots.map(lot=>{
      const row=reportForLot(lot)?.row;
      const booking=collectionForLot(lot);
      const date=booking.bookedIn&&booking.bookingDate?`${booking.bookingDate} ${booking.bookingTime||'TBC'}`:'—';
      const buyer=ADMIN().asText(row?.['dbo.RWX_Invoices::Full Billing Name']);
      const phones=[row?.['mobile::StringNativeValue'],row?.['tel::StringNativeValue']].filter(Boolean);
      return `<tr><td><strong>${e(lot.number||'—')}</strong></td>
        <td>${e(effectiveInvoiceFor(lot)||'—')}</td>
        <td>${e(buyer||'—')}</td>
        <td>${e(phones.join(' / ')||'—')}</td>
        <td>${e(booking.recoveryName||'—')} ${booking.recoveryPhone?`<small>${e(booking.recoveryPhone)}</small>`:''}</td>
        <td>${e(date)}</td></tr>`;
    }).join('');
    return `<header class="directory-head"><h2>${e(project.name)} · Lot contact directory</h2>
      <p>Confidential · generated locally · ${lots.length} placed lots · ${e(new Date().toLocaleString('en-GB'))}</p>
      <p>Compact contacts appear inside lot shapes where space permits. This directory provides a readable reference for every lot.</p></header>
      <table class="print-contact-table"><thead><tr><th>Lot</th><th>Invoice</th><th>Buyer / contact</th><th>Buyer telephone</th><th>Recovering contact</th><th>Booked</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
  function printScheduleContent(){
    return `<header class="directory-head"><h2>${e(project.name)} · Collection schedule</h2>
      <p>Confidential · generated locally · ${e(new Date().toLocaleString('en-GB'))}</p>
      <p>Bookings grouped by date, in time order. Contact and RAMS status are drawn from locally stored records.</p></header>
      ${scheduleHTML()}`;
  }
  function openPrintPreview(mode='site') {
    printView=mode==='schedule'?'schedule':'site';
    $('printPaper').value='A4';
    $('printOrientation').value=printView==='schedule'?'portrait':project.cols>=project.rows?'landscape':'portrait';
    $('printText').checked=project.showText!==false;
    $('printGrid').checked=true;
    $('printContact').checked=true;
    $('printBuyerLayout').value='buyerGroups';
    $('printExcludeCollected').checked=false;
    for(const option of document.querySelectorAll('.print-site-option')){
      option.hidden=printView==='schedule';
    }
    $('printDialog').showModal();
    renderPrintPreview();
  }
  function renderPrintPreview() {
    const paper=$('printPaper').value==='A3'?'A3':'A4';
    const orientation=$('printOrientation').value==='portrait'?'portrait':'landscape';
    $('printPageRules').textContent=`@media print{@page{size:${paper} ${orientation};margin:0}}`;
    const isSchedule=printView==='schedule';
    $('printPage').hidden=isSchedule;
    $('printDirectory').hidden=isSchedule;
    $('printSchedule').hidden=!isSchedule;
    $('printDialog').classList.toggle('mode-schedule',isSchedule);
    if(isSchedule){
      $('printSchedule').innerHTML=printScheduleContent();
      $('printSheetSize').textContent=`${paper} ${orientation} · ${collectionSchedule().length} booked collection(s)`;
      return;
    }
    const showText=$('printText').checked,grid=$('printGrid').checked;
    const contacts=$('printContact').checked;
    const excludeCollected=contacts&&$('printExcludeCollected').checked;
    $('printBuyerLayout').disabled=!contacts;
    $('printExcludeCollected').disabled=!contacts;
    const format=$('printBuyerLayout').value==='lotDirectory'?'lotDirectory':'buyerGroups';
    const allGroups=contacts?printBuyerGroups():[];
    const report=excludeCollected?adminReport():null;
    const index=report?ADMIN().indexReport(report):null;
    const fullyCollected=excludeCollected?
      allGroups.filter(group=>isFullyCollectedInvoice(group,index)):[];
    const excludedInvoices=new Set(fullyCollected.map(group=>group.invoice));
    const results={groups:allGroups.filter(group=>!excludedInvoices.has(group.invoice)),
      excluded:fullyCollected.length};
    // Always print the entire map on page one, including greened-off lots.
    // Contact filtering never modifies the site drawing or exported JSON.
    $('printPage').classList.remove('with-buyer-side');
    $('printDirectory').hidden=!contacts;
    $('printDirectory').innerHTML=contacts?(format==='buyerGroups'
      ?printBuyerContinuation(results.groups,results.excluded)
      :printContactDirectory(excludedInvoices)):'';
    const mm=paper==='A3'?[297,420]:[210,297];
    const mmW=orientation==='landscape'?mm[1]:mm[0],mmH=orientation==='landscape'?mm[0]:mm[1];
    const width=Math.max(1,Math.round((mmW-24)*5)),height=Math.max(1,Math.round((mmH-52)*5));
    const render=document.createElement('canvas');render.width=width;render.height=height;
    const c=render.getContext('2d');
    const bounds=rotatedSiteBounds(view.rotation);
    const px=Math.min((width-14)/bounds.width,(height-14)/bounds.height);
    const ox=(width-bounds.width*px)/2-bounds.minX*px;
    const oy=(height-bounds.height*px)/2-bounds.minY*px;
    paint(c,width,height,ox,oy,px,{export:true,grid,showText,
      printContacts:false,rotation:view.rotation});
    $('printMap').src=render.toDataURL('image/png');
    $('printPage').style.aspectRatio=`${mmW} / ${mmH}`;
    $('printSiteName').textContent=project.name;
    $('printMeta').textContent=`${fmt(project.cols*project.cellMeters)} m × ${fmt(project.rows*project.cellMeters)} m · ${paper} ${orientation} · rotation ${view.rotation*90}°`;
    $('printScale').textContent=`1 grid square = ${fmt(project.cellMeters)} m · diagram fitted to page (not a measured print scale)`;
    const lots=project.objects.filter(x=>x.type==='lot');
    $('printCounts').textContent=`Lots: ${lots.length} · Cleared: ${lots.filter(x=>x.status==='cleared').length}`;
    $('printSheetSize').textContent=`${paper} ${orientation} · full-page site plan${contacts?` + ${format==='buyerGroups'?'buyer / invoice':'lot'} contact pages`:''}${results.excluded?` · ${results.excluded} fully collected excluded`:''}`;
  }

  function printPlan() {
 renderPrintPreview();
 requestAnimationFrame(()=>window.print());
}
  function wireUI(){
    $('settingsBtn').addEventListener('click',openSettings);
    for(const id of ['settingsCloseX','settingsDoneBtn']){
      $(id).addEventListener('click',()=>$('settingsDialog').close());
    }
    $('settingsTheme').addEventListener('change',event=>setThemePreference(event.target.value));
    $('settingsLargerText').addEventListener('change',event=>setLargerTextPreference(event.target.checked));
    $('settingsShowTools').addEventListener('change',event=>setPanelPreference('tools',event.target.checked));
    $('settingsShowDetails').addEventListener('change',event=>setPanelPreference('details',event.target.checked));
    $('settingsResetBtn').addEventListener('click',resetDisplayPreferences);
    $('fullscreenMapBtn').addEventListener('click',toggleMapFullscreen);
    $('fullscreenToolsBtn').addEventListener('click',toggleFullscreenTools);
    $('fullscreenDrawerClose').addEventListener('click',()=>selectObject(null));
    $('rotateMapLeft').addEventListener('click',()=>rotateMap(-1));
    $('rotateMapRight').addEventListener('click',()=>rotateMap(1));
    $('rotateMapReset').addEventListener('click',()=>rotateMap(-view.rotation));
    document.addEventListener('fullscreenchange',refreshFullscreenPresentation);
    document.addEventListener('fullscreenerror',()=>{
      if(!isMapFullscreen())toast('Browser full screen was unavailable. Try Focus Map instead.');
    });
    $('toggleToolsBtn').addEventListener('click',()=>toggleMapPanel('tools'));
    $('toggleDetailsBtn').addEventListener('click',()=>toggleMapPanel('details'));
    $('focusMapBtn').addEventListener('click',toggleMapFocus);
    $('mapHighlightDismiss').addEventListener('click',dismissMapHighlights);
    $('mapHighlightPreviewBtn').addEventListener('click',()=>openHighlightedPlanPreview(highlightedMapKey));
    $('mapHighlightDownloadBtn').addEventListener('click',()=>{
      if(highlightedMapKey)downloadHighlightedPlan(highlightedTargetForKey(highlightedMapKey));
    });
    $('highlightPreviewCloseBtn').addEventListener('click',closeHighlightedPlanPreview);
    $('highlightPreviewDoneBtn').addEventListener('click',closeHighlightedPlanPreview);
    $('highlightPreviewDownloadBtn').addEventListener('click',()=>downloadHighlightedPlan(highlightPreviewTarget));
    $('highlightPreviewShowMapBtn').addEventListener('click',()=>{
      const key=highlightPreviewTarget?.key;
      closeHighlightedPlanPreview();
      if(key)highlightCollectionOnMap(key);
    });
    $('highlightPreviewDialog').addEventListener('close',()=>{
      $('highlightPreviewImage').removeAttribute('src');
      highlightPreviewTarget=null;
    });
    if(typeof window.matchMedia==='function'){
      const systemTheme=window.matchMedia('(prefers-color-scheme: dark)');
      systemTheme.addEventListener?.('change',()=>{
        if(uiPrefs.theme==='system')applyUiPreferences();
      });
    }
    document.querySelector('.panel-tabs')?.addEventListener('keydown',event=>{
      if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;
      if(!event.target.matches('[data-tab]'))return;
      const tabs=[...document.querySelectorAll('[data-tab]')].filter(tab=>
        tab.dataset.modeVisibility===settings.mode);
      if(!tabs.length)return;
      const pos=tabs.indexOf(event.target);
      if(pos<0)return;
      event.preventDefault();
      let next=pos;
      if(event.key==='ArrowRight')next=(pos+1)%tabs.length;
      else if(event.key==='ArrowLeft')next=(pos-1+tabs.length)%tabs.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=tabs.length-1;
      switchTab(tabs[next].dataset.tab);
      tabs[next].focus();
    });
    for(const btn of document.querySelectorAll('button[data-tool]'))btn.addEventListener('click',()=>setTool(btn.dataset.tool));
    for(const btn of document.querySelectorAll('[data-tab]'))btn.addEventListener('click',()=>switchTab(btn.dataset.tab));
    $('modeMapBtn').addEventListener('click',()=>switchMode('map'));
    $('modeAdminBtn').addEventListener('click',()=>switchMode('admin'));
    $('projectSelect').addEventListener('change',event=>changeProject(event.target.value));
    $('renameBtn').addEventListener('click',renameSite);$('newBtn').addEventListener('click',newSite);
    $('exportBtn').addEventListener('click',exportJSON);
    $('importBtn').addEventListener('click',()=>$('importFile').click());
    $('importFile').addEventListener('change',event=>{importJSON(event.target.files[0]);event.target.value='';});
    $('adminExcelFile').addEventListener('change',event=>{importAdminFile(event.target.files[0],'excel');event.target.value='';});
    $('undoBtn').addEventListener('click',undo);$('redoBtn').addEventListener('click',redo);
    $('clearCanvasBackup').addEventListener('click',exportJSON);
    $('clearCanvasCancel').addEventListener('click',()=>$('clearCanvasDialog').close());
    $('clearCanvasPhrase').addEventListener('input',checkClearCanvasConfirmation);
    $('clearCanvasUnderstand').addEventListener('change',checkClearCanvasConfirmation);
    $('clearCanvasConfirm').addEventListener('click',clearCanvasPermanently);
    $('fitBtn').addEventListener('click',fitView);
    $('moveAllBtn').addEventListener('click',()=>setTool(settings.tool==='move-all'?'select':'move-all'));
    $('textScaleInput').addEventListener('change',ev=>setGlobalTextPercent(ev.target.value));
    $('textToggleBtn').addEventListener('click',setTextVisibility);
    $('printPreviewBtn').addEventListener('click',openPrintPreview);
    $('printCloseBtn').addEventListener('click',()=>$('printDialog').close());
    for(const id of ['printPaper','printOrientation','printText','printGrid','printContact','printBuyerLayout','printExcludeCollected']){
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
      if(event.target.id==='collectionsSort'){
        settings.collectionsSort=event.target.value;
        updateCollectionListResults();return;
      }
      if(event.target.id==='lotSort'){
        settings.lotSort=event.target.value;renderLotList();return;
      }
      if(event.target.matches('[data-field]')){
        updateField(event.target);
        if(event.target.dataset.field==='invoice')migrateUnlinkedCollections();
        liveEditKey=null;
        renderPanel();
      }
      if(event.target.matches('[data-collection-field]')){
        updateCollectionField(event.target);
      }
    });
    panel.addEventListener('input',event=>{
      if(event.target.id==='lotSearch'){settings.lotSearch=event.target.value;renderLotList();return;}
      if(event.target.id==='collectionsSearch'){
        settings.collectionsSearch=event.target.value;
        updateCollectionListResults();
        return;
      }
      if(event.target.matches('[data-collection-field]')){updateCollectionField(event.target);return;}
      if(event.target.matches('[data-field]'))updateField(event.target,true);
    });
    panel.addEventListener('search',event=>{
      if(event.target.id==='collectionsSearch'){
        settings.collectionsSearch=event.target.value;
        updateCollectionListResults();
      }
    });
    panel.addEventListener('focusout',event=>{
      if(event.target.matches('[data-field]'))liveEditKey=null;
    });
    panel.addEventListener('click',event=>{
      const viewMap=event.target.closest('[data-view-collection-map]');
      if(viewMap){openHighlightedPlanPreview(viewMap.dataset.viewCollectionMap);return;}
      const nextStep=event.target.closest('[data-admin-next]');
      if(nextStep&&settings.mode==='admin'){
        const dest=nextStep.dataset.adminNext;
        if(dest==='admin'||dest==='collections'||dest==='schedule'){
          if(dest==='collections')settings.collectionsSelectedKey=null;
          switchTab(dest);panel.scrollTop=0;focusPanelHeading();
        }
        return;
      }
      const switcher=event.target.closest('[data-collections-view]');
      if(switcher){
        settings.collectionsView=switcher.dataset.collectionsView==='schedule'?'schedule':'list';
        renderPanel();panel.scrollTop=0;return;
      }
      if(event.target.closest('[data-collection-back]')){
        settings.collectionsSelectedKey=null;
        renderPanel();panel.scrollTop=0;focusPanelHeading();return;
      }
      const collection=event.target.closest('[data-collection-select]');
      if(collection){
        settings.collectionsSelectedKey=collection.dataset.collectionSelect;
        settings.collectionsView='list';
        switchTab('collections');
        panel.scrollTop=0;focusPanelHeading();return;
      }
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
      if(event.key==='Escape'&&isMapFullscreen()&&
         !['settingsDialog','printDialog','highlightPreviewDialog','confirmDialog','clearCanvasDialog']
           .some(id=>$(id).open)){
        event.preventDefault();
        exitMapFullscreen();
        return;
      }
      const target=event.target;
      if(target instanceof HTMLElement && (target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(target.tagName)))return;
      if($('confirmDialog').open||$('printDialog').open||$('clearCanvasDialog').open||
         $('settingsDialog').open||$('highlightPreviewDialog').open)return;
      // Admin workspace has no drawing shortcuts. Ctrl+A must never
      // accidentally activate Move All while staff work through invoices.
      if(settings.mode==='admin'){
        if(event.key==='Escape'&&settings.tab==='collections'&&settings.collectionsSelectedKey){
          settings.collectionsSelectedKey=null;renderPanel();
        }
        return;
      }
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){
        event.preventDefault();setTool('move-all');return;
      }
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
      const map={v:'select',a:'move-all',e:'delete',p:'pan',w:'wall',d:'door',s:'shutter',l:'lot',b:'box',g:'green',k:'lock',t:'label'};
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
  loadUiPreferences();
  load();loadAdminReports();loadCollections();wireUI();refreshProjectSelector();refreshStats();switchTab('properties');setTool('select');
  requestAnimationFrame(()=>{resizeCanvas();fitView();});
})();
