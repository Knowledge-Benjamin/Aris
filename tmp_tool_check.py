import re
from pathlib import Path
p = Path('server/src/services/arisService.ts')
text = p.read_text(encoding='utf-8')
m = re.search(r'private readonly supportedToolNames = new Set<string>\(\[([\s\S]*?)\]\);', text)
if not m:
    print('supported set not found')
    raise SystemExit(1)
raw = m.group(1)
tools = [line.strip().rstrip(',').strip('"') for line in raw.strip().splitlines() if line.strip()]
cases = sorted(set(re.findall(r'case "([^"]+)"', text)))
print('supported count', len(tools))
print('cases count', len(cases))
missing = sorted(set(tools) - set(cases))
extra = sorted(set(cases) - set(tools))
print('missing in cases', missing)
print('extra cases', extra)
