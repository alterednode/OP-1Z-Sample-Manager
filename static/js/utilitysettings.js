function resetConfig() {
  fetch('/reset-config', {
    method: 'POST'
  })
    .then(response => response.json())
    .then(data => {
      toast.success('Please restart the app', 'Config Reset');
      window.location.reload();
    })
    .catch(error => {
      toast.error('Error resetting config');
      console.error(error);
    });
}

function openConfigInEditor() {
  fetch('/open-config-in-editor', {
    method: 'POST'
  })
    .then(response => {
      if (!response.ok) throw new Error("Request failed");
      return response.json();
    })
    .then(data => {
      toast.success('Config file opened', 'Editor Launched');
    })
    .catch(error => {
      toast.error('Failed to open config file');
      console.error(error);
    });
}

function openPathPicker(endpoint, inputId, infoId, configOption, autoSet = false) {
  // autoSet determines if this will automatically send the path it gets off to the flask server to set & save the config option - defaults to false
  fetch(endpoint)
    .then(res => res.json())
    .then(data => {
      const input = document.getElementById(inputId);
      if (data.path) {
        input.value = data.path;
        updateInputWidth(input);
        if (autoSet && configOption) {
          setConfigPath(configOption, inputId, infoId);
        }
      } else {
        document.getElementById(infoId).textContent = "Failed to get path.";
      }
    })
    .catch(err => {
      console.error("Error getting path:", err);
      document.getElementById(infoId).textContent = "Error communicating with server.";
    });
}


function setConfigPath(configOption, inputId, infoId = null) {
  //does this based on the value of the inputId thing, might be worth changing that
  const path = document.getElementById(inputId).value;
  console.log(`Setting config "${configOption}" to path:`, path);

  fetch("/set-config-setting", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      config_option: configOption,
      config_value: path
    })
  })
    .then(res => {
      if (infoId) {
        document.getElementById(infoId).textContent =
          res.ok ? "Setting saved successfully!" : "Failed to set path.";
      }
      console.log(res.ok ? `Successfully set "${configOption}"` : `Failed to set "${configOption}". HTTP status: ${res.status}`);
    })
    .catch(err => {
      console.error(`Error while setting "${configOption}":`, err);
      if (infoId) {
        document.getElementById(infoId).textContent = "Error communicating with server.";
      }
    });
}


function removeConfigPath(configOption, inputId, infoId = null) {
  // tells flask to delete this config option
  fetch("/remove-config-setting", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ config_option: configOption })
  })
    .then(res => res.json())
    .then(data => {
      const input = document.getElementById(inputId);
      if (data.success) {
        input.value = "";
        updateInputWidth(input);
        if (infoId) {
          document.getElementById(infoId).textContent = "Path removed.";
        }
        console.log(`Successfully removed "${configOption}"`);
      } else {
        if (infoId) {
          document.getElementById(infoId).textContent = "Failed to remove path.";
        }
        console.warn(`Failed to remove "${configOption}":`, data);
      }
    })
    .catch(err => {
      console.error(`Error while removing "${configOption}":`, err);
      if (infoId) {
        document.getElementById(infoId).textContent = "Error communicating with server.";
      }
    });
}

async function loadConfig(configOption) {
  const res = await fetch(`/get-config-setting?config_option=${configOption}`);
  const data = await res.json();
  return data.config_value || "";
}

async function loadConfigPath(configOption, inputId) {
  const res = await fetch(`/get-config-setting?config_option=${configOption}`);
  const data = await res.json();
  const input = document.getElementById(inputId);
  input.value = data.config_value || "";
  updateInputWidth(input);
}

function enableAutoResizeInput(inputElement, minWidth = 200, padding = 20) {
  const measurer = document.createElement("span");
  measurer.style.position = "absolute";
  measurer.style.visibility = "hidden";
  measurer.style.whiteSpace = "pre";
  measurer.style.font = getComputedStyle(inputElement).font;
  document.body.appendChild(measurer);

  function update() {
    measurer.textContent = inputElement.value || inputElement.placeholder;
    inputElement.style.width = Math.max(measurer.offsetWidth + padding, minWidth) + "px";
  }

  inputElement.addEventListener("input", update);
  update(); // initial run

  inputElement._resizeHandler = update;
}

function updateInputWidth(inputElement) {
  if (inputElement && inputElement._resizeHandler) {
    inputElement._resizeHandler();
  }
}

function setLoggerLevelFromDropdown() {
  const level = document.getElementById("logger-level-select").value;
  console.log(`Setting LOGGER_LEVEL to: ${level}`);
  setConfigPath("LOGGER_LEVEL", "logger-level-select", "logger-info");
}

async function loadLoggerLevel() {
  const res = await fetch("/get-config-setting?config_option=LOGGER_LEVEL");
  const data = await res.json();

  const select = document.getElementById("logger-level-select");
  const level = data.config_value || "INFO"; // Default to INFO
  select.value = level;
  updateInputWidth(select);
}

/**
 * Toggle developer mode on/off
 */
function toggleDeveloperMode() {
  const toggle = document.getElementById("developer-mode-toggle");
  const isEnabled = toggle.checked;

  // Save to config
  fetch("/set-config-setting", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config_option: "DEVELOPER_MODE",
      config_value: isEnabled
    })
  })
    .then(res => {
      if (res.ok) {
        updateManualPathsVisibility(isEnabled);
        toast.success(
          isEnabled ? "Manual device paths enabled" : "Auto-detection enabled",
          "Developer Mode " + (isEnabled ? "Enabled" : "Disabled")
        );
      } else {
        toast.error("Failed to save setting");
        toggle.checked = !isEnabled; // Revert
      }
    })
    .catch(err => {
      console.error("Error toggling developer mode:", err);
      toast.error("Error saving setting");
      toggle.checked = !isEnabled; // Revert
    });
}

/**
 * Load developer mode setting and update UI
 */
async function loadDeveloperMode() {
  try {
    const res = await fetch("/get-config-setting?config_option=DEVELOPER_MODE");
    const data = await res.json();
    const isEnabled = data.config_value === true;

    const toggle = document.getElementById("developer-mode-toggle");
    if (toggle) {
      toggle.checked = isEnabled;
    }

    updateManualPathsVisibility(isEnabled);
  } catch (err) {
    console.error("Error loading developer mode:", err);
  }
}

/**
 * Show/hide manual paths container based on developer mode
 */
function updateManualPathsVisibility(isEnabled) {
  const container = document.getElementById("manual-paths-container");
  if (container) {
    container.style.display = isEnabled ? "block" : "none";
  }
}

/**
 * Toggle between logged-in and logged-out UI states for OP1.fun
 */
function updateOp1FunLoginUI(isLoggedIn, email) {
  const loggedOutDiv = document.getElementById('op1fun-logged-out');
  const loggedInDiv = document.getElementById('op1fun-logged-in');
  const emailSpan = document.getElementById('op1fun-user-email');

  if (isLoggedIn && email) {
    loggedOutDiv.style.display = 'none';
    loggedInDiv.style.display = 'block';
    emailSpan.textContent = email;
  } else {
    loggedOutDiv.style.display = 'block';
    loggedInDiv.style.display = 'none';
  }

  lucide.createIcons();  // Reinitialize icons for newly visible elements
}

/**
 * Check OP1.fun login status on page load
 */
async function loadOp1FunLoginState() {
  try {
    const res = await fetch('/get-config-setting?config_option=OP1FUN_USER_EMAIL');
    const data = await res.json();
    const email = data.config_value;

    if (email) {
      updateOp1FunLoginUI(true, email);
    } else {
      updateOp1FunLoginUI(false, null);
    }
  } catch (err) {
    console.error('Error loading OP1.fun login state:', err);
    updateOp1FunLoginUI(false, null);
  }
}

/**
 * Open OP1.fun login modal and pre-fill email if available
 */
async function openOp1FunLoginModal() {
  // Pre-fill email if available
  try {
    const res = await fetch('/get-config-setting?config_option=OP1FUN_USER_EMAIL');
    const data = await res.json();
    if (data.config_value) {
      document.getElementById('op1fun-email').value = data.config_value;
    }
  } catch (err) {
    console.error('Error loading email:', err);
  }

  document.getElementById('op1fun-password').value = '';  // Always clear password

  const modal = new bootstrap.Modal(document.getElementById('op1funLoginModal'));
  modal.show();
}

/**
 * Handle OP1.fun login form submission
 */
async function op1funLogin() {
  const email = document.getElementById('op1fun-email').value.trim();
  const password = document.getElementById('op1fun-password').value;
  const loginBtn = document.getElementById('op1fun-login-btn');

  // Validate
  if (!email || !password) {
    toast.error('Please enter both email and password', 'Validation Error');
    return;
  }

  // Show loading state
  loginBtn.disabled = true;
  const originalText = loginBtn.textContent;
  loginBtn.textContent = 'Logging in...';

  try {
    const response = await fetch('/integrations/op1fun/api_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (response.ok && data.success) {
      bootstrap.Modal.getInstance(document.getElementById('op1funLoginModal')).hide();
      toast.success('You are now connected to OP1.fun', 'OP1.fun Login Successful');
      updateOp1FunLoginUI(true, email);
    } else {
      const errorMessage = data.error || 'Invalid credentials';
      toast.error(errorMessage, 'OP1.fun Login Failed');
    }
  } catch (err) {
    console.error('Error during login:', err);
    toast.error('Unable to connect to OP1.fun. Please check your internet connection.', 'Connection Error');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = originalText;
  }
}

/**
 * Handle OP1.fun logout
 */
async function op1funLogout() {
  try {
    const response = await fetch('/integrations/op1fun/clear_auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await response.json();

    if (response.ok && data.success) {
      toast.success('Your account has been disconnected from OP1.fun', 'Logged Out');
      updateOp1FunLoginUI(false, null);
    } else {
      toast.error('Failed to log out from OP1.fun', 'Error');
    }
  } catch (err) {
    console.error('Error during logout:', err);
    toast.error('Failed to log out from OP1.fun', 'Error');
  }
}


window.onload = function () {
  loadConfigPath("OPZ_MOUNT_PATH", "opz-path-holder");
  loadConfigPath("OP1_MOUNT_PATH", "op1-path-holder");
  loadConfigPath("WORKING_DIRECTORY", "working-dir-holder");
  loadLoggerLevel();
  loadDeveloperMode();
  loadOp1FunLoginState();

  enableAutoResizeInput(document.getElementById("opz-path-holder"));
  enableAutoResizeInput(document.getElementById("op1-path-holder"));
  enableAutoResizeInput(document.getElementById("working-dir-holder"));
};
