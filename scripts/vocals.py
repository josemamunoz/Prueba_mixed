#!/usr/bin/env python3
"""Separa la voz de cada pista con Demucs y guarda cuánta voz hay, para la columna «Voz» de la app.

Se ejecuta fuera del navegador, una vez por biblioteca (Demucs tarda más o menos lo que dura el
tema en una CPU normal):

    pip install -r scripts/requirements-vocals.txt
    python scripts/vocals.py "F:/Musica/Progressive"

Escribe `keymix-voces.json` en la carpeta indicada. Con cada pista terminada se guarda el archivo,
así que se puede interrumpir (Ctrl+C) y volver a lanzar: las pistas ya medidas (mismo nombre y
tamaño) se saltan. Después, al abrir esa carpeta en la app, se lee el archivo solo.

Por cada segmento de 3 s se guarda la energía de la voz separada respecto a la mezcla, en dB
(null si el segmento está en silencio). La decisión «con voz / instrumental» la toma la app
(js/vocals.js), para poder ajustarla sin volver a separar.
"""
import argparse
import json
import math
import os
import sys
import time

AUDIO_EXT = ('.wav', '.wave', '.aif', '.aiff', '.flac', '.mp3', '.ogg', '.oga')
OUT_NAME = 'keymix-voces.json'
SEG_SEC = 3
MAX_DEPTH = 4  # como «Abrir carpeta» en la app


def find_audio(root):
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        depth = os.path.relpath(dirpath, root).count(os.sep) + (dirpath != root)
        if depth >= MAX_DEPTH:
            dirnames[:] = []
        for name in filenames:
            if name.lower().endswith(AUDIO_EXT):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def load_results(path, model):
    empty = {'format': 'keymix-voces', 'version': 1, 'model': model, 'tracks': {}}
    if not os.path.exists(path):
        return empty
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    if data.get('format') != 'keymix-voces' or data.get('version') != 1:
        sys.exit(f'{path} no es un archivo de este script; muévelo o bórralo antes de continuar.')
    if data.get('model') != model:
        print(f"Aviso: {OUT_NAME} se creó con el modelo {data.get('model')}; se vuelven a medir todas las pistas.")
        return empty
    return data


def save_results(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)


def segment_db(vocal, mix, sr):
    """dB de la energía de la voz separada respecto a la mezcla en segmentos de SEG_SEC segundos."""
    hop = sr * SEG_SEC
    out = []
    for i in range(0, mix.shape[-1] - hop + 1, hop):
        m = float((mix[:, i:i + hop] ** 2).mean())
        if m < 1e-9:
            out.append(None)
            continue
        v = float((vocal[:, i:i + hop] ** 2).mean())
        out.append(round(10 * math.log10((v + 1e-12) / m), 1))
    return out


def main():
    ap = argparse.ArgumentParser(description='Mide la voz de cada pista con Demucs para KeyMix Pro.')
    ap.add_argument('folder', help='carpeta de música (se recorren hasta 4 niveles de subcarpetas)')
    ap.add_argument('--model', default='htdemucs', help='modelo de Demucs (por defecto: htdemucs)')
    args = ap.parse_args()
    root = os.path.abspath(args.folder)
    if not os.path.isdir(root):
        sys.exit(f'No existe la carpeta {root}')

    out_path = os.path.join(root, OUT_NAME)
    data = load_results(out_path, args.model)
    files = find_audio(root)
    pending = []
    for p in files:
        rel = os.path.relpath(p, root).replace(os.sep, '/')
        prev = data['tracks'].get(rel)
        if not (prev and prev.get('size') == os.path.getsize(p)):
            pending.append((p, rel))
    print(f'{len(files)} pistas en {root}: {len(files) - len(pending)} ya medidas, {len(pending)} pendientes.')
    if not pending:
        return

    # Se importan aquí para que el resumen de arriba salga aunque falten las dependencias.
    import soundfile as sf
    import torch
    import torchaudio.functional as AF
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    torch.set_num_threads(os.cpu_count() or 4)
    model = get_model(args.model)
    model.eval()
    voc_index = model.sources.index('vocals')
    sr_model = model.samplerate

    for n, (p, rel) in enumerate(pending, 1):
        t0 = time.time()
        try:
            audio, sr = sf.read(p, dtype='float32', always_2d=True)
            wav = torch.from_numpy(audio.T.copy())
            if wav.shape[0] == 1:
                wav = wav.repeat(2, 1)
            wav = wav[:2]
            if sr != sr_model:
                wav = AF.resample(wav, sr, sr_model)
            ref = wav.mean(0)
            mean, std = ref.mean(), ref.std() + 1e-8
            with torch.no_grad():
                est = apply_model(model, ((wav - mean) / std)[None], shifts=0, split=True, overlap=0.25, progress=False)[0]
            vocal = est[voc_index] * std + mean
            data['tracks'][rel] = {
                'name': os.path.basename(p),
                'size': os.path.getsize(p),
                'seconds': round(wav.shape[-1] / sr_model, 1),
                'segSec': SEG_SEC,
                'seg': segment_db(vocal, wav, sr_model),
            }
            save_results(out_path, data)
            print(f'[{n}/{len(pending)}] {rel} ({time.time() - t0:.0f} s)', flush=True)
        except Exception as err:  # una pista ilegible no debe parar el resto
            print(f'[{n}/{len(pending)}] {rel}: error, se salta ({err})', flush=True)
    print(f'Listo: {out_path}')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit('\nInterrumpido. Las pistas terminadas ya están guardadas; vuelve a lanzarlo para seguir.')
