const fs = require('fs');
const buf = Buffer.from(Array.from({length:256}, (_,i)=>i));
fs.writeFileSync('frame.jpg', buf);
console.log('WROTE frame.jpg', buf.length);