import {readFileSync} from 'node:fs';
import {unzipSync,zipSync} from 'fflate';
import {describe,expect,it} from 'vitest';
import {patchProposalWorkbook} from '../src/quote-proposal/patch-template.js';

const template=readFileSync(new URL('../fixtures/centurion-quotation-template.xlsx',import.meta.url));
const sheetPath='xl/worksheets/sheet1.xml';
const input={attention:'Synthetic',company:'Synthetic',clientEmail:'',clientTelephone:'',signerName:'Synthetic',signerEmail:'',signerTelephone:'',lines:[{dateLabel:'Synthetic',qty:1,description:'Single room Room Only',nights:2,rate:1000}]};
const decode=(bytes:Uint8Array)=>new TextDecoder().decode(bytes);
function changeSheet(change:(sheet:string)=>string){const files=unzipSync(template),before=decode(files[sheetPath]!);const after=change(before);expect(after).not.toBe(before);files[sheetPath]=new TextEncoder().encode(after);return zipSync(files);}

describe('legacy proposal availability sentence layout',()=>{
 it('uses the full printable width without changing terms, drawings or money',()=>{
  const before=unzipSync(template),after=unzipSync(patchProposalWorkbook(template,input)),sheet=decode(after[sheetPath]!);
  expect(sheet).toContain('<mergeCell ref="A52:H52"/>');
  expect(sheet).not.toContain('<mergeCell ref="A52:F52"/>');
  expect(sheet).toContain('<c r="H24" s="98"><v>2000</v></c>');
  expect(after['xl/sharedStrings.xml']).toEqual(before['xl/sharedStrings.xml']);
  expect(after['xl/drawings/drawing1.xml']).toEqual(before['xl/drawings/drawing1.xml']);
  expect(decode(after['xl/workbook.xml']!)).toContain('Sheet1!$A$1:$H$69');
 });
 it.each(['G52','H52'])('refuses extending the sentence over populated %s',ref=>{
  const changed=changeSheet(sheet=>sheet.replace(new RegExp(`<c r="${ref}"[^>]*/>`),`<c r="${ref}" t="inlineStr"><is><t>Other business content</t></is></c>`));
  expect(()=>patchProposalWorkbook(changed,input)).toThrow(/availability.*geometry/i);
 });
 it('refuses unknown or duplicate availability merge geometry',()=>{
  const missing=changeSheet(sheet=>sheet.replace('<mergeCell ref="A52:F52"/>',''));
  const duplicate=changeSheet(sheet=>sheet.replace('</mergeCells>','<mergeCell ref="A52:F52"/></mergeCells>'));
  expect(()=>patchProposalWorkbook(missing,input)).toThrow(/availability.*geometry/i);
  expect(()=>patchProposalWorkbook(duplicate,input)).toThrow(/availability.*geometry/i);
 });
 it('refuses an overlapping merge in the extension',()=>{
  const changed=changeSheet(sheet=>sheet.replace('</mergeCells>','<mergeCell ref="G52:H52"/></mergeCells>'));
  expect(()=>patchProposalWorkbook(changed,input)).toThrow(/availability.*geometry/i);
 });
});
