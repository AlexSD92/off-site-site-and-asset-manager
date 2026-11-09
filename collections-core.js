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
  if(!/^(inv:|lot:)/.test(key)||key.length>240)continue;
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
function scheduleEntries(records,lots,getInvoice,lookupRow,lotKey,invoiceGroup){
 const byKey=new Map();
 for(const lot of lots.filter(l=>l.type==="lot")){
  const inv=getInvoice(lot);
  const key=keyFor(lot,inv);
  if(!byKey.has(key))byKey.set(key,[]);
  byKey.get(key).push(lot);
 }
 const out=[];
 for(const [key,raw] of Object.entries(records)){
  const rec=cleanRecord(raw);
  if(!rec.bookedIn||!validDate(rec.bookingDate))continue;
  const matched=byKey.get(key)||[];
  // Retain booked appointments even if a drawing lot has not yet been placed.
  const first=matched[0]||null;
  const inv=key.startsWith("inv:")?key.slice(4):first?getInvoice(first):"";
  let row=null;
  if(first)row=lookupRow(first);
  if(!row&&inv&&invoiceGroup?.has(inv))row=invoiceGroup.get(inv)[0]||null;
  const allLotNumbers=new Set(matched.map(l=>String(l.number)));
  if(inv&&invoiceGroup?.has(inv)){
    for(const excelLot of invoiceGroup.get(inv))allLotNumbers.add(String(excelLot.LotNumber));
  }
  const lotNumbers=[...allLotNumbers].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  out.push({key,record:rec,invoice:inv,lots:lotNumbers,lotIds:matched.map(l=>l.id),
    buyer:row?.["dbo.RWX_Invoices::Full Billing Name"]||"",
    mobile:row?.["mobile::StringNativeValue"]||"",
    telephone:row?.["tel::StringNativeValue"]||"",
    postcode:row?.["dbo.RWX_Invoices::BillingZipPostal"]||"",
    date:rec.bookingDate,time:rec.bookingTime});
 }
 out.sort((a,b)=>a.date.localeCompare(b.date)||(a.time||"99:99").localeCompare(b.time||"99:99")||a.invoice.localeCompare(b.invoice));
 return out;
}
window.YardMapCollections=Object.freeze({FORMAT,VERSION,TEXT_FIELDS,BOOL_FIELDS,validDate,validTime,keyFor,cleanRecord,cleanRecords,makeDefault,deserialize,formatDate,scheduleEntries});
})();
