let currentSettings = null;

document.addEventListener("DOMContentLoaded", async () => {
  currentSettings = await loadSettings();
  renderFormats();
  renderBatchFilter();
  renderTransparency();
  renderNotifications();
});

// --- Format List ---

function renderFormats() {
  const list = document.getElementById("formatList");
  list.innerHTML = "";

  currentSettings.formats.forEach((fmt, index) => {
    const li = document.createElement("li");
    li.className = "format-item";
    li.draggable = true;
    li.dataset.index = index;

    li.innerHTML = `
      <span class="drag-handle">\u2807</span>
      <label class="toggle">
        <input type="checkbox" data-field="visible" ${fmt.visible ? "checked" : ""}>
        <span class="slider"></span>
      </label>
      <span class="format-label">${fmt.label}</span>
      <div class="format-controls">
        <span class="placement-toggle ${fmt.topLevel ? "top-level" : ""}"
              data-field="topLevel">
          ${fmt.topLevel ? "Top level" : "Others"}
        </span>
        <div class="format-settings">
          ${renderFormatSettings(fmt)}
        </div>
      </div>
    `;

    // Event: visibility toggle
    li.querySelector("[data-field='visible']").addEventListener("change", (e) => {
      currentSettings.formats[index].visible = e.target.checked;
      save();
    });

    // Event: placement toggle
    li.querySelector("[data-field='topLevel']").addEventListener("click", (e) => {
      currentSettings.formats[index].topLevel = !currentSettings.formats[index].topLevel;
      renderFormats();
      save();
    });

    // Event: format-specific settings
    const qualityInput = li.querySelector("[data-field='quality']");
    if (qualityInput) {
      const valueSpan = li.querySelector(".quality-value");
      qualityInput.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        currentSettings.formats[index].quality = val;
        if (valueSpan) valueSpan.textContent = val + "%";
        save();
      });
    }

    const sizeSelect = li.querySelector("[data-field='size']");
    if (sizeSelect) {
      sizeSelect.addEventListener("change", (e) => {
        currentSettings.formats[index].size = parseInt(e.target.value);
        save();
      });
    }

    // Drag events
    li.addEventListener("dragstart", onDragStart);
    li.addEventListener("dragover", onDragOver);
    li.addEventListener("dragleave", onDragLeave);
    li.addEventListener("drop", onDrop);
    li.addEventListener("dragend", onDragEnd);

    list.appendChild(li);
  });
}

function renderFormatSettings(fmt) {
  if ("quality" in fmt) {
    return `<span class="quality-value">${fmt.quality}%</span>
            <input type="range" min="1" max="100" value="${fmt.quality}" data-field="quality">`;
  }
  if ("size" in fmt) {
    return `<select data-field="size">
              ${[16, 32, 48, 64, 128, 256].map(
                (s) => `<option value="${s}" ${fmt.size === s ? "selected" : ""}>${s}\u00d7${s}</option>`
              ).join("")}
            </select>`;
  }
  return "";
}

// --- Drag and Drop Reorder ---

let dragIndex = null;

function onDragStart(e) {
  dragIndex = parseInt(e.currentTarget.dataset.index);
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}

function onDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add("drag-over");
}

function onDragLeave(e) {
  e.currentTarget.classList.remove("drag-over");
}

function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("drag-over");
  const dropIndex = parseInt(e.currentTarget.dataset.index);
  if (dragIndex === null || dragIndex === dropIndex) return;

  const [moved] = currentSettings.formats.splice(dragIndex, 1);
  currentSettings.formats.splice(dropIndex, 0, moved);
  renderFormats();
  save();
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  dragIndex = null;
}

// --- Batch Filter ---

function renderBatchFilter() {
  const bf = currentSettings.batchFilter || { minWidth: 100, maxWidth: 0, preferHighRes: true };

  const minInput = document.getElementById("batchMinWidth");
  const maxInput = document.getElementById("batchMaxWidth");
  const highResToggle = document.getElementById("batchPreferHighRes");

  minInput.value = bf.minWidth;
  maxInput.value = bf.maxWidth;
  highResToggle.checked = bf.preferHighRes !== false;

  minInput.addEventListener("change", (e) => {
    currentSettings.batchFilter.minWidth = parseInt(e.target.value) || 0;
    save();
  });

  maxInput.addEventListener("change", (e) => {
    currentSettings.batchFilter.maxWidth = parseInt(e.target.value) || 0;
    save();
  });

  highResToggle.addEventListener("change", (e) => {
    currentSettings.batchFilter.preferHighRes = e.target.checked;
    save();
  });
}

// --- Transparency ---

function renderTransparency() {
  const color = currentSettings.transparency.bgColor;
  const customColor = document.getElementById("customColor");
  const colorHex = document.getElementById("colorHex");

  customColor.value = color;
  colorHex.textContent = color;
  updatePresetActive(color);

  document.querySelectorAll(".color-preset").forEach((el) => {
    el.addEventListener("click", () => {
      const c = el.dataset.color;
      currentSettings.transparency.bgColor = c;
      customColor.value = c;
      colorHex.textContent = c;
      updatePresetActive(c);
      save();
    });
  });

  customColor.addEventListener("input", (e) => {
    currentSettings.transparency.bgColor = e.target.value;
    colorHex.textContent = e.target.value;
    updatePresetActive(e.target.value);
    save();
  });
}

function updatePresetActive(color) {
  document.querySelectorAll(".color-preset").forEach((el) => {
    el.classList.toggle("active", el.dataset.color === color);
  });
}

// --- Notifications ---

function renderNotifications() {
  const n = currentSettings.notifications;

  const badge = document.getElementById("showSuccessBadge");
  const errors = document.getElementById("showErrorNotifications");
  const action = document.getElementById("defaultAction");

  badge.checked = n.showSuccessBadge;
  errors.checked = n.showErrorNotifications;
  action.value = n.defaultAction;

  badge.addEventListener("change", (e) => {
    currentSettings.notifications.showSuccessBadge = e.target.checked;
    save();
  });

  errors.addEventListener("change", (e) => {
    currentSettings.notifications.showErrorNotifications = e.target.checked;
    save();
  });

  action.addEventListener("change", (e) => {
    currentSettings.notifications.defaultAction = e.target.value;
    save();
  });
}

// --- Save ---

let saveTimeout = null;

function save() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    await saveSettings(currentSettings);
    showSaveStatus();
  }, 300);
}

function showSaveStatus() {
  const el = document.getElementById("saveStatus");
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 1500);
}
