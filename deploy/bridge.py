"""Run the existing credential loader/bridge, overriding only its SSH host in memory."""
import ast
import os
import sys

path = os.environ.get('BRIDGE', '/workspace/evs/s.py')
with open(path) as source:
    tree = ast.parse(source.read(), filename=path)
count = 0
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'connect':
        if not node.args:
            raise SystemExit('Unsupported bridge: expected positional SSH host')
        node.args[0] = ast.Constant(os.environ['DEPLOY_HOST'])
        count += 1
if count != 1:
    raise SystemExit('Unsupported bridge: expected one SSH connection')
sys.argv[0] = path
exec(compile(ast.fix_missing_locations(tree), path, 'exec'), {'__name__': '__main__', '__file__': path})
