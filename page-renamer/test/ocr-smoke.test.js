const test=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {recognizeZone,normalizedNumber,closeWorker}=require('../server');

test('reads a sheet number and title from separate title-block regions in a TIFF',async()=>{
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500">
    <rect width="1200" height="500" fill="white"/><rect x="40" y="40" width="1120" height="420" fill="none" stroke="black" stroke-width="3"/>
    <text x="90" y="200" font-family="Arial" font-size="92" fill="black">A1.1</text>
    <text x="90" y="370" font-family="Arial" font-size="72" fill="black">FIRST FLOOR PLAN</text></svg>`;
  const buffer=await sharp(Buffer.from(svg)).tiff().toBuffer();
  const meta=await sharp(buffer).metadata();
  try {
    const number=await recognizeZone(buffer,meta,{x:.06,y:.17,w:.38,h:.30},'number');
    const title=await recognizeZone(buffer,meta,{x:.06,y:.48,w:.87,h:.32},'title');
    assert.equal(normalizedNumber(number.text),'A1.1');
    // A real architectural sheet was read as AO.2; keep the correction reviewable.
    assert.equal(normalizedNumber('AO.2'),'A0.2');
    assert.match(title.text,/FIRST FLOOR PLAN/i);
  } finally {await closeWorker();}
});
