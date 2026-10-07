# KeyMix Pro

Clon web de **Mixed In Key Pro** para DJs. Analiza tu música directamente en el navegador (los archivos nunca salen de tu equipo) y detecta:

- **Tonalidad**, en notación Camelot (8A), Open Key (1m) o musical (Am), con nivel de confianza, afinación y cromagrama.
- **BPM** con precisión de décimas: reconoce tempos no enteros y corrige errores de octava (174 frente a 87).
- **Nivel de energía 1–10**, calculado a partir del volumen, la densidad de ataques, el brillo, el tempo y el tiempo que la pista pasa a plena intensidad.
- **Hasta 8 cue points automáticos** (Intro, Drop, Break, Subida, Outro), alineados al compás según la rejilla de beats.

Además incluye:

- **Rueda Camelot** interactiva: resalta las claves compatibles con la pista seleccionada y permite filtrar por tonalidad.
- **Mezcla armónica**: filtro «Solo compatibles» (tonalidad + BPM ±6 %, incluida la mezcla a doble o mitad de tempo) y sugerencias de «qué pinchar después».
- **Constructor de sets**: ordena las pistas para minimizar choques armónicos, saltos de tempo y caídas de energía; muestra la curva de energía y cada transición (misma tonalidad, ±1, relativa, energy boost, diagonal…). Exporta a M3U o CSV.
- **Escritura de etiquetas ID3 en MP3**: comentario «8A - Energy 7», campos TKEY y TBPM, y opcionalmente un prefijo en el nombre del archivo. En Chrome y Edge, «Abrir carpeta» permite guardar las etiquetas directamente en los archivos originales; en otros navegadores se descarga una copia etiquetada.
- **Reproductor** con forma de onda coloreada por frecuencias, marcas de frase, cabezal y botones de cue 1–8.
- **Biblioteca persistente**: los análisis se guardan en el navegador. Si vuelves a añadir un archivo ya analizado, se reutiliza el resultado al instante.
- Exportación de la biblioteca a CSV o JSON.

## Uso

Los módulos ES y los Web Workers necesitan servirse por HTTP (no funcionan con `file://`):

```bash
npm start            # equivale a: python3 scripts/serve.py 8080
# abre http://localhost:8080
```

Arrastra archivos o carpetas a la ventana, o usa «Añadir pistas». Acepta MP3, WAV, FLAC, AAC/M4A y OGG (según lo que soporte el navegador) y AIFF/AIFF-C en cualquier navegador: la app los decodifica por su cuenta (PCM de 8 a 32 bits y coma flotante) y lee el título y el artista de su etiqueta ID3.

### Atajos de teclado

| Tecla | Acción |
| --- | --- |
| Espacio | Reproducir / pausa la pista seleccionada |
| 1–8 | Saltar al cue point |
| ↑ / ↓ | Cambiar de pista |
| Intro | Reproducir desde el inicio |
| `/` | Buscar |
| C | Activar o desactivar «Solo compatibles» |
| A | Añadir archivos |

## Cómo funciona

Todo el análisis es JavaScript sin dependencias (`js/dsp.js`) y se ejecuta en Web Workers:

1. **Decodificación**: `OfflineAudioContext` a 22 050 Hz, mezclado a mono.
2. **Tempo**: flujo espectral → autocorrelación con refuerzo de armónicos → comprobación de doble tempo → afinado con un filtro peine sobre toda la pista (pasos de 0,02 BPM). La fase se ajusta con el flujo de graves (el bombo).
3. **Tonalidad**: FFT de 16 384 puntos, detección de picos espectrales con interpolación, estimación de la afinación global, cromagrama con refuerzo de la línea de bajo y correlación con los perfiles de Krumhansl-Kessler y Temperley.
4. **Rejilla y cues**: volumen y graves por beat, primer tiempo del compás elegido por la nitidez de los cambios entre compases y detección de novedad (±8 compases) con preferencia por los límites de frase.
5. **Energía**: combinación ponderada de brillo (30 %), volumen activo (20 %), tempo dentro del rango de baile (20 %), densidad de ataques (15 %) y proporción de secciones intensas (15 %), con una curva que reserva los niveles altos. Calibrada con una referencia real de deep house; el panel de detalle muestra el desglose de cada pista.

> Los algoritmos de Mixed In Key son propietarios. Este proyecto usa técnicas públicas de MIR, así que los resultados (sobre todo el nivel de energía, que es heurístico) pueden diferir en algunas pistas.

## Desarrollo

```bash
npm test                                 # tests (Node ≥ 18; los de ID3 usan ffmpeg si está instalado)
node scripts/analyze.mjs pista.wav ...   # analizar WAV desde la terminal
```

Estructura:

```
index.html          interfaz
css/styles.css      estilos (tema oscuro, adaptable a móvil)
js/app.js           UI: biblioteca, rueda, detalle, reproductor, sets, exportación
js/dsp.js           motor de análisis (FFT, tempo, tonalidad, energía, cues, forma de onda)
js/worker.js        Web Worker de análisis
js/camelot.js       notaciones y reglas de mezcla armónica
js/setbuilder.js    ordenación de sets
js/id3.js           lectura y escritura de ID3v2.3/2.4
js/aiff.js          decodificador AIFF/AIFF-C y codificador WAV
scripts/            CLI de análisis para WAV
tests/              tests con audio sintético
```
