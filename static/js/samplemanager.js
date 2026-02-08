// Settings management
async function loadSettings() {
    const settings = {
        autoPitch: true // default
    };

    try {
        const res = await fetch('/get-config-setting?config_option=AUTO_PITCH_SYNTH_SAMPLES');
        const data = await res.json();
        if (data.config_value !== undefined && data.config_value !== null && data.config_value !== '') {
            settings.autoPitch = data.config_value;
        }
    } catch (e) {
        console.warn('Failed to load settings:', e);
    }

    return settings;
}

async function saveSettings(settings) {
    try {
        await fetch('/set-config-setting', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                config_option: 'AUTO_PITCH_SYNTH_SAMPLES',
                config_value: settings.autoPitch
            })
        });
    } catch (e) {
        console.warn('Failed to save settings:', e);
    }
}

async function openSettingsModal() {
    const settings = await loadSettings();
    document.getElementById('setting-auto-pitch').checked = settings.autoPitch;

    const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
    modal.show();
}

// Current device selection
let currentDevice = 'opz';

// OP-Z specific variables
let opzStorageUsed = 0;
let OPZ_TOTAL_STORAGE = 24000; // 24 MB total storage in KB
let opzNumSamples = 0;

// OP-1 specific variables
let op1Data = null;
const OP1_TOTAL_STORAGE = 512000; // 512 MB in KB
const OP1_DRUM_LIMIT = 42;
const OP1_SYNTH_LIMIT = 42;
const OP1_PATCH_LIMIT = 100;

// Audio preview
let audioPlayer = null;
let currentlyPlayingPath = null;
let currentlyPlayingElement = null;

// ============================================
// Loading State Management
// ============================================

function showLoading(device) {
    const overlay = document.getElementById(`${device}-loading-overlay`);
    if (overlay) {
        overlay.hidden = false;
    }
}

function hideLoading(device) {
    const overlay = document.getElementById(`${device}-loading-overlay`);
    if (overlay) {
        overlay.hidden = true;
    }
}

// ============================================
// Audio Preview Functions
// ============================================

function initAudioPlayer() {
    if (!audioPlayer) {
        audioPlayer = new Audio();
        audioPlayer.addEventListener('ended', () => {
            clearPlayingState();
        });
        audioPlayer.addEventListener('error', (e) => {
            console.error('Audio playback error:', e);
            clearPlayingState();
            toast.error('Could not play sample');
        });
    }
}

function clearPlayingState() {
    if (currentlyPlayingElement) {
        currentlyPlayingElement.classList.remove('playing');
    }
    currentlyPlayingPath = null;
    currentlyPlayingElement = null;
}

function stopPlayback() {
    if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
    }
    clearPlayingState();
}

function playSample(path, element) {
    initAudioPlayer();

    // If clicking the same sample that's playing, stop it
    if (currentlyPlayingPath === path) {
        stopPlayback();
        return;
    }

    // Stop any current playback
    stopPlayback();

    // Always mark as selected/playing, even if preview fails
    currentlyPlayingPath = path;
    currentlyPlayingElement = element;
    element.classList.add('playing');

    // Try to preview, but don't fail if it doesn't work (e.g., tilde samples)
    audioPlayer.src = `/preview-sample?path=${encodeURIComponent(path)}`;
    audioPlayer.play().catch(err => {
        console.warn('Preview not available for this sample:', err);
        // Keep selection but don't show error for tilde samples
        // (they're symbolic links and can't be previewed)
    });
}

// ============================================
// Device Tab Management
// ============================================

async function initDeviceTabs() {
    // Load saved device from config
    try {
        const res = await fetch('/get-config-setting?config_option=SELECTED_DEVICE');
        const data = await res.json();
        if (data.config_value && (data.config_value === 'opz' || data.config_value === 'op1')) {
            currentDevice = data.config_value;
        }
    } catch (err) {
        console.error('Failed to load device setting:', err);
    }

    // Set up tab click handlers
    document.querySelectorAll('.device-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const device = tab.dataset.device;
            switchDevice(device);
        });
    });

    // Initialize the correct device view
    switchDevice(currentDevice);
}

function switchDevice(device) {
    currentDevice = device;

    // Hide any validation error from previous device
    const errorContainer = document.getElementById("validation-error-container");
    if (errorContainer) {
        errorContainer.hidden = true;
    }

    // Stop any playing audio
    stopPlayback();

    // Update tab active states
    document.querySelectorAll('.device-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.device === device);
    });

    // Toggle container visibility
    const opzContainer = document.getElementById('opz-container');
    const op1Container = document.getElementById('op1-container');

    if (device === 'opz') {
        opzContainer.hidden = false;
        op1Container.hidden = true;
        fetchOpzSamples();  // Fire and forget - don't block UI
    } else {
        opzContainer.hidden = true;
        op1Container.hidden = false;
        fetchOp1Samples();  // Fire and forget - don't block UI
    }

    // Save device selection to config (fire and forget)
    fetch('/set-config-setting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_option: 'SELECTED_DEVICE', config_value: device })
    }).catch(err => console.error('Failed to save device setting:', err));
}

async function openDirectory() {
    try {
        const response = await fetch(`/open-device-directory?device=${currentDevice}`);
        if (!response.ok) {
            throw new Error("Failed to open directory");
        }
    } catch (error) {
        console.error(`Failed to open ${currentDevice.toUpperCase()} directory:`, error);
        toast.error(`Could not open ${currentDevice === 'opz' ? 'OP-Z' : 'OP-1'} directory.`);
    }
}

async function refreshSamples() {
    if (currentDevice === 'opz') {
        await fetchOpzSamples();
    } else {
        await fetchOp1Samples();
    }
}

// ============================================
// Shared Functions
// ============================================

/**
 * Update storage display for a device
 * @param {string} device - "opz" or "op1"
 * @param {object} storage - Storage object with 'used' and 'total' in KB
 * @param {object} extraData - Optional extra data (counts for OP-1, numSamples for OP-Z)
 */
function updateStorageDisplay(device, storage, extraData = {}) {
    const prefix = device === 'op1' ? 'op1' : 'opz';
    const used = storage.used;
    const total = storage.total;

    const percent = ((used / total) * 100).toFixed(1);
    const percentNum = parseFloat(percent);

    const storageUsedElem = document.getElementById(`${prefix}-storage-used`);
    if (storageUsedElem) {
        storageUsedElem.textContent = `${(used / 1024).toFixed(1)} MB`;  // KB to MB
    }

    const storageFreeElem = document.getElementById(`${prefix}-storage-free`);
    const freeSpace = total - used;
    if (storageFreeElem) {
        storageFreeElem.textContent = `${(freeSpace / 1024).toFixed(1)} MB`;  // KB to MB
    }

    // Device-specific count displays
    if (device === 'op1' && extraData.counts) {
        const counts = extraData.counts;
        const drumSamplesElem = document.getElementById("op1-drum-samples");
        if (drumSamplesElem) {
            drumSamplesElem.textContent = `${counts.drum_samples} / ${OP1_DRUM_LIMIT}`;
        }

        const synthSamplesElem = document.getElementById("op1-synth-samples");
        if (synthSamplesElem) {
            synthSamplesElem.textContent = `${counts.synth_samples} / ${OP1_SYNTH_LIMIT}`;
        }

        const patchesElem = document.getElementById("op1-patches");
        if (patchesElem) {
            patchesElem.textContent = `${counts.patches} / ${OP1_PATCH_LIMIT}`;
        }
    } else if (device === 'opz' && extraData.numSamples !== undefined) {
        const samplesUsedElem = document.getElementById("opz-samples-used");
        if (samplesUsedElem) {
            samplesUsedElem.textContent = `${extraData.numSamples}`;
        }
    }

    let colorClass = 'storage-low';
    if (percentNum >= 85) {
        colorClass = 'storage-high';
    } else if (percentNum >= 60) {
        colorClass = 'storage-medium';
    }

    const storageBarFill = document.getElementById(`${prefix}-storage-bar-fill`);
    const storageBarLabel = document.getElementById(`${prefix}-storage-bar-label`);
    if (storageBarFill) {
        storageBarFill.style.width = `${percent}%`;
        storageBarFill.classList.remove('storage-low', 'storage-medium', 'storage-high');
        storageBarFill.classList.add(colorClass);
    }
    if (storageBarLabel) {
        storageBarLabel.textContent = `Storage: ${percent}%`;
    }

    if (storageFreeElem) {
        storageFreeElem.classList.remove('storage-low', 'storage-medium', 'storage-high');
        storageFreeElem.classList.add(colorClass);
    }
}

/**
 * Delete a sample from any device
 * @param {string} device - "opz" or "op1"
 * @param {string} path - Full path to the sample
 * @param {function} refreshCallback - Function to call after successful deletion
 */
function deleteSample(device, path, refreshCallback) {
    const filename = path.split('/').pop();

    showConfirmModal(
        'Delete Sample',
        `Delete "<strong>${escapeHtml(filename)}</strong>"?`,
        async () => {
            try {
                const response = await fetch('/delete-sample', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path, device: device })
                });

                if (!response.ok) {
                    const data = await response.json();
                    throw new Error(data.error || 'Failed to delete file');
                }

                if (refreshCallback) {
                    await refreshCallback();
                }
            } catch (err) {
                console.error('Failed to delete sample:', err);
                toast.error(err.message, 'Delete Failed');
            }
        }
    );
}

// ============================================
// OP-Z Functions
// ============================================

async function fetchOpzSamples() {
    showLoading('opz');
    try {
        const response = await fetch("/read-samples");
        if (!response.ok) {
            throw new Error("Network response was not ok: " + response.statusText);
        }
        const data = await response.json();

        const errorContainer = document.getElementById("validation-error-container");
        const errorMessage = document.getElementById("validation-error-message");
        const storageInfo = document.getElementById("opz-storage-info");
        const fileList = document.getElementById("opz-file-list");

        if (data.validation_error) {
            errorMessage.innerHTML = data.validation_error;
            errorContainer.hidden = false;
            if (storageInfo) storageInfo.hidden = true;
            if (fileList) fileList.hidden = true;
            return;
        }

        errorContainer.hidden = true;
        if (storageInfo) storageInfo.hidden = false;
        if (fileList) fileList.hidden = false;

        // Use storage from backend (includes all files under device dir)
        if (data.storage) {
            opzStorageUsed = data.storage.used;
            OPZ_TOTAL_STORAGE = data.storage.total;
        } else {
            opzStorageUsed = 0;
        }
        opzNumSamples = 0;

        data.categories.forEach((category, catIndex) => {
            const container = document.getElementById(category);
            if (!container) return;

            const heading = container.querySelector("h3");
            container.innerHTML = "";
            if (heading) {
                container.appendChild(heading);
            }

            data.sampleData[catIndex].forEach((slot, slotIndex) => {
                const slotDiv = document.createElement("div");
                slotDiv.classList.add("sampleslot");
                slotDiv.setAttribute("draggable", "true");
                slotDiv.dataset.category = category;
                slotDiv.dataset.slot = slotIndex;
                if (slot.path) {
                    slotDiv.dataset.path = slot.path;
                }

                slotDiv.addEventListener("dragstart", (e) => {
                    // Prevent drag during rename
                    if (currentRenameElement) {
                        e.preventDefault();
                        return;
                    }
                    e.dataTransfer.setData("text/plain", JSON.stringify({
                        category,
                        slot: slotIndex,
                        path: slot.path
                    }));
                });

                slotDiv.addEventListener("dragover", (e) => {
                    e.preventDefault();
                    slotDiv.classList.add("drag-hover");
                });

                slotDiv.addEventListener("dragleave", () => {
                    slotDiv.classList.remove("drag-hover");
                });

                slotDiv.addEventListener("drop", async (e) => {
                    e.preventDefault();
                    slotDiv.classList.remove("drag-hover");

                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        return;
                    }

                    const textData = e.dataTransfer.getData("text/plain");
                    if (!textData) return;

                    const droppedData = JSON.parse(textData);
                    const fromPath = droppedData.path;

                    if (!fromPath || (droppedData.category === category && droppedData.slot == slotIndex)) return;

                    const formData = new FormData();
                    formData.append("source_path", fromPath);
                    formData.append("target_category", category);
                    formData.append("target_slot", slotIndex);

                    try {
                        const response = await fetch("/move-sample", {
                            method: "POST",
                            body: formData
                        });

                        if (!response.ok) throw new Error("Move failed");
                        await fetchOpzSamples();
                    } catch (err) {
                        console.error("Failed to move sample:", err);
                        toast.error("Could not move sample");
                    }
                });

                const filename = slot.filename || "(empty)";
                const filesize = slot.filesize ? ` (${(slot.filesize / 1024).toFixed(1)} KB)` : "";
                const isTilde = slot.filename && slot.filename.startsWith("~");
                const isFilled = slot.path && typeof slot.filename === "string" && slot.filename !== "(empty)" && !isTilde;

                if (isFilled) {
                    opzNumSamples++;
                    slotDiv.classList.add('filled');
                } else if (isTilde) {
                    slotDiv.classList.add('tilde');
                } else {
                    slotDiv.classList.add('empty');
                }

                updateStorageDisplay('opz', data.storage, { numSamples: opzNumSamples });

                const text = document.createElement("span");
                text.classList.add('sample-name');
                text.textContent = `Slot ${slotIndex + 1}: ${filename}${filesize}`;

                // Button container
                const buttonContainer = document.createElement("div");
                buttonContainer.classList.add("sample-buttons");

                // More actions button (always visible)
                const moreBtn = document.createElement("button");
                moreBtn.innerHTML = "⋯";
                moreBtn.classList.add("more-actions-btn");
                moreBtn.setAttribute("data-bs-toggle", "dropdown");
                moreBtn.setAttribute("data-bs-container", "body");
                moreBtn.setAttribute("aria-expanded", "false");

                // Dropdown menu
                const dropdown = document.createElement("div");
                dropdown.classList.add("dropdown-menu", "sample-actions-dropdown");

                const renameItem = document.createElement("a");
                renameItem.classList.add("dropdown-item");
                renameItem.textContent = "Rename";
                renameItem.onclick = () => {
                    if (currentRenameElement) return;
                    startRename(slotDiv, slot.path, slot.filename);
                };
                if (!isFilled) renameItem.classList.add("disabled");

                const copyItem = document.createElement("a");
                copyItem.classList.add("dropdown-item");
                copyItem.textContent = "Copy";
                copyItem.onclick = () => {
                    if (currentRenameElement) return;
                    copySample(slot.path);
                };
                if (!isFilled) copyItem.classList.add("disabled");

                const pasteItem = document.createElement("a");
                pasteItem.classList.add("dropdown-item", "paste-item");
                pasteItem.textContent = "Paste";
                pasteItem.onclick = () => {
                    if (currentRenameElement) return;
                    pasteSample('opz', category, slotIndex);
                };
                // Paste state will be updated by clipboard monitoring

                dropdown.appendChild(renameItem);
                dropdown.appendChild(copyItem);
                dropdown.appendChild(pasteItem);

                // Delete button (only visible on filled slots via CSS)
                const deleteBtn = document.createElement("button");
                deleteBtn.textContent = "✕";
                deleteBtn.classList.add("delete-btn");
                deleteBtn.onclick = async (e) => {
                    e.stopPropagation();
                    const samplePath = slot.path;
                    if (!samplePath) return;
                    await deleteSample('opz', samplePath, fetchOpzSamples);
                };

                // Add click handler for ALL slots (including empty ones)
                slotDiv.addEventListener('click', (e) => {
                    // Don't play if clicking buttons or dropdown
                    if (e.target.closest('.more-actions-btn') ||
                        e.target.closest('.delete-btn') ||
                        e.target.closest('.dropdown-menu')) return;

                    if (slot.path) {
                        // For filled slots, play audio
                        playSample(slot.path, slotDiv);
                    } else {
                        // For empty slots, just select without playing
                        stopPlayback();
                        currentlyPlayingPath = null;
                        currentlyPlayingElement = slotDiv;
                        slotDiv.classList.add('playing');
                    }
                });

                buttonContainer.appendChild(moreBtn);
                buttonContainer.appendChild(dropdown);
                buttonContainer.appendChild(deleteBtn);

                slotDiv.appendChild(text);
                slotDiv.appendChild(buttonContainer);
                container.appendChild(slotDiv);
            });
        });

    } catch (error) {
        console.error("Failed to fetch OP-Z samples:", error);
    } finally {
        hideLoading('opz');
        // Update paste button states after rendering
        await updatePasteButtonStates();
    }
}


// ============================================
// OP-1 Functions
// ============================================

async function fetchOp1Samples() {
    showLoading('op1');
    try {
        const response = await fetch("/read-op1-samples");
        if (!response.ok) {
            throw new Error("Network response was not ok: " + response.statusText);
        }
        op1Data = await response.json();

        const errorContainer = document.getElementById("validation-error-container");
        const errorMessage = document.getElementById("validation-error-message");
        const storageInfo = document.getElementById("op1-storage-info");
        const fileList = document.getElementById("op1-file-list");

        if (op1Data.validation_error) {
            errorMessage.innerHTML = op1Data.validation_error;
            errorContainer.hidden = false;
            if (storageInfo) storageInfo.hidden = true;
            if (fileList) fileList.hidden = true;
            return;
        }

        errorContainer.hidden = true;
        if (storageInfo) storageInfo.hidden = false;
        if (fileList) fileList.hidden = false;

        // Render drum subdirectories
        renderOp1Section('drum', op1Data.drum.subdirectories);

        // Render synth subdirectories
        renderOp1Section('synth', op1Data.synth.subdirectories);

        // Update storage display
        updateStorageDisplay('op1', op1Data.storage, { counts: op1Data.counts });

    } catch (error) {
        console.error("Failed to fetch OP-1 samples:", error);
    } finally {
        hideLoading('op1');
        // Update paste button states after rendering
        await updatePasteButtonStates();
    }
}

function renderOp1Section(parentFolder, subdirectories) {
    const container = document.getElementById(`op1-${parentFolder}-subdirectories`);
    if (!container) return;

    container.innerHTML = '';

    const sortedSubdirs = Object.keys(subdirectories).sort((a, b) => {
        // Put "user" at the end
        if (a === 'user') return 1;
        if (b === 'user') return -1;
        return a.localeCompare(b);
    });

    if (sortedSubdirs.length === 0) {
        container.innerHTML = '<p class="empty-subdirectory">No folders yet. Click "+ Add Folder" to create one.</p>';
        return;
    }

    sortedSubdirs.forEach(subdirName => {
        const files = subdirectories[subdirName];
        const isReadOnly = subdirName === 'user';

        const subdirDiv = document.createElement('div');
        subdirDiv.classList.add('op1-subdirectory');
        if (isReadOnly) {
            subdirDiv.classList.add('read-only');
        }
        subdirDiv.dataset.path = `${parentFolder}/${subdirName}`;

        // Count samples and patches
        const sampleCount = files.filter(f => f.category !== 'patch').length;
        const patchCount = files.filter(f => f.category === 'patch').length;

        let countText = '';
        if (parentFolder === 'drum') {
            countText = `(${files.length} files)`;
        } else {
            const parts = [];
            if (sampleCount > 0) parts.push(`${sampleCount} sample${sampleCount !== 1 ? 's' : ''}`);
            if (patchCount > 0) parts.push(`${patchCount} patch${patchCount !== 1 ? 'es' : ''}`);
            countText = parts.length > 0 ? `(${parts.join(', ')})` : '(empty)';
        }

        // Header
        const header = document.createElement('div');
        header.classList.add('subdirectory-header');
        header.innerHTML = `
            <span class="expand-icon">▶</span>
            <span class="subdirectory-name">${escapeHtml(subdirName)}</span>
            <span class="sample-count">${countText}</span>
            ${isReadOnly ? '<span class="read-only-badge">Read-only</span>' : `
                <div class="subdirectory-actions">
                    <button class="btn btn-small btn-secondary" onclick="event.stopPropagation(); renameOp1Subdirectory('${parentFolder}/${subdirName}')">Rename</button>
                    <button class="btn btn-small btn-danger" onclick="event.stopPropagation(); deleteOp1Subdirectory('${parentFolder}/${subdirName}')">Delete</button>
                </div>
            `}
        `;

        // Toggle expand/collapse on header click
        header.addEventListener('click', () => {
            const content = subdirDiv.querySelector('.subdirectory-content');
            const icon = header.querySelector('.expand-icon');
            content.classList.toggle('collapsed');
            icon.classList.toggle('expanded');
        });

        // Content (file list)
        const content = document.createElement('div');
        content.classList.add('subdirectory-content', 'collapsed');

        if (files.length === 0) {
            content.innerHTML = '<p class="empty-subdirectory">No files in this folder</p>';
        } else {
            files.forEach(file => {
                const fileDiv = document.createElement('div');
                fileDiv.classList.add('op1-sample');
                fileDiv.classList.add('filled'); // OP-1 files are always filled
                fileDiv.dataset.path = file.path;

                const sizeKB = (file.size / 1024).toFixed(1);
                const isPatch = file.category === 'patch';
                const badgeClass = isPatch ? 'patch' : 'sample';
                const badgeText = isPatch ? 'patch' : 'sample';

                // Sample name
                const nameSpan = document.createElement('span');
                nameSpan.classList.add('sample-name');
                nameSpan.textContent = file.name;

                // Size badge
                const sizeSpan = document.createElement('span');
                sizeSpan.classList.add('sample-size');
                sizeSpan.textContent = `${sizeKB} KB`;

                // Type badge
                const typeBadge = document.createElement('span');
                typeBadge.classList.add('sample-type-badge', badgeClass);
                typeBadge.textContent = badgeText;

                // Button container
                const buttonContainer = document.createElement('div');
                buttonContainer.classList.add('sample-buttons');

                if (!isReadOnly) {
                    // More actions button
                    const moreBtn = document.createElement('button');
                    moreBtn.innerHTML = '⋯';
                    moreBtn.classList.add('more-actions-btn');
                    moreBtn.setAttribute('data-bs-toggle', 'dropdown');
                    moreBtn.setAttribute('data-bs-container', 'body');
                    moreBtn.setAttribute('aria-expanded', 'false');

                    // Dropdown menu
                    const dropdown = document.createElement('div');
                    dropdown.classList.add('dropdown-menu', 'sample-actions-dropdown');

                    const renameItem = document.createElement('a');
                    renameItem.classList.add('dropdown-item');
                    renameItem.textContent = 'Rename';
                    renameItem.onclick = () => {
                        if (currentRenameElement) return;
                        startRename(fileDiv, file.path, file.name);
                    };

                    const copyItem = document.createElement('a');
                    copyItem.classList.add('dropdown-item');
                    copyItem.textContent = 'Copy';
                    copyItem.onclick = () => {
                        if (currentRenameElement) return;
                        copySample(file.path);
                    };

                    const pasteItem = document.createElement('a');
                    pasteItem.classList.add('dropdown-item', 'paste-item');
                    pasteItem.textContent = 'Paste';
                    pasteItem.onclick = () => {
                        if (currentRenameElement) return;
                        pasteSample('op1', file.path);
                    };

                    dropdown.appendChild(renameItem);
                    dropdown.appendChild(copyItem);
                    dropdown.appendChild(pasteItem);

                    // Delete button
                    const deleteBtn = document.createElement('button');
                    deleteBtn.textContent = '✕';
                    deleteBtn.classList.add('delete-btn');
                    deleteBtn.onclick = (e) => {
                        e.stopPropagation();
                        deleteSample('op1', file.path, fetchOp1Samples);
                    };

                    buttonContainer.appendChild(moreBtn);
                    buttonContainer.appendChild(dropdown);
                    buttonContainer.appendChild(deleteBtn);
                }

                // Add click handler for audio preview
                fileDiv.addEventListener('click', (e) => {
                    // Don't play if clicking buttons or dropdown
                    if (e.target.closest('.more-actions-btn') ||
                        e.target.closest('.delete-btn') ||
                        e.target.closest('.dropdown-menu')) return;
                    playSample(file.path, fileDiv);
                });

                fileDiv.appendChild(nameSpan);
                fileDiv.appendChild(sizeSpan);
                fileDiv.appendChild(typeBadge);
                if (!isReadOnly) {
                    fileDiv.appendChild(buttonContainer);
                }

                content.appendChild(fileDiv);
            });
        }

        subdirDiv.appendChild(header);
        subdirDiv.appendChild(content);
        container.appendChild(subdirDiv);

        // Add drag-and-drop support for files (not for read-only directories)
        if (!isReadOnly) {
            setupOp1SubdirectoryDropZone(subdirDiv, parentFolder, subdirName);
        }
    });

    // Set up drop zone for the whole section (for folder uploads)
    setupOp1SectionDropZone(parentFolder);
}

function setupOp1SubdirectoryDropZone(subdirDiv, parentFolder, subdirName) {
    subdirDiv.addEventListener('dragover', (e) => {
        e.preventDefault();
        subdirDiv.classList.add('drag-hover');
    });

    subdirDiv.addEventListener('dragleave', (e) => {
        if (!subdirDiv.contains(e.relatedTarget)) {
            subdirDiv.classList.remove('drag-hover');
        }
    });

    subdirDiv.addEventListener('drop', async (e) => {
        e.preventDefault();
        subdirDiv.classList.remove('drag-hover');

        const files = e.dataTransfer.files;
        if (files.length === 0) return;

        // Upload files to this subdirectory
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('device', 'op1');
            formData.append('target_path', `${parentFolder}/${subdirName}`);

            try {
                const response = await fetch('/upload-sample', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    const data = await response.json();
                    throw new Error(data.error || 'Upload failed');
                }
            } catch (err) {
                console.error('Failed to upload file:', err);
                toast.error(`${file.name}: ${err.message}`, 'Upload Failed');
            }
        }

        // Refresh the view
        await fetchOp1Samples();
    });
}

function setupOp1SectionDropZone(parentFolder) {
    const section = document.getElementById(`op1-${parentFolder}-section`);
    if (!section) return;

    section.addEventListener('dragover', (e) => {
        // Only show drop zone if dragging a folder (has items)
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            e.preventDefault();
            section.classList.add('drag-hover');
        }
    });

    section.addEventListener('dragleave', (e) => {
        if (!section.contains(e.relatedTarget)) {
            section.classList.remove('drag-hover');
        }
    });

    section.addEventListener('drop', async (e) => {
        e.preventDefault();
        section.classList.remove('drag-hover');

        const items = e.dataTransfer.items;
        if (!items || items.length === 0) return;

        // Check if this is a folder drop
        const entry = items[0].webkitGetAsEntry ? items[0].webkitGetAsEntry() : null;

        if (entry && entry.isDirectory) {
            // Handle folder drop
            const folderName = entry.name;
            const files = await getFilesFromDirectory(entry);

            if (files.length === 0) {
                toast.warning('The folder is empty');
                return;
            }

            const formData = new FormData();
            formData.append('parent', parentFolder);
            formData.append('folder_name', folderName);
            files.forEach(file => {
                formData.append('files', file);
            });

            try {
                const response = await fetch('/upload-op1-folder', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    const data = await response.json();
                    throw new Error(data.error || 'Upload failed');
                }

                const result = await response.json();
                if (result.errors && result.errors.length > 0) {
                    toast.warning(`Some files failed: ${result.errors.join(', ')}`, 'Partial Upload');
                } else {
                    toast.success('Folder uploaded', 'Upload Complete');
                }
            } catch (err) {
                console.error('Failed to upload folder:', err);
                toast.error(err.message, 'Upload Failed');
            }

            await fetchOp1Samples();
        }
    });
}

async function getFilesFromDirectory(directoryEntry) {
    const files = [];
    const reader = directoryEntry.createReader();

    return new Promise((resolve) => {
        reader.readEntries(async (entries) => {
            for (const entry of entries) {
                if (entry.isFile) {
                    const file = await new Promise((res) => entry.file(res));
                    files.push(file);
                }
            }
            resolve(files);
        });
    });
}

async function createOp1Subdirectory(parentFolder) {
    const name = prompt(`Enter name for new ${parentFolder} folder:`);
    if (!name) return;

    try {
        const response = await fetch('/create-op1-subdirectory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parent: parentFolder, name: name })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to create folder');
        }

        await fetchOp1Samples();
        toast.success('Folder created');
    } catch (err) {
        console.error('Failed to create subdirectory:', err);
        toast.error(err.message, 'Create Failed');
    }
}

async function renameOp1Subdirectory(path) {
    const parts = path.split('/');
    const currentName = parts[1];
    const newName = prompt(`Enter new name for "${currentName}":`, currentName);
    if (!newName || newName === currentName) return;

    try {
        const response = await fetch('/rename-op1-subdirectory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old_path: path, new_name: newName })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to rename folder');
        }

        await fetchOp1Samples();
        toast.success('Folder renamed');
    } catch (err) {
        console.error('Failed to rename subdirectory:', err);
        toast.error(err.message, 'Rename Failed');
    }
}

function deleteOp1Subdirectory(path) {
    const parts = path.split('/');
    const name = parts[1];

    showConfirmModal(
        'Delete Folder',
        `Delete folder "<strong>${escapeHtml(name)}</strong>" and all its contents?`,
        async () => {
            try {
                const response = await fetch('/delete-op1-subdirectory', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path })
                });

                if (!response.ok) {
                    const data = await response.json();
                    throw new Error(data.error || 'Failed to delete folder');
                }

                await fetchOp1Samples();
                toast.success('Folder deleted');
            } catch (err) {
                console.error('Failed to delete subdirectory:', err);
                toast.error(err.message, 'Delete Failed');
            }
        }
    );
}

// ============================================
// Sample Actions: Rename, Copy, Paste
// ============================================

// State management
let clipboardData = null;
let currentRenameElement = null;
let clipboardCheckInterval = null;

/**
 * Start inline rename of a sample
 */
function startRename(element, path, filename) {
    // Prevent multiple simultaneous renames
    if (currentRenameElement) {
        return;
    }

    currentRenameElement = element;
    element.classList.add('renaming');

    // Disable draggable
    element.setAttribute('draggable', 'false');

    // Get the name span
    const nameSpan = element.querySelector('.sample-name');
    const originalText = nameSpan.textContent;

    // Extract just the filename without slot prefix (for OP-Z)
    let displayName = filename || originalText;
    if (originalText.startsWith('Slot ')) {
        // OP-Z format: "Slot X: filename.aif (size)"
        const match = originalText.match(/Slot \d+: ([^(]+)/);
        if (match) {
            displayName = match[1].trim();
        }
    }

    // Remove .aif/.aiff extension for editing
    const nameWithoutExt = displayName.replace(/\.(aif|aiff)$/i, '');

    // Create input field
    const input = document.createElement('input');
    input.type = 'text';
    input.classList.add('sample-name-input');
    input.value = nameWithoutExt;
    input.maxLength = 10;

    // Replace span with input
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    // Save on Enter
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            await finishRename(element, path, input.value, originalText, input);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename(element, originalText, input);
        }
    });

    // Save on blur
    input.addEventListener('blur', async () => {
        await finishRename(element, path, input.value, originalText, input);
    });
}

/**
 * Finish rename operation
 */
async function finishRename(element, path, newName, originalText, input) {
    if (!currentRenameElement) return;

    // Validate new name
    const trimmedName = newName.trim();
    if (!trimmedName) {
        toast.error('Filename cannot be empty');
        cancelRename(element, originalText, input);
        return;
    }

    // Validate characters (alphanumeric, underscore, hyphen only)
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
        toast.error('Invalid characters. Use only letters, numbers, hyphens, and underscores.');
        cancelRename(element, originalText, input);
        return;
    }

    // Check length
    if (trimmedName.length > 10) {
        toast.error('Filename must be 10 characters or less.');
        cancelRename(element, originalText, input);
        return;
    }

    // Call backend to rename
    try {
        const response = await fetch('/rename-sample', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device: currentDevice,
                old_path: path,
                new_name: trimmedName
            })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to rename');
        }

        // Success - refresh the view
        if (currentDevice === 'opz') {
            await fetchOpzSamples();
        } else {
            await fetchOp1Samples();
        }

        toast.success('Sample renamed');
    } catch (err) {
        console.error('Rename failed:', err);
        toast.error(err.message);
        cancelRename(element, originalText, input);
    } finally {
        cleanupRename(element);
    }
}

/**
 * Cancel rename operation
 */
function cancelRename(element, originalText, input) {
    const nameSpan = document.createElement('span');
    nameSpan.classList.add('sample-name');
    nameSpan.textContent = originalText;
    input.replaceWith(nameSpan);
    cleanupRename(element);
}

/**
 * Cleanup rename state
 */
function cleanupRename(element) {
    element.classList.remove('renaming');
    element.setAttribute('draggable', 'true');
    currentRenameElement = null;
}

/**
 * Copy sample to clipboard (tries system clipboard first, falls back to internal)
 */
async function copySample(path) {
    if (!path) {
        toast.error('No sample to copy');
        return;
    }

    // Try to copy to system clipboard first
    try {
        const response = await fetch('/copy-to-system-clipboard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device: currentDevice,
                path: path
            })
        });

        if (response.ok) {
            // System clipboard successful
            clipboardData = {
                path: path,
                device: currentDevice,
                isSystemClipboard: true
            };
            updatePasteButtonStates();
            toast.success('Sample copied to system clipboard');
            return;
        }
    } catch (err) {
        console.warn('System clipboard failed, using internal clipboard:', err);
    }

    // Fall back to internal clipboard
    clipboardData = {
        path: path,
        device: currentDevice,
        isSystemClipboard: false
    };

    updatePasteButtonStates();
    toast.success('Sample copied to internal clipboard');
}

/**
 * Paste sample from clipboard (supports both system and internal clipboard)
 */
async function pasteSample(device, targetPathOrCategory, slot) {
    // Check if we should try system clipboard
    const hasSystemClipboard = clipboardData && clipboardData.isSystemClipboard;

    // Try system clipboard first if available
    if (hasSystemClipboard) {
        try {
            const response = await fetch('/paste-from-system-clipboard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device: device,
                    target_path: targetPathOrCategory,
                    slot: slot
                })
            });

            if (response.ok) {
                // Success - refresh the view
                if (device === 'opz') {
                    await fetchOpzSamples();
                } else {
                    await fetchOp1Samples();
                }
                toast.success('Sample pasted from system clipboard');
                return;
            }
        } catch (err) {
            console.warn('System clipboard paste failed, trying internal:', err);
        }
    }

    // Fall back to internal clipboard paste
    if (!clipboardData || !clipboardData.path) {
        toast.error('No sample in clipboard');
        return;
    }

    try {
        const response = await fetch('/paste-sample', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device: device,
                source_path: clipboardData.path,
                target_path: targetPathOrCategory,
                slot: slot
            })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to paste');
        }

        // Success - refresh the view
        if (device === 'opz') {
            await fetchOpzSamples();
        } else {
            await fetchOp1Samples();
        }

        toast.success('Sample pasted successfully');
    } catch (err) {
        console.error('Paste failed:', err);
        toast.error(err.message);
    }
}

/**
 * Update paste button states based on clipboard
 */
async function updatePasteButtonStates() {
    // Check both internal and system clipboard
    let hasClipboard = clipboardData && clipboardData.path;

    // Also check system clipboard if no internal clipboard
    if (!hasClipboard) {
        try {
            const response = await fetch('/check-system-clipboard');
            if (response.ok) {
                const data = await response.json();
                hasClipboard = data.has_file;
                if (hasClipboard) {
                    // Update internal state to indicate system clipboard has file
                    clipboardData = {
                        path: null,  // Path unknown until paste
                        device: currentDevice,
                        isSystemClipboard: true
                    };
                }
            }
        } catch (err) {
            // Silent fail - just use internal clipboard state
        }
    }

    const pasteItems = document.querySelectorAll('.paste-item');
    pasteItems.forEach(item => {
        if (hasClipboard) {
            item.classList.remove('disabled');
        } else {
            item.classList.add('disabled');
        }
    });
}

/**
 * Start periodic system clipboard monitoring
 */
function startClipboardMonitoring() {
    // Check clipboard every 2 seconds
    if (clipboardCheckInterval) {
        clearInterval(clipboardCheckInterval);
    }

    clipboardCheckInterval = setInterval(async () => {
        // Only check if no internal clipboard is set
        if (!clipboardData || !clipboardData.path) {
            await updatePasteButtonStates();
        }
    }, 2000);
}

/**
 * Stop clipboard monitoring
 */
function stopClipboardMonitoring() {
    if (clipboardCheckInterval) {
        clearInterval(clipboardCheckInterval);
        clipboardCheckInterval = null;
    }
}

// ============================================
// Keyboard Shortcuts
// ============================================

/**
 * Get the currently selected/playing sample element and its data
 */
function getSelectedSample() {
    const playingElement = document.querySelector('.sampleslot.playing, .op1-sample.playing');
    if (!playingElement) return null;

    // Extract path and filename from the element
    let path = null;
    let filename = null;

    if (playingElement.classList.contains('sampleslot')) {
        // OP-Z sample
        const nameSpan = playingElement.querySelector('.sample-name');
        if (nameSpan) {
            const text = nameSpan.textContent;
            const match = text.match(/Slot \d+: ([^(]+)/);
            if (match) {
                filename = match[1].trim();
            }
        }
        // Get path from dataset or reconstruct
        path = playingElement.dataset.path;
    } else if (playingElement.classList.contains('op1-sample')) {
        // OP-1 sample
        const nameSpan = playingElement.querySelector('.sample-name');
        if (nameSpan) {
            filename = nameSpan.textContent;
        }
        path = playingElement.dataset.path;
    }

    return { element: playingElement, path: path || currentlyPlayingPath, filename };
}

/**
 * Handle global keyboard shortcuts
 */
function handleKeyboardShortcut(e) {
    // Don't trigger shortcuts if currently renaming
    if (currentRenameElement) return;

    // Don't trigger shortcuts if typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const selected = getSelectedSample();
    if (!selected) return;

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    // Paste: Ctrl/Cmd+V (works on empty slots too)
    if (modKey && e.key === 'v') {
        e.preventDefault();
        // Determine paste target based on selected element
        if (selected.element.classList.contains('sampleslot')) {
            const category = selected.element.dataset.category;
            const slot = selected.element.dataset.slot;
            if (category && slot !== undefined) {
                pasteSample('opz', category, parseInt(slot));
            }
        } else {
            // OP-1: paste to the same location (needs path)
            if (selected.path) {
                pasteSample('op1', selected.path);
            }
        }
        return;
    }

    // Operations below require a path (copy/rename/delete)
    if (!selected.path) return;

    // Copy: Ctrl/Cmd+C
    if (modKey && e.key === 'c') {
        e.preventDefault();
        copySample(selected.path);
        return;
    }

    // Rename: F2 or Enter
    if (e.key === 'F2' || (e.key === 'Enter' && !modKey)) {
        e.preventDefault();
        startRename(selected.element, selected.path, selected.filename);
        return;
    }

    // Delete: Delete key
    if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSample(currentDevice, selected.path, currentDevice === 'opz' ? fetchOpzSamples : fetchOp1Samples);
        return;
    }
}

// Attach keyboard shortcut handler
document.addEventListener('keydown', handleKeyboardShortcut);

// Clear selection when clicking outside of samples
document.addEventListener('click', (e) => {
    // Don't clear if clicking on a sample, button, or dropdown
    if (e.target.closest('.sampleslot') ||
        e.target.closest('.op1-sample') ||
        e.target.closest('.more-actions-btn') ||
        e.target.closest('.delete-btn') ||
        e.target.closest('.dropdown-menu')) {
        return;
    }

    // Clear playback and selection
    stopPlayback();
});

// ============================================
// OP-Z Drag and Drop Setup
// ============================================

// Set up OP-Z sample box drag-and-drop after DOM loads
document.addEventListener('DOMContentLoaded', () => {
    // Setup settings event listener
    const settingsCheckbox = document.getElementById('setting-auto-pitch');
    if (settingsCheckbox) {
        settingsCheckbox.addEventListener('change', async (e) => {
            const settings = await loadSettings();
            settings.autoPitch = e.target.checked;
            await saveSettings(settings);
        });
    }

    // Start system clipboard monitoring
    startClipboardMonitoring();

    document.querySelectorAll(".samplepackbox").forEach(box => {
        box.addEventListener("dragover", (e) => {
            e.preventDefault();
        });

        box.addEventListener("drop", async (e) => {
            e.preventDefault();

            const files = e.dataTransfer.files;
            if (files.length === 0) return;

            const file = files[0];
            const category = box.id;

            const slotElement = document.elementFromPoint(e.clientX, e.clientY)?.closest(".sampleslot");
            if (!slotElement) return;

            const slot = slotElement.dataset.slot;

            const formData = new FormData();
            formData.append("file", file);
            formData.append("category", category);
            formData.append("slot", slot);

            try {
                const response = await fetch("/upload-sample", {
                    method: "POST",
                    body: formData
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error || "Upload failed");
                }

                await fetchOpzSamples();
                toast.success('Sample uploaded');
            } catch (err) {
                console.error("Failed to upload file:", err);
                toast.error(err.message || 'Upload failed');
            }
        });
    });
});

// Prevent default drag-and-drop behavior on the whole page
window.addEventListener("dragover", (e) => {
    e.preventDefault();
});

window.addEventListener("drop", (e) => {
    e.preventDefault();
});
