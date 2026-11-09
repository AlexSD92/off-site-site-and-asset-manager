(function collectionCore(){
'use strict';
const FORMAT="yardmap-collections",VERSION=1;
const TEXT_FIELDS=["recoveryName","recoveryPhone","recoveryEmail","recoveryCompany","draft"];
const BOOL_FIELDS=["contactedForPayment","bookedIn","ramsChecked"];
const max=(v,n=250)=>String(v??"").slice(0,n);
const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(new Date(v+"T12:00:00").getTime())&&new Date(v+"T12:00:00").toISOString().slice(0,10)===v;
const validTime=v=>/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const keyFor=(lot,invoice)=>invoice?`inv:${String(invoice).trim()}`:`lot:${lot.id}`;
function cleanRecord(raw){
 const r=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:{};
 const out={};
 for(const key of BOOL_FIELDS)out[key]=r[key]===true;
 out.bookingDate=validDate(r.bookingDate)?r.bookingDate:"";
 out.bookingTime=validTime(r.bookingTime)?r.bookingTime:"";
 for(const key of TEXT_FIELDS)out[key]=max(r[key],key==="draft"?1500:200);
 out.notes=Array.isArray(r.notes)?r.notes.slice(-150).filter(n=>n&&typeof n==="object").map(n=>({
  id:max(n.id,90),
  at:Number.isFinite(Date.parse(n.at))?new Date(n.at).toISOString():"",
  text:max(n.text,1500)
 })).filter(n=>n.text&&n.at):[];
 return out;
}
function cleanRecords(input){
 if(!input||typeof input!=="object"||Array.isArray(input))throw Error("Invalid collection records.");
 const out=Object.create(null),keys=Object.keys(input);
 if(keys.length>2500)throw Error("Too many collection records in this file.");
 for(const key of keys){
  if(!/^(inv:|lot:|reportlot:)/.test(key)||key.length>240)continue;
  out[key]=cleanRecord(input[key]);
 }
 return out;
}
function makeDefault(){return cleanRecord({});}
function deserialize(contents){
 if(!contents||contents.format!==FORMAT||contents.formatVersion!==VERSION)throw Error("This is not a supported YardMap collections JSON file.");
 return cleanRecords(contents.records);
}
function formatDate(iso){
 if(!validDate(iso))return iso;
 return new Intl.DateTimeFormat("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})
  .format(new Date(iso+"T12:00:00"));
}
function listEntries(rows,lots,getInvoice,lotKey,records){
 const items=new Map();
 const normalize=v=>String(lotKey(v)||'').trim();
 const add=(key,invoice,lotNumber,row=null,drawnId=null)=>{
   if(!key||key.length>240)return;
   if(!items.has(key))items.set(key,{key,invoice,lots:[],drawnIds:[],row:null});
   const item=items.get(key);
   if(lotNumber!==undefined&&lotNumber!==null){
     const n=String(lotNumber).trim();
     if(n&&!item.lots.includes(n))item.lots.push(n);
   }
   if(row&&!item.row)item.row=row;
   if(drawnId&&!item.drawnIds.includes(drawnId))item.drawnIds.push(drawnId);
 };
 for(const row of Array.isArray(rows)?rows:[]){
   if(!row||typeof row!=='object')continue;
   const lot=normalize(row.LotNumber),inv=String(row["dbo.RWX_Invoices::Id"]||'').trim();
   if(!lot)continue;
   add(inv?'inv:'+inv:'reportlot:'+lot,inv,row.LotNumber,row);
 }
 for(const lot of Array.isArray(lots)?lots:[]){
   if(lot?.type!=='lot')continue;
   const inv=String(getInvoice(lot)||'').trim();
   const n=normalize(lot.number);
   const key=inv?'inv:'+inv:(n&&items.has('reportlot:'+n)?'reportlot:'+n:'lot:'+lot.id);
   add(key,inv,lot.number,null,lot.id);
 }
 for(const key of Object.keys(records||{})){
   if(items.has(key))continue;
   if(key.startsWith('reportlot:'))add(key,'',key.slice('reportlot:'.length));
   else if(key.startsWith('inv:'))add(key,key.slice(4));
   else if(key.startsWith('lot:'))add(key,'');
 }
 const out=[...items.values()];
 for(const item of out){
   item.lots.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
 }
 out.sort((a,b)=>{
   const a0=a.lots[0]||'',b0=b.lots[0]||'';
   return a0.localeCompare(b0,undefined,{numeric:true})||a.key.localeCompare(b.key);
 });
 return out;
}
function scheduleEntries(records,lots,getInvoice,lookupRow,lotKey,invoiceGroup,reportRows=[]){
 const available=new Map(listEntries(reportRows,lots,getInvoice,lotKey,records).map(x=>[x.key,x]));
 const drawn=Array.isArray(lots)?lots.filter(x=>x.type==='lot'):[];
 const out=[];
 for(const [key,raw] of Object.entries(records||{})){
   const rec=cleanRecord(raw);
   if(!rec.bookedIn||!validDate(rec.bookingDate))continue;
   const entry=available.get(key);
   const invoice=key.startsWith('inv:')?key.slice(4):entry?.invoice||'';
   const mapped=drawn.filter(l=>keyFor(l,getInvoice(l))===key||
     (!invoice&&key.startsWith('reportlot:')&&String(lotKey(l.number))===key.slice(10)));
   let row=entry?.row||null;
   if(!row&&mapped.length)row=lookupRow(mapped[0]);
   if(!row&&invoice&&invoiceGroup?.has(invoice))row=invoiceGroup.get(invoice)[0]||null;
   const lotsForEntry=new Set(entry?.lots||[]);
   for(const l of mapped)lotsForEntry.add(String(l.number));
   if(invoice&&invoiceGroup?.has(invoice)){
     for(const row of invoiceGroup.get(invoice))lotsForEntry.add(String(row.LotNumber));
   }
   const numbers=[...lotsForEntry].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
   out.push({key,record:rec,invoice,lots:numbers,lotIds:entry?.drawnIds||mapped.map(l=>l.id),
     buyer:row?.["dbo.RWX_Invoices::Full Billing Name"]||'',
     mobile:row?.["mobile::StringNativeValue"]||'',
     telephone:row?.["tel::StringNativeValue"]||'',
     postcode:row?.["dbo.RWX_Invoices::BillingZipPostal"]||'',
     date:rec.bookingDate,time:rec.bookingTime});
 }
 out.sort((a,b)=>a.date.localeCompare(b.date)||(a.time||'99:99').localeCompare(b.time||'99:99')||a.invoice.localeCompare(b.invoice));
 return out;
}

window.YardMapCollections=Object.freeze({FORMAT,VERSION,TEXT_FIELDS,BOOL_FIELDS,validDate,validTime,keyFor,cleanRecord,cleanRecords,makeDefault,deserialize,formatDate,listEntries,scheduleEntries});
})();
