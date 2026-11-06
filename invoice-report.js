(function yardmapReportModule(){
'use strict';
const HEADERS=[
 'AuctionEventID','LotNumber','dbo.RWX_Listings::Title',
 'dbo.RWX_Listings::CurrentPrice','dbo.RWX_LineItems::Lot Status',
 'dbo.RWX_Consignors 2::ConsignorNumber','dbo.RWX_Invoices::PayerId',
 'dbo.RWX_Invoices::Id','dbo.RWX_Invoices::ShippingAmount',
 'dbo.RWX_Listings::Weight','dbo.RWX_Invoices::Full Billing Name',
 'dbo.RWX_Invoices::BillingZipPostal','dbo.RWX_Users 2::UserName',
 'mobile::StringNativeValue','tel::StringNativeValue',
 'dbo.RWX_Invoices::PaidDTTM'
];
const FORMAT='yardmap-admin-report',VERSION=1;
const asText=x=>x==null?'':String(x).trim();
const clean=(x,n=3000)=>typeof x==='number'&&Number.isFinite(x)?x:asText(x).slice(0,n);
function lotKey(x){
 const val=asText(x).replace(/\s+/g,' ').replace(/^LOT\s*(?:(?:NO\.?|NUMBER|#|:|-)\s*)?/i,'').toUpperCase();
 return /^\d+$/.test(val)?val.replace(/^0+(?=\d)/,''):val;
}
function invoiceKey(x){return asText(x);}
function validateReport(input){
 if(!input||input.format!==FORMAT||input.formatVersion!==VERSION||!Array.isArray(input.rows)||input.rows.length>10000)
   throw Error('Not a supported YardMap admin-report JSON file.');
 const rows=input.rows.map(r=>{
   if(!r||typeof r!=='object')throw Error('Invalid report row.');
   const result=Object.create(null);
   for(const h of HEADERS)result[h]=clean(r[h]);
   return result;
 }).filter(r=>lotKey(r.LotNumber));
 const events=new Set(rows.map(r=>asText(r.AuctionEventID)).filter(Boolean));
 if(events.size>1)throw Error('The report includes multiple AuctionEventID values.');
 return {format:FORMAT,formatVersion:VERSION,auctionEventId:[...events][0]||asText(input.auctionEventId),
   importedAt:asText(input.importedAt)||new Date().toISOString(),sourceName:clean(input.sourceName,180),
   headers:[...HEADERS],rows};
}
function rowsToReport(matrix,sourceName){
 const required=['AuctionEventID','LotNumber','dbo.RWX_Invoices::Id'];
 const headerAt=matrix.findIndex(r=>Array.isArray(r)&&required.every(h=>r.some(c=>asText(c)===h)));
 if(headerAt<0)throw Error('Required headings not found: AuctionEventID, LotNumber, dbo.RWX_Invoices::Id.');
 const positions=HEADERS.map(h=>matrix[headerAt].findIndex(x=>asText(x)===h));
 const missing=HEADERS.filter((h,i)=>positions[i]<0);
 if(missing.length)throw Error('Missing spreadsheet heading(s): '+missing.join(', '));
 const rows=[];
 for(const source of matrix.slice(headerAt+1)){
   if(!Array.isArray(source))continue;
   const item=Object.create(null);
   for(let i=0;i<HEADERS.length;i++)item[HEADERS[i]]=clean(source[positions[i]]);
   if(!lotKey(item.LotNumber))continue;
   rows.push(item);
   if(rows.length>10000)throw Error('The spreadsheet exceeds 10,000 lot rows.');
 }
 if(!rows.length)throw Error('No lot rows found in the spreadsheet.');
 return validateReport({format:FORMAT,formatVersion:VERSION,sourceName:sourceName||'Admin export.xlsx',
   importedAt:new Date().toISOString(),rows});
}
function indexReport(report){
 const byLot=new Map(),byInvoice=new Map(),duplicates=new Set();
 for(const row of report.rows){
   const l=lotKey(row.LotNumber),inv=invoiceKey(row['dbo.RWX_Invoices::Id']);
   if(!l)continue;
   if(byLot.has(l))duplicates.add(l);else byLot.set(l,row);
   if(inv){if(!byInvoice.has(inv))byInvoice.set(inv,[]);byInvoice.get(inv).push(row);}
 }
 for(const k of duplicates)byLot.delete(k);
 for(const group of byInvoice.values())group.sort((a,b)=>lotKey(a.LotNumber).localeCompare(lotKey(b.LotNumber),undefined,{numeric:true}));
 return {byLot,byInvoice,duplicates};
}
function countMatch(report,objects){
 const index=indexReport(report),lots=objects.filter(o=>o.type==='lot'),match=lots.filter(o=>index.byLot.has(lotKey(o.number))).length;
 const invoiced=report.rows.filter(r=>invoiceKey(r['dbo.RWX_Invoices::Id'])).length;
 return {reportRows:report.rows.length,lotCount:lots.length,matched:match,unmatched:lots.length-match,
   invoiced,withoutInvoice:report.rows.length-invoiced,duplicateLotKeys:[...index.duplicates]};
}
function formatPaid(raw){
 if(raw==null||raw==='')return '';
 if(typeof raw==='number'&&raw>10000&&raw<1000000)return new Date(Math.round((raw-25569)*86400000)).toISOString().replace('T',' ').slice(0,16)+' UTC';
 return asText(raw);
}
const decoder=new TextDecoder('utf-8');
function parseXml(text){
 if(/<!\s*(?:DOCTYPE|ENTITY)/i.test(text))throw Error('Unsafe XML declarations in workbook.');
 const dom=new DOMParser().parseFromString(text,'application/xml');
 if(dom.getElementsByTagName('parsererror').length)throw Error('Malformed XML in workbook.');
 return dom;
}
const tags=(d,t)=>Array.from(d.getElementsByTagName(t));
function zipDirectory(buffer){
 if(buffer.byteLength>15*1024*1024)throw Error('Excel workbook exceeds 15 MB.');
 const v=new Uint8Array(buffer),d=new DataView(buffer),u16=i=>d.getUint16(i,true),u32=i=>d.getUint32(i,true);
 let eocd=-1;
 for(let i=v.length-22;i>=Math.max(0,v.length-65557);i--)if(u32(i)===0x06054b50){eocd=i;break;}
 if(eocd<0)throw Error('This is not a valid XLSX file.');
 const count=u16(eocd+10);let off=u32(eocd+16);
 if(count>500||off>=v.length)throw Error('Invalid Excel archive directory.');
 const entries=new Map();
 for(let k=0;k<count;k++){
   if(off+46>v.length||u32(off)!==0x02014b50)throw Error('Broken Excel archive directory.');
   const flag=u16(off+8),method=u16(off+10),comp=u32(off+20),size=u32(off+24),
     nameLen=u16(off+28),extra=u16(off+30),comment=u16(off+32),local=u32(off+42);
   if(flag&1)throw Error('Encrypted XLSX files cannot be read.');
   if(size>12e6||comp>12e6)throw Error('Workbook archive entry exceeds safety limit.');
   const name=decoder.decode(v.subarray(off+46,off+46+nameLen));
   if(name.startsWith('xl/')&&name.endsWith('.xml'))entries.set(name,{method,comp,size,local});
   off+=46+nameLen+extra+comment;
 }
 return {v,d,entries};
}
async function zipText(z,name){
 const p=z.entries.get(name);if(!p)throw Error('Missing workbook entry: '+name);
 if(p.local+30>z.v.length||z.d.getUint32(p.local,true)!==0x04034b50)throw Error('Corrupt Excel archive.');
 const start=p.local+30+z.d.getUint16(p.local+26,true)+z.d.getUint16(p.local+28,true);
 if(start+p.comp>z.v.length)throw Error('Truncated Excel archive.');
 const packed=z.v.subarray(start,start+p.comp);
 let out;
 if(p.method===0)out=packed;
 else if(p.method===8){
   if(typeof DecompressionStream==='undefined')throw Error('This browser cannot decompress XLSX offline. Update Chrome, Edge, Firefox or Safari.');
   const reader=new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
   const chunks=[];let size=0;
   for(;;){
     const {value,done}=await reader.read();if(done)break;
     size+=value.byteLength;
     if(size>12e6){await reader.cancel();throw Error('Decompressed workbook entry too large.');}
     chunks.push(value);
   }
   out=new Uint8Array(size);let i=0;for(const chunk of chunks){out.set(chunk,i);i+=chunk.byteLength;}
 }else throw Error('Unsupported XLSX ZIP compression method.');
 if(out.byteLength!==p.size)throw Error('Workbook entry size mismatch.');
 return decoder.decode(out);
}
function cellValue(cell,shared){
 const type=cell.getAttribute('t');
 if(type==='inlineStr')return tags(cell,'t').map(n=>n.textContent||'').join('');
 const val=tags(cell,'v')[0]?.textContent;if(val==null)return '';
 if(type==='s'){const index=Number(val);return shared[index]??'';}
 if(type==='b')return val==='1';
 if(type==='str'||type==='e')return val;
 const n=Number(val);return Number.isFinite(n)?n:val;
}
function colNumber(chars){
 let n=0;for(const c of chars.toUpperCase())n=n*26+c.charCodeAt(0)-64;
 return n-1;
}
async function parseXlsx(arrayBuffer,filename){
 const z=zipDirectory(arrayBuffer);
 let worksheet='xl/worksheets/sheet1.xml';
 if(z.entries.has('xl/workbook.xml')&&z.entries.has('xl/_rels/workbook.xml.rels')){
   const book=parseXml(await zipText(z,'xl/workbook.xml'));
   const first=tags(book,'sheet')[0],id=first?.getAttribute('r:id')||Array.from(first?.attributes||[]).find(x=>x.localName==='id')?.value;
   if(id){
     const rels=parseXml(await zipText(z,'xl/_rels/workbook.xml.rels'));
     const target=tags(rels,'Relationship').find(r=>r.getAttribute('Id')===id)?.getAttribute('Target');
     if(target){
       worksheet=target.startsWith('/')?target.slice(1):target.startsWith('xl/')?target:'xl/'+target.replace(/^\.?\//,'');
       if(!worksheet.startsWith('xl/worksheets/')||worksheet.includes('..'))throw Error('Unexpected worksheet path in workbook.');
     }
   }
 }
 if(!z.entries.has(worksheet))worksheet=[...z.entries.keys()].find(k=>/^xl\/worksheets\/sheet\d+\.xml$/.test(k));
 if(!worksheet)throw Error('No worksheet found.');
 let strings=[];
 if(z.entries.has('xl/sharedStrings.xml')){
   strings=tags(parseXml(await zipText(z,'xl/sharedStrings.xml')),'si')
     .map(si=>tags(si,'t').map(t=>t.textContent||'').join(''));
 }
 const sheet=parseXml(await zipText(z,worksheet)),data=tags(sheet,'sheetData')[0];
 if(!data)throw Error('The worksheet is empty.');
 const rows=tags(data,'row');
 if(rows.length>12000)throw Error('The worksheet has too many rows.');
 const matrix=rows.map(row=>{
   const out=[];
   for(const cell of tags(row,'c')){
     const m=(cell.getAttribute('r')||'').match(/^[A-Z]+/i),i=m?colNumber(m[0]):out.length;
     if(i>=0&&i<256)out[i]=cellValue(cell,strings);
   }
   return out;
 });
 return rowsToReport(matrix,filename);
}
window.YardMapReport=Object.freeze({HEADERS,FORMAT,VERSION,lotKey,invoiceKey,asText,validateReport,rowsToReport,indexReport,
countMatch,parseXlsx,formatPaid});
})();
