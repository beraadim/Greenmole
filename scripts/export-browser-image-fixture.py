#!/usr/bin/env python3
"""Export synthetic PNG/WebP replay assets using a pinned production libguac."""

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT/'scripts/benchmarks/export-image-assets.c'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--png-control', action='store_true',
                        help='benchmark only: interpose indexed PNG settings, including default/default control')
    parser.add_argument('--png-level', choices=['default','1','3'], default='default')
    parser.add_argument('--png-filter', choices=['default','none','up','fast'], default='default')
    parser.add_argument('--png-strategy', choices=['default','rle'], default='default')
    args = parser.parse_args()
    if not args.png_control and any(v != 'default' for v in [args.png_level,args.png_filter,args.png_strategy]):
        parser.error('PNG settings require --png-control')
    if not re.fullmatch('[0-9a-f]{40}', args.revision):
        parser.error('--revision must be a full Git revision')
    image = json.loads(subprocess.check_output(['docker','image','inspect',args.image], text=True))[0]
    assert image['Config']['Labels']['org.opencontainers.image.revision'] == args.revision
    command = r"""set -eu
export LD_LIBRARY_PATH=/opt/guacamole/lib
export TMPDIR=/run/fixture
cd /run/fixture
EXTRA_SETUP
cc -O2 -std=gnu11 -Wall -Werror -pedantic -pthread \
 -I/tmp/guacamole-server/src/libguac -I/bench $extra_flags $(pkg-config --cflags cairo libwebp) \
 /bench/export-image-assets.c -L/opt/guacamole/lib -Wl,-rpath,/opt/guacamole/lib \
 -Wl,--export-dynamic $extra_sources -lguac -ldl $(pkg-config --libs cairo libwebp) $extra_libs \
 -o /run/fixture/export
exec /run/fixture/export EXTRA_ARGUMENTS
"""
    setup="extra_flags=; extra_sources=; extra_libs="
    if args.png_control:
        setup="extra_flags=-DBENCH_PNG_COMPRESSION_CONTROL; extra_sources=/bench/png-compression-control.c; extra_libs=$(pkg-config --libs libpng)"
    command=command.replace("EXTRA_SETUP",setup).replace("EXTRA_ARGUMENTS",
        " ".join([args.png_level,args.png_filter,args.png_strategy]) if args.png_control else "")
    result = subprocess.run(['docker','run','--rm','--pull=never','--network=none',
        '--read-only','--tmpfs','/run/fixture:rw,exec,size=128m','--cap-drop=ALL',
        '--security-opt','no-new-privileges','--memory=512m','--pids-limit=32',
        '--mount',f'type=bind,src={SOURCE},dst=/bench/export-image-assets.c,readonly',
        *(['--mount',f"type=bind,src={ROOT / 'scripts/benchmarks/png-compression-control.c'},dst=/bench/png-compression-control.c,readonly",
           '--mount',f"type=bind,src={ROOT / 'scripts/benchmarks/png-compression-control.h'},dst=/bench/png-compression-control.h,readonly"] if args.png_control else []),
        image['Id'],'/bin/sh','-c',command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace'))
    raw=result.stdout
    control=json.loads(result.stderr) if args.png_control else None
    if control:
        assert control['hooks_verified'] and control['indexed_calls']==10
    stream = io.BytesIO(raw)
    assets = []
    for _ in range(20):
        item = json.loads(stream.readline())
        length = item.pop('bytes')
        assert 0 < length <= 32*1024*1024
        data = stream.read(length)
        assert len(data) == length and stream.read(1) == b'\n'
        item['data_base64'] = base64.b64encode(data).decode('ascii')
        item['encoded_sha256'] = hashlib.sha256(data).hexdigest()
        assets.append(item)
    assert not stream.read(), 'unexpected output after twenty assets'
    scenarios=[]
    for codec in ['png','webp']:
        for tiles in [1,40,128]:
            full = tiles == 1
            columns = 1 if full else 8 if tiles == 40 else 16
            rows = 1 if full else 5 if tiles == 40 else 8
            width,height = (1920,944) if full else (columns*128,rows*96)
            frames=[]
            for variant in range(2):
                frames.append({'images':[{'asset':f"{codec}-{'full' if full else 'tile'}-v{variant}-t{0 if full else i%4}",
                    'x':0 if full else (i%columns)*128,'y':0 if full else (i//columns)*96}
                    for i in range(tiles)]})
            scenarios.append({'id':f'{codec}-{tiles}','width':width,'height':height,'frames':frames})
    result={'schema':'guacamole-image-pipeline-fixture-v1','provenance':{
        'source_revision':args.revision,'image_id':image['Id'],
        'generator':'scripts/benchmarks/export-image-assets.c',
        'generator_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        'encoder_note':'Actual guac_png_write/guac_webp_write and real blob serialization to a discard socket. WebP is lossy quality90, method2; PNG uses the image production policy. Browser replay constructs img/blob/end/sync instructions around these encoded bytes. One sequential encode time per asset is informational, not a performance comparison.'},
        'assets':assets,'scenarios':scenarios}
    if control:
        result['provenance']['png_compression_control']=control
        result['provenance']['compression_control_sha256']=hashlib.sha256((ROOT/'scripts/benchmarks/png-compression-control.c').read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,separators=(',',':'))+'\n')
    print(json.dumps({'assets':len(assets),'scenarios':len(scenarios),'image_id':image['Id'],
        'source_revision':args.revision,'fixture_sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),
        'asset_bytes':sum(len(base64.b64decode(a['data_base64'])) for a in assets)}))


if __name__ == '__main__':
    main()
