import os
import re

files_to_migrate = [
    'src/services/db/observations/files.ts',
    'src/services/db/observations/get.ts',
    'src/services/db/observations/recent.ts',
    'src/services/db/observations/store.ts',
    'src/services/db/prompts/store.ts',
    'src/services/db/sessions/get.ts',
    'src/services/db/summaries/get.ts',
    'src/services/db/summaries/recent.ts',
    'src/services/db/summaries/store.ts',
]

def migrate_file(filepath):
    if not os.path.exists(filepath):
        return
    with open(filepath, 'r') as f:
        content = f.read()

    original = content
    
    # 1. Replace imports
    if "import type { Database } from 'bun:sqlite';" in content:
        content = content.replace("import type { Database } from 'bun:sqlite';", "import { IDatabaseProvider } from '../provider/IDatabaseProvider.js';")
    elif "import { Database } from 'bun:sqlite';" in content:
        content = content.replace("import { Database } from 'bun:sqlite';", "import { IDatabaseProvider } from '../provider/IDatabaseProvider.js';")
    
    # Ensure IDatabaseProvider is imported if missing
    if "IDatabaseProvider" not in content and "db: IDatabaseProvider" in content:
        # Just put it at the top
        content = "import { IDatabaseProvider } from '../provider/IDatabaseProvider.js';\n" + content
    
    # 2. Fix signature to async
    def replace_func_signature(m):
        func_mod = m.group(1) if m.group(1) else ''
        func_name = m.group(2)
        params = m.group(3)
        ret_type = m.group(4)
        
        # Don't add promise if already
        if ret_type and not ret_type.startswith('Promise<'):
            ret_type = f"Promise<{ret_type}>"
            
        async_str = ""
        if "async" not in func_mod:
            async_str = "async "
            
        res = f"export {async_str}function {func_name}({params})"
        if ret_type:
            res += f": {ret_type}"
        return res

    content = re.sub(r'export\s+(async\s+)?function\s+(\w+)\s*\(([^)]+)\)\s*(?::\s*([^\{\n]+))?', replace_func_signature, content)

    # Convert db.prepare() pattern
    # Pattern: const stmt = db.prepare(`...`); return stmt.get(...)
    # Let's do it manually since each file is small, wait no. I can write a regex for simple ones
    
    # Actually, using python for this AST-like change is hard. Let's look at what we're replacing.
    content = re.sub(r'const stmt = db\.prepare\((.*?)\);([\s\S]*?)return\s*\(?stmt\.get\((.*?)\)(.*?)\)?(?:\s*\|\|\s*null)?;', 
                     lambda m: f"return await db.get({m.group(1)}, [{m.group(3)}]){m.group(4)} || null;", content)
                     
    content = re.sub(r'const stmt = db\.prepare\((.*?)\);([\s\S]*?)return\s*stmt\.all\((.*?)\)(.*);', 
                     lambda m: f"return await db.all({m.group(1)}, [{m.group(3)}]){m.group(4)};", content)

    content = re.sub(r'const stmt = db\.prepare\((.*?)\);([\s\S]*?)stmt\.run\((.*?)\);', 
                     lambda m: f"await db.run({m.group(1)}, [{m.group(3)}]);\n{m.group(2)}", content)
    
    # Specific fix for prompts/store.ts missing IDatabaseProvider
    if "db: IDatabaseProvider" in content and "IDatabaseProvider" not in content.split("function")[0]:
        content = "import { IDatabaseProvider } from '../provider/IDatabaseProvider.js';\n" + content

    if content != original:
        with open(filepath, 'w') as f:
            f.write(content)

for filepath in files_to_migrate:
    migrate_file(filepath)
