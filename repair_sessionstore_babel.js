const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const filePath = '/Users/mac/Documents/dev/ai/skills/claude-mem/src/services/db/SessionStore.ts';
let code = fs.readFileSync(filePath, 'utf8');

const ast = parser.parse(code, {
  sourceType: 'module',
  plugins: ['typescript', 'decorators-legacy'],
});

function markAsyncAndPromise(path) {
  if (!path.node.async) {
    path.node.async = true;
    if (path.node.returnType && path.node.returnType.type === 'TSTypeAnnotation') {
      const typeAno = path.node.returnType.typeAnnotation;
      if (typeAno.type !== 'TSTypeReference' || (typeAno.typeName && typeAno.typeName.name !== 'Promise')) {
        path.node.returnType = t.tsTypeAnnotation(
          t.tsTypeReference(t.identifier('Promise'), t.tsTypeParameterInstantiation([typeAno]))
        );
      }
    }
  }
}

// Map to keep track of stmt names and their SQL AST node
// Block scope id -> Map<stmtName, sqlNode>
const stmtMap = new Map();

traverse(ast, {
  ClassMethod(path) {
    if (path.node.kind !== 'constructor') markAsyncAndPromise(path);
  },

  VariableDeclarator(path) {
    // const stmt = this.db.prepare(SQL) or query(SQL)
    const init = path.node.init;
    if (init && init.type === 'CallExpression' && init.callee.type === 'MemberExpression') {
        const p = init.callee.property.name;
        if ((p === 'prepare' || p === 'query') && 
            init.callee.object.type === 'MemberExpression' &&
            init.callee.object.property.name === 'db' &&
            init.callee.object.object.type === 'ThisExpression') {
            
            const stmtName = path.node.id.name;
            const sqlNode = init.arguments[0];
            
            // Store it in our map keyed by BlockStatement parent
            const block = path.findParent(p => p.isBlockStatement());
            if (block) {
                if (!stmtMap.has(block)) stmtMap.set(block, new Map());
                stmtMap.get(block).set(stmtName, sqlNode);
            }
            
            // Remove the declaration
            path.remove();
        }
    }
  },

  CallExpression(path) {
    const callee = path.node.callee;
    
    // Transform stmt.run(x) to await this.db.run(SQL, x)
    if (callee.type === 'MemberExpression') {
        const propName = callee.property.name;
        if (['run', 'get', 'all'].includes(propName)) {
            
            if (callee.object.type === 'Identifier') {
                const stmtName = callee.object.name;
                const block = path.findParent(p => p.isBlockStatement());
                if (block && stmtMap.has(block) && stmtMap.get(block).has(stmtName)) {
                    const sqlNode = stmtMap.get(block).get(stmtName);
                    
                    const B = path.node.arguments;
                    let newArgs = [sqlNode];
                    if (B.length > 0) {
                        if (B.length === 1 && (B[0].type === 'ArrayExpression' || B[0].type === 'ObjectExpression')) {
                            newArgs.push(B[0]);
                        } else {
                            newArgs.push(t.arrayExpression(B));
                        }
                    }
                    
                    const newCall = t.callExpression(
                        t.memberExpression(t.memberExpression(t.thisExpression(), t.identifier('db')), t.identifier(propName)),
                        newArgs
                    );
                    
                    let awaitExpr = newCall;
                    // Dont wrap with await twice if it's already awaited
                    if (path.parent.type !== 'AwaitExpression' && path.parent.type !== 'ReturnStatement') {
                        awaitExpr = t.awaitExpression(newCall);
                    }
                    if (path.parent.type === 'ReturnStatement') {
                        awaitExpr = t.awaitExpression(newCall);
                    }
                    path.replaceWith(awaitExpr);
                    return;
                }
            }

            // Transform this.db.query(sql).all(args)
            const innerCall = callee.object;
            if (innerCall.type === 'CallExpression' && innerCall.callee.type === 'MemberExpression') {
                const innerProp = innerCall.callee.property.name;
                if (['prepare', 'query'].includes(innerProp) && 
                    innerCall.callee.object.type === 'MemberExpression' &&
                    innerCall.callee.object.object.type === 'ThisExpression' &&
                    innerCall.callee.object.property.name === 'db') {
                    
                    const A = innerCall.arguments; // SQL
                    const B = path.node.arguments; // Args
                    
                    let newArgs = [...A];
                    if (B.length > 0) {
                        if (B.length === 1 && (B[0].type === 'ArrayExpression' || B[0].type === 'ObjectExpression')) {
                            newArgs.push(B[0]);
                        } else {
                            newArgs.push(t.arrayExpression(B));
                        }
                    }
                    
                    const newCall = t.callExpression(
                        t.memberExpression(t.memberExpression(t.thisExpression(), t.identifier('db')), t.identifier(propName)),
                        newArgs
                    );
                    
                    let awaitExpr = t.awaitExpression(newCall);
                    path.replaceWith(awaitExpr);
                    return;
                }
            }
        }
    }
  }
});

traverse(ast, {
    // Add await to this.db.run/get/all/exec/query if missing
    CallExpression(path) {
        const callee = path.node.callee;
        if (callee.type === 'MemberExpression' &&
            callee.object && callee.object.type === 'MemberExpression' &&
            callee.object.object && callee.object.object.type === 'ThisExpression' &&
            callee.object.property.name === 'db') {
            
            const propName = callee.property.name;
            if (['run', 'get', 'all', 'exec', 'query'].includes(propName)) {
                if (path.parent.type !== 'AwaitExpression') {
                    path.replaceWith(t.awaitExpression(path.node));
                }
            }
        }
    }
});

const output = generate(ast, { retainLines: false }, code);
let finalCode = output.code;
fs.writeFileSync(filePath, finalCode, 'utf8');
console.log('Successfully written with Babel Transform');
