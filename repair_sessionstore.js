const fs = require('fs');
let code = fs.readFileSync('src/services/db/SessionStore.ts', 'utf-8');

// The `IDatabaseProvider` has:
// `get<T>(sql: string, params?: any[]): Promise<T | null>;`
// `all<T>(sql: string, params?: any[]): Promise<T[]>;`
// `run(sql: string, params?: any[]): Promise<{ changes: number; lastInsertRowid: number }>;`
// `transaction<T>(fn: (provider: IDatabaseProvider) => Promise<T>): Promise<T>;`

// 1. Remove all `this.db.prepare(x).method(y)`
code = code.replace(/const\s+([a-zA-Z0-9_]+)\s*=\s*(?:await\s+)?this\.db\.prepare\(([\s\S]*?)\);\s*(?:(?:await\s+)?(?:return\s+)?)?(?:await\s+)?\1\.(all|get|run)\(([^)]*)\)\s*;/g, (match, stmtName, sql, method, params) => {
    let call = `await this.db.${method}(${sql}`;
    let p = params.trim();
    if (p) {
        // If params are passed like `(limit)` it needs to be `([limit])`
        // Wait, if it's already an array, don't wrap it.
        if (p.startsWith('[') && p.endsWith(']')) {
             call += `, ${p}`;
        } else {
             call += `, [${p}]`;
        }
    }
    call += `);`;
    if (match.includes('return ')) call = 'return ' + call;
    return call;
});

// 2. Also fix the ones replaced by patch_prepare.ts (e.g. `this.db.get(sql, p)`)
// Ensure they have `[]` around params if they are passed as loose arguments.
code = code.replace(/(?:await\s+)?this\.db\.(get|all|run)\((`[^`]+`|'[^']+'|"[^"]+"),([^)]+)\)/g, (match, method, sql, params) => {
    let p = params.trim();
    if (!p) return `await this.db.${method}(${sql})`;
    // Check if params is already an array or an object
    if (p.startsWith('[') && p.endsWith(']') || p.startsWith('{') && p.endsWith('}')) {
        return `await this.db.${method}(${sql}, ${p})`;
    }
    // Check if p contains commas, meaning multiple arguments.
    // Wrap them in an array
    return `await this.db.${method}(${sql}, [${p}])`;
});

// 3. Make sure IDatabaseProvider import is correct
if (!code.includes("import { IDatabaseProvider }")) {
   code = "import { IDatabaseProvider } from './provider/IDatabaseProvider.js';\n" + code;
}

// 4. Ensure methods are `async` and return `Promise`. We did this mostly with regex earlier, make sure there are no syntax errors.

fs.writeFileSync('src/services/db/SessionStore.ts', code);
console.log('SessionStore repaired.');
