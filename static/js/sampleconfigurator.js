/**
 * Sample Configurator JavaScript
 *
 * Handles file loading (click/drag-and-drop), ADSR canvas rendering
 * and interaction, control bindings, and save/undo operations.
 */

// ============================================================
// State & Constants
// ============================================================

let currentFileId = null;
let currentMetadata = null;
let canUndo = false;
let isTemp = false;

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

    const xDecay = attackZoneEnd + decayMaxW * d;
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
          xMin: attackZoneEnd, xMax: decayZoneEnd },
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

function capitalizeFirst(str) {
    if (!str) return '--';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function populateControls(metadata) {
    if (!metadata) return;

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

    // Octave
    if (metadata.octave !== undefined) {
        document.querySelectorAll('#octave-buttons .seg-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.value) === metadata.octave);
        });
    }

    // FX (read-only) — fx_type is a string like "delay"
    const fxType = document.getElementById('fx-type');
    const fxActive = document.getElementById('fx-active');
    if (fxType) {
        fxType.textContent = capitalizeFirst(metadata.fx_type);
    }
    if (fxActive) {
        fxActive.textContent = metadata.fx_active ? 'On' : 'Off';
    }

    // LFO (read-only) — lfo_type is a string like "random"
    const lfoType = document.getElementById('lfo-type');
    const lfoActive = document.getElementById('lfo-active');
    if (lfoType) {
        lfoType.textContent = capitalizeFirst(metadata.lfo_type);
    }
    if (lfoActive) {
        lfoActive.textContent = metadata.lfo_active ? 'On' : 'Off';
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
    canUndo = false;
    isTemp = false;
    document.getElementById('undo-btn').disabled = true;
}

function loadDifferentFile() {
    showDropZone();
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

        currentFileId = data.file_id;
        currentMetadata = data.metadata;
        isTemp = false;
        canUndo = false;
        document.getElementById('undo-btn').disabled = true;

        showEditor(data.filename);
        populateControls(currentMetadata);
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

        currentFileId = data.file_id;
        currentMetadata = data.metadata;
        isTemp = data.is_temp || false;
        canUndo = false;
        document.getElementById('undo-btn').disabled = true;

        showEditor(data.filename);
        populateControls(currentMetadata);
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
    setupDropZone();
    setupPlayModeButtons();
    setupOctaveButtons();
    setupPortamentoSlider();
    setupFrequencyControls();
    preventWindowDrag();
    lucide.createIcons();
});
