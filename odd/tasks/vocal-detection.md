# Vocal detection (offline separation)

Objective: tell vocal from instrumental tracks by separating vocals offline with Demucs and showing the result in the app.
Branch: feat/vocal-detection · Delivery: ask-on-risk · Tests: `npm test` (node --test), Python script checked by running it on real files.

## Specs

- S1. "separar las voces del resto de la mezcla": an offline script runs Demucs (htdemucs) over a music folder and measures, per 3 s segment, the vocal-stem to mix energy ratio in dB.
- S2. "Me sirve un análisis por fuera": the analysis runs outside the browser, on the user's PC, once per library; it writes `keymix-voces.json` in the analyzed folder and skips tracks already in that file (same name and size), so it can be stopped and resumed.
- S3. The app reads `keymix-voces.json` when it reads a folder (Abrir carpeta, remembered folders) or when the file is added or dropped, matches tracks by file name and size, stores the measurements with the library and shows a «Voz» column (sortable) with the result.
- S4. Decision rule, from the 18 user-labeled tracks: a 3 s segment counts as vocal when it is above -10 dB and an adjacent segment is too (isolated segments are ignored); a track is vocal when those segments are at least 2.5 % of the track. On the labeled set this classifies 18/18 (leave-one-out 94 %). Assumption: the threshold is tuned on these 18 tracks only, so the rule lives in the app (js/vocals.js) and can be retuned without separating again.
- S5. README documents how to install and run the script and what the column means.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S4 | inline | done: 7 tests GREEN, 18/18 on the labeled Demucs data | e333b85 |
| T2 | S1, S2 | inline | done: ran on a temp folder (WAV in subfolder + silent AIFF), rerun skipped both, output parsed by js/vocals.js | ed77c55 |
| T3 | S3, S5 | inline | done: suite 32 pass / 0 fail; headless Chrome dropped a WAV + keymix-voces.json: «Voz» with tooltip, «—» for unmeasured, sort works, survives reload, no console errors | this commit |

## Log

- L1 (2026-10-29, user): "sigue con la separacion" → "separar las voces del resto de la mezcla".
- L2 (2026-10-29, user): "Oblivion no tiene voz, , find yourself tampoco tiene voz. Oblivion de Nikola Jovanovic si tiene son voces muy suaves de un hombre y una mujer con ecos que aparecen en el minuto 2:30 mas o menos" → Martín Serbali - Oblivion relabeled instrumental (8 V / 10 I).
- L3 (2026-10-29, user): "Me sirve un análisis por fuera".
- L4: evidence. Demucs htdemucs on CPU runs at 0.64-1.7x realtime. Features over the corrected labels: p95 AUC 0.96 / LOO 89 %; run-filtered fraction above -10 dB AUC 1.00 / LOO 94 % (vocal 2.9-16.9 %, instrumental 0-2.2 %). YAMNet, Essentia voice_instrumental and pitch contours were rejected earlier.
