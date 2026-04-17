import { Project, SyntaxKind, MethodDeclaration, FunctionDeclaration, Node, TypeFormatFlags } from 'ts-morph';

const project = new Project({
  tsConfigFilePath: './tsconfig.json',
});

function refactorQueryCalls(node: Node) {
  // Find expressions like: this.db.query('...').get(...args)
  const callExprs = node.getDescendantsOfKind(SyntaxKind.CallExpression);
  
  for (const callExpr of callExprs) {
    const expr = callExpr.getExpression();
    if (Node.isPropertyAccessExpression(expr)) {
      const name = expr.getName();
      if (['get', 'all', 'run'].includes(name)) {
        const caller = expr.getExpression();
        // Check if caller is a call to .query()
        if (Node.isCallExpression(caller)) {
          const innerExpr = caller.getExpression();
          if (Node.isPropertyAccessExpression(innerExpr) && innerExpr.getName() === 'query') {
             const dbRef = innerExpr.getExpression().getText(); // e.g. "this.db" or "db"
             const sqlArg = caller.getArguments()[0]?.getText();
             const methArgs = callExpr.getArguments().map(a => a.getText());
             
             if (sqlArg) {
                // If it evaluates to e.g. this.db.get<Type>(sql, [args])
                let typeArgs = "";
                const typeNodes = callExpr.getTypeArguments();
                if (typeNodes.length > 0) {
                    typeArgs = `<${typeNodes[0].getText()}>`;
                }

                // SQLite .run() returns changes and lastInsertRowid
                // We map this properly in IDatabaseProvider
                
                let newText = `await ${dbRef}.${name}${typeArgs}(${sqlArg}`;
                if (methArgs.length > 0) {
                   // if someone did .run(a, b), we need to convert to array .run(sql, [a, b])
                   // Wait, if it's already an array, just pass it or wrap. Let's just wrap
                   if (methArgs.length === 1 && methArgs[0].startsWith('[')) {
                       newText += `, ${methArgs[0]}`;
                   } else {
                       newText += `, [${methArgs.join(', ')}]`;
                   }
                }
                newText += ')';
                
                callExpr.replaceWithText(newText);
             }
          }
        }
      } else if (name === 'prepare') {
        const caller = expr.getExpression();
         if (caller.getText() === 'this.db' || caller.getText() === 'db') {
            // handle prepare... wait, no one typically uses prepare.get, they use query.get in ClaudeMem
         }
      }
    }
  }
}

function makeMethodsAsync(sourceFile) {
   sourceFile.getFunctions().forEach(f => {
      if (f.getText().includes('await ') && !f.isAsync()) {
         f.setIsAsync(true);
      }
   });
   
   sourceFile.getClasses().forEach(c => {
      c.getMethods().forEach(m => {
         if (m.getText().includes('await ') && !m.isAsync()) {
            m.setIsAsync(true);
            
            // Fix return type if it lacks Promise
            const retType = m.getReturnTypeNode();
            if (retType && !retType.getText().startsWith('Promise<')) {
               m.setReturnType(`Promise<${retType.getText()}>`);
            } else if (!retType) {
               m.setReturnType(`Promise<any>`);
            }
         }
      });
   });
}

const files = project.getSourceFiles('src/services/db/**/*.ts');
for (const file of files) {
  refactorQueryCalls(file);
  makeMethodsAsync(file);
}

project.saveSync();
console.log('Done refactoring db sync to async calls.');
