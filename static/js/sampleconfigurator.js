/**
 * Sample Configurator JavaScript
 *
 * Handles file loading (click/drag-and-drop), ADSR canvas rendering
 * and interaction, waveform display, audio playback, drum slice editing,
 * control bindings, and save/undo operations.
 */

// ============================================================
// State & Constants
// ============================================================

let currentFileId = null;
let currentMetadata = null;
let canUndo = false;
let isTemp = false;

// Sample type: 'sampler' (synth) or 'drum'
let currentSampleType = null;

// Drum state
let selectedSlice = 0;
let activeSliceCount = 24;

// Audio state
let audioCtx = null;
let audioBuffer = null;
let currentSource = null;
let isPlaying = false;
let playbackAnimId = null;
let playbackStartTime = 0;
let playbackOffset = 0;
let playbackDuration = 0;

// OP-1 position encoding: 2^31 = 12 seconds at 44100 Hz
const OP1_MAX_POS = 2147483648;

// ADSR parameter configs (indices 0-3 of metadata.adsr array)
const ADSR_PARAMS = [
    { name: 'attack',  min: 0, max: 32767, step: 256 },
    { name: 'decay',   min: 0, max: 32767, step: 256 },
    { name: 'sustain', min: 0, max: 32767, step: 256 },
    { name: 'release', min: 0, max: 32767, step: 256 },
];

// Play mode mapping (adsr index 4) — nearest-match on read, canonical on write
const PLAY_MODES = [
    { name: 'Poly',   value: 2048 },
    { name: 'Mono',   value: 5120 },
    { name: 'Legato', value: 11264 },
    { name: 'Unison', value: 14336 },
];

// Drum slice play mode and reverse mappings — nearest-match on read, canonical on write
const DRUM_PLAY_MODES = [
    { name: 'Forward',  value: 4096 },
    { name: 'One-shot', value: 8192 },
];

const DRUM_REVERSE_MODES = [
    { name: 'Forward', value: 8192 },
    { name: 'Reverse', value: 16384 },
];

// FX and LFO types — fetched from backend (devices.py)
let FX_TYPES = [];
let LFO_TYPES = [];

// Generate note frequency table (C0-B8)
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_FREQS = [];

for (let octave = 0; octave <= 8; octave++) {
    for (let note = 0; note < 12; note++) {
        const midiNote = octave * 12 + note;
        // A4 = MIDI 69 = 440 Hz
        const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
        NOTE_FREQS.push({
            name: `${NOTE_NAMES[note]}${octave}`,
            freq: Math.round(freq * 100) / 100,
            midi: midiNote
        });
    }
}

// Semitone offsets for drum pitch control (-24 to +24)
const SEMITONE_OFFSETS = [];
for (let s = -24; s <= 24; s++) {
    SEMITONE_OFFSETS.push({ label: s === 0 ? '0 (center)' : (s > 0 ? `+${s}` : `${s}`), semitones: s });
}

// Map between raw pitch values and semitones.
// Empirically, OP-1 pitch uses ~1365 units per semitone around center (0).
const PITCH_UNITS_PER_SEMITONE = 1365;

function pitchToSemitones(rawValue) {
    return Math.round(rawValue / PITCH_UNITS_PER_SEMITONE);
}

function semitonesToPitch(semitones) {
    return semitones * PITCH_UNITS_PER_SEMITONE;
}

// ============================================================
// Utility: OP-1 position <-> seconds
// ============================================================

function op1PosToSeconds(value) {
    if (!audioBuffer) return 0;
    return (value / OP1_MAX_POS) * audioBuffer.duration;
}

function secondsToOp1Pos(seconds) {
    if (!audioBuffer) return 0;
    return Math.round((seconds / audioBuffer.duration) * OP1_MAX_POS);
}

// ============================================================
// ADSR Canvas
// ============================================================

let canvas, ctx;
let draggingHandle = null;

// Handle positions (computed during draw)
let handles = [];

function drawADSRCanvas(adsr) {
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = rect.width;
    const h = rect.height;
    const pad = 20;
    const drawW = w - pad * 2;
    const drawH = h - pad * 2;

    ctx.clearRect(0, 0, w, h);

    // Normalize values to 0-1
    const maxVal = 32767;
    const a = adsr[0] / maxVal;
    const d = adsr[1] / maxVal;
    const s = adsr[2] / maxVal;
    const r = adsr[3] / maxVal;

    // Max widths for each segment (proportional allocation)
    const attackMaxW  = drawW * 0.30;
    const decayMaxW   = drawW * 0.30;
    const sustainHoldW = drawW * 0.10;
    const releaseMaxW = drawW * 0.30;

    // Fixed zone boundaries (independent of parameter values)
    const x0 = pad;
    const y0 = pad + drawH; // bottom (zero level)
    const yTop = pad;       // top (max level)

    const attackZoneEnd  = x0 + attackMaxW;
    const decayZoneEnd   = attackZoneEnd + decayMaxW;
    const sustainZoneEnd = decayZoneEnd + sustainHoldW;

    // Handle positions within their fixed zones
    const xAttack = x0 + attackMaxW * a;
    const yAttack = yTop;

    const xDecay = xAttack + decayMaxW * d;
    const yDecay = yTop + drawH * (1 - s);

    const xSustainEnd = sustainZoneEnd;
    const ySustainEnd = yDecay;

    const xRelease = sustainZoneEnd + releaseMaxW * r;
    const yRelease = y0;

    // Get CSS variable for color
    const blueColor = getComputedStyle(document.documentElement).getPropertyValue('--second-color').trim() || '#0186bb';

    // Draw filled path
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(xAttack, yAttack);
    ctx.lineTo(xDecay, yDecay);
    ctx.lineTo(xSustainEnd, ySustainEnd);
    ctx.lineTo(xRelease, yRelease);
    ctx.lineTo(x0, y0);
    ctx.closePath();
    ctx.fillStyle = blueColor + '33';
    ctx.fill();

    // Draw stroke path
    ctx.strokeStyle = blueColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(xAttack, yAttack);
    ctx.lineTo(xDecay, yDecay);
    ctx.lineTo(xSustainEnd, ySustainEnd);
    ctx.lineTo(xRelease, yRelease);
    ctx.stroke();

    // Define handles with fixed drag bounds (independent of each other)
    handles = [
        { x: xAttack, y: yAttack, param: 'attack', axis: 'x',
          xMin: x0, xMax: attackZoneEnd },
        { x: xDecay, y: yDecay, param: 'decay', axis: 'x',
          xMin: xAttack, xMax: xAttack + decayMaxW },
        { x: xSustainEnd, y: ySustainEnd, param: 'sustain', axis: 'y',
          yMin: yTop, yMax: y0 },
        { x: xRelease, y: yRelease, param: 'release', axis: 'x',
          xMin: sustainZoneEnd, xMax: sustainZoneEnd + releaseMaxW }
    ];

    // Draw handle circles
    const handleRadius = 8;
    handles.forEach(handle => {
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, handleRadius, 0, Math.PI * 2);
        ctx.fillStyle = blueColor;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
        handle.radius = handleRadius;
    });
}

function hitTestHandle(clientX, clientY) {
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    for (let i = 0; i < handles.length; i++) {
        const h = handles[i];
        const dx = mx - h.x;
        const dy = my - h.y;
        if (dx * dx + dy * dy <= (h.radius + 6) * (h.radius + 6)) {
            return i;
        }
    }
    return -1;
}

function snapToStep(value, step, min, max) {
    value = Math.round(value / step) * step;
    return Math.max(min, Math.min(max, value));
}

function handleCanvasDrag(clientX, clientY) {
    if (draggingHandle === null || !currentMetadata || !currentMetadata.adsr) return;

    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const maxVal = 32767;

    const handle = handles[draggingHandle];
    if (!handle) return;

    let newValue;

    if (handle.axis === 'x') {
        // Horizontal drag: map mouse x to 0-1 range within the segment
        const range = handle.xMax - handle.xMin;
        const ratio = range > 0 ? Math.max(0, Math.min(1, (mx - handle.xMin) / range)) : 0;
        newValue = ratio * maxVal;
    } else {
        // Vertical drag (sustain): map mouse y to value (inverted: top = max)
        const range = handle.yMax - handle.yMin;
        const ratio = 1 - Math.max(0, Math.min(1, (my - handle.yMin) / range));
        newValue = ratio * maxVal;
    }

    const paramConfig = ADSR_PARAMS[draggingHandle];
    newValue = snapToStep(newValue, paramConfig.step, paramConfig.min, paramConfig.max);

    currentMetadata.adsr[draggingHandle] = newValue;
    drawADSRCanvas(currentMetadata.adsr);
    updateADSRLabels();
}

function setupCanvasEvents() {
    canvas = document.getElementById('adsr-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    // Mouse events
    canvas.addEventListener('mousedown', (e) => {
        const idx = hitTestHandle(e.clientX, e.clientY);
        if (idx >= 0) {
            draggingHandle = idx;
            e.preventDefault();
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (draggingHandle !== null) {
            handleCanvasDrag(e.clientX, e.clientY);
            e.preventDefault();
        }
    });

    window.addEventListener('mouseup', () => {
        draggingHandle = null;
    });

    // Touch events
    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            const idx = hitTestHandle(touch.clientX, touch.clientY);
            if (idx >= 0) {
                draggingHandle = idx;
                e.preventDefault();
            }
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        if (draggingHandle !== null && e.touches.length === 1) {
            handleCanvasDrag(e.touches[0].clientX, e.touches[0].clientY);
            e.preventDefault();
        }
    }, { passive: false });

    canvas.addEventListener('touchend', () => {
        draggingHandle = null;
    });

    // Resize handler
    window.addEventListener('resize', () => {
        if (currentMetadata && currentMetadata.adsr) {
            drawADSRCanvas(currentMetadata.adsr);
        }
    });
}

function updateADSRLabels() {
    if (!currentMetadata || !currentMetadata.adsr) return;
    document.getElementById('adsr-attack-value').textContent = currentMetadata.adsr[0];
    document.getElementById('adsr-decay-value').textContent = currentMetadata.adsr[1];
    document.getElementById('adsr-sustain-value').textContent = currentMetadata.adsr[2];
    document.getElementById('adsr-release-value').textContent = currentMetadata.adsr[3];
}

// ============================================================
// Waveform Canvas
// ============================================================

let waveformCanvas, waveformCtx;
let overlayCanvas, overlayCtx;
let draggingSliceBoundary = -1; // index of the boundary being dragged (-1 = none)

function drawWaveform() {
    if (!waveformCanvas || !waveformCtx || !audioBuffer) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = waveformCanvas.getBoundingClientRect();
    waveformCanvas.width = rect.width * dpr;
    waveformCanvas.height = rect.height * dpr;
    waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = rect.width;
    const h = rect.height;

    waveformCtx.clearRect(0, 0, w, h);

    const channelData = audioBuffer.getChannelData(0);
    const samples = channelData.length;
    const samplesPerPixel = samples / w;

    const blueColor = getComputedStyle(document.documentElement).getPropertyValue('--second-color').trim() || '#0186bb';

    // Draw waveform bars
    waveformCtx.fillStyle = blueColor;
    const mid = h / 2;

    for (let x = 0; x < w; x++) {
        const start = Math.floor(x * samplesPerPixel);
        const end = Math.min(Math.floor((x + 1) * samplesPerPixel), samples);

        let min = 0, max = 0;
        for (let i = start; i < end; i++) {
            const val = channelData[i];
            if (val < min) min = val;
            if (val > max) max = val;
        }

        const yMin = mid - min * mid;
        const yMax = mid - max * mid;
        const barHeight = Math.max(1, yMin - yMax);
        waveformCtx.fillRect(x, yMax, 1, barHeight);
    }

    // Also set up overlay canvas dimensions
    if (overlayCanvas) {
        overlayCanvas.width = rect.width * dpr;
        overlayCanvas.height = rect.height * dpr;
        overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    drawWaveformOverlay();
}

function drawWaveformOverlay() {
    if (!overlayCanvas || !overlayCtx || !audioBuffer) return;

    const rect = overlayCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    overlayCtx.clearRect(0, 0, w, h);

    const isDrum = currentSampleType === 'drum';
    const duration = audioBuffer.duration;

    if (isDrum && currentMetadata && currentMetadata.start && currentMetadata.end) {
        // Highlight selected slice
        const startSec = op1PosToSeconds(currentMetadata.start[selectedSlice]);
        const endSec = op1PosToSeconds(currentMetadata.end[selectedSlice]);
        const x1 = (startSec / duration) * w;
        const x2 = (endSec / duration) * w;

        const blueColor = getComputedStyle(document.documentElement).getPropertyValue('--second-color').trim() || '#0186bb';
        overlayCtx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        overlayCtx.fillRect(x1, 0, x2 - x1, h);

        // Draw slice boundary lines
        overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        overlayCtx.lineWidth = 1;

        for (let i = 0; i < activeSliceCount; i++) {
            const sliceStart = op1PosToSeconds(currentMetadata.start[i]);
            const x = (sliceStart / duration) * w;
            if (x > 0 && x < w) {
                overlayCtx.beginPath();
                overlayCtx.moveTo(x, 0);
                overlayCtx.lineTo(x, h);
                overlayCtx.stroke();
            }
        }

        // Draw final end boundary
        const lastEnd = op1PosToSeconds(currentMetadata.end[activeSliceCount - 1]);
        const xEnd = (lastEnd / duration) * w;
        if (xEnd > 0 && xEnd < w) {
            overlayCtx.beginPath();
            overlayCtx.moveTo(xEnd, 0);
            overlayCtx.lineTo(xEnd, h);
            overlayCtx.stroke();
        }

        // Highlight selected slice boundaries more prominently
        overlayCtx.strokeStyle = blueColor;
        overlayCtx.lineWidth = 2;
        [x1, x2].forEach(x => {
            if (x > 0 && x < w) {
                overlayCtx.beginPath();
                overlayCtx.moveTo(x, 0);
                overlayCtx.lineTo(x, h);
                overlayCtx.stroke();
            }
        });
    }
}

function getSliceAtX(clientX) {
    if (!overlayCanvas || !audioBuffer || !currentMetadata || !currentMetadata.start) return -1;
    const rect = overlayCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const seconds = (x / rect.width) * audioBuffer.duration;

    for (let i = 0; i < activeSliceCount; i++) {
        const startSec = op1PosToSeconds(currentMetadata.start[i]);
        const endSec = op1PosToSeconds(currentMetadata.end[i]);
        if (seconds >= startSec && seconds < endSec) {
            return i;
        }
    }
    return -1;
}

function getSliceBoundaryAtX(clientX) {
    if (!overlayCanvas || !audioBuffer || !currentMetadata || !currentMetadata.start) return -1;
    const rect = overlayCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const duration = audioBuffer.duration;
    const hitThreshold = 6; // pixels

    // Check each boundary between slices (not the very first start or very last end)
    for (let i = 1; i < activeSliceCount; i++) {
        const bx = (op1PosToSeconds(currentMetadata.start[i]) / duration) * rect.width;
        if (Math.abs(x - bx) < hitThreshold) {
            return i; // boundary index = start of slice i = end of slice i-1
        }
    }
    return -1;
}

function setupWaveformEvents() {
    overlayCanvas = document.getElementById('waveform-overlay');
    if (!overlayCanvas) return;
    overlayCtx = overlayCanvas.getContext('2d');

    waveformCanvas = document.getElementById('waveform-canvas');
    if (!waveformCanvas) return;
    waveformCtx = waveformCanvas.getContext('2d');

    // Click on waveform to select slice (drum) or seek (synth)
    overlayCanvas.addEventListener('mousedown', (e) => {
        if (currentSampleType !== 'drum') return;

        // Check for boundary drag
        const bIdx = getSliceBoundaryAtX(e.clientX);
        if (bIdx >= 0) {
            draggingSliceBoundary = bIdx;
            overlayCanvas.style.cursor = 'col-resize';
            e.preventDefault();
            return;
        }

        // Otherwise select slice
        const idx = getSliceAtX(e.clientX);
        if (idx >= 0) {
            selectSlice(idx);
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (draggingSliceBoundary < 0) {
            // Update cursor on hover over boundaries
            if (currentSampleType === 'drum' && overlayCanvas) {
                const bIdx = getSliceBoundaryAtX(e.clientX);
                overlayCanvas.style.cursor = bIdx >= 0 ? 'col-resize' : 'default';
            }
            return;
        }

        // Drag boundary
        const rect = overlayCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const seconds = Math.max(0, Math.min(audioBuffer.duration, (x / rect.width) * audioBuffer.duration));
        const newPos = secondsToOp1Pos(seconds);

        const i = draggingSliceBoundary;

        // Constrain: must stay between prev slice start and next slice end
        const minPos = currentMetadata.start[i - 1] + 4058; // at least 1 frame
        const maxPos = currentMetadata.end[i] - 4058;

        if (newPos >= minPos && newPos <= maxPos) {
            currentMetadata.end[i - 1] = newPos;
            currentMetadata.start[i] = newPos;
            drawWaveformOverlay();
        }

        e.preventDefault();
    });

    window.addEventListener('mouseup', () => {
        if (draggingSliceBoundary >= 0) {
            draggingSliceBoundary = -1;
            if (overlayCanvas) overlayCanvas.style.cursor = 'default';
        }
    });

    // Touch events for waveform
    overlayCanvas.addEventListener('touchstart', (e) => {
        if (currentSampleType !== 'drum' || e.touches.length !== 1) return;
        const touch = e.touches[0];

        const bIdx = getSliceBoundaryAtX(touch.clientX);
        if (bIdx >= 0) {
            draggingSliceBoundary = bIdx;
            e.preventDefault();
            return;
        }

        const idx = getSliceAtX(touch.clientX);
        if (idx >= 0) {
            selectSlice(idx);
        }
    }, { passive: false });

    overlayCanvas.addEventListener('touchmove', (e) => {
        if (draggingSliceBoundary < 0 || e.touches.length !== 1) return;

        const touch = e.touches[0];
        const rect = overlayCanvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        const seconds = Math.max(0, Math.min(audioBuffer.duration, (x / rect.width) * audioBuffer.duration));
        const newPos = secondsToOp1Pos(seconds);

        const i = draggingSliceBoundary;
        const minPos = currentMetadata.start[i - 1] + 4058;
        const maxPos = currentMetadata.end[i] - 4058;

        if (newPos >= minPos && newPos <= maxPos) {
            currentMetadata.end[i - 1] = newPos;
            currentMetadata.start[i] = newPos;
            drawWaveformOverlay();
        }

        e.preventDefault();
    }, { passive: false });

    overlayCanvas.addEventListener('touchend', () => {
        draggingSliceBoundary = -1;
    });

    // Resize handler
    window.addEventListener('resize', () => {
        if (audioBuffer) {
            drawWaveform();
        }
    });
}

// ============================================================
// Audio Playback
// ============================================================

function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

async function loadAudio() {
    if (!currentFileId) return;

    try {
        const response = await fetch(`/sampleconfigurator/audio/${currentFileId}`);
        if (!response.ok) return;

        const arrayBuffer = await response.arrayBuffer();
        const ctx = getAudioContext();
        audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        drawWaveform();
    } catch (err) {
        console.error('Error loading audio:', err);
    }
}

function togglePlayback() {
    if (isPlaying) {
        stopPlayback();
        return;
    }

    if (!audioBuffer) return;

    const ctx = getAudioContext();
    currentSource = ctx.createBufferSource();
    currentSource.buffer = audioBuffer;
    currentSource.connect(ctx.destination);

    if (currentSampleType === 'drum' && currentMetadata && currentMetadata.start) {
        // Play from start of first slice to end of last active slice
        const startSec = op1PosToSeconds(currentMetadata.start[0]);
        const endSec = op1PosToSeconds(currentMetadata.end[activeSliceCount - 1]);
        playbackOffset = startSec;
        playbackDuration = endSec - startSec;
        currentSource.start(0, startSec, playbackDuration);
    } else {
        playbackOffset = 0;
        playbackDuration = audioBuffer.duration;
        currentSource.start(0);
    }

    playbackStartTime = ctx.currentTime;
    isPlaying = true;
    updatePlayButton(true);

    currentSource.onended = () => {
        if (isPlaying) {
            isPlaying = false;
            updatePlayButton(false);
            cancelAnimationFrame(playbackAnimId);
            drawWaveformOverlay();
        }
    };

    animatePlayhead();
}

function playSelectedSlice() {
    if (!audioBuffer || !currentMetadata || !currentMetadata.start) return;

    stopPlayback();

    const ctx = getAudioContext();
    currentSource = ctx.createBufferSource();
    currentSource.buffer = audioBuffer;
    currentSource.connect(ctx.destination);

    const startSec = op1PosToSeconds(currentMetadata.start[selectedSlice]);
    const endSec = op1PosToSeconds(currentMetadata.end[selectedSlice]);
    playbackOffset = startSec;
    playbackDuration = endSec - startSec;

    currentSource.start(0, startSec, playbackDuration);
    playbackStartTime = ctx.currentTime;
    isPlaying = true;
    updatePlayButton(true);

    currentSource.onended = () => {
        if (isPlaying) {
            isPlaying = false;
            updatePlayButton(false);
            cancelAnimationFrame(playbackAnimId);
            drawWaveformOverlay();
        }
    };

    animatePlayhead();
}

function stopPlayback() {
    if (currentSource) {
        try { currentSource.stop(); } catch (e) { /* already stopped */ }
        currentSource = null;
    }
    isPlaying = false;
    updatePlayButton(false);
    cancelAnimationFrame(playbackAnimId);
    drawWaveformOverlay();
}

function updatePlayButton(playing) {
    const playBtn = document.getElementById('play-btn');
    if (!playBtn) return;
    playBtn.innerHTML = playing
        ? '<i data-lucide="pause"></i> Pause'
        : '<i data-lucide="play"></i> Play';
    lucide.createIcons();
}

function animatePlayhead() {
    if (!isPlaying || !audioBuffer || !overlayCtx) return;

    drawWaveformOverlay();

    // Draw playhead line
    const ctx = getAudioContext();
    const elapsed = ctx.currentTime - playbackStartTime;
    const currentSec = playbackOffset + elapsed;
    const rect = overlayCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const x = (currentSec / audioBuffer.duration) * w;

    overlayCtx.strokeStyle = '#ff4444';
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.moveTo(x, 0);
    overlayCtx.lineTo(x, h);
    overlayCtx.stroke();

    playbackAnimId = requestAnimationFrame(animatePlayhead);
}

// ============================================================
// Drum Slice Management
// ============================================================

function detectActiveSlices() {
    if (!currentMetadata || !currentMetadata.start) {
        activeSliceCount = 0;
        return;
    }

    // Find how many slices are actually used.
    // Unused slots repeat the last active slice's start/end values.
    const starts = currentMetadata.start;
    activeSliceCount = 1;
    for (let i = 1; i < starts.length; i++) {
        if (starts[i] > starts[i - 1]) {
            activeSliceCount = i + 1;
        }
    }
}

function buildSliceGrid() {
    const grid = document.getElementById('slice-grid');
    if (!grid) return;
    grid.innerHTML = '';

    for (let i = 0; i < 24; i++) {
        const btn = document.createElement('button');
        btn.className = 'slice-btn';
        btn.textContent = i + 1;
        btn.dataset.index = i;

        if (i >= activeSliceCount) {
            btn.classList.add('inactive');
        }
        if (i === selectedSlice) {
            btn.classList.add('selected');
        }

        btn.addEventListener('click', () => {
            if (i < activeSliceCount) {
                selectSlice(i);
            }
        });

        grid.appendChild(btn);
    }
}

function selectSlice(index) {
    if (index < 0 || index >= activeSliceCount) return;
    selectedSlice = index;

    // Update grid selection
    document.querySelectorAll('.slice-btn').forEach((btn, i) => {
        btn.classList.toggle('selected', i === index);
    });

    // Update per-slice controls
    populateDrumSliceControls();

    // Update waveform overlay
    drawWaveformOverlay();
}

function populateDrumSliceControls() {
    if (!currentMetadata) return;

    const i = selectedSlice;

    // Volume
    const volumeSlider = document.getElementById('slice-volume-slider');
    const volumeLabel = document.getElementById('slice-volume-value');
    if (volumeSlider && currentMetadata.volume) {
        volumeSlider.value = currentMetadata.volume[i];
        if (volumeLabel) volumeLabel.textContent = currentMetadata.volume[i];
    }

    // Pitch — semitone picker + raw input
    const semitonePicker = document.getElementById('slice-semitone-picker');
    const pitchInput = document.getElementById('slice-pitch-input');
    if (currentMetadata.pitch) {
        const rawVal = currentMetadata.pitch[i];
        if (pitchInput) pitchInput.value = rawVal;
        if (semitonePicker) {
            const semitones = pitchToSemitones(rawVal);
            const clamped = Math.max(-24, Math.min(24, semitones));
            semitonePicker.value = clamped;
        }
    }

    // Playmode — nearest-match to button
    if (currentMetadata.playmode) {
        const val = currentMetadata.playmode[i];
        let nearest = DRUM_PLAY_MODES[0];
        let minDiff = Math.abs(val - nearest.value);
        for (const mode of DRUM_PLAY_MODES) {
            const diff = Math.abs(val - mode.value);
            if (diff < minDiff) { minDiff = diff; nearest = mode; }
        }
        document.querySelectorAll('#slice-playmode-buttons .seg-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.value) === nearest.value);
        });
    }

    // Reverse — nearest-match to button
    if (currentMetadata.reverse) {
        const val = currentMetadata.reverse[i];
        let nearest = DRUM_REVERSE_MODES[0];
        let minDiff = Math.abs(val - nearest.value);
        for (const mode of DRUM_REVERSE_MODES) {
            const diff = Math.abs(val - mode.value);
            if (diff < minDiff) { minDiff = diff; nearest = mode; }
        }
        document.querySelectorAll('#slice-reverse-buttons .seg-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.value) === nearest.value);
        });
    }
}

function setupDrumSliceControls() {
    // Volume slider
    const volumeSlider = document.getElementById('slice-volume-slider');
    const volumeLabel = document.getElementById('slice-volume-value');
    if (volumeSlider) {
        volumeSlider.addEventListener('input', () => {
            const val = parseInt(volumeSlider.value);
            if (volumeLabel) volumeLabel.textContent = val;
            if (currentMetadata && currentMetadata.volume) {
                currentMetadata.volume[selectedSlice] = val;
            }
        });
    }

    // Pitch — semitone picker + raw input (bidirectional)
    const semitonePicker = document.getElementById('slice-semitone-picker');
    const pitchInput = document.getElementById('slice-pitch-input');

    // Populate semitone dropdown
    if (semitonePicker) {
        SEMITONE_OFFSETS.forEach(s => {
            const option = document.createElement('option');
            option.value = s.semitones;
            option.textContent = s.label;
            semitonePicker.appendChild(option);
        });

        semitonePicker.addEventListener('change', () => {
            const semitones = parseInt(semitonePicker.value);
            const rawVal = semitonesToPitch(semitones);
            if (pitchInput) pitchInput.value = rawVal;
            if (currentMetadata && currentMetadata.pitch) {
                currentMetadata.pitch[selectedSlice] = rawVal;
            }
        });
    }

    if (pitchInput) {
        pitchInput.addEventListener('change', () => {
            const rawVal = parseInt(pitchInput.value);
            if (isNaN(rawVal)) return;
            const clamped = Math.max(-32768, Math.min(32767, rawVal));
            pitchInput.value = clamped;
            if (currentMetadata && currentMetadata.pitch) {
                currentMetadata.pitch[selectedSlice] = clamped;
            }
            // Update semitone picker to nearest
            if (semitonePicker) {
                const semitones = pitchToSemitones(clamped);
                const clampedSemi = Math.max(-24, Math.min(24, semitones));
                semitonePicker.value = clampedSemi;
            }
        });
    }

    // Playmode buttons
    const playmodeContainer = document.getElementById('slice-playmode-buttons');
    if (playmodeContainer) {
        playmodeContainer.querySelectorAll('.seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                playmodeContainer.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (currentMetadata && currentMetadata.playmode) {
                    currentMetadata.playmode[selectedSlice] = parseInt(btn.dataset.value);
                }
            });
        });
    }

    // Reverse buttons
    const reverseContainer = document.getElementById('slice-reverse-buttons');
    if (reverseContainer) {
        reverseContainer.querySelectorAll('.seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                reverseContainer.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (currentMetadata && currentMetadata.reverse) {
                    currentMetadata.reverse[selectedSlice] = parseInt(btn.dataset.value);
                }
            });
        });
    }
}

// ============================================================
// Controls
// ============================================================

function setupOctaveButtons() {
    const container = document.getElementById('octave-buttons');
    if (!container) return;

    container.querySelectorAll('.seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (currentMetadata) {
                currentMetadata.octave = parseInt(btn.dataset.value);
            }
        });
    });
}

function setupPlayModeButtons() {
    const container = document.getElementById('playmode-buttons');
    if (!container) return;

    container.querySelectorAll('.seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (currentMetadata && currentMetadata.adsr && currentMetadata.adsr.length >= 5) {
                currentMetadata.adsr[4] = parseInt(btn.dataset.value);
            }
        });
    });
}

function setupPortamentoSlider() {
    const slider = document.getElementById('portamento-slider');
    const valueLabel = document.getElementById('portamento-value');
    if (!slider || !valueLabel) return;

    slider.addEventListener('input', () => {
        const val = parseInt(slider.value);
        valueLabel.textContent = val <= 64 ? 'Off' : val;
        if (currentMetadata && currentMetadata.adsr) {
            currentMetadata.adsr[5] = val;
        }
    });
}

function populateDropdown(selectId, types) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.innerHTML = '';
    types.forEach(t => {
        const option = document.createElement('option');
        option.value = t.value;
        option.textContent = t.name;
        select.appendChild(option);
    });
}

async function fetchTypes() {
    try {
        const response = await fetch('/sampleconfigurator/types');
        const data = await response.json();
        // Use OP-1 types (OP-Z ignores FX/LFO metadata)
        FX_TYPES = data.op1.fx_types;
        LFO_TYPES = data.op1.lfo_types;
        populateDropdown('fx-type-select', FX_TYPES);
        populateDropdown('lfo-type-select', LFO_TYPES);
    } catch (err) {
        console.error('Error fetching types:', err);
    }
}

function setupFxControls() {
    const select = document.getElementById('fx-type-select');
    if (select) {
        select.addEventListener('change', () => {
            if (currentMetadata) {
                currentMetadata.fx_type = select.value;
            }
        });
    }

    const container = document.getElementById('fx-active-buttons');
    if (container) {
        container.querySelectorAll('.seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (currentMetadata) {
                    currentMetadata.fx_active = btn.dataset.value === 'true';
                }
            });
        });
    }
}

function setupLfoControls() {
    const select = document.getElementById('lfo-type-select');
    if (select) {
        select.addEventListener('change', () => {
            if (currentMetadata) {
                currentMetadata.lfo_type = select.value;
            }
        });
    }

    const container = document.getElementById('lfo-active-buttons');
    if (container) {
        container.querySelectorAll('.seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (currentMetadata) {
                    currentMetadata.lfo_active = btn.dataset.value === 'true';
                }
            });
        });
    }
}

function setupFrequencyControls() {
    const notePicker = document.getElementById('note-picker');
    const freqInput = document.getElementById('freq-input');
    if (!notePicker || !freqInput) return;

    // Populate note picker
    NOTE_FREQS.forEach(note => {
        const option = document.createElement('option');
        option.value = note.freq;
        option.textContent = `${note.name} (${note.freq} Hz)`;
        notePicker.appendChild(option);
    });

    // Note picker change -> update Hz input and metadata
    notePicker.addEventListener('change', () => {
        const freq = parseFloat(notePicker.value);
        freqInput.value = freq;
        if (currentMetadata) {
            currentMetadata.base_freq = freq;
        }
    });

    // Hz input change -> find nearest note, update picker and metadata
    freqInput.addEventListener('change', () => {
        const freq = parseFloat(freqInput.value);
        if (isNaN(freq) || freq <= 0) return;

        if (currentMetadata) {
            currentMetadata.base_freq = freq;
        }

        // Find nearest note
        let nearest = NOTE_FREQS[0];
        let minDiff = Math.abs(freq - nearest.freq);
        for (const note of NOTE_FREQS) {
            const diff = Math.abs(freq - note.freq);
            if (diff < minDiff) {
                minDiff = diff;
                nearest = note;
            }
        }
        notePicker.value = nearest.freq;
    });
}

// ============================================================
// Populate Controls from Metadata
// ============================================================

function populateControls(metadata) {
    if (!metadata) return;

    if (currentSampleType === 'drum') {
        populateDrumControls(metadata);
    } else {
        populateSynthControls(metadata);
    }

    // Shared controls
    populateSharedControls(metadata);
}

function populateSynthControls(metadata) {
    // ADSR
    if (metadata.adsr && metadata.adsr.length >= 4) {
        drawADSRCanvas(metadata.adsr);
        updateADSRLabels();

        // Play mode (adsr index 4) — nearest-match to canonical values
        if (metadata.adsr.length >= 5) {
            const playVal = metadata.adsr[4];
            let nearestMode = PLAY_MODES[0];
            let minDiff = Math.abs(playVal - nearestMode.value);
            for (const mode of PLAY_MODES) {
                const diff = Math.abs(playVal - mode.value);
                if (diff < minDiff) {
                    minDiff = diff;
                    nearestMode = mode;
                }
            }
            document.querySelectorAll('#playmode-buttons .seg-btn').forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.value) === nearestMode.value);
            });
        }

        // Portamento (adsr index 5)
        if (metadata.adsr.length >= 6) {
            const portVal = metadata.adsr[5];
            const slider = document.getElementById('portamento-slider');
            const portLabel = document.getElementById('portamento-value');
            if (slider) slider.value = portVal;
            if (portLabel) portLabel.textContent = portVal <= 64 ? 'Off' : portVal;
        }
    }

    // Base frequency
    if (metadata.base_freq !== undefined) {
        const freqInput = document.getElementById('freq-input');
        const notePicker = document.getElementById('note-picker');
        if (freqInput) freqInput.value = metadata.base_freq;

        // Find nearest note
        if (notePicker) {
            let nearest = NOTE_FREQS[0];
            let minDiff = Math.abs(metadata.base_freq - nearest.freq);
            for (const note of NOTE_FREQS) {
                const diff = Math.abs(metadata.base_freq - note.freq);
                if (diff < minDiff) {
                    minDiff = diff;
                    nearest = note;
                }
            }
            notePicker.value = nearest.freq;
        }
    }
}

function populateDrumControls(metadata) {
    detectActiveSlices();
    selectedSlice = 0;
    buildSliceGrid();
    populateDrumSliceControls();
}

function populateSharedControls(metadata) {
    // Octave
    if (metadata.octave !== undefined) {
        document.querySelectorAll('#octave-buttons .seg-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.value) === metadata.octave);
        });
    }

    // FX
    const fxSelect = document.getElementById('fx-type-select');
    if (fxSelect && metadata.fx_type !== undefined) {
        fxSelect.value = metadata.fx_type;
    }
    document.querySelectorAll('#fx-active-buttons .seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === String(metadata.fx_active));
    });

    // LFO
    const lfoSelect = document.getElementById('lfo-type-select');
    if (lfoSelect && metadata.lfo_type !== undefined) {
        lfoSelect.value = metadata.lfo_type;
    }
    document.querySelectorAll('#lfo-active-buttons .seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === String(metadata.lfo_active));
    });
}

// ============================================================
// Show/Hide Drum vs Synth Sections
// ============================================================

function updateEditorVisibility() {
    const isDrum = currentSampleType === 'drum';

    // Synth-only elements
    document.querySelectorAll('.synth-only').forEach(el => {
        el.hidden = isDrum;
    });

    // Drum-only elements
    document.querySelectorAll('.drum-only').forEach(el => {
        el.hidden = !isDrum;
    });

    // Update badge
    const badge = document.getElementById('sample-type-badge');
    if (badge) {
        badge.textContent = isDrum ? 'DRUM' : 'SYNTH';
        badge.className = 'sample-type-badge ' + (isDrum ? 'badge-drum' : 'badge-synth');
    }
}

// ============================================================
// File Loading
// ============================================================

function showEditor(filename) {
    document.getElementById('drop-zone-container').hidden = true;
    document.getElementById('editor-container').hidden = false;
    document.getElementById('loaded-filename').textContent = filename;
    lucide.createIcons();
}

function showDropZone() {
    document.getElementById('drop-zone-container').hidden = false;
    document.getElementById('editor-container').hidden = true;
    currentFileId = null;
    currentMetadata = null;
    currentSampleType = null;
    canUndo = false;
    isTemp = false;
    audioBuffer = null;
    stopPlayback();
    document.getElementById('undo-btn').disabled = true;
}

function loadDifferentFile() {
    showDropZone();
}

function handleFileLoaded(data) {
    currentFileId = data.file_id;
    currentMetadata = data.metadata;
    isTemp = data.is_temp || false;
    canUndo = false;
    document.getElementById('undo-btn').disabled = true;

    // Determine sample type
    currentSampleType = currentMetadata.type === 'drum' ? 'drum' : 'sampler';

    showEditor(data.filename);
    updateEditorVisibility();
    populateControls(currentMetadata);

    // Load audio for waveform and playback
    loadAudio();
}

async function loadFileFromPath(path) {
    try {
        const response = await fetch('/sampleconfigurator/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path })
        });

        const data = await response.json();

        if (!response.ok) {
            toast.error(data.error || 'Failed to load file');
            return;
        }

        handleFileLoaded(data);
    } catch (err) {
        console.error('Error loading file:', err);
        toast.error('Failed to load file');
    }
}

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/sampleconfigurator/upload', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            toast.error(data.error || 'Failed to load file');
            return;
        }

        handleFileLoaded(data);
    } catch (err) {
        console.error('Error uploading file:', err);
        toast.error('Failed to upload file');
    }
}

function setupDropZone() {
    const dropZone = document.getElementById('configurator-drop-zone');
    if (!dropZone) return;

    let dragCounter = 0;

    // Click to browse via native file dialog
    dropZone.addEventListener('click', async () => {
        try {
            const response = await fetch('/get-user-file-path');
            const data = await response.json();
            if (data.path) {
                await loadFileFromPath(data.path);
            }
        } catch (err) {
            console.error('Error opening file dialog:', err);
        }
    });

    // Drag and drop
    dropZone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter === 0) {
            dropZone.classList.remove('dragover');
        }
    });

    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        dropZone.classList.remove('dragover');

        const files = e.dataTransfer.files;
        if (files.length === 0) return;

        const file = files[0]; // Only first file
        const ext = file.name.toLowerCase().split('.').pop();
        if (ext !== 'aif' && ext !== 'aiff') {
            toast.error('Please drop an AIFF file (.aif or .aiff)');
            return;
        }

        await uploadFile(file);
    });
}

// Prevent default drag behavior on window (avoid browser opening dropped files)
function preventWindowDrag() {
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
        // Only prevent if not on the drop zone
        const dropZone = document.getElementById('configurator-drop-zone');
        if (dropZone && !dropZone.contains(e.target)) {
            e.preventDefault();
        }
    });
}

// ============================================================
// Save / Undo
// ============================================================

async function saveMetadata() {
    if (!currentFileId || !currentMetadata) {
        toast.error('No file loaded');
        return;
    }

    const saveBtn = document.getElementById('save-btn');

    // If file was uploaded (temp), get a save location first
    let savePath = null;
    if (isTemp) {
        try {
            const dialogResponse = await fetch('/get-save-location-path');
            const dialogData = await dialogResponse.json();
            if (!dialogData.path) {
                return; // User cancelled
            }
            savePath = dialogData.path;
        } catch (err) {
            toast.error('Failed to open save dialog');
            return;
        }
    }

    const payload = {
        file_id: currentFileId,
        metadata: currentMetadata
    };
    if (savePath) {
        payload.save_path = savePath;
    }

    try {
        await withButtonLoading(saveBtn, 'Saving...', async () => {
            const response = await fetch('/sampleconfigurator/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (!response.ok) {
                toast.error(data.error || 'Save failed');
                return;
            }

            canUndo = data.can_undo;
            isTemp = false; // After save, file is no longer temp
            document.getElementById('undo-btn').disabled = !canUndo;
            toast.success('Metadata saved successfully');
        });
    } catch (err) {
        console.error('Error saving:', err);
        toast.error('Save failed');
    }
}

async function undoSave() {
    if (!currentFileId || !canUndo) return;

    const undoBtn = document.getElementById('undo-btn');

    try {
        await withButtonLoading(undoBtn, 'Undoing...', async () => {
            const response = await fetch('/sampleconfigurator/undo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: currentFileId })
            });

            const data = await response.json();

            if (!response.ok) {
                toast.error(data.error || 'Undo failed');
                return;
            }

            currentMetadata = data.metadata;
            canUndo = data.can_undo;
            document.getElementById('undo-btn').disabled = !canUndo;
            populateControls(currentMetadata);
            toast.success('Changes reverted');
        });
    } catch (err) {
        console.error('Error undoing:', err);
        toast.error('Undo failed');
    }
}

// ============================================================
// Init
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    setupCanvasEvents();
    setupWaveformEvents();
    setupDropZone();
    setupPlayModeButtons();
    setupOctaveButtons();
    setupPortamentoSlider();
    setupFrequencyControls();
    setupFxControls();
    setupLfoControls();
    setupDrumSliceControls();
    fetchTypes();
    preventWindowDrag();
    lucide.createIcons();
});
