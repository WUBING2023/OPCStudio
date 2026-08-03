const assert = require('node:assert/strict');
const clamp = require('./clamp');

assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-1, 0, 10), 0);
assert.equal(clamp(15, 0, 10), 10);

console.log('clamp tests passed');
