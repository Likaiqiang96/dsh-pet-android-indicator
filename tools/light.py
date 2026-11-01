#!/usr/bin/env python3
"""把透明动画烘焙到 #f2f3f5 浅色背景上（1280x720，不透明），给不支持 alpha 的 WebView 用。"""
import argparse, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets')
DST = os.path.join(ROOT, 'assets-light')
os.makedirs(DST, exist_ok=True)
BG = '0xf2f3f5'

CORE = [
    '待机呼吸休闲', '东张西望',
    '工作状态-思考冒泡', '工作状态-忙碌点按', '工作状态-清点归档',
    '工作状态-原地踱步张望', '工作状态-雀跃庆祝', '工作状态-垂头叹气冒汗',
    '点击回应-开心跃动', '点击回应-害羞惊讶', '点击回应-傲娇生气',
    '点击回应-挠痒咯咯笑', '点击回应-元气挥手',
]

def convert(name):
    src = os.path.join(SRC, name + '.webm')
    dst = os.path.join(DST, name + '.webm')
    if os.path.exists(dst) and os.path.getsize(dst) > 1024:
        return name, 'skip'
    fg = ("color=c=%s:s=1280x720[bg];[0:v]scale=1280:720:flags=lanczos[fg];"
          "[bg][fg]overlay=shortest=1:format=auto,format=yuv420p[out]" % BG)
    cmd = ['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', src,
           '-filter_complex', fg, '-map', '[out]',
           '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '31',
           '-row-mt', '1', '-cpu-used', '8', '-an', '-y', dst]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        try: os.remove(dst)
        except OSError: pass
        return name, 'fail ' + (p.stderr or '')[-120:]
    return name, f'ok {os.path.getsize(dst)//1024}K'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('names', nargs='*')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--workers', type=int, default=2)
    args = ap.parse_args()
    names = sorted(os.path.splitext(f)[0] for f in os.listdir(SRC) if f.endswith('.webm')) if args.all else (args.names or CORE)
    print(f'共 {len(names)} 段，{args.workers} 并发', flush=True)
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(convert, n): n for n in names}
        for fut in as_completed(futures):
            name, result = fut.result()
            done += 1
            print(f'[{done}/{len(names)}] {name}: {result}', flush=True)

if __name__ == '__main__':
    main()
