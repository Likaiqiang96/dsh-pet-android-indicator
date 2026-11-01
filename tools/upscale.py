#!/usr/bin/env python3
"""把 640x360 的动画放大到 1280x720（保留透明通道 + 轻锐化），输出到 assets-hd/。

用法:
  tools/upscale.py --core       # 只处理待机/工作状态/点击/转向（最常出现的 13 段）
  tools/upscale.py --all        # 全部 106 段（比较久）
  tools/upscale.py 名字1 名字2    # 指定动画
"""
import argparse, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets')
DST = os.path.join(ROOT, 'assets-hd')
os.makedirs(DST, exist_ok=True)

CORE = [
    '待机呼吸休闲', '东张西望',
    '工作状态-思考冒泡', '工作状态-忙碌点按', '工作状态-清点归档',
    '工作状态-原地踱步张望', '工作状态-雀跃庆祝', '工作状态-垂头叹气冒汗',
    '点击回应-开心跃动', '点击回应-害羞惊讶', '点击回应-傲娇生气',
    '点击回应-挠痒咯咯笑', '点击回应-元气挥手',
]

def convert(name, workers):
    src = os.path.join(SRC, name + '.webm')
    dst = os.path.join(DST, name + '.webm')
    if not os.path.exists(src):
        return name, 'missing'
    if os.path.exists(dst) and os.path.getsize(dst) > 1024:
        return name, 'skip'
    vf = ("[0:v]split=2[c][a];"
          "[a]alphaextract,scale=1280:720:flags=lanczos[alpha];"
          "[c]format=yuv420p,scale=1280:720:flags=lanczos,unsharp=5:5:0.5:5:5:0[color];"
          "[color][alpha]alphamerge,format=yuva420p[out]")
    cmd = [
        'ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', src,
        '-filter_complex', vf, '-map', '[out]',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '31',
        '-auto-alt-ref', '0', '-lag-in-frames', '0', '-row-mt', '1', '-cpu-used', '8',
        '-an', '-y', dst,
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        try: os.remove(dst)
        except OSError: pass
        return name, 'fail: ' + (p.stderr or '')[-160:]
    return name, f'ok {os.path.getsize(dst)//1024}K'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('names', nargs='*')
    ap.add_argument('--core', action='store_true')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--workers', type=int, default=2)
    args = ap.parse_args()
    if args.core:
        names = CORE
    elif args.all:
        names = sorted(os.path.splitext(f)[0] for f in os.listdir(SRC) if f.endswith('.webm'))
    else:
        names = args.names
    if not names:
        ap.error('没有指定动画')
    print(f'共 {len(names)} 段，{args.workers} 并发', flush=True)
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(convert, n, args.workers): n for n in names}
        for fut in as_completed(futures):
            name, result = fut.result()
            done += 1
            print(f'[{done}/{len(names)}] {name}: {result}', flush=True)

if __name__ == '__main__':
    main()
