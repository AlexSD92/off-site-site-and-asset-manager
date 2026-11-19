/* YardMap: local-only Excel report export, no external dependencies. */
(function YardMapExcelModule(){
  'use strict';
  // Small, dependency-free XLSX writer. Creates the file entirely in the browser.
  // It does not connect to any server, upload data or evaluate Excel formulas.
  const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const clean=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/g,'').slice(0,32767);
  const xml=value=>clean(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));
  const money=pence=>Number((pence/100).toFixed(2));
  const column=i=>{let n=i+1,s='';while(n){s=String.fromCharCode(65+(n-1)%26)+s;n=Math.floor((n-1)/26);}return s;};
  const textCell=(ref,value,style=0)=>
    `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  const numberCell=(ref,value,style=4)=>
    `<c r="${ref}" s="${style}" t="n"><v>${value}</v></c>`;
  const blankCell=(ref,style=4)=>`<c r="${ref}" s="${style}"/>`;
  const formulaCell=(ref,formula,cached,style=4)=>{
    if(cached===null)return `<c r="${ref}" s="${style}" t="str"><f>${xml(formula)}</f><v></v></c>`;
    return `<c r="${ref}" s="${style}"><f>${xml(formula)}</f><v>${cached}</v></c>`;
  };
  function sheetXml(title,description,filters,headers,records,widths,summary=false){
    const width=column(headers.length-1),lastRow=Math.max(5,5+records.length);
    const rows=[
      `<row r="1" ht="29" customHeight="1">${textCell('A1',title,1)}</row>`,
      `<row r="2" ht="39" customHeight="1">${textCell('A2',description,2)}</row>`,
      `<row r="3" ht="34" customHeight="1">${textCell('A3',filters,2)}</row>`,
      `<row r="4" ht="9" customHeight="1"/>`,
      `<row r="5" ht="26" customHeight="1">${headers.map((head,i)=>textCell(column(i)+'5',head,3)).join('')}</row>`
    ];
    for(let i=0;i<records.length;i++){
      const n=i+6,rec=records[i];
      let cells;
      if(summary){
        const invoice=clean(rec.invoice);
        const end=5+rec.detailCount;
        const rangeInvoice=`'Lot Details'!$A$6:$A$${end}`;
        const rangeTotal=`'Lot Details'!$G$6:$G$${end}`;
        const expression=`IF(COUNTIFS(${rangeInvoice},A${n},${rangeTotal},"")>0,"",SUMIF(${rangeInvoice},A${n},${rangeTotal}))`;
        cells=[
          textCell(`A${n}`,invoice),
          formulaCell(`B${n}`,expression,rec.incompleteCount?null:money(rec.totalPence)),
          rec.incompleteCount?textCell(`C${n}`,`${rec.incompleteCount} missing or duplicate lot value(s) — check source`,6):blankCell(`C${n}`,0)
        ];
      }else{
        cells=[
          textCell(`A${n}`,rec.invoice),
          textCell(`B${n}`,rec.lot),
          textCell(`C${n}`,rec.description)
        ];
        if(rec.hammerPence!==null){
          const h=money(rec.hammerPence),bp=money(rec.bpPence),vat=money(rec.vatPence),total=money(rec.totalPence);
          cells.push(
            numberCell(`D${n}`,h),
            formulaCell(`E${n}`,`ROUND(D${n}*0.25,2)`,bp),
            formulaCell(`F${n}`,`ROUND(D${n}*0.20,2)+ROUND(E${n}*0.20,2)`,vat),
            formulaCell(`G${n}`,`SUM(D${n}:F${n})`,total)
          );
        }else{
          for(const c of ['D','E','F','G'])cells.push(blankCell(`${c}${n}`));
        }
        cells.push(textCell(`H${n}`,rec.status,rec.hammerPence===null?6:0));
        if(rec.includeBuyer){
          cells.push(textCell(`I${n}`,rec.buyer));
          cells.push(textCell(`J${n}`,rec.phone));
          cells.push(textCell(`K${n}`,rec.email));
        }
      }
      rows.push(`<row r="${n}" ht="21" customHeight="1">${cells.join('')}</row>`);
    }
    const cols=widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('');
    const merges=['1','2','3'].map(n=>`<mergeCell ref="A${n}:${width}${n}"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
      `<worksheet xmlns="${NS}"><sheetViews><sheetView showGridLines="0" workbookViewId="0">`+
      `<pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`+
      `<sheetFormatPr defaultRowHeight="18"/><cols>${cols}</cols><sheetData>${rows.join('')}</sheetData>`+
      `<mergeCells count="3">${merges}</mergeCells><autoFilter ref="A5:${width}${lastRow}"/>`+
      `<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.3" footer="0.3"/></worksheet>`;
  }
  function stylesXml(){
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
      `<styleSheet xmlns="${NS}">`+
      `<numFmts count="1"><numFmt numFmtId="164" formatCode="£#,##0.00;[Red](£#,##0.00)"/></numFmts>`+
      `<fonts count="5">`+
      `<font><sz val="11"/><name val="Aptos"/></font>`+
      `<font><b/><sz val="18"/><color rgb="FF173A5E"/><name val="Aptos Display"/></font>`+
      `<font><sz val="10"/><color rgb="FF526C81"/><name val="Aptos"/></font>`+
      `<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>`+
      `<font><sz val="11"/><color rgb="FF9A4D12"/><name val="Aptos"/></font>`+
      `</fonts><fills count="3"><fill><patternFill patternType="none"/></fill>`+
      `<fill><patternFill patternType="gray125"/></fill>`+
      `<fill><patternFill patternType="solid"><fgColor rgb="FF173A5E"/><bgColor indexed="64"/></patternFill></fill></fills>`+
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`+
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`+
      `<cellXfs count="7">`+
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`+
      `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`+
      `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment wrapText="1" vertical="center"/></xf>`+
      `<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1" vertical="center"/></xf>`+
      `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`+
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1"/></xf>`+
      `<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment wrapText="1"/></xf>`+
      `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
  function packZip(entries){
    const encoder=new TextEncoder(),locals=[],centrals=[];
    const table=new Uint32Array(256);
    for(let n=0;n<256;n++){let c=n;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);table[n]=c>>>0;}
    const crc32=bytes=>{
      let c=0xFFFFFFFF;
      for(let i=0;i<bytes.length;i++)c=table[(c^bytes[i])&255]^(c>>>8);
      return (c^0xFFFFFFFF)>>>0;
    };
    let offset=0,centralSize=0;
    for(const [path,content] of entries){
      const name=encoder.encode(path),body=encoder.encode(content);
      if(body.length>0xFFFFFFFF)throw Error('Excel export is too large.');
      const crc=crc32(body);
      const local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);
      lv.setUint32(0,0x04034b50,true);
      lv.setUint16(4,20,true);
      lv.setUint16(8,0,true); // Stored, not compressed; works without external libraries.
      lv.setUint16(12,0x0021,true);
      lv.setUint32(14,crc,true);
      lv.setUint32(18,body.length,true);
      lv.setUint32(22,body.length,true);
      lv.setUint16(26,name.length,true);
      local.set(name,30);
      locals.push(local,body);
      const central=new Uint8Array(46+name.length),cv=new DataView(central.buffer);
      cv.setUint32(0,0x02014b50,true);
      cv.setUint16(4,20,true);
      cv.setUint16(6,20,true);
      cv.setUint16(14,0x0021,true);
      cv.setUint32(16,crc,true);
      cv.setUint32(20,body.length,true);
      cv.setUint32(24,body.length,true);
      cv.setUint16(28,name.length,true);
      cv.setUint32(42,offset,true);
      central.set(name,46);
      centrals.push(central);
      offset+=local.length+body.length;
      centralSize+=central.length;
    }
    if(entries.length>65535||offset>0xFFFFFFFF)throw Error('Excel workbook exceeds ZIP limits.');
    const end=new Uint8Array(22),ev=new DataView(end.buffer);
    ev.setUint32(0,0x06054b50,true);
    ev.setUint16(8,entries.length,true);
    ev.setUint16(10,entries.length,true);
    ev.setUint32(12,centralSize,true);
    ev.setUint32(16,offset,true);
    const chunks=[...locals,...centrals,end];
    const total=offset+centralSize+end.length,out=new Uint8Array(total);
    let pos=0;for(const chunk of chunks){out.set(chunk,pos);pos+=chunk.length;}
    return out;
  }
  function createReport(input){
    if(!input||!Array.isArray(input.lots)||!Array.isArray(input.invoices)||input.lots.length>10000)
      throw Error('Invalid Excel report data.');
    const includeBuyer=input.excludeBuyer!==true;
    const lots=input.lots.map(l=>({...l,includeBuyer}));
    const count=lots.length;
    const filterText=[
      input.mappedOnly?'Map lots only':'All Excel lots',
      includeBuyer?'Buyer details included':'Buyer details excluded',
      input.groupByInvoice?'Sorted by invoice':'Original report order',
      `${count} outstanding/unverified lot(s)`
    ].join('   |   ');
    const lotHeaders=['Invoice number','Lot','Description','Hammer','BP (25%)',
      'Total VAT','Lot total','Collection status',...(includeBuyer?['Buyer','Buyer phone','Buyer email']:[])];
    const lotWidths=[23,10,44,16,16,17,18,46,...(includeBuyer?[30,22,34]:[])];
    const lotDescription='Outstanding/unverified lots only. Figures use 25% buyers premium and 20% VAT on hammer and premium; shipping excluded.';
    const lotsXml=sheetXml(`${input.siteName||'Site'} · Lot Details`,lotDescription,filterText,
      lotHeaders,lots,lotWidths,false);
    const invoices=input.invoices.filter(r=>r.invoice).map(r=>({...r,detailCount:count}));
    const summaryDescription='Calculated totals of included outstanding/unverified lots, not full invoice balances. Includes 25% BP and VAT; shipping excluded.';
    const summaryFilter=filterText+'   |   Uninvoiced lots omitted from this summary';
    const invoiceXml=sheetXml(`${input.siteName||'Site'} · Invoice Summary`,summaryDescription,
      summaryFilter,['Invoice number','Invoice total (included lots)','Value check'],
      invoices,[26,30,54],true);
    const workbookXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
      `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>`+
      `<sheet name="Lot Details" sheetId="1" r:id="rId1"/>`+
      `<sheet name="Invoice Summary" sheetId="2" r:id="rId2"/>`+
      `</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
    const relsXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
      `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`+
      `<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>`+
      `<Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/>`+
      `</Relationships>`;
    const typesXml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`+
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`+
      `<Default Extension="xml" ContentType="application/xml"/>`+
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`+
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`+
      `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`+
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`+
      `</Types>`;
    const rootRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`+
      `</Relationships>`;
    return packZip([
      ['[Content_Types].xml',typesXml],['_rels/.rels',rootRels],
      ['xl/workbook.xml',workbookXml],['xl/_rels/workbook.xml.rels',relsXml],
      ['xl/styles.xml',stylesXml()],['xl/worksheets/sheet1.xml',lotsXml],
      ['xl/worksheets/sheet2.xml',invoiceXml]
    ]);
  }
  window.YardMapExcel=Object.freeze({createReport});
})();
