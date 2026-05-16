/**
 * Homepage JavaScript
 *
 * Handles device sidebar updates and other home page functionality.
 */

// Track scanning state for each device (after disconnect, scan for 30 sec)
const deviceScanningState = {
    opz: { scanning: false, timeout: null, previousMode: null },
    op1: { scanning: false, timeout: null, previousMode: null }
};

// How long to show "scanning" after a device disconnects (ms)
const SCANNING_DURATION = 30000;

/**
 * Load sidebar state from config and check device status
 */
async function loadSidebarState() {
    const sidebar = document.getElementById('device-sidebar');
    if (!sidebar) return;

    try {
        // First check if any device is connected - if so, expand
        const status = await deviceStatus.getStatus();
        if (status && (status.opz.connected || status.op1.connected)) {
            sidebar.classList.remove('collapsed');
            updateToggleButton(false);
            return;
        }

        // No devices connected - check saved preference
        const response = await fetch('/get-config-setting?config_option=SIDEBAR_EXPANDED');
        const data = await response.json();
        if (data.config_value === true) {
            sidebar.classList.remove('collapsed');
            updateToggleButton(false);
        }
    } catch (e) {
        console.error('Error loading sidebar state:', e);
    }
}

/**
 * Toggle sidebar visibility and save preference
 */
async function toggleSidebar() {
    const sidebar = document.getElementById('device-sidebar');
    if (!sidebar) return;

    const isCollapsed = sidebar.classList.toggle('collapsed');
    updateToggleButton(isCollapsed);

    try {
        await fetch('/set-config-setting', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config_option: 'SIDEBAR_EXPANDED', config_value: !isCollapsed })
        });
    } catch (e) {
        console.error('Error saving sidebar state:', e);
    }
}

/**
 * Update toggle button appearance based on sidebar state
 */
function updateToggleButton(isCollapsed) {
    const button = document.getElementById('sidebar-toggle');
    if (!button) return;
    button.classList.toggle('active', !isCollapsed);
}

/**
 * Expand sidebar (called when device connects)
 */
function expandSidebar() {
    const sidebar = document.getElementById('device-sidebar');
    if (!sidebar || !sidebar.classList.contains('collapsed')) return;

    sidebar.classList.remove('collapsed');
    updateToggleButton(false);

    // Save expanded state
    fetch('/set-config-setting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_option: 'SIDEBAR_EXPANDED', config_value: true })
    }).catch(e => console.error('Error saving sidebar state:', e));
}

/**
 * Start scanning state for a device (shows pulsing indicator for 30 sec)
 */
function startDeviceScanning(device) {
    const state = deviceScanningState[device];
    if (!state) return;

    // Clear any existing timeout
    if (state.timeout) {
        clearTimeout(state.timeout);
    }

    state.scanning = true;

    // Update UI to show scanning
    const indicator = document.getElementById(`${device}-indicator`);
    const statusText = document.getElementById(`${device}-status-text`);
    const pathText = document.getElementById(`${device}-path-text`);

    if (indicator) {
        indicator.classList.remove('connected', 'disconnected');
        indicator.classList.add('scanning');
    }
    if (statusText) {
        statusText.textContent = 'Scanning...';
    }
    if (pathText) {
        pathText.textContent = '';
        pathText.classList.remove('mode-hint');
    }

    // Stop scanning after duration
    state.timeout = setTimeout(() => {
        stopDeviceScanning(device);
    }, SCANNING_DURATION);
}

/**
 * Stop scanning state for a device
 */
function stopDeviceScanning(device) {
    const state = deviceScanningState[device];
    if (!state) return;

    if (state.timeout) {
        clearTimeout(state.timeout);
        state.timeout = null;
    }

    state.scanning = false;

    // If device is still not connected, show disconnected state
    const indicator = document.getElementById(`${device}-indicator`);
    const statusText = document.getElementById(`${device}-status-text`);

    if (indicator && indicator.classList.contains('scanning')) {
        indicator.classList.remove('scanning');
        indicator.classList.add('disconnected');
    }
    if (statusText && statusText.textContent === 'Scanning...') {
        statusText.textContent = 'Not connected';
    }
}

// Device status display configurations
const DEVICE_STATUS_CONFIG = {
    storage: {
        indicatorClass: 'connected',
        statusText: 'Connected in disk mode',
        pathTextFn: (path) => path || 'Mounting...',
        isHint: (path) => !path,
        disabled: (path) => !path
    },
    upgrade: {
        indicatorClass: 'wrong-mode',
        statusText: 'Connected in upgrade mode',
        pathText: 'Switch to disk mode for file access',
        isHint: true,
        disabled: true
    },
    standby: {
        indicatorClass: 'standby',
        statusText: 'Device off',
        pathText: 'Power on device for access',
        isHint: true,
        disabled: true
    },
    other: {
        indicatorClass: 'wrong-mode',
        statusText: 'Connected in standalone mode',
        pathText: 'Switch to disk mode for file access',
        isHint: true,
        disabled: true
    },
    disconnected: {
        indicatorClass: 'disconnected',
        statusText: 'Not connected',
        pathText: '',
        isHint: false,
        disabled: true
    }
};

const ALL_INDICATOR_CLASSES = ['connected', 'disconnected', 'scanning', 'wrong-mode', 'standby'];

/**
 * Update device sidebar card with current status
 */
function updateDeviceSidebar(device, connected, path, mode) {
    const indicator = document.getElementById(`${device}-indicator`);
    const statusText = document.getElementById(`${device}-status-text`);
    const pathText = document.getElementById(`${device}-path-text`);
    const card = document.getElementById(`${device}-status-card`);

    if (!indicator || !statusText || !pathText || !card) {
        return;
    }

    const state = deviceScanningState[device];

    // If device connects, stop any scanning state
    if (connected) {
        stopDeviceScanning(device);
    }

    // Track mode for detecting mode switches
    const previousMode = state ? state.previousMode : null;
    if (state) {
        state.previousMode = mode;
    }

    // Handle disconnected state with scanning logic
    if (!connected) {
        if (previousMode !== null && state && !state.scanning) {
            startDeviceScanning(device);
            card.classList.add('disabled');
        } else if (state && state.scanning) {
            card.classList.add('disabled');
        } else {
            applyDeviceStatus(indicator, statusText, pathText, card, 'disconnected');
        }
        return;
    }

    // Apply connected status based on mode
    applyDeviceStatus(indicator, statusText, pathText, card, mode, path);
}

/**
 * Apply device status configuration to UI elements
 */
function applyDeviceStatus(indicator, statusText, pathText, card, mode, path = null) {
    const config = DEVICE_STATUS_CONFIG[mode] || DEVICE_STATUS_CONFIG.disconnected;

    // Update indicator
    indicator.classList.remove(...ALL_INDICATOR_CLASSES);
    indicator.classList.add(config.indicatorClass);

    // Update status text
    statusText.textContent = config.statusText;

    // Update path text (can be static or dynamic based on path)
    const pathValue = typeof config.pathTextFn === 'function'
        ? config.pathTextFn(path)
        : config.pathText;
    pathText.textContent = pathValue;

    // Update hint class
    const isHint = typeof config.isHint === 'function'
        ? config.isHint(path)
        : config.isHint;
    pathText.classList.toggle('mode-hint', isHint);

    // Update disabled state
    const isDisabled = typeof config.disabled === 'function'
        ? config.disabled(path)
        : config.disabled;
    card.classList.toggle('disabled', isDisabled);
}

/**
 * Initialize sidebar with current device status
 */
async function initDeviceSidebar() {
    try {
        const status = await deviceStatus.getStatus();
        if (status) {
            updateDeviceSidebar('opz', status.opz.connected, status.opz.path, status.opz.mode);
            updateDeviceSidebar('op1', status.op1.connected, status.op1.path, status.op1.mode);
        }
    } catch (e) {
        console.error('Error initializing device sidebar:', e);
    }
}

/**
 * Open external links in system browser
 */
function openExternalLink(url) {
    fetch(`/open-external-link?url=${encodeURIComponent(url)}`)
        .then(response => response.json())
        .catch(err => console.error('Error opening link:', err));
}

// ============================================================
// Homepage Pagination
// ============================================================

let currentPage = 0;
const totalPages = 2;

/**
 * Navigate to a page by relative direction (-1 or +1)
 */
function navigatePage(direction) {
    goToPage(currentPage + direction);
}

/**
 * Navigate directly to a page index
 */
function goToPage(index) {
    if (index < 0 || index >= totalPages || index === currentPage) return;

    currentPage = index;

    // Toggle active on tile pages
    document.querySelectorAll('.tile-page').forEach(page => {
        page.classList.toggle('active', parseInt(page.dataset.page) === currentPage);
    });

    // Toggle active on dots
    document.querySelectorAll('.page-dot').forEach(dot => {
        dot.classList.toggle('active', parseInt(dot.dataset.page) === currentPage);
    });

    // Enable/disable arrows
    const leftArrow = document.getElementById('page-arrow-left');
    const rightArrow = document.getElementById('page-arrow-right');
    if (leftArrow) leftArrow.disabled = currentPage === 0;
    if (rightArrow) rightArrow.disabled = currentPage === totalPages - 1;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide icons
    lucide.createIcons();

    // Load sidebar state (checks devices and config)
    loadSidebarState();

    // Initialize device sidebar status
    initDeviceSidebar();
});
