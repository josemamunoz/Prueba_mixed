# Vocal detection (offline separation)

Objective: tell vocal from instrumental tracks by separating vocals offline with Demucs and showing the result in the app.
Branch: feat/vocal-detection · Delivery: ask-on-risk · Tests: `npm test` (node --test), Python script checked by running it on real files.

## Specs

- S1. "separar las voces del resto de la mezcla": an offline script runs Demucs (htdemucs) over a music folder and measures, per 3 s segment, the vocal-stem to mix energy ratio in dB.
- S2. "Me sirve un análisis por fuera": the analysis runs outside the browser, on the user's PC, once per library; it writes `keymix-voces.json` in the analyzed folder and skips tracks already in that file (same name and size), so it can be stopped and resumed.
- S3. The app reads `keymix-voces.json` when it reads a folder (Abrir carpeta, remembered folders) or when the file is added or dropped, matches tracks by file name and size, stores the measurements with the library and shows a «Voz» column (sortable) with the result.
- S4. Decision rule, from the 18 user-labeled tracks: a 3 s segment counts as vocal when it is above -10 dB and an adjacent segment is too (isolated segments are ignored); a track is vocal when those segments are at least 2.5 % of the track. On the labeled set this classifies 18/18 (leave-one-out 94 %). Assumption: the threshold is tuned on these 18 tracks only, so the rule lives in the app (js/vocals.js) and can be retuned without separating again.
- S5. README documents how to install and run the script and what the column means.
- S6. Review follow-up 2: a `keymix-voces.json` that cannot be read shows an error in every path, including the relink of remembered folders.
- S7. Review follow-up 3: the script reports the tracks that failed at the end and exits with a non-zero code when any failed.
- S8. Review follow-up 4: a test covers loading the measurements into library tracks (match by name and size, only changed tracks count).

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S4 | inline | done: 7 tests GREEN, 18/18 on the labeled Demucs data | e333b85 |
| T2 | S1, S2 | inline | done: ran on a temp folder (WAV in subfolder + silent AIFF), rerun skipped both, output parsed by js/vocals.js | ed77c55 |
| T3 | S3, S5 | inline | done: suite 32 pass / 0 fail; headless Chrome dropped a WAV + keymix-voces.json: «Voz» with tooltip, «—» for unmeasured, sort works, survives reload, no console errors | 3efc5ab |
| T4 | S6 | inline | done: corrupt keymix-voces.json dropped in headless Chrome shows the error toast and a console warning; the relink path now goes through the same code (no quiet mode); happy path rechecked | 966b5c3 |
| T5 | S7 | inline | done: temp folder with a good and a broken WAV: failures listed, exit 1, rerun retries only the broken one; a corrupt keymix-voces.json exits with a clear message | 966b5c3 |
| T6 | S8 | inline | done: applyVocals extracted to js/vocals.js, test RED then GREEN; suite 33 pass / 0 fail / 11 skipped (already skipped before) | 966b5c3 |

## Log

- L1 (2026-10-29, user): "sigue con la separacion" → "separar las voces del resto de la mezcla".
- L2 (2026-10-29, user): "Oblivion no tiene voz, , find yourself tampoco tiene voz. Oblivion de Nikola Jovanovic si tiene son voces muy suaves de un hombre y una mujer con ecos que aparecen en el minuto 2:30 mas o menos" → Martín Serbali - Oblivion relabeled instrumental (8 V / 10 I).
- L3 (2026-10-29, user): "Me sirve un análisis por fuera".
- L4: evidence. Demucs htdemucs on CPU runs at 0.64-1.7x realtime. Features over the corrected labels: p95 AUC 0.96 / LOO 89 %; run-filtered fraction above -10 dB AUC 1.00 / LOO 94 % (vocal 2.9-16.9 %, instrumental 0-2.2 %). YAMNet, Essentia voice_instrumental and pitch contours were rejected earlier.
- L5 (2026-10-29): native review granted by the user; lenses resilience, readability, reliability; approved and acknowledged (lineage review-021467e0cf6caaae, authority burned). Non-blocking follow-ups: scripts/vocals.py skips .m4a/.aac that the app accepts; a rejected keymix-voces.json is silent when remembered folders relink; the script exits 0 and prints «Listo» even when tracks failed; no integration test for applyVocalFiles.
- L6 (2026-10-29, user): "Arregla el 2, 3 y 4. El 1 no lo necesitaré porque solo tengo archivos wav y aiff"
- L7 (2026-10-29): second native review (3efc5ab..966b5c3) granted by the user; lenses resilience, reliability; approved and acknowledged (lineage review-37886550149e59f9). Non-blocking suggestions: no automated test for the script exit code and failure summary, nor for the app error toast (both checked by hand).
