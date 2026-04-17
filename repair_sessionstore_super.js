const fs = require('fs');

const path = 'src/services/db/SessionStore.ts';
let code = fs.readFileSync(path, 'utf8');

// 1. Make all methods async, and return Promise<T>
// We'll use a simple regex replacing " method(" to " async method("
// But wait, it's easier to use a TS AST parser to just mark methods async.
// I will use Babel for this! Babel is 100% reliable for AST transformations.
