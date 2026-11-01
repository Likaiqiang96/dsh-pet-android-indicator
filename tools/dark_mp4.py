#!/usr/bin/env python3
"""把透明动画烘焙到 #191d23 黑灰背景（1280x720 H.264 MP4）。"""
import os, subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets')
DST = os.path.join(ROOT, 'assets-dark')
os.makedirs(DST, exist_ok=True)
BG = '0x191d23'

CORE = ['待机呼吸休闲', '东张西望', '工作状态-思考冒泡', '工作状态-忙碌点按', '工作状态-清点归档',
        '工作状态-原地踱步张望', '工作状态-雀跃庆祝', '工作状态-垂头叹气冒汗',
        '点击回应-开心跃动', '点击回应-害羞惊讶', '点击回应-傲娇生气', '点击回应-挠痒咯咯笑',
        '点击回应-元气挥手', '碎碎念-发呆碎碎念', '碎碎念-对屏碎碎念', '碎碎念-擦桌碎碎念']

def convert(name):
    src = os.path.join(SRC, name + '.webm')
    dst = os.path.join(DST, name + '.mp4')
    if os.path.exists(dst) and os.path.getsize(dst) > 1024:
        return name, 'skip'
    fg = ("color=c=%s:s=1280x720[bg];[0:v]scale=1280:720:flags=lanczos[fg];"
          "[bg][fg]overlay=shortest=1:format=auto,format=yuv420p[out]" % BG)
    cmd = ['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', src,
           '-filter_complex', fg, '-map', '[out]',
           '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
           '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-y', dst]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        try: os.remove(dst)
        except OSError: pass
        return name, 'fail ' + (p.stderr or '')[-120:]
    return name, f'ok {os.path.getsize(dst)//1024}K'

def main():
    allnames = sorted(os.path.splitext(f)[0] for f in os.listdir(SRC) if f.endswith('.webm'))
    names = [n for n in CORE if n in allnames] + [n for n in allnames if n not in CORE]
    print(f'共 {len(names)} 段', flush=True)
    done = 0
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(convert, n): n for n in names}
        for fut in as_completed(futures):
            name, result = fut.result()
            done += 1
            print(f'[{done}/{len(names)}] {name}: {result}', flush=True)

if __name__ == '__main__':
    main()
