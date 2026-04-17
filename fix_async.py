import os
import re

for root, _, files in os.walk("src/"):
    for file in files:
        if file.endswith(".ts"):
            path = os.path.join(root, file)
            with open(path, "r") as f:
                content = f.read()

            # Match `export function foo(...): Promise<...>` or `export function foo(...) : Promise<...>`
            # We must be careful because parameters might contain newlines.
            # Instead, let's just find `export function ` and see if the function contains `await`.
            # If `await ` is in the body, it needs to be `async function`.
            # But the TypeScript error tells us exactly which ones!
            
            # Let's parse my_tsc_errors.log
            pass

error_file = "my_tsc_errors.log"
with open(error_file, "r") as f:
    text = f.read()

# find all errors of TS1308: 'await' expressions are only allowed within async functions
# e.g., src/services/db/observations/files.ts(34,16): error TS1308: 'await' expressions...
import collections

files_to_fix = collections.defaultdict(list)
for line in text.splitlines():
    match = re.search(r'^(.+\.ts)\((\d+),\d+\):.*TS1308', line)
    if match:
        filename = match.group(1)
        line_num = int(match.group(2))
        files_to_fix[filename].append(line_num)

for filename, lines in files_to_fix.items():
    if not os.path.exists(filename):
        continue
    with open(filename, "r") as f:
        content_lines = f.readlines()
    
    # For each line where 'await' is used, we walk backwards to find the enclosing 'function ' and prepend 'async '
    for line_num in sorted(lines, reverse=True):
        idx = line_num - 1
        while idx >= 0:
            if re.search(r'\bfunction\b', content_lines[idx]) and 'async' not in content_lines[idx]:
                content_lines[idx] = re.sub(r'\bfunction\b', 'async function', content_lines[idx])
                break
            idx -= 1
            
    with open(filename, "w") as f:
        f.writelines(content_lines)
    print(f"Fixed TS1308 in {filename}")
