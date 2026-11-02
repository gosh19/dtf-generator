// ============================================================================
// Generador de PDF con Canales de Tinta DTF / UV-DTF (Spot Channels)
// Soporta importación directa de Adobe Illustrator (.ai con Zona Gris) y .svg
// ============================================================================

const state = {
  sourceMode: 'svg', // 'svg' | 'ai' | 'raster'
  svgText: null,
  rasterImg: null,
  fileName: 'ESTRADA (40 uni.)',
  svgNaturalWidthMm: 19.134667,
  svgNaturalHeightMm: 90.254667,
  aspectRatio: 19.134667 / 90.254667,
  lockAspect: true,
  rotate90: false,

  // Estado de archivo .AI (Zona Gris)
  aiDoc: null,           // { fileName, elements, designs, bbox }
  activeAiDesignIdx: 0,
  aiMergeDistMm: 2.0,
  aiIgnoreLargeBg: true,
  manualCropMode: false,
  dragCropStart: null,
  dragCropCurr: null,
  pasteboardScale: 0.45, // px por punto en el mapa de la zona gris

  // Configuración de salida
  dpi: 300,
  widthMm: 19.13,
  heightMm: 90.25,
  paddingPx: 0,
  clampToAlphaBBox: true,

  // Configuración de fondo transparente / Sacar fondo
  ignoreBgColor: false,
  bgColorHex: '#ffffff',
  extraBgColors: [],
  bgRemovalMode: 'flood_holes', // 'flood_holes' | 'flood' | 'global'
  bgTolerance: 18,
  bgDecontaminate: true,
  bgChokePx: 0,
  autoTrimBg: false,
  stripSvgBgRect: false,
  eyedropperActive: false,
  eyedropperAddMode: false,
  previewBackdrop: 'checker',

  // Canales Spot (por defecto idénticos al ejemplo: Spot 1..4)
  spotChannels: [
    { id: 1, enabled: true, name: 'Spot 1', offsetPx: -1, color: '#ff0000' },
    { id: 2, enabled: true, name: 'Spot 2', offsetPx: -1, color: '#ff0000' },
    { id: 3, enabled: true, name: 'Spot 3', offsetPx: +2, color: '#ff0000' },
    { id: 4, enabled: true, name: 'Spot 4', offsetPx: +2, color: '#ff0000' }
  ],
  nextSpotId: 5,

  // Vista previa
  activeView: 'composite', // 'pasteboard' | 'composite' | 'cmyk' | 'diff' | 'spot_0' ...
  spotViewMode: 'plate',   // 'plate' | 'ink'
  zoom: 1,

  // Buffers procesados del diseño actual
  widthPx: 226,
  heightPx: 1066,
  rawWidthPx: 226,
  rawHeightPx: 1066,
  rawRgbaBuffer: null,
  rgbaBuffer: null,
  cmykBuffer: null,
  alphaBuffer: null,
  spotBuffers: []
};

// ============================================================================
// Inicialización UI
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  bindUIEvents();
  renderSpotChannelsList();
  loadSampleEstradaSvg();
});

function showLoading(title, sub) {
  document.getElementById('loadingTitle').textContent = title || 'Procesando...';
  document.getElementById('loadingSub').textContent = sub || '';
  document.getElementById('loadingOverlay').classList.add('visible');
}

function hideLoading() {
  document.getElementById('loadingOverlay').classList.remove('visible');
}

function bindUIEvents() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleInputFile(e.dataTransfer.files[0]);
    }
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleInputFile(e.target.files[0]);
    }
  });

  const btnLoadSample = document.getElementById('btnLoadSample');
  if (btnLoadSample) {
    btnLoadSample.addEventListener('click', () => {
      loadSampleEstradaSvg();
    });
  }

  const btnLoadSampleAi = document.getElementById('btnLoadSampleAi');
  if (btnLoadSampleAi) {
    btnLoadSampleAi.addEventListener('click', async () => {
      try {
        showLoading('Cargando ejemplo_sura_garage.ai...', 'Descomprimiendo vectores e imágenes de la Zona Gris');
        const resp = await fetch('ejemplo_sura_garage.ai');
        if (!resp.ok) throw new Error('Usa el botón de arrastrar archivo si abriste el HTML sin servidor.');
        const ab = await resp.arrayBuffer();
        await loadAiArrayBuffer(ab, 'Prod SURA, GARAGE 29, HEXYCARS.ai');
      } catch (err) {
        hideLoading();
        alert('Para cargar el .AI directamente cuando abres index.html sin GeneradorDTF.exe, arrastra el archivo "Prod SURA, GARAGE 29, HEXYCARS.ai" al recuadro 1.');
      }
    });
  }

  // Controles de Separador .AI
  const aiIgnoreLargeBgChk = document.getElementById('aiIgnoreLargeBgChk');
  const aiMergeDistInput = document.getElementById('aiMergeDistInput');
  const aiMergeDistVal = document.getElementById('aiMergeDistVal');

  aiIgnoreLargeBgChk.addEventListener('change', () => {
    state.aiIgnoreLargeBg = aiIgnoreLargeBgChk.checked;
    rebuildAiDesignsList();
  });

  aiMergeDistInput.addEventListener('input', () => {
    state.aiMergeDistMm = parseFloat(aiMergeDistInput.value) || 0;
    aiMergeDistVal.textContent = state.aiMergeDistMm.toFixed(1);
    rebuildAiDesignsList();
  });

  document.getElementById('btnViewPasteboard').addEventListener('click', () => {
    if (!state.aiDoc) return;
    state.activeView = 'pasteboard';
    renderViewTabs();
    renderPreviewCanvas();
    fitCanvasToViewport();
  });

  const btnManualCropMode = document.getElementById('btnManualCropMode');
  btnManualCropMode.addEventListener('click', () => {
    if (!state.aiDoc) return;
    state.manualCropMode = !state.manualCropMode;
    btnManualCropMode.classList.toggle('btn-active', state.manualCropMode);
    document.getElementById('manualCropBanner').classList.toggle('visible', state.manualCropMode);
    if (state.manualCropMode && state.activeView !== 'pasteboard') {
      state.activeView = 'pasteboard';
      renderViewTabs();
      renderPreviewCanvas();
      fitCanvasToViewport();
    }
  });

  const chkMasterSelectAi = document.getElementById('chkMasterSelectAi');
  if (chkMasterSelectAi) {
    chkMasterSelectAi.addEventListener('change', () => {
      if (!state.aiDoc) return;
      const val = chkMasterSelectAi.checked;
      state.aiDoc.designs.forEach(d => { d.selected = val; });
      renderAiDesignsSidebar();
      if (state.activeView === 'pasteboard') renderPreviewCanvas();
    });
  }

  document.getElementById('btnSelectAllAi').addEventListener('click', () => {
    if (!state.aiDoc) return;
    state.aiDoc.designs.forEach(d => { d.selected = true; });
    renderAiDesignsSidebar();
    if (state.activeView === 'pasteboard') renderPreviewCanvas();
  });

  document.getElementById('btnDeselectAllAi').addEventListener('click', () => {
    if (!state.aiDoc) return;
    state.aiDoc.designs.forEach(d => { d.selected = false; });
    renderAiDesignsSidebar();
    if (state.activeView === 'pasteboard') renderPreviewCanvas();
  });

  document.getElementById('btnExportBatchAi').addEventListener('click', async () => {
    await exportBatchAiPdfs();
  });

  // Rotar 90°
  document.getElementById('btnRotate90').addEventListener('click', () => {
    state.rotate90 = !state.rotate90;
    const tmp = state.widthMm;
    state.widthMm = state.heightMm;
    state.heightMm = tmp;
    state.aspectRatio = state.widthMm / state.heightMm;
    document.getElementById('widthMmInput').value = +state.widthMm.toFixed(2);
    document.getElementById('heightMmInput').value = +state.heightMm.toFixed(2);
    document.getElementById('btnRotate90').classList.toggle('btn-active', state.rotate90);
    processCurrentDesign();
  });

  // Dimensiones y DPI
  const dpiInput = document.getElementById('dpiInput');
  const widthMmInput = document.getElementById('widthMmInput');
  const heightMmInput = document.getElementById('heightMmInput');
  const lockAspectChk = document.getElementById('lockAspectChk');
  const paddingPxInput = document.getElementById('paddingPxInput');
  const clampBBoxChk = document.getElementById('clampBBoxChk');

  dpiInput.addEventListener('change', () => {
    state.dpi = Math.max(36, Math.min(2400, parseInt(dpiInput.value, 10) || 300));
    dpiInput.value = state.dpi;
    processCurrentDesign();
  });

  widthMmInput.addEventListener('change', () => {
    const val = Math.max(1, parseFloat(widthMmInput.value) || 19.13);
    state.widthMm = val;
    if (state.lockAspect && state.aspectRatio > 0) {
      state.heightMm = +(val / state.aspectRatio).toFixed(2);
      heightMmInput.value = state.heightMm;
    }
    processCurrentDesign();
  });

  heightMmInput.addEventListener('change', () => {
    const val = Math.max(1, parseFloat(heightMmInput.value) || 90.25);
    state.heightMm = val;
    if (state.lockAspect && state.aspectRatio > 0) {
      state.widthMm = +(val * state.aspectRatio).toFixed(2);
      widthMmInput.value = state.widthMm;
    }
    processCurrentDesign();
  });

  lockAspectChk.addEventListener('change', () => {
    state.lockAspect = lockAspectChk.checked;
  });

  paddingPxInput.addEventListener('change', () => {
    state.paddingPx = Math.max(0, Math.min(100, parseInt(paddingPxInput.value, 10) || 0));
    paddingPxInput.value = state.paddingPx;
    processCurrentDesign();
  });

  clampBBoxChk.addEventListener('change', () => {
    state.clampToAlphaBBox = clampBBoxChk.checked;
    recomputeSpotChannelsAndRender();
  });

  // Fondo / Transparencia
  const ignoreBgChk = document.getElementById('ignoreBgChk');
  const bgPickerPanel = document.getElementById('bgPickerPanel');
  const bgColorInput = document.getElementById('bgColorInput');
  const bgToleranceInput = document.getElementById('bgToleranceInput');
  const bgToleranceVal = document.getElementById('bgToleranceVal');
  const stripSvgBgRectChk = document.getElementById('stripSvgBgRectChk');
  const btnEyedropper = document.getElementById('btnEyedropper');
  const btnAddExtraBgColor = document.getElementById('btnAddExtraBgColor');
  const btnAutoCornerBg = document.getElementById('btnAutoCornerBg');
  const btnBgWhite = document.getElementById('btnBgWhite');
  const btnBgBlack = document.getElementById('btnBgBlack');
  const bgRemovalModeSelect = document.getElementById('bgRemovalModeSelect');
  const bgChokePxInput = document.getElementById('bgChokePxInput');
  const bgDecontaminateChk = document.getElementById('bgDecontaminateChk');
  const autoTrimBgChk = document.getElementById('autoTrimBgChk');
  const btnAutoRemoveBg = document.getElementById('btnAutoRemoveBg');
  const btnResetBg = document.getElementById('btnResetBg');
  const btnQuickRemoveBg = document.getElementById('btnQuickRemoveBg');
  const btnQuickEyedropper = document.getElementById('btnQuickEyedropper');
  const previewBackdropSelect = document.getElementById('previewBackdropSelect');

  ignoreBgChk.addEventListener('change', () => {
    state.ignoreBgColor = ignoreBgChk.checked;
    syncBgRemovalUI();
    processCurrentDesign();
  });

  bgColorInput.addEventListener('input', () => {
    state.bgColorHex = bgColorInput.value;
    if (!state.ignoreBgColor) {
      state.ignoreBgColor = true;
      syncBgRemovalUI();
    }
    processCurrentDesign();
  });

  bgToleranceInput.addEventListener('input', () => {
    state.bgTolerance = parseInt(bgToleranceInput.value, 10) || 0;
    bgToleranceVal.textContent = state.bgTolerance;
    if (state.ignoreBgColor) processCurrentDesign();
  });

  if (bgRemovalModeSelect) {
    bgRemovalModeSelect.addEventListener('change', () => {
      state.bgRemovalMode = bgRemovalModeSelect.value;
      if (state.ignoreBgColor) processCurrentDesign();
    });
  }

  if (bgChokePxInput) {
    bgChokePxInput.addEventListener('change', () => {
      state.bgChokePx = Math.max(0, Math.min(5, parseInt(bgChokePxInput.value, 10) || 0));
      bgChokePxInput.value = state.bgChokePx;
      if (state.ignoreBgColor || state.stripSvgBgRect) processCurrentDesign();
    });
  }

  if (bgDecontaminateChk) {
    bgDecontaminateChk.addEventListener('change', () => {
      state.bgDecontaminate = bgDecontaminateChk.checked;
      if (state.ignoreBgColor) processCurrentDesign();
    });
  }

  if (autoTrimBgChk) {
    autoTrimBgChk.addEventListener('change', () => {
      state.autoTrimBg = autoTrimBgChk.checked;
      processCurrentDesign();
    });
  }

  stripSvgBgRectChk.addEventListener('change', () => {
    state.stripSvgBgRect = stripSvgBgRectChk.checked;
    syncBgRemovalUI();
    processCurrentDesign();
  });

  const toggleEyedropperMode = (addMode = false) => {
    if (state.eyedropperActive && state.eyedropperAddMode === addMode) {
      setEyedropperState(false, false);
    } else {
      if (state.activeView === 'pasteboard') {
        state.activeView = 'composite';
        renderViewTabs();
        renderPreviewCanvas();
        fitCanvasToViewport();
      }
      setEyedropperState(true, addMode);
    }
  };

  btnEyedropper.addEventListener('click', () => toggleEyedropperMode(false));
  if (btnAddExtraBgColor) {
    btnAddExtraBgColor.addEventListener('click', () => toggleEyedropperMode(true));
  }
  if (btnQuickEyedropper) {
    btnQuickEyedropper.addEventListener('click', () => toggleEyedropperMode(false));
  }

  btnAutoCornerBg.addEventListener('click', () => {
    const srcBuf = state.rawRgbaBuffer || state.rgbaBuffer;
    const srcW = state.rawRgbaBuffer ? state.rawWidthPx : state.widthPx;
    const srcH = state.rawRgbaBuffer ? state.rawHeightPx : state.heightPx;
    if (!srcBuf) return;
    const hex = detectDominantBorderColor(srcBuf, srcW, srcH);
    state.bgColorHex = hex;
    bgColorInput.value = hex;
    state.ignoreBgColor = true;
    syncBgRemovalUI();
    processCurrentDesign();
  });

  if (btnBgWhite) {
    btnBgWhite.addEventListener('click', () => {
      state.bgColorHex = '#ffffff';
      bgColorInput.value = '#ffffff';
      state.ignoreBgColor = true;
      syncBgRemovalUI();
      processCurrentDesign();
    });
  }

  if (btnBgBlack) {
    btnBgBlack.addEventListener('click', () => {
      state.bgColorHex = '#000000';
      bgColorInput.value = '#000000';
      state.ignoreBgColor = true;
      syncBgRemovalUI();
      processCurrentDesign();
    });
  }

  if (btnAutoRemoveBg) {
    btnAutoRemoveBg.addEventListener('click', () => {
      triggerAutoRemoveBackground();
    });
  }

  if (btnResetBg) {
    btnResetBg.addEventListener('click', () => {
      resetBackgroundRemoval();
    });
  }

  if (btnQuickRemoveBg) {
    btnQuickRemoveBg.addEventListener('click', () => {
      if (state.ignoreBgColor || state.stripSvgBgRect) {
        resetBackgroundRemoval();
      } else {
        triggerAutoRemoveBackground();
      }
    });
  }

  if (previewBackdropSelect) {
    previewBackdropSelect.addEventListener('change', () => {
      state.previewBackdrop = previewBackdropSelect.value;
      const vp = document.getElementById('canvasViewport');
      if (vp) {
        vp.classList.remove('backdrop-dark', 'backdrop-light', 'backdrop-contrast');
        if (state.previewBackdrop === 'dark') vp.classList.add('backdrop-dark');
        else if (state.previewBackdrop === 'light') vp.classList.add('backdrop-light');
        else if (state.previewBackdrop === 'contrast') vp.classList.add('backdrop-contrast');
      }
    });
  }

  // Presets de canales Spot
  document.getElementById('presetExample4').addEventListener('click', () => {
    state.spotChannels = [
      { id: 1, enabled: true, name: 'Spot 1', offsetPx: -1, color: '#ff0000' },
      { id: 2, enabled: true, name: 'Spot 2', offsetPx: -1, color: '#ff0000' },
      { id: 3, enabled: true, name: 'Spot 3', offsetPx: +2, color: '#ff0000' },
      { id: 4, enabled: true, name: 'Spot 4', offsetPx: +2, color: '#ff0000' }
    ];
    state.nextSpotId = 5;
    renderSpotChannelsList();
    recomputeSpotChannelsAndRender();
  });

  document.getElementById('presetWhite1').addEventListener('click', () => {
    state.spotChannels = [
      { id: 1, enabled: true, name: 'Spot 1', offsetPx: -1, color: '#ff0000' }
    ];
    state.nextSpotId = 2;
    if (state.activeView.startsWith('spot_')) state.activeView = 'composite';
    renderSpotChannelsList();
    recomputeSpotChannelsAndRender();
  });

  document.getElementById('presetWhiteVarnish2').addEventListener('click', () => {
    state.spotChannels = [
      { id: 1, enabled: true, name: 'Spot 1', offsetPx: -1, color: '#ff0000' },
      { id: 2, enabled: true, name: 'Spot 2', offsetPx: +2, color: '#ff0000' }
    ];
    state.nextSpotId = 3;
    if (state.activeView.startsWith('spot_')) state.activeView = 'composite';
    renderSpotChannelsList();
    recomputeSpotChannelsAndRender();
  });

  document.getElementById('btnAddSpot').addEventListener('click', () => {
    const idx = state.spotChannels.length + 1;
    state.spotChannels.push({
      id: state.nextSpotId++,
      enabled: true,
      name: `Spot ${idx}`,
      offsetPx: -1,
      color: '#ff0000'
    });
    renderSpotChannelsList();
    recomputeSpotChannelsAndRender();
  });

  // Zoom controls
  document.getElementById('btnZoomOut').addEventListener('click', () => setZoom(state.zoom / 1.4));
  document.getElementById('btnZoomIn').addEventListener('click', () => setZoom(state.zoom * 1.4));
  document.getElementById('btnZoomFit').addEventListener('click', () => fitCanvasToViewport());
  document.getElementById('btnSpotModeToggle').addEventListener('click', () => {
    state.spotViewMode = state.spotViewMode === 'plate' ? 'ink' : 'plate';
    updateSpotModeButtonText();
    renderPreviewCanvas();
  });

  // Interacción sobre el canvas (Inspector + Gotero + Selección en Mapa Zona Gris .AI)
  const canvas = document.getElementById('previewCanvas');

  canvas.addEventListener('mousedown', (e) => {
    if (state.activeView === 'pasteboard' && state.aiDoc) {
      const pt = canvasEventToAiPoint(e, canvas);
      if (state.manualCropMode) {
        state.dragCropStart = pt;
        state.dragCropCurr = pt;
      } else {
        // Verificar si hizo clic dentro de algún diseño detectado
        for (let i = state.aiDoc.designs.length - 1; i >= 0; i--) {
          const d = state.aiDoc.designs[i];
          if (pt.x >= d.minX && pt.x <= d.maxX && pt.y >= d.minY && pt.y <= d.maxY) {
            selectAiDesign(i, true);
            break;
          }
        }
      }
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (state.activeView === 'pasteboard' && state.aiDoc) {
      const pt = canvasEventToAiPoint(e, canvas);
      document.getElementById('pixelInspector').textContent =
        `Zona Gris .AI | Coordenadas: X=${pt.x.toFixed(1)} pt, Y=${pt.y.toFixed(1)} pt | Haz clic en cualquier recuadro para abrir sus canales Spot`;
      if (state.manualCropMode && state.dragCropStart) {
        state.dragCropCurr = pt;
        renderPreviewCanvas();
      }
      return;
    }

    if (!state.cmykBuffer) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * state.widthPx);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * state.heightPx);
    if (x >= 0 && x < state.widthPx && y >= 0 && y < state.heightPx) {
      const idx = y * state.widthPx + x;
      const c = Math.round((state.cmykBuffer[idx * 4] / 255) * 100);
      const m = Math.round((state.cmykBuffer[idx * 4 + 1] / 255) * 100);
      const yv = Math.round((state.cmykBuffer[idx * 4 + 2] / 255) * 100);
      const k = Math.round((state.cmykBuffer[idx * 4 + 3] / 255) * 100);
      const a = Math.round((state.alphaBuffer[idx] / 255) * 100);
      const spotsInfo = state.spotBuffers
        .map(sb => `${sb.channel.name}:${Math.round((sb.inkMask[idx] / 255) * 100)}%`)
        .join(' ');
      document.getElementById('pixelInspector').textContent =
        `X:${x} Y:${y} | CMYK(${c}%,${m}%,${yv}%,${k}%) Opacidad:${a}% | ${spotsInfo}`;
    }
  });

  window.addEventListener('mouseup', () => {
    if (state.activeView === 'pasteboard' && state.manualCropMode && state.dragCropStart && state.dragCropCurr) {
      const p1 = state.dragCropStart;
      const p2 = state.dragCropCurr;
      state.dragCropStart = null;
      state.dragCropCurr = null;

      const minX = Math.min(p1.x, p2.x);
      const maxX = Math.max(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const maxY = Math.max(p1.y, p2.y);

      if (maxX - minX > 5 && maxY - minY > 5) {
        createManualCropDesign(minX, minY, maxX, maxY);
      } else {
        renderPreviewCanvas();
      }
    }
  });

  canvas.addEventListener('click', (e) => {
    if (state.activeView === 'pasteboard') return;
    if (!state.eyedropperActive || !state.rgbaBuffer) return;

    const rect = canvas.getBoundingClientRect();
    const cx = Math.floor(((e.clientX - rect.left) / rect.width) * state.widthPx);
    const cy = Math.floor(((e.clientY - rect.top) / rect.height) * state.heightPx);
    if (cx >= 0 && cx < state.widthPx && cy >= 0 && cy < state.heightPx) {
      const cIdx = (cy * state.widthPx + cx) * 4;
      let r = state.rgbaBuffer[cIdx];
      let g = state.rgbaBuffer[cIdx + 1];
      let b = state.rgbaBuffer[cIdx + 2];
      const a = state.rgbaBuffer[cIdx + 3];

      // Si hizo clic sobre una zona que ya estaba transparente, leer el color original de rawRgbaBuffer
      if (a === 0 && state.rawRgbaBuffer) {
        const rx = Math.floor(((e.clientX - rect.left) / rect.width) * state.rawWidthPx);
        const ry = Math.floor(((e.clientY - rect.top) / rect.height) * state.rawHeightPx);
        const rIdx = (ry * state.rawWidthPx + rx) * 4;
        r = state.rawRgbaBuffer[rIdx];
        g = state.rawRgbaBuffer[rIdx + 1];
        b = state.rawRgbaBuffer[rIdx + 2];
      }

      const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toLowerCase();

      if (state.eyedropperAddMode && state.ignoreBgColor) {
        if (hex !== state.bgColorHex.toLowerCase() && !state.extraBgColors.includes(hex)) {
          state.extraBgColors.push(hex);
        }
      } else {
        state.bgColorHex = hex;
        document.getElementById('bgColorInput').value = hex;
      }
      state.ignoreBgColor = true;
      setEyedropperState(false, false);
      syncBgRemovalUI();
      processCurrentDesign();
    }
  });

  // Campo de nombre de archivo PDF a exportar
  const exportFileNameInput = document.getElementById('exportFileNameInput');
  if (exportFileNameInput) {
    exportFileNameInput.addEventListener('input', () => {
      const val = exportFileNameInput.value.replace(/\.pdf$/i, '');
      state.fileName = val || 'Archivo_DTF';
      if (state.sourceMode === 'ai' && state.aiDoc && state.aiDoc.designs[state.activeAiDesignIdx]) {
        state.aiDoc.designs[state.activeAiDesignIdx].name = state.fileName;
        const activeNameInput = document.querySelector(`.ai-design-name-input[data-idx="${state.activeAiDesignIdx}"]`);
        if (activeNameInput && document.activeElement !== activeNameInput) {
          activeNameInput.value = state.fileName;
        }
      }
    });
  }

  // Botón Generar PDF Actual
  document.getElementById('btnExportPdf').addEventListener('click', async () => {
    await exportPdfFile();
  });
}

function canvasEventToAiPoint(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const cx = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const cy = ((e.clientY - rect.top) / rect.height) * canvas.height;
  const bb = state.aiDoc.bbox;
  const padPt = 40;
  const x = (bb.minX - padPt) + cx / state.pasteboardScale;
  const y = (bb.maxY + padPt) - cy / state.pasteboardScale;
  return { x, y };
}

function createManualCropDesign(minX, minY, maxX, maxY) {
  if (!state.aiDoc) return;
  const matching = state.aiDoc.elements.filter(el => {
    if (state.aiIgnoreLargeBg && el.isBgRect) return false;
    const overlapX = !(el.maxX < minX || maxX < el.minX);
    const overlapY = !(el.maxY < minY || maxY < el.minY);
    return overlapX && overlapY;
  });

  if (matching.length === 0) {
    renderPreviewCanvas();
    return;
  }

  const widthPt = maxX - minX;
  const heightPt = maxY - minY;
  const widthMm = +(widthPt * 25.4 / 72).toFixed(2);
  const heightMm = +(heightPt * 25.4 / 72).toFixed(2);
  const newIdx = state.aiDoc.designs.length;

  state.aiDoc.designs.push({
    id: newIdx,
    selected: true,
    name: `Recorte Manual #${newIdx + 1} (${widthMm}×${heightMm} mm)`,
    minX,
    minY,
    maxX,
    maxY,
    widthPt,
    heightPt,
    widthMm,
    heightMm,
    elements: matching
  });

  state.manualCropMode = false;
  document.getElementById('btnManualCropMode').classList.remove('btn-active');
  document.getElementById('manualCropBanner').classList.remove('visible');

  renderAiDesignsSidebar();
  selectAiDesign(newIdx, true);
}

function updateSpotModeButtonText() {
  const btn = document.getElementById('btnSpotModeToggle');
  btn.textContent = state.spotViewMode === 'plate'
    ? 'Vista Canal: Placa B/N (Photoshop)'
    : 'Vista Canal: Tinta Roja';
}

function setZoom(newZoom) {
  const canvas = document.getElementById('previewCanvas');
  state.zoom = Math.max(0.1, Math.min(16, newZoom));
  canvas.style.width = `${Math.round(canvas.width * state.zoom)}px`;
  canvas.style.height = `${Math.round(canvas.height * state.zoom)}px`;
  document.getElementById('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitCanvasToViewport() {
  const vp = document.getElementById('canvasViewport');
  const canvas = document.getElementById('previewCanvas');
  if (!vp || !canvas.width || !canvas.height) return;
  const availW = Math.max(100, vp.clientWidth - 60);
  const availH = Math.max(100, vp.clientHeight - 60);
  const z = Math.min(availW / canvas.width, availH / canvas.height);
  setZoom(z);
}

// ============================================================================
// Manejo de Archivos de Entrada (.AI, .SVG o .PNG)
// ============================================================================
function showFileError(msgHtml) {
  const banner = document.getElementById('fileErrorBanner');
  const dropzone = document.getElementById('dropzone');
  if (banner) {
    if (msgHtml) banner.innerHTML = msgHtml;
    banner.classList.add('visible');
  }
  if (dropzone) {
    dropzone.classList.add('dropzone-error');
  }
}

function clearFileError() {
  const banner = document.getElementById('fileErrorBanner');
  const dropzone = document.getElementById('dropzone');
  if (banner) banner.classList.remove('visible');
  if (dropzone) dropzone.classList.remove('dropzone-error');
}

function handleInputFile(file) {
  const name = (file && file.name) ? file.name : '';
  const lower = name.toLowerCase();
  const isPng = lower.endsWith('.png') || (file && file.type === 'image/png');

  if (!lower.endsWith('.ai') && !lower.endsWith('.svg') && !isPng) {
    showFileError(`⚠️ Formato no válido (<strong>${escapeHtml(name)}</strong>). Solo se permiten archivos <strong>.AI</strong>, <strong>.SVG</strong> o <strong>.PNG</strong>.`);
    return;
  }

  clearFileError();

  if (isPng) {
    loadRasterFile(file);
  } else if (lower.endsWith('.svg')) {
    const reader = new FileReader();
    reader.onload = (e) => loadSvgString(e.target.result, name);
    reader.readAsText(file, 'utf-8');
  } else {
    // Archivo .AI
    showLoading(`Importando ${name}...`, 'Procesando vectores e imágenes del archivo .AI');
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        await loadAiArrayBuffer(e.target.result, name);
      } catch (err) {
        console.error(err);
        showFileError('⚠️ Error al leer el archivo .AI: ' + escapeHtml(err.message));
      } finally {
        hideLoading();
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

function loadRasterFile(file) {
  const name = (file && file.name) ? file.name : 'imagen.png';
  showLoading(`Importando ${name}...`, 'Procesando imagen PNG y generando canales Spot');
  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    URL.revokeObjectURL(url);
    state.sourceMode = 'raster';
    state.aiDoc = null;
    state.svgText = null;
    state.rasterImg = img;
    state.rotate90 = false;
    document.getElementById('btnRotate90').classList.remove('btn-active');

    state.fileName = name.replace(/\.png$/i, '');
    const hdrInput = document.getElementById('exportFileNameInput');
    if (hdrInput) hdrInput.value = state.fileName;

    const loadedEl = document.getElementById('loadedFileName');
    loadedEl.textContent = name;
    loadedEl.title = name;

    document.getElementById('fileTypeBadge').textContent = 'PNG';
    document.getElementById('aiSeparatorCard').style.display = 'none';
    if (state.activeView === 'pasteboard') state.activeView = 'composite';

    const natW = Math.max(1, img.naturalWidth || img.width || 300);
    const natH = Math.max(1, img.naturalHeight || img.height || 300);
    const wMm = (natW / state.dpi) * 25.4;
    const hMm = (natH / state.dpi) * 25.4;

    state.svgNaturalWidthMm = wMm;
    state.svgNaturalHeightMm = hMm;
    state.aspectRatio = natW / natH;
    state.widthMm = +wMm.toFixed(4);
    state.heightMm = +hMm.toFixed(4);
    document.getElementById('widthMmInput').value = +wMm.toFixed(2);
    document.getElementById('heightMmInput').value = +hMm.toFixed(2);

    processCurrentDesign(true);
    hideLoading();
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    hideLoading();
    showFileError(`⚠️ No se pudo cargar la imagen PNG (<strong>${escapeHtml(name)}</strong>).`);
  };

  img.src = url;
}

async function loadAiArrayBuffer(arrayBuffer, fileName) {
  showLoading(`Analizando ${fileName}...`, 'Extrayendo capas y separando diseños');
  // Dar un respiro de 20ms para que el navegador pinte el cartel de carga
  await new Promise(r => setTimeout(r, 30));

  const aiDoc = await window.AiParser.parseAiBuffer(arrayBuffer, fileName);
  state.sourceMode = 'ai';
  state.aiDoc = aiDoc;
  state.rotate90 = false;
  document.getElementById('btnRotate90').classList.remove('btn-active');
  const loadedEl = document.getElementById('loadedFileName');
  loadedEl.textContent = fileName;
  loadedEl.title = fileName;
  document.getElementById('fileTypeBadge').textContent = 'AI';
  document.getElementById('aiSeparatorCard').style.display = 'block';

  rebuildAiDesignsList(false);

  // Seleccionar el primer diseño principal pero mostrar el Mapa
  if (state.aiDoc.designs.length > 0) {
    selectAiDesign(0, false);
  }
  state.activeView = 'pasteboard';
  renderViewTabs();
  renderPreviewCanvas();
  fitCanvasToViewport();
  hideLoading();
}

function rebuildAiDesignsList(reRender = true) {
  if (!state.aiDoc) return;
  const filteredElements = state.aiIgnoreLargeBg
    ? state.aiDoc.elements
    : state.aiDoc.elements.map(e => ({ ...e, isBgRect: false }));

  state.aiDoc.designs = window.AiParser.buildSeparatedDesigns(filteredElements, state.aiMergeDistMm);
  if (state.activeAiDesignIdx >= state.aiDoc.designs.length) {
    state.activeAiDesignIdx = 0;
  }
  renderAiDesignsSidebar();
  if (reRender) {
    if (state.activeView === 'pasteboard') {
      renderPreviewCanvas();
    } else if (state.aiDoc.designs.length > 0) {
      selectAiDesign(state.activeAiDesignIdx, false);
    }
  }
}

function updateAiSelectionCounters() {
  if (!state.aiDoc) return;
  const designs = state.aiDoc.designs;
  const selectedCount = designs.filter(d => d.selected).length;
  document.getElementById('aiDesignCountBadge').textContent = `${designs.length} detectados`;
  document.getElementById('btnExportBatchAi').textContent =
    `⬇ Exportar Seleccionados (${selectedCount} PDF${selectedCount === 1 ? '' : 's'})`;
  document.getElementById('btnExportBatchAi').disabled = selectedCount === 0;

  const lbl = document.getElementById('lblSelectedAiCount');
  if (lbl) lbl.textContent = `${selectedCount} de ${designs.length} seleccionados`;

  const masterChk = document.getElementById('chkMasterSelectAi');
  if (masterChk) {
    masterChk.checked = designs.length > 0 && selectedCount === designs.length;
    masterChk.indeterminate = selectedCount > 0 && selectedCount < designs.length;
  }
}

function renderAiDesignsSidebar() {
  const listEl = document.getElementById('aiDesignsList');
  listEl.innerHTML = '';
  if (!state.aiDoc) return;

  const designs = state.aiDoc.designs;
  updateAiSelectionCounters();

  designs.forEach((d, idx) => {
    const item = document.createElement('div');
    item.className = 'ai-design-item' + (state.activeAiDesignIdx === idx ? ' active' : '');
    item.innerHTML = `
      <input type="checkbox" class="ai-design-chk" ${d.selected ? 'checked' : ''} title="Marcar este diseño para exportar en lote" />
      <div class="ai-design-meta">
        <input type="text" class="ai-design-name-input" data-idx="${idx}" value="${escapeHtml(d.name)}" title="Nombre del PDF para este diseño" style="width:100%; padding:2px 5px; font-size:12px; font-weight:600; margin-bottom:2px;" />
        <div class="ai-design-dim">#${idx + 1} · ${d.widthMm} × ${d.heightMm} mm (${d.elements.length} obj)</div>
      </div>
      <div class="ai-design-actions">
        <button class="btn btn-sm btn-icon ai-open-btn" title="Previsualizar canales Spot de este diseño">Ver</button>
        <button class="btn btn-sm btn-success btn-icon ai-dl-btn" style="padding:5px 8px; font-size:11.5px;" title="Descargar ahora el PDF con canales Spot de este diseño">⬇ PDF</button>
      </div>
    `;

    const chk = item.querySelector('.ai-design-chk');
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      d.selected = chk.checked;
      updateAiSelectionCounters();
      if (state.activeView === 'pasteboard') renderPreviewCanvas();
    });

    const nameInput = item.querySelector('.ai-design-name-input');
    nameInput.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.activeAiDesignIdx !== idx) {
        selectAiDesign(idx, false);
      }
    });
    nameInput.addEventListener('input', () => {
      d.name = nameInput.value.trim() || `Diseño ${idx + 1}`;
      if (state.activeAiDesignIdx === idx) {
        state.fileName = d.name;
        const hdrInput = document.getElementById('exportFileNameInput');
        if (hdrInput) hdrInput.value = d.name;
      }
    });

    const openBtn = item.querySelector('.ai-open-btn');
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectAiDesign(idx, true);
    });

    const dlBtn = item.querySelector('.ai-dl-btn');
    dlBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await exportSingleAiDesignByIndex(idx, dlBtn);
    });

    item.addEventListener('click', () => {
      selectAiDesign(idx, true);
    });

    listEl.appendChild(item);
  });
}

function selectAiDesign(idx, switchToComposite = true) {
  if (!state.aiDoc || !state.aiDoc.designs[idx]) return;
  state.activeAiDesignIdx = idx;
  const d = state.aiDoc.designs[idx];

  state.fileName = d.name.replace(/[\\/:*?"<>|]/g, '_');
  const hdrInput = document.getElementById('exportFileNameInput');
  if (hdrInput) hdrInput.value = state.fileName;
  state.widthMm = state.rotate90 ? d.heightMm : d.widthMm;
  state.heightMm = state.rotate90 ? d.widthMm : d.heightMm;
  state.aspectRatio = state.widthMm / state.heightMm;

  document.getElementById('widthMmInput').value = +state.widthMm.toFixed(2);
  document.getElementById('heightMmInput').value = +state.heightMm.toFixed(2);

  renderAiDesignsSidebar();
  if (switchToComposite) {
    state.activeView = 'composite';
  }
  processCurrentDesign(switchToComposite);
}

// ============================================================================
// Carga y Parseo de SVG
// ============================================================================
function loadSampleEstradaSvg() {
  if (window.DTF_SAMPLE_SVG_B64) {
    const bin = atob(window.DTF_SAMPLE_SVG_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder('utf-8').decode(bytes);
    loadSvgString(text, 'ESTRADA (40 uni.).svg');
  }
}

function parseSvgUnitToMm(valStr) {
  if (!valStr) return null;
  const m = String(valStr).trim().match(/^([0-9.]+)\s*(mm|cm|in|pt|pc|px)?$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (isNaN(num) || num <= 0) return null;
  const unit = (m[2] || 'px').toLowerCase();
  switch (unit) {
    case 'mm': return num;
    case 'cm': return num * 10;
    case 'in': return num * 25.4;
    case 'pt': return num * (25.4 / 72);
    case 'pc': return num * (25.4 / 6);
    case 'px': return num * (25.4 / 96);
    default: return num * (25.4 / 96);
  }
}

function loadSvgString(svgText, fileName) {
  state.sourceMode = 'svg';
  state.aiDoc = null;
  state.svgText = svgText;
  state.rotate90 = false;
  document.getElementById('btnRotate90').classList.remove('btn-active');
  state.fileName = fileName.replace(/\.svg$/i, '');
  const hdrInput = document.getElementById('exportFileNameInput');
  if (hdrInput) hdrInput.value = state.fileName;
  const loadedEl = document.getElementById('loadedFileName');
  loadedEl.textContent = fileName;
  loadedEl.title = fileName;
  document.getElementById('fileTypeBadge').textContent = 'SVG';
  document.getElementById('aiSeparatorCard').style.display = 'none';
  if (state.activeView === 'pasteboard') state.activeView = 'composite';

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');

  if (svgEl) {
    const wAttr = svgEl.getAttribute('width');
    const hAttr = svgEl.getAttribute('height');
    const vbAttr = svgEl.getAttribute('viewBox');

    let wMm = parseSvgUnitToMm(wAttr);
    let hMm = parseSvgUnitToMm(hAttr);

    if (vbAttr) {
      const parts = vbAttr.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        if (!wMm && !hMm) {
          wMm = parts[2] * (25.4 / 72);
          hMm = parts[3] * (25.4 / 72);
        } else if (wMm && !hMm) {
          hMm = wMm * (parts[3] / parts[2]);
        } else if (!wMm && hMm) {
          wMm = hMm * (parts[2] / parts[3]);
        }
      }
    }

    if (wMm && hMm) {
      state.svgNaturalWidthMm = wMm;
      state.svgNaturalHeightMm = hMm;
      state.aspectRatio = wMm / hMm;
      state.widthMm = +wMm.toFixed(4);
      state.heightMm = +hMm.toFixed(4);
      document.getElementById('widthMmInput').value = +wMm.toFixed(2);
      document.getElementById('heightMmInput').value = +hMm.toFixed(2);
    }
  }

  processCurrentDesign(true);
}

// ============================================================================
// Procesamiento del Diseño Activo (.AI, .SVG o Imagen) a CMYK + Alfa + Spot
// ============================================================================
function processCurrentDesign(fitOnFinish = false) {
  syncBgRemovalUI();

  if (state.sourceMode === 'ai' && state.aiDoc) {
    const d = state.aiDoc.designs[state.activeAiDesignIdx];
    if (!d) return;

    // Escalar respecto al tamaño original del diseño si el usuario editó Ancho/Alto en mm
    const targetWMm = state.rotate90 ? state.heightMm : state.widthMm;
    const scaleFactor = targetWMm / Math.max(0.1, d.widthMm);
    const effectiveDpi = state.dpi * scaleFactor;

    const rendered = window.AiParser.renderDesignToBuffers(
      d,
      effectiveDpi,
      state.paddingPx,
      state.rotate90,
      state.stripSvgBgRect
    );

    state.rawWidthPx = rendered.widthPx;
    state.rawHeightPx = rendered.heightPx;
    state.rawRgbaBuffer = new Uint8ClampedArray(rendered.rgba);

    const processed = applyFullBackgroundPipeline(rendered.rgba, rendered.cmyk, rendered.alpha, rendered.widthPx, rendered.heightPx);
    state.widthPx = processed.widthPx;
    state.heightPx = processed.heightPx;
    state.rgbaBuffer = processed.rgba;
    state.cmykBuffer = processed.cmyk;
    state.alphaBuffer = processed.alpha;

    updateDimensionsHeaderBadge();
    recomputeSpotChannelsAndRender();
    if (fitOnFinish) {
      fitCanvasToViewport();
    } else if (state.activeView !== 'pasteboard') {
      setZoom(state.zoom);
    }
    return;
  }

  // Modo Imagen Raster (.PNG / .JPG / .WEBP)
  if (state.sourceMode === 'raster' && state.rasterImg) {
    const baseW = Math.max(1, Math.round((state.widthMm / 25.4) * state.dpi));
    const baseH = Math.max(1, Math.round((state.heightMm / 25.4) * state.dpi));
    const innerW = state.rotate90 ? baseH : baseW;
    const innerH = state.rotate90 ? baseW : baseH;
    const pad = state.paddingPx;
    const unrotW = innerW + pad * 2;
    const unrotH = innerH + pad * 2;

    const offCanvas = document.createElement('canvas');
    offCanvas.width = state.rotate90 ? unrotH : unrotW;
    offCanvas.height = state.rotate90 ? unrotW : unrotH;
    const ctx = offCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, offCanvas.width, offCanvas.height);

    if (state.rotate90) {
      ctx.save();
      ctx.translate(offCanvas.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(state.rasterImg, pad, pad, innerW, innerH);
      ctx.restore();
    } else {
      ctx.drawImage(state.rasterImg, pad, pad, innerW, innerH);
    }

    const rawW = offCanvas.width;
    const rawH = offCanvas.height;
    const imgData = ctx.getImageData(0, 0, rawW, rawH);
    const rgba = imgData.data;

    state.rawWidthPx = rawW;
    state.rawHeightPx = rawH;
    state.rawRgbaBuffer = new Uint8ClampedArray(rgba);

    const initial = buildCmykAndAlphaFromRgba(rgba, rawW, rawH);
    const processed = applyFullBackgroundPipeline(rgba, initial.cmyk, initial.alpha, rawW, rawH);

    state.widthPx = processed.widthPx;
    state.heightPx = processed.heightPx;
    state.rgbaBuffer = processed.rgba;
    state.cmykBuffer = processed.cmyk;
    state.alphaBuffer = processed.alpha;

    updateDimensionsHeaderBadge();
    recomputeSpotChannelsAndRender();
    if (fitOnFinish) {
      fitCanvasToViewport();
    } else {
      setZoom(state.zoom);
    }
    return;
  }

  // Modo SVG
  if (!state.svgText) return;

  const baseW = Math.max(1, Math.round((state.widthMm / 25.4) * state.dpi));
  const baseH = Math.max(1, Math.round((state.heightMm / 25.4) * state.dpi));
  const innerW = state.rotate90 ? baseH : baseW;
  const innerH = state.rotate90 ? baseW : baseH;
  const pad = state.paddingPx;
  const unrotW = innerW + pad * 2;
  const unrotH = innerH + pad * 2;

  const preparedSvg = prepareSvgForRender(state.svgText, innerW, innerH);
  const blob = new Blob([preparedSvg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();

  img.onload = () => {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = state.rotate90 ? unrotH : unrotW;
    offCanvas.height = state.rotate90 ? unrotW : unrotH;
    const ctx = offCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, offCanvas.width, offCanvas.height);

    if (state.rotate90) {
      ctx.save();
      ctx.translate(offCanvas.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, pad, pad, innerW, innerH);
      ctx.restore();
    } else {
      ctx.drawImage(img, pad, pad, innerW, innerH);
    }
    URL.revokeObjectURL(url);

    const rawW = offCanvas.width;
    const rawH = offCanvas.height;
    const imgData = ctx.getImageData(0, 0, rawW, rawH);
    const rgba = imgData.data;

    state.rawWidthPx = rawW;
    state.rawHeightPx = rawH;
    state.rawRgbaBuffer = new Uint8ClampedArray(rgba);

    const initial = buildCmykAndAlphaFromRgba(rgba, rawW, rawH);
    const processed = applyFullBackgroundPipeline(rgba, initial.cmyk, initial.alpha, rawW, rawH);

    state.widthPx = processed.widthPx;
    state.heightPx = processed.heightPx;
    state.rgbaBuffer = processed.rgba;
    state.cmykBuffer = processed.cmyk;
    state.alphaBuffer = processed.alpha;

    updateDimensionsHeaderBadge();
    recomputeSpotChannelsAndRender();
    if (fitOnFinish) {
      fitCanvasToViewport();
    } else {
      setZoom(state.zoom);
    }
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert('No se pudo renderizar el archivo SVG.');
  };

  img.src = url;
}

function updateDimensionsHeaderBadge() {
  const totalW = state.widthPx;
  const totalH = state.heightPx;
  const ptW = ((totalW / state.dpi) * 72).toFixed(2);
  const ptH = ((totalH / state.dpi) * 72).toFixed(2);
  const mmW = ((totalW / state.dpi) * 25.4).toFixed(2);
  const mmH = ((totalH / state.dpi) * 25.4).toFixed(2);
  document.getElementById('docDimensionsBadge').textContent =
    `${totalW} × ${totalH} px | ${ptW} × ${ptH} pt | ${mmW} × ${mmH} mm @ ${state.dpi} PPP`;
}

function prepareSvgForRender(rawSvgText, targetW, targetH) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawSvgText, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return rawSvgText;

  if (!svgEl.getAttribute('viewBox')) {
    const w = parseFloat(svgEl.getAttribute('width')) || targetW;
    const h = parseFloat(svgEl.getAttribute('height')) || targetH;
    svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

  if (state.stripSvgBgRect) {
    const vb = (svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const rects = svgEl.querySelectorAll('rect');
    if (rects.length > 0 && vb.length === 4) {
      const firstRect = rects[0];
      const rw = parseFloat(firstRect.getAttribute('width')) || 0;
      const rh = parseFloat(firstRect.getAttribute('height')) || 0;
      const wAttr = firstRect.getAttribute('width') || '';
      const hAttr = firstRect.getAttribute('height') || '';
      if (wAttr === '100%' || hAttr === '100%' || (rw >= vb[2] * 0.90 && rh >= vb[3] * 0.90)) {
        firstRect.remove();
      }
    }
  }

  svgEl.setAttribute('width', `${targetW}px`);
  svgEl.setAttribute('height', `${targetH}px`);
  svgEl.setAttribute('preserveAspectRatio', 'none');

  return new XMLSerializer().serializeToString(doc);
}

function hexToRgb(hex) {
  const clean = (hex || '#ffffff').replace('#', '');
  const num = parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

// ============================================================================
// Motor Inteligente para Sacar el Fondo (Vector + Píxel + Antihalo + Auto-Trim)
// ============================================================================
function setEyedropperState(active, addMode = false) {
  state.eyedropperActive = active;
  state.eyedropperAddMode = addMode;
  const eyebanner = document.getElementById('eyebanner');
  if (eyebanner) {
    eyebanner.textContent = addMode
      ? 'Haz clic sobre otro color de fondo en la vista previa para sumarlo a la eliminación'
      : 'Haz clic sobre cualquier zona del fondo en la vista previa para eliminar ese color';
    eyebanner.classList.toggle('visible', active);
  }
  const btnEye = document.getElementById('btnEyedropper');
  if (btnEye) btnEye.classList.toggle('btn-active', active && !addMode);
  const btnAdd = document.getElementById('btnAddExtraBgColor');
  if (btnAdd) btnAdd.classList.toggle('btn-active', active && addMode);
  const btnQuickEye = document.getElementById('btnQuickEyedropper');
  if (btnQuickEye) btnQuickEye.classList.toggle('btn-active', active);
  const canvas = document.getElementById('previewCanvas');
  if (canvas) canvas.classList.toggle('eyedropper-cursor', active);
}

function syncBgRemovalUI() {
  const isBgRemoved = state.ignoreBgColor || state.stripSvgBgRect;
  const ignoreBgChk = document.getElementById('ignoreBgChk');
  if (ignoreBgChk) ignoreBgChk.checked = state.ignoreBgColor;
  const stripChk = document.getElementById('stripSvgBgRectChk');
  if (stripChk) stripChk.checked = state.stripSvgBgRect;
  const bgPickerPanel = document.getElementById('bgPickerPanel');
  if (bgPickerPanel) bgPickerPanel.style.display = state.ignoreBgColor ? 'flex' : 'none';
  const bgColorInput = document.getElementById('bgColorInput');
  if (bgColorInput) bgColorInput.value = state.bgColorHex;

  const badge = document.getElementById('bgStatusBadge');
  if (badge) {
    badge.textContent = isBgRemoved ? 'Sin Fondo' : 'Original';
    badge.classList.toggle('badge-success', isBgRemoved);
  }

  const quickBtn = document.getElementById('btnQuickRemoveBg');
  if (quickBtn) {
    quickBtn.classList.toggle('active', isBgRemoved);
    quickBtn.textContent = isBgRemoved ? '✓ Fondo Quitado' : '✨ Sacar Fondo';
  }

  renderExtraBgColorsChips();
}

function renderExtraBgColorsChips() {
  const container = document.getElementById('extraBgColorsContainer');
  const list = document.getElementById('extraBgColorsList');
  if (!container || !list) return;
  if (state.extraBgColors.length === 0) {
    container.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  container.style.display = 'flex';
  list.innerHTML = '';
  state.extraBgColors.forEach((hex, idx) => {
    const chip = document.createElement('span');
    chip.className = 'extra-color-chip';
    chip.innerHTML = `
      <span class="extra-color-swatch" style="background:${hex};"></span>
      <span>${hex}</span>
      <button type="button" class="extra-color-remove" title="Quitar este color">✕</button>
    `;
    chip.querySelector('.extra-color-remove').addEventListener('click', () => {
      state.extraBgColors.splice(idx, 1);
      syncBgRemovalUI();
      processCurrentDesign();
    });
    list.appendChild(chip);
  });
}

function detectDominantBorderColor(rgba, w, h) {
  if (!rgba || w <= 0 || h <= 0) return '#ffffff';
  const pad = Math.min(Math.floor(Math.min(w, h) / 4), state.paddingPx || 0);
  const x0 = Math.min(w - 1, pad);
  const x1 = Math.max(0, w - 1 - pad);
  const y0 = Math.min(h - 1, pad);
  const y1 = Math.max(0, h - 1 - pad);

  const buckets = new Map();
  const addSample = (x, y, weight) => {
    const idx = (y * w + x) * 4;
    const a = rgba[idx + 3];
    if (a < 25) return false;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let entry = buckets.get(key);
    if (!entry) {
      entry = { weight: 0, rSum: 0, gSum: 0, bSum: 0 };
      buckets.set(key, entry);
    }
    entry.weight += weight;
    entry.rSum += r * weight;
    entry.gSum += g * weight;
    entry.bSum += b * weight;
    return true;
  };

  // Esquinas con mayor peso
  addSample(x0, y0, 12);
  addSample(x1, y0, 12);
  addSample(x0, y1, 12);
  addSample(x1, y1, 12);

  // Bordes del perímetro
  const stepX = Math.max(1, Math.floor((x1 - x0) / 40));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 40));
  for (let x = x0; x <= x1; x += stepX) {
    addSample(x, y0, 1);
    addSample(x, y1, 1);
  }
  for (let y = y0; y <= y1; y += stepY) {
    addSample(x0, y, 1);
    addSample(x1, y, 1);
  }

  // Si el perímetro exterior ya es transparente, lanzar rayos hacia adentro para detectar una placa de fondo interna
  if (buckets.size === 0) {
    const rays = 16;
    for (let i = 1; i < rays; i++) {
      const rx = Math.floor((w * i) / rays);
      for (let y = 0; y < h; y++) {
        if (addSample(rx, y, 2)) break;
      }
      for (let y = h - 1; y >= 0; y--) {
        if (addSample(rx, y, 2)) break;
      }
      const ry = Math.floor((h * i) / rays);
      for (let x = 0; x < w; x++) {
        if (addSample(x, ry, 2)) break;
      }
      for (let x = w - 1; x >= 0; x--) {
        if (addSample(x, ry, 2)) break;
      }
    }
  }

  let best = null;
  for (const entry of buckets.values()) {
    if (!best || entry.weight > best.weight) best = entry;
  }
  if (!best || best.weight === 0) return '#ffffff';

  const r = Math.round(best.rSum / best.weight);
  const g = Math.round(best.gSum / best.weight);
  const b = Math.round(best.bSum / best.weight);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function triggerAutoRemoveBackground() {
  if (state.activeView === 'pasteboard') {
    state.activeView = 'composite';
    renderViewTabs();
  }

  // 1. Activar eliminación de placa vectorial (.AI y .SVG)
  let hasVecPlate = false;
  if (state.sourceMode === 'ai' && state.aiDoc && state.aiDoc.designs[state.activeAiDesignIdx]) {
    hasVecPlate = window.AiParser.hasVectorBgPlate(state.aiDoc.designs[state.activeAiDesignIdx]);
  } else if (state.sourceMode === 'svg' && state.svgText) {
    hasVecPlate = /<rect\b/i.test(state.svgText);
  }
  if (hasVecPlate) {
    state.stripSvgBgRect = true;
  }

  // 2. Detectar color dominante del fondo en esquinas/bordes y activar eliminación por color
  const srcBuf = state.rawRgbaBuffer || state.rgbaBuffer;
  const srcW = state.rawRgbaBuffer ? state.rawWidthPx : state.widthPx;
  const srcH = state.rawRgbaBuffer ? state.rawHeightPx : state.heightPx;
  if (srcBuf) {
    // Verificar si las esquinas tienen fondo opaco o si no había placa vectorial
    const pad = Math.min(Math.floor(Math.min(srcW, srcH) / 4), state.paddingPx || 0);
    const c1 = srcBuf[(pad * srcW + pad) * 4 + 3];
    const c2 = srcBuf[(pad * srcW + (srcW - 1 - pad)) * 4 + 3];
    const c3 = srcBuf[((srcH - 1 - pad) * srcW + pad) * 4 + 3];
    const c4 = srcBuf[((srcH - 1 - pad) * srcW + (srcW - 1 - pad)) * 4 + 3];
    const cornersOpaque = (c1 > 25 || c2 > 25 || c3 > 25 || c4 > 25);

    if (cornersOpaque || !hasVecPlate) {
      const detectedHex = detectDominantBorderColor(srcBuf, srcW, srcH);
      state.bgColorHex = detectedHex;
      state.ignoreBgColor = true;
    }
  } else {
    state.ignoreBgColor = true;
  }

  const detailsEl = document.getElementById('bgCardDetails');
  if (detailsEl) detailsEl.open = true;

  syncBgRemovalUI();
  processCurrentDesign();
}

function resetBackgroundRemoval() {
  state.ignoreBgColor = false;
  state.stripSvgBgRect = false;
  state.extraBgColors = [];
  setEyedropperState(false, false);
  syncBgRemovalUI();
  processCurrentDesign();
}

function rgbPixelToCmyk(r, g, b) {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const maxRgb = Math.max(rf, gf, bf);
  const minRgb = Math.min(rf, gf, bf);
  const k = 1 - maxRgb;

  if (k >= 0.9999) {
    return [0, 0, 0, 255];
  } else if (maxRgb >= 0.88 && minRgb < 0.02) {
    return [
      Math.round((1 - rf) * 255),
      Math.round((1 - gf) * 255),
      Math.round((1 - bf) * 255),
      0
    ];
  } else {
    return [
      Math.round(((1 - rf - k) / (1 - k)) * 255),
      Math.round(((1 - gf - k) / (1 - k)) * 255),
      Math.round(((1 - bf - k) / (1 - k)) * 255),
      Math.round(k * 255)
    ];
  }
}

function buildCmykAndAlphaFromRgba(rgba, w, h) {
  const numPixels = w * h;
  const cmyk = new Uint8Array(numPixels * 4);
  const alpha = new Uint8Array(numPixels);

  for (let i = 0; i < numPixels; i++) {
    const a = rgba[i * 4 + 3];
    alpha[i] = a;
    if (a === 0) continue;
    const [c, m, y, k] = rgbPixelToCmyk(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    cmyk[i * 4] = c;
    cmyk[i * 4 + 1] = m;
    cmyk[i * 4 + 2] = y;
    cmyk[i * 4 + 3] = k;
  }
  return { cmyk, alpha };
}

function applyFullBackgroundPipeline(rgbaIn, cmykIn, alphaIn, w, h) {
  const numPixels = w * h;
  let rgba = new Uint8ClampedArray(rgbaIn);
  let cmyk = new Uint8Array(cmykIn);
  let alpha = new Uint8Array(alphaIn);

  if (state.ignoreBgColor) {
    const targets = [hexToRgb(state.bgColorHex), ...state.extraBgColors.map(hexToRgb)];
    const maxDist = Math.max(2, (state.bgTolerance / 100) * 441.67);
    const featherRange = Math.max(9, maxDist * 0.36);
    const innerCutoff = Math.max(0, maxDist - featherRange);

    const closestBgDist = (r, g, b) => {
      let bestDist = Infinity;
      let bestBg = targets[0];
      for (let t = 0; t < targets.length; t++) {
        const bg = targets[t];
        const dr = r - bg.r;
        const dg = g - bg.g;
        const db = b - bg.b;
        const d = Math.sqrt(dr * dr + dg * dg + db * db);
        if (d < bestDist) {
          bestDist = d;
          bestBg = bg;
        }
      }
      return { dist: bestDist, bg: bestBg };
    };

    // Máscara de qué píxeles deben ser evaluados contra el color de fondo
    // 0 = protegido (interior), 1 = evaluar y eliminar/suavizar
    let shouldKeyMask = null;

    if (state.bgRemovalMode === 'flood' || state.bgRemovalMode === 'flood_holes') {
      shouldKeyMask = new Uint8Array(numPixels);
      const visited = new Uint8Array(numPixels);
      const queue = new Int32Array(numPixels);
      let qHead = 0;
      let qTail = 0;

      const trySeed = (idx) => {
        if (visited[idx]) return;
        const a = alpha[idx];
        if (a < 16) {
          visited[idx] = 1;
          shouldKeyMask[idx] = 1;
          queue[qTail++] = idx;
          return;
        }
        const { dist } = closestBgDist(rgba[idx * 4], rgba[idx * 4 + 1], rgba[idx * 4 + 2]);
        if (dist < maxDist) {
          visited[idx] = 1;
          shouldKeyMask[idx] = 1;
          if (dist <= innerCutoff) {
            queue[qTail++] = idx;
          }
        }
      };

      // Sembrar desde los 4 bordes exteriores
      for (let x = 0; x < w; x++) {
        trySeed(x);
        trySeed((h - 1) * w + x);
      }
      for (let y = 1; y < h - 1; y++) {
        trySeed(y * w);
        trySeed(y * w + (w - 1));
      }

      // Flood-fill 8-conexo desde el exterior
      while (qHead < qTail) {
        const curr = queue[qHead++];
        const cx = curr % w;
        const cy = (curr - cx) / w;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          const rowOff = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const nIdx = rowOff + nx;
            if (visited[nIdx]) continue;

            const na = alpha[nIdx];
            if (na < 16) {
              visited[nIdx] = 1;
              shouldKeyMask[nIdx] = 1;
              queue[qTail++] = nIdx;
            } else {
              const { dist } = closestBgDist(rgba[nIdx * 4], rgba[nIdx * 4 + 1], rgba[nIdx * 4 + 2]);
              if (dist <= innerCutoff) {
                visited[nIdx] = 1;
                shouldKeyMask[nIdx] = 1;
                queue[qTail++] = nIdx;
              } else if (dist < maxDist) {
                // Borde suavizado (antialiasing) adyacente al fondo exterior
                visited[nIdx] = 1;
                shouldKeyMask[nIdx] = 1;
              }
            }
          }
        }
      }

      // Si el modo es 'flood_holes', también eliminar huecos internos cerrados dentro de letras (ej. O, A, B, P, R, D)
      if (state.bgRemovalMode === 'flood_holes') {
        const maxHolePixels = Math.max(64, Math.floor(numPixels * 0.08));
        const compIndices = [];

        for (let i = 0; i < numPixels; i++) {
          if (visited[i] || alpha[i] < 16) continue;
          const { dist } = closestBgDist(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
          if (dist > innerCutoff) continue;

          compIndices.length = 0;
          let touchesOuterFg = false;
          let cHead = 0;
          visited[i] = 1;
          compIndices.push(i);

          while (cHead < compIndices.length) {
            const u = compIndices[cHead++];
            const ux = u % w;
            const uy = (u - ux) / w;

            for (let dy = -1; dy <= 1; dy++) {
              const ny = uy + dy;
              if (ny < 0 || ny >= h) continue;
              const rOff = ny * w;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = ux + dx;
                if (nx < 0 || nx >= w) continue;
                const v = rOff + nx;
                if (visited[v]) continue;
                if (alpha[v] >= 16) {
                  const { dist: vDist } = closestBgDist(rgba[v * 4], rgba[v * 4 + 1], rgba[v * 4 + 2]);
                  if (vDist <= innerCutoff) {
                    visited[v] = 1;
                    compIndices.push(v);
                  } else {
                    touchesOuterFg = true;
                  }
                }
              }
            }
          }

          if (touchesOuterFg && compIndices.length <= maxHolePixels) {
            for (let k = 0; k < compIndices.length; k++) {
              const u = compIndices[k];
              shouldKeyMask[u] = 1;
              const ux = u % w;
              const uy = (u - ux) / w;
              for (let dy = -1; dy <= 1; dy++) {
                const ny = uy + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                  const nx = ux + dx;
                  if (nx < 0 || nx >= w) continue;
                  const nb = ny * w + nx;
                  if (!shouldKeyMask[nb] && alpha[nb] > 0) {
                    const { dist: nbDist } = closestBgDist(rgba[nb * 4], rgba[nb * 4 + 1], rgba[nb * 4 + 2]);
                    if (nbDist < maxDist) shouldKeyMask[nb] = 1;
                  }
                }
              }
            }
          }
        }
      }
    }

    // Aplicar recorte de alfa y descontaminación de color del borde (antihalo)
    for (let i = 0; i < numPixels; i++) {
      const origA = alpha[i];
      if (origA === 0) continue;
      if (shouldKeyMask && !shouldKeyMask[i]) continue;

      const r = rgba[i * 4];
      const g = rgba[i * 4 + 1];
      const b = rgba[i * 4 + 2];
      const { dist, bg } = closestBgDist(r, g, b);

      if (dist <= innerCutoff) {
        alpha[i] = 0;
        rgba[i * 4 + 3] = 0;
        cmyk[i * 4] = 0;
        cmyk[i * 4 + 1] = 0;
        cmyk[i * 4 + 2] = 0;
        cmyk[i * 4 + 3] = 0;
      } else if (dist < maxDist) {
        const factor = (dist - innerCutoff) / (maxDist - innerCutoff);
        const newA = Math.round(origA * factor);
        alpha[i] = newA;
        rgba[i * 4 + 3] = newA;

        if (newA === 0) {
          cmyk[i * 4] = 0;
          cmyk[i * 4 + 1] = 0;
          cmyk[i * 4 + 2] = 0;
          cmyk[i * 4 + 3] = 0;
        } else if (state.bgDecontaminate && factor > 0.08) {
          // Descontaminar el color del fondo en el borde semitransparente para eliminar el halo blanco/color
          const invF = 1 - factor;
          const pureR = Math.min(255, Math.max(0, Math.round((r - bg.r * invF) / factor)));
          const pureG = Math.min(255, Math.max(0, Math.round((g - bg.g * invF) / factor)));
          const pureB = Math.min(255, Math.max(0, Math.round((b - bg.b * invF) / factor)));
          rgba[i * 4] = pureR;
          rgba[i * 4 + 1] = pureG;
          rgba[i * 4 + 2] = pureB;
          const [nc, nm, ny, nk] = rgbPixelToCmyk(pureR, pureG, pureB);
          cmyk[i * 4] = nc;
          cmyk[i * 4 + 1] = nm;
          cmyk[i * 4 + 2] = ny;
          cmyk[i * 4 + 3] = nk;
        }
      }
    }
  }

  // Limpieza/contracción adicional de halo en el borde alfa si bgChokePx > 0
  if ((state.ignoreBgColor || state.stripSvgBgRect) && state.bgChokePx > 0) {
    for (let step = 0; step < state.bgChokePx; step++) {
      const nextAlpha = new Uint8Array(numPixels);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          let m = alpha[row + x];
          if (m === 0) continue;
          if (y > 0) m = Math.min(m, alpha[(y - 1) * w + x]); else m = 0;
          if (y + 1 < h) m = Math.min(m, alpha[(y + 1) * w + x]); else m = 0;
          if (x > 0) m = Math.min(m, alpha[row + x - 1]); else m = 0;
          if (x + 1 < w) m = Math.min(m, alpha[row + x + 1]); else m = 0;
          nextAlpha[row + x] = m;
        }
      }
      alpha = nextAlpha;
    }
    for (let i = 0; i < numPixels; i++) {
      rgba[i * 4 + 3] = alpha[i];
      if (alpha[i] === 0) {
        cmyk[i * 4] = 0;
        cmyk[i * 4 + 1] = 0;
        cmyk[i * 4 + 2] = 0;
        cmyk[i * 4 + 3] = 0;
      }
    }
  }

  // Auto-Trim: recortar márgenes transparentes sobrantes tras sacar el fondo
  if (state.autoTrimBg && (state.ignoreBgColor || state.stripSvgBgRect)) {
    const bbox = computeAlphaBoundingBox(alpha, w, h);
    if (!bbox.empty) {
      const pad = state.paddingPx || 0;
      const trimW = (bbox.right - bbox.left + 1) + pad * 2;
      const trimH = (bbox.bottom - bbox.top + 1) + pad * 2;
      if (trimW < w || trimH < h) {
        const newRgba = new Uint8ClampedArray(trimW * trimH * 4);
        const newCmyk = new Uint8Array(trimW * trimH * 4);
        const newAlpha = new Uint8Array(trimW * trimH);
        const contentW = bbox.right - bbox.left + 1;
        const contentH = bbox.bottom - bbox.top + 1;

        for (let y = 0; y < contentH; y++) {
          const srcY = bbox.top + y;
          const dstY = pad + y;
          for (let x = 0; x < contentW; x++) {
            const srcIdx = srcY * w + (bbox.left + x);
            const dstIdx = dstY * trimW + (pad + x);
            newAlpha[dstIdx] = alpha[srcIdx];
            for (let c = 0; c < 4; c++) {
              newRgba[dstIdx * 4 + c] = rgba[srcIdx * 4 + c];
              newCmyk[dstIdx * 4 + c] = cmyk[srcIdx * 4 + c];
            }
          }
        }
        return { widthPx: trimW, heightPx: trimH, rgba: newRgba, cmyk: newCmyk, alpha: newAlpha };
      }
    }
  }

  return { widthPx: w, heightPx: h, rgba, cmyk, alpha };
}

// ============================================================================
// Morfología Exacta de Photoshop para Canales Spot (Contracción / Expansión)
// ============================================================================
function computeAlphaBoundingBox(alpha, w, h) {
  let top = h, left = w, bottom = -1, right = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[row + x] > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < top) {
    return { top: 0, left: 0, bottom: h - 1, right: w - 1, empty: true };
  }
  return { top, left, bottom, right, empty: false };
}

function computeSpotChannelMask(alpha, w, h, offsetPx, clampBBox) {
  const numPixels = w * h;
  const inkMask = new Uint8Array(numPixels);
  const bbox = computeAlphaBoundingBox(alpha, w, h);

  if (bbox.empty) {
    const pdfIndexed = new Uint8Array(numPixels);
    pdfIndexed.fill(255);
    return { inkMask, pdfIndexed };
  }

  const minX = clampBBox ? bbox.left : 0;
  const maxX = clampBBox ? bbox.right : w - 1;
  const minY = clampBBox ? bbox.top : 0;
  const maxY = clampBBox ? bbox.bottom : h - 1;

  if (offsetPx === 0) {
    inkMask.set(alpha);
  } else if (offsetPx < 0) {
    const r = Math.abs(offsetPx);
    let current = new Uint8Array(alpha);
    for (let step = 0; step < r; step++) {
      const next = new Uint8Array(numPixels);
      for (let y = minY; y <= maxY; y++) {
        const yUp = clampBBox ? Math.max(minY, y - 1) : y - 1;
        const yDn = clampBBox ? Math.min(maxY, y + 1) : y + 1;
        for (let x = minX; x <= maxX; x++) {
          const xLt = clampBBox ? Math.max(minX, x - 1) : x - 1;
          const xRt = clampBBox ? Math.min(maxX, x + 1) : x + 1;
          let m = current[y * w + x];
          if (yUp >= 0) m = Math.min(m, current[yUp * w + x]); else m = 0;
          if (yDn < h)  m = Math.min(m, current[yDn * w + x]); else m = 0;
          if (xLt >= 0) m = Math.min(m, current[y * w + xLt]); else m = 0;
          if (xRt < w)  m = Math.min(m, current[y * w + xRt]); else m = 0;
          next[y * w + x] = m;
        }
      }
      current = next;
    }
    inkMask.set(current);
  } else {
    const r = offsetPx;
    const rSqLimit = r === 1 ? 1 : (r * r + 1);
    const offsets = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= rSqLimit) {
          offsets.push([dx, dy]);
        }
      }
    }

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let maxVal = 0;
        for (let k = 0; k < offsets.length; k++) {
          let nx = x + offsets[k][0];
          let ny = y + offsets[k][1];
          if (clampBBox) {
            if (nx < minX) nx = minX; else if (nx > maxX) nx = maxX;
            if (ny < minY) ny = minY; else if (ny > maxY) ny = maxY;
          } else {
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          }
          const v = alpha[ny * w + nx];
          if (v > maxVal) {
            maxVal = v;
            if (maxVal === 255) break;
          }
        }
        inkMask[y * w + x] = maxVal;
      }
    }
  }

  const pdfIndexed = new Uint8Array(numPixels);
  for (let i = 0; i < numPixels; i++) {
    pdfIndexed[i] = 255 - inkMask[i];
  }

  return { inkMask, pdfIndexed };
}

function recomputeSpotChannelsAndRender() {
  if (!state.alphaBuffer) return;

  const activeChannels = state.spotChannels.filter(c => c.enabled);
  const cache = new Map();
  state.spotBuffers = activeChannels.map((ch) => {
    const key = `${ch.offsetPx}_${state.clampToAlphaBBox}`;
    if (!cache.has(key)) {
      cache.set(key, computeSpotChannelMask(state.alphaBuffer, state.widthPx, state.heightPx, ch.offsetPx, state.clampToAlphaBBox));
    }
    const res = cache.get(key);
    return {
      channel: ch,
      inkMask: res.inkMask,
      pdfIndexed: res.pdfIndexed
    };
  });

  renderViewTabs();
  renderPreviewCanvas();
}

// ============================================================================
// Renderizado de Lista de Canales Spot y Vista Previa
// ============================================================================
function renderSpotChannelsList() {
  const container = document.getElementById('spotList');
  container.innerHTML = '';

  state.spotChannels.forEach((ch, idx) => {
    const item = document.createElement('div');
    item.className = 'spot-item' + (ch.enabled ? '' : ' disabled');

    let tagClass = 'exact';
    let tagText = '0 px (Exacto)';
    if (ch.offsetPx < 0) {
      tagClass = 'choke';
      tagText = `${ch.offsetPx} px (Contracción)`;
    } else if (ch.offsetPx > 0) {
      tagClass = 'expand';
      tagText = `+${ch.offsetPx} px (Expansión)`;
    }

    item.innerHTML = `
      <div class="spot-item-top">
        <input type="checkbox" class="spot-enable-chk" ${ch.enabled ? 'checked' : ''} title="Activar/Desactivar canal" />
        <input type="text" class="spot-name-input" value="${escapeHtml(ch.name)}" placeholder="Nombre del canal (ej. Spot 1)" />
        <input type="color" class="spot-color-input" value="${ch.color}" title="Color de visualización en el PDF" />
        <button class="btn btn-sm btn-icon spot-remove-btn" title="Eliminar este canal" ${state.spotChannels.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>
      <div class="spot-item-bottom">
        <div class="offset-control">
          <span>Borde (px):</span>
          <input type="number" class="spot-offset-input" min="-30" max="30" step="1" value="${ch.offsetPx}" />
        </div>
        <span class="offset-tag ${tagClass}">${tagText}</span>
      </div>
    `;

    const chk = item.querySelector('.spot-enable-chk');
    const nameInput = item.querySelector('.spot-name-input');
    const colorInput = item.querySelector('.spot-color-input');
    const offsetInput = item.querySelector('.spot-offset-input');
    const removeBtn = item.querySelector('.spot-remove-btn');

    chk.addEventListener('change', () => {
      ch.enabled = chk.checked;
      renderSpotChannelsList();
      recomputeSpotChannelsAndRender();
    });

    nameInput.addEventListener('change', () => {
      ch.name = nameInput.value.trim() || `Spot ${idx + 1}`;
      renderViewTabs();
    });

    colorInput.addEventListener('input', () => {
      ch.color = colorInput.value;
      renderPreviewCanvas();
    });

    offsetInput.addEventListener('change', () => {
      ch.offsetPx = Math.max(-30, Math.min(30, parseInt(offsetInput.value, 10) || 0));
      renderSpotChannelsList();
      recomputeSpotChannelsAndRender();
    });

    removeBtn.addEventListener('click', () => {
      if (state.spotChannels.length <= 1) return;
      state.spotChannels.splice(idx, 1);
      if (state.activeView.startsWith('spot_')) state.activeView = 'composite';
      renderSpotChannelsList();
      recomputeSpotChannelsAndRender();
    });

    container.appendChild(item);
  });

  const activeCount = state.spotChannels.filter(c => c.enabled).length;
  document.getElementById('spotCountBadge').textContent = `${activeCount} activos`;
}

function renderViewTabs() {
  const tabsEl = document.getElementById('viewTabs');
  tabsEl.innerHTML = '';

  const tabs = [];
  if (state.sourceMode === 'ai' && state.aiDoc) {
    tabs.push({ id: 'pasteboard', label: '🗺️ Mapa Zona Gris (.AI)' });
  }
  tabs.push(
    { id: 'composite', label: 'Compuesto PDF (CMYK + Spot)' },
    { id: 'cmyk', label: 'Solo Arte CMYK' },
    ...state.spotBuffers.map((sb, i) => ({
      id: `spot_${i}`,
      label: `${sb.channel.name} (${sb.channel.offsetPx > 0 ? '+' + sb.channel.offsetPx : sb.channel.offsetPx}px)`
    })),
    { id: 'diff', label: 'Inspector de Bordes' }
  );

  if (!tabs.some(t => t.id === state.activeView)) {
    state.activeView = 'composite';
  }

  tabs.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'view-tab' + (state.activeView === t.id ? ' active' : '');
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      const prevWasPasteboard = state.activeView === 'pasteboard';
      state.activeView = t.id;
      renderViewTabs();
      renderPreviewCanvas();
      if (prevWasPasteboard || t.id === 'pasteboard') {
        fitCanvasToViewport();
      }
    });
    tabsEl.appendChild(btn);
  });

  const spotToggleBtn = document.getElementById('btnSpotModeToggle');
  spotToggleBtn.style.display = state.activeView.startsWith('spot_') ? 'inline-flex' : 'none';
}

function renderPasteboardMapCanvas() {
  const canvas = document.getElementById('previewCanvas');
  const aiDoc = state.aiDoc;
  if (!aiDoc) return;

  const bb = aiDoc.bbox;
  const padPt = 40;
  const totalPtW = (bb.maxX - bb.minX) + padPt * 2;
  const totalPtH = (bb.maxY - bb.minY) + padPt * 2;
  const sc = state.pasteboardScale;

  const w = Math.max(200, Math.round(totalPtW * sc));
  const h = Math.max(200, Math.round(totalPtH * sc));

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${Math.round(w * state.zoom)}px`;
    canvas.style.height = `${Math.round(h * state.zoom)}px`;
  }

  const ctx = canvas.getContext('2d');
  // Color de fondo de la Zona Gris de Illustrator
  ctx.fillStyle = '#282b34';
  ctx.fillRect(0, 0, w, h);

  const tx = (x) => (x - (bb.minX - padPt)) * sc;
  const ty = (y) => ((bb.maxY + padPt) - y) * sc;

  // Dibujar todos los elementos (Si aiIgnoreLargeBg está activo, atenuar los fondos grandes al 25% para que se vean como referencia pero no estorben)
  for (const el of aiDoc.elements) {
    ctx.save();
    if (state.aiIgnoreLargeBg && el.isBgRect) {
      ctx.globalAlpha = 0.25;
    }
    if (el.raster) {
      window.AiParser.drawRasterElementOnCanvas(ctx, el.raster, tx, ty, sc);
    }
    for (const sh of el.shapes) {
      window.AiParser.drawVectorShapeOnCanvas(ctx, sh, tx, ty, sc);
    }
    ctx.restore();
  }

  // Dibujar los recuadros de cada diseño detectado
  aiDoc.designs.forEach((d, idx) => {
    const x = tx(d.minX);
    const y = ty(d.maxY);
    const dw = (d.maxX - d.minX) * sc;
    const dh = (d.maxY - d.minY) * sc;
    const isCurrent = idx === state.activeAiDesignIdx;

    ctx.save();
    ctx.strokeStyle = isCurrent ? '#3b82f6' : (d.selected ? '#10b981' : '#64748b');
    ctx.lineWidth = isCurrent ? 2.5 : 1.5;
    if (!isCurrent) ctx.setLineDash([5, 4]);
    ctx.strokeRect(x - 2, y - 2, dw + 4, dh + 4);

    // Etiqueta con número y dimensiones
    ctx.setLineDash([]);
    const label = `#${idx + 1} (${d.widthMm}×${d.heightMm}mm)`;
    ctx.font = 'bold 11px Segoe UI, sans-serif';
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = isCurrent ? '#2563eb' : (d.selected ? '#059669' : '#334155');
    ctx.fillRect(x - 2, Math.max(0, y - 20), tw, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 3, Math.max(13, y - 7));
    ctx.restore();
  });

  // Si está arrastrando un recorte manual
  if (state.manualCropMode && state.dragCropStart && state.dragCropCurr) {
    const x1 = tx(state.dragCropStart.x);
    const y1 = ty(state.dragCropStart.y);
    const x2 = tx(state.dragCropCurr.x);
    const y2 = ty(state.dragCropCurr.y);
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.fillStyle = 'rgba(245, 158, 11, 0.15)';
    ctx.lineWidth = 2;
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.restore();
  }
}

function renderPreviewCanvas() {
  if (state.activeView === 'pasteboard' && state.aiDoc) {
    renderPasteboardMapCanvas();
    return;
  }

  if (!state.cmykBuffer || !state.alphaBuffer) return;

  const w = state.widthPx;
  const h = state.heightPx;
  const canvas = document.getElementById('previewCanvas');
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${Math.round(w * state.zoom)}px`;
    canvas.style.height = `${Math.round(h * state.zoom)}px`;
  }

  const ctx = canvas.getContext('2d');
  const outImg = ctx.createImageData(w, h);
  const dst = outImg.data;
  const numPixels = w * h;

  if (state.activeView === 'composite') {
    const spotRgbs = state.spotBuffers.map(sb => hexToRgb(sb.channel.color));

    for (let i = 0; i < numPixels; i++) {
      let outR = 0, outG = 0, outB = 0, outA = 0;

      // 1. Componer canales Spot activos sobre fondo transparente
      for (let s = 0; s < state.spotBuffers.length; s++) {
        const tint = state.spotBuffers[s].inkMask[i] / 255;
        if (tint > 0) {
          const sc = spotRgbs[s];
          const newA = tint + outA * (1 - tint);
          if (newA > 0) {
            outR = (sc.r * tint + outR * outA * (1 - tint)) / newA;
            outG = (sc.g * tint + outG * outA * (1 - tint)) / newA;
            outB = (sc.b * tint + outB * outA * (1 - tint)) / newA;
            outA = newA;
          }
        }
      }

      // 2. Componer capa de arte CMYK encima
      const a = state.alphaBuffer[i] / 255;
      if (a > 0) {
        const c = state.cmykBuffer[i * 4] / 255;
        const m = state.cmykBuffer[i * 4 + 1] / 255;
        const y = state.cmykBuffer[i * 4 + 2] / 255;
        const k = state.cmykBuffer[i * 4 + 3] / 255;

        const cmykR = 255 * (1 - c) * (1 - k);
        const cmykG = 255 * (1 - m) * (1 - k);
        const cmykB = 255 * (1 - y) * (1 - k);

        const newA = a + outA * (1 - a);
        if (newA > 0) {
          outR = (cmykR * a + outR * outA * (1 - a)) / newA;
          outG = (cmykG * a + outG * outA * (1 - a)) / newA;
          outB = (cmykB * a + outB * outA * (1 - a)) / newA;
          outA = newA;
        }
      }

      dst[i * 4] = Math.round(outR);
      dst[i * 4 + 1] = Math.round(outG);
      dst[i * 4 + 2] = Math.round(outB);
      dst[i * 4 + 3] = Math.round(outA * 255);
    }
  } else if (state.activeView === 'cmyk') {
    for (let i = 0; i < numPixels; i++) {
      const a = state.alphaBuffer[i];
      if (a === 0) {
        dst[i * 4 + 3] = 0;
        continue;
      }
      const c = state.cmykBuffer[i * 4] / 255;
      const m = state.cmykBuffer[i * 4 + 1] / 255;
      const y = state.cmykBuffer[i * 4 + 2] / 255;
      const k = state.cmykBuffer[i * 4 + 3] / 255;

      dst[i * 4] = Math.round(255 * (1 - c) * (1 - k));
      dst[i * 4 + 1] = Math.round(255 * (1 - m) * (1 - k));
      dst[i * 4 + 2] = Math.round(255 * (1 - y) * (1 - k));
      dst[i * 4 + 3] = a;
    }
  } else if (state.activeView.startsWith('spot_')) {
    const sIdx = parseInt(state.activeView.split('_')[1], 10);
    const sb = state.spotBuffers[sIdx];
    if (sb) {
      const sc = hexToRgb(sb.channel.color);
      for (let i = 0; i < numPixels; i++) {
        if (state.spotViewMode === 'plate') {
          const v = sb.pdfIndexed[i];
          dst[i * 4] = v;
          dst[i * 4 + 1] = v;
          dst[i * 4 + 2] = v;
          dst[i * 4 + 3] = 255;
        } else {
          const ink = sb.inkMask[i];
          dst[i * 4] = sc.r;
          dst[i * 4 + 1] = sc.g;
          dst[i * 4 + 2] = sc.b;
          dst[i * 4 + 3] = ink;
        }
      }
    }
  } else if (state.activeView === 'diff') {
    const choked = state.spotBuffers.find(s => s.channel.offsetPx < 0) || state.spotBuffers[0];
    const expanded = state.spotBuffers.find(s => s.channel.offsetPx > 0) || state.spotBuffers[state.spotBuffers.length - 1];

    for (let i = 0; i < numPixels; i++) {
      const a = state.alphaBuffer[i];
      const cInk = choked ? choked.inkMask[i] : a;
      const eInk = expanded ? expanded.inkMask[i] : a;

      if (eInk === 0 && a === 0) {
        dst[i * 4 + 3] = 0;
      } else if (a === 0 && eInk > 0) {
        dst[i * 4] = 239;
        dst[i * 4 + 1] = 68;
        dst[i * 4 + 2] = 68;
        dst[i * 4 + 3] = eInk;
      } else if (a > cInk) {
        dst[i * 4] = 59;
        dst[i * 4 + 1] = 130;
        dst[i * 4 + 2] = 246;
        dst[i * 4 + 3] = 255;
      } else {
        dst[i * 4] = 226;
        dst[i * 4 + 1] = 232;
        dst[i * 4 + 2] = 240;
        dst[i * 4 + 3] = a;
      }
    }
  }

  ctx.putImageData(outImg, 0, 0);
}

// ============================================================================
// Compresión Zlib (RFC 1950) + Predictor 2 (TIFF Horizontal Differencing)
// ============================================================================
function applyTiffPredictor2(buf, width, height, colors) {
  const out = new Uint8Array(buf.length);
  const stride = width * colors;
  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride;
    for (let c = 0; c < colors; c++) {
      let prev = 0;
      for (let x = 0; x < width; x++) {
        const idx = rowOffset + x * colors + c;
        const cur = buf[idx];
        out[idx] = (cur - prev) & 0xff;
        prev = cur;
      }
    }
  }
  return out;
}

async function zlibCompress(uint8Data) {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(uint8Data);
    writer.close();
    const res = new Response(cs.readable);
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }
  return zlibStoreFallback(uint8Data);
}

function zlibStoreFallback(data) {
  const maxBlock = 65535;
  const numBlocks = Math.ceil(data.length / maxBlock) || 1;
  const out = new Uint8Array(2 + data.length + numBlocks * 5 + 4);
  let p = 0;
  out[p++] = 0x78;
  out[p++] = 0x01;
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = Math.min(maxBlock, data.length - offset);
    const isLast = b === numBlocks - 1 ? 1 : 0;
    out[p++] = isLast;
    out[p++] = len & 0xff;
    out[p++] = (len >> 8) & 0xff;
    const nlen = (~len) & 0xffff;
    out[p++] = nlen & 0xff;
    out[p++] = (nlen >> 8) & 0xff;
    out.set(data.subarray(offset, offset + len), p);
    p += len;
    offset += len;
  }
  let s1 = 1, s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  const adler = ((s2 << 16) | s1) >>> 0;
  out[p++] = (adler >>> 24) & 0xff;
  out[p++] = (adler >>> 16) & 0xff;
  out[p++] = (adler >>> 8) & 0xff;
  out[p++] = adler & 0xff;
  return out;
}

// ============================================================================
// Empaquetado de Bloques Photoshop (8BIMLayr + 8BIMAlph + 8BIM ImageResources)
// ============================================================================
function packBitsRLEChannel(channelBytes, w, h) {
  const rowCounts = new Uint16Array(h);
  const encodedRows = [];
  let totalEncodedBytes = 0;

  for (let y = 0; y < h; y++) {
    const rowStart = y * w;
    const rowOut = [];
    let x = 0;
    while (x < w) {
      let runLen = 1;
      while (x + runLen < w && runLen < 128 && channelBytes[rowStart + x + runLen] === channelBytes[rowStart + x]) {
        runLen++;
      }
      if (runLen >= 3) {
        rowOut.push((257 - runLen) & 0xff, channelBytes[rowStart + x]);
        x += runLen;
      } else {
        let litStart = x;
        let litLen = 0;
        while (x < w && litLen < 128) {
          let nextRun = 1;
          while (x + nextRun < w && nextRun < 128 && channelBytes[rowStart + x + nextRun] === channelBytes[rowStart + x]) {
            nextRun++;
          }
          if (nextRun >= 3) break;
          x++;
          litLen++;
        }
        rowOut.push(litLen - 1);
        for (let k = 0; k < litLen; k++) {
          rowOut.push(channelBytes[rowStart + litStart + k]);
        }
      }
    }
    const rowArr = new Uint8Array(rowOut);
    rowCounts[y] = rowArr.length;
    encodedRows.push(rowArr);
    totalEncodedBytes += rowArr.length;
  }

  const result = new Uint8Array(2 + h * 2 + totalEncodedBytes);
  const dv = new DataView(result.buffer);
  dv.setInt16(0, 1, false);
  let pos = 2;
  for (let y = 0; y < h; y++) {
    dv.setUint16(pos, rowCounts[y], false);
    pos += 2;
  }
  for (let y = 0; y < h; y++) {
    result.set(encodedRows[y], pos);
    pos += encodedRows[y].length;
  }
  return result;
}

class BinaryBuilder {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  pushBytes(uint8) {
    this.chunks.push(uint8);
    this.length += uint8.length;
  }
  pushAscii(str) {
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
    this.pushBytes(arr);
  }
  pushInt16BE(val) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, val, false);
    this.pushBytes(b);
  }
  pushInt32BE(val) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, val, false);
    this.pushBytes(b);
  }
  toUint8Array() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

function buildPhotoshopStandardImageFileData(w, h, cmykBuf, alphaBuf, spotBuffers) {
  const bbox = computeAlphaBoundingBox(alphaBuf, w, h);
  const top = bbox.empty ? 0 : bbox.top;
  const left = bbox.empty ? 0 : bbox.left;
  const bottom = bbox.empty ? h : bbox.bottom + 1;
  const right = bbox.empty ? w : bbox.right + 1;
  const rw = Math.max(1, right - left);
  const rh = Math.max(1, bottom - top);

  const chAlphaRaw = new Uint8Array(rw * rh);
  const chCRaw = new Uint8Array(rw * rh);
  const chMRaw = new Uint8Array(rw * rh);
  const chYRaw = new Uint8Array(rw * rh);
  const chKRaw = new Uint8Array(rw * rh);

  for (let y = 0; y < rh; y++) {
    const srcY = top + y;
    for (let x = 0; x < rw; x++) {
      const srcIdx = srcY * w + (left + x);
      const dstIdx = y * rw + x;
      chAlphaRaw[dstIdx] = alphaBuf[srcIdx];
      chCRaw[dstIdx] = 255 - cmykBuf[srcIdx * 4];
      chMRaw[dstIdx] = 255 - cmykBuf[srcIdx * 4 + 1];
      chYRaw[dstIdx] = 255 - cmykBuf[srcIdx * 4 + 2];
      chKRaw[dstIdx] = 255 - cmykBuf[srcIdx * 4 + 3];
    }
  }

  const rleAlpha = packBitsRLEChannel(chAlphaRaw, rw, rh);
  const rleC = packBitsRLEChannel(chCRaw, rw, rh);
  const rleM = packBitsRLEChannel(chMRaw, rw, rh);
  const rleY = packBitsRLEChannel(chYRaw, rw, rh);
  const rleK = packBitsRLEChannel(chKRaw, rw, rh);

  const layerBlendAndExtra = hexStringToBytes(
    '38-42-49-4D-6E-6F-72-6D-FF-00-08-00-00-00-01-38-00-00-00-00-00-00-00-28-00-00-FF-FF-00-00-FF-FF-00-00-FF-FF-00-00-FF-FF-00-00-FF-FF-00-00-FF-FF-00-00-FF-FF-00-00-FF-FF-00-00-FF-FF-00-00-FF-FF-06-43-61-70-61-20-31-00-38-42-49-4D-6C-75-6E-69-00-00-00-10-00-00-00-06-00-43-00-61-00-70-00-61-00-20-00-31-38-42-49-4D-6C-6E-73-72-00-00-00-04-6C-61-79-72-38-42-49-4D-6C-79-69-64-00-00-00-04-00-00-00-02-38-42-49-4D-63-6C-62-6C-00-00-00-04-01-00-00-00-38-42-49-4D-69-6E-66-78-00-00-00-04-00-00-00-00-38-42-49-4D-6B-6E-6B-6F-00-00-00-04-00-00-00-00-38-42-49-4D-6C-73-70-66-00-00-00-04-00-00-00-00-38-42-49-4D-6C-63-6C-72-00-00-00-08-00-00-00-00-00-00-00-00-38-42-49-4D-73-68-6D-64-00-00-00-48-00-00-00-01-38-42-49-4D-63-75-73-74-00-00-00-00-00-00-00-34-00-00-00-10-00-00-00-01-00-00-00-00-00-08-6D-65-74-61-64-61-74-61-00-00-00-01-00-00-00-09-6C-61-79-65-72-54-69-6D-65-64-6F-75-62-41-DA-B6-36-19-13-38-18-00-38-42-49-4D-66-78-72-70-00-00-00-10-3F-F0-00-00-00-00-00-00-3F-F0-00-00-00-00-00-00'
  );

  const layrBody = new BinaryBuilder();
  layrBody.pushInt16BE(1);
  layrBody.pushInt32BE(top);
  layrBody.pushInt32BE(left);
  layrBody.pushInt32BE(bottom);
  layrBody.pushInt32BE(right);
  layrBody.pushInt16BE(5);

  const channels = [
    { id: -1, data: rleAlpha },
    { id: 0, data: rleC },
    { id: 1, data: rleM },
    { id: 2, data: rleY },
    { id: 3, data: rleK }
  ];

  for (const ch of channels) {
    layrBody.pushInt16BE(ch.id);
    layrBody.pushInt32BE(ch.data.length);
  }
  layrBody.pushBytes(layerBlendAndExtra);
  for (const ch of channels) {
    layrBody.pushBytes(ch.data);
  }
  if (layrBody.length % 2 !== 0) {
    layrBody.pushBytes(new Uint8Array([0]));
  }

  const layrBodyBytes = layrBody.toUint8Array();

  const full = new BinaryBuilder();
  full.pushAscii('8BIMLayr');
  full.pushInt32BE(layrBodyBytes.length);
  full.pushBytes(layrBodyBytes);

  full.pushBytes(hexStringToBytes(
    '00-00-38-42-49-4D-4C-4D-73-6B-00-00-00-0E-00-00-FF-FF-00-00-00-00-00-00-00-32-80-00-00-00-38-42-49-4D-50-61-74-74-00-00-00-00-38-42-49-4D-43-41-49-20-00-00-00-4D-00-00-00-03-00-00-00-10-00-00-00-01-00-00-00-00-00-00-6E-75-6C-6C-00-00-00-02-00-00-00-00-65-6E-61-62-62-6F-6F-6C-00-00-00-00-10-67-65-6E-65-72-61-74-69-6F-6E-61-6C-47-75-69-64-54-45-58-54-00-00-00-01-00-00-00-00-00-00-00-00-00-00-00-00-00-38-42-49-4D-47-65-6E-49-00-00-00-37-00-00-00-10-00-00-00-01-00-00-00-00-00-0B-67-65-6E-54-65-63-68-49-6E-66-6F-00-00-00-01-00-00-00-0E-69-73-55-73-69-6E-67-47-65-6E-54-65-63-68-6C-6F-6E-67-00-00-00-00-00-38-42-49-4D-46-4D-73-6B-00-00-00-0C-00-00-FF-FF-00-00-00-00-00-00-00-32'
  ));

  const alphBody = new BinaryBuilder();
  alphBody.pushInt32BE(8);
  alphBody.pushInt32BE(spotBuffers.length);

  spotBuffers.forEach((sb, i) => {
    const entry = new BinaryBuilder();
    entry.pushInt32BE(4 + i);
    entry.pushInt32BE(-1);

    const nameStr = sb.channel.name;
    const nameRawLen = 4 + nameStr.length * 2;
    const namePaddedLen = (nameRawLen + 3) & ~3;
    const nameBuf = new Uint8Array(namePaddedLen);
    const nameDv = new DataView(nameBuf.buffer);
    nameDv.setInt32(0, nameStr.length, false);
    for (let k = 0; k < nameStr.length; k++) {
      nameDv.setUint16(4 + k * 2, nameStr.charCodeAt(k), false);
    }
    entry.pushAscii('8BIMname');
    entry.pushInt32BE(namePaddedLen);
    entry.pushBytes(nameBuf);

    entry.pushAscii('8BIMkind');
    entry.pushInt32BE(8);
    entry.pushAscii('8BIMspot');

    entry.pushAscii('8BIMopac');
    entry.pushInt32BE(1);
    entry.pushBytes(new Uint8Array([0, 0, 0, 0]));

    const rgb = hexToRgb(sb.channel.color);
    const colBuf = new Uint8Array(12);
    const colDv = new DataView(colBuf.buffer);
    colDv.setUint16(0, 0, false);
    colDv.setUint16(2, (rgb.r << 8) | rgb.r, false);
    colDv.setUint16(4, (rgb.g << 8) | rgb.g, false);
    colDv.setUint16(6, (rgb.b << 8) | rgb.b, false);
    entry.pushAscii('8BIMcolr');
    entry.pushInt32BE(10);
    entry.pushBytes(colBuf);

    entry.pushAscii('8BIMid  ');
    entry.pushInt32BE(4);
    entry.pushInt32BE(3 + i);

    const entryBytes = entry.toUint8Array();
    alphBody.pushInt32BE(entryBytes.length);
    alphBody.pushBytes(entryBytes);
  });

  const alphBytes = alphBody.toUint8Array();
  full.pushAscii('8BIMAlph');
  full.pushInt32BE(alphBytes.length);
  full.pushBytes(alphBytes);

  full.pushBytes(hexStringToBytes(
    '38-42-49-4D-63-69-6E-66-00-00-01-97-00-00-00-10-00-00-00-01-00-00-00-00-00-00-6E-75-6C-6C-00-00-00-08-00-00-00-00-56-72-73-6E-4F-62-6A-63-00-00-00-01-00-00-00-00-00-00-6E-75-6C-6C-00-00-00-03-00-00-00-05-6D-61-6A-6F-72-6C-6F-6E-67-00-00-00-01-00-00-00-05-6D-69-6E-6F-72-6C-6F-6E-67-00-00-00-03-00-00-00-03-66-69-78-6C-6F-6E-67-00-00-00-00-00-00-00-09-70-73-56-65-72-73-69-6F-6E-4F-62-6A-63-00-00-00-01-00-00-00-00-00-00-6E-75-6C-6C-00-00-00-03-00-00-00-05-6D-61-6A-6F-72-6C-6F-6E-67-00-00-00-19-00-00-00-05-6D-69-6E-6F-72-6C-6F-6E-67-00-00-00-00-00-00-00-03-66-69-78-6C-6F-6E-67-00-00-00-00-00-00-00-0B-64-65-73-63-72-69-70-74-69-6F-6E-54-45-58-54-00-00-00-01-00-00-00-00-00-06-72-65-61-73-6F-6E-54-45-58-54-00-00-00-01-00-00-00-00-00-00-45-6E-67-6E-65-6E-75-6D-00-00-00-00-45-6E-67-6E-00-00-00-08-63-6F-6D-70-43-6F-72-65-00-00-00-11-65-6E-61-62-6C-65-43-6F-6D-70-43-6F-72-65-47-50-55-65-6E-75-6D-00-00-00-06-65-6E-61-62-6C-65-00-00-00-07-66-65-61-74-75-72-65-00-00-00-15-65-6E-61-62-6C-65-43-6F-6D-70-43-6F-72-65-54-68-72-65-61-64-73-65-6E-75-6D-00-00-00-06-65-6E-61-62-6C-65-00-00-00-07-66-65-61-74-75-72-65-00-00-00-12-63-6F-6D-70-43-6F-72-65-47-50-55-53-75-70-70-6F-72-74-65-6E-75-6D-00-00-00-06-72-65-61-73-6F-6E-00-00-00-09-73-75-70-70-6F-72-74-65-64-00'
  ));

  return full.toUint8Array();
}

function buildPhotoshopImageResources8BIM(dpi, spotCount) {
  const rawBin = atob(window.DTF_OBJ39_RAW_B64);
  const src = new Uint8Array(rawBin.length);
  for (let i = 0; i < rawBin.length; i++) src[i] = rawBin.charCodeAt(i);

  const out = new BinaryBuilder();
  let pos = 0;
  while (pos + 12 <= src.length) {
    const id = (src[pos + 4] << 8) | src[pos + 5];
    const nameLen = src[pos + 6];
    let padName = 1 + nameLen;
    if (padName % 2 !== 0) padName++;
    const sizePos = pos + 6 + padName;
    const size = (src[sizePos] << 24) | (src[sizePos + 1] << 16) | (src[sizePos + 2] << 8) | src[sizePos + 3];
    const dataPos = sizePos + 4;

    if (id === 1005) {
      out.pushBytes(src.subarray(pos, sizePos));
      out.pushInt32BE(16);
      const resBuf = new Uint8Array(16);
      const dv = new DataView(resBuf.buffer);
      dv.setUint16(0, dpi, false);
      dv.setUint16(4, 1, false);
      dv.setUint16(6, 2, false);
      dv.setUint16(8, dpi, false);
      dv.setUint16(12, 1, false);
      dv.setUint16(14, 2, false);
      out.pushBytes(resBuf);
    } else if (id === 1043) {
      out.pushBytes(src.subarray(pos, sizePos));
      const newSize = 4 + spotCount * 18;
      out.pushInt32BE(newSize);
      const shBuf = new Uint8Array(newSize);
      shBuf[1] = 6;
      shBuf[3] = spotCount;
      for (let s = 0; s < spotCount; s++) {
        shBuf[4 + s * 18 + 5] = 1;
      }
      out.pushBytes(shBuf);
    } else {
      const totalBlockLen = (dataPos - pos) + size + (size % 2);
      out.pushBytes(src.subarray(pos, pos + totalBlockLen));
    }

    pos = dataPos + size + (size % 2);
  }
  return out.toUint8Array();
}

function hexStringToBytes(hexStr) {
  const parts = hexStr.split('-');
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    out[i] = parseInt(parts[i], 16);
  }
  return out;
}

// ============================================================================
// Generación del Archivo PDF Final (Individual y en Lote)
// ============================================================================
function pdfNameEscape(name) {
  let out = '/';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code === 32) {
      out += '#20';
    } else if (code < 33 || code > 126 || '#()/[]<>%'.includes(name[i])) {
      out += '#' + code.toString(16).toUpperCase().padStart(2, '0');
    } else {
      out += name[i];
    }
  }
  return out;
}

function encodeUtf16BePdfLiteral(str) {
  const rawBytes = [0xfe, 0xff];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    rawBytes.push((code >> 8) & 0xff, code & 0xff);
  }
  rawBytes.push(0x00, 0x00);

  const out = [0x28];
  for (const b of rawBytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) {
      out.push(0x5c, b);
    } else if (b === 0x0a) {
      out.push(0x5c, 0x6e);
    } else if (b === 0x0d) {
      out.push(0x5c, 0x72);
    } else {
      out.push(b);
    }
  }
  out.push(0x29);
  return new Uint8Array(out);
}

function buildTintTransformPostScript(hexColor) {
  const rgb = hexToRgb(hexColor);
  const dr = (rgb.r / 255 - 1.0).toFixed(6);
  const dg = (rgb.g / 255 - 1.0).toFixed(6);
  const db = (rgb.b / 255 - 1.0).toFixed(6);
  return `{dup dup ${db} mul 1.0 add 3 1 roll ${dg} mul 1.0 add 3 1 roll ${dr} mul 1.0 add 3 1 roll}`;
}

async function generatePdfBytesFromBuffers(w, h, dpi, docTitle, cmykBuf, alphaBuf, spots) {
  const ptW = +((w / dpi) * 72).toFixed(7);
  const ptH = +((h / dpi) * 72).toFixed(7);
  const ptWBox = +((w / dpi) * 72).toFixed(2);
  const ptHBox = +((h / dpi) * 72).toFixed(2);
  const N = spots.length;

  const compressedSpots = [];
  for (let i = 0; i < N; i++) {
    const predSpot = applyTiffPredictor2(spots[i].pdfIndexed, w, h, 1);
    compressedSpots.push(await zlibCompress(predSpot));
  }

  const predAlpha = applyTiffPredictor2(alphaBuf, w, h, 1);
  const compressedAlpha = await zlibCompress(predAlpha);

  const predCmyk = applyTiffPredictor2(cmykBuf, w, h, 4);
  const compressedCmyk = await zlibCompress(predCmyk);

  const raw8BIM = buildPhotoshopImageResources8BIM(dpi, N);
  const compressed8BIM = await zlibCompress(raw8BIM);

  const rawLayrData = buildPhotoshopStandardImageFileData(w, h, cmykBuf, alphaBuf, spots);
  const compressedLayrData = await zlibCompress(rawLayrData);

  const iccBin = atob(window.DTF_ICC_FLATED_B64);
  const iccFlatedBytes = new Uint8Array(iccBin.length);
  for (let i = 0; i < iccBin.length; i++) iccFlatedBytes[i] = iccBin.charCodeAt(i);

  const invertedLut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) invertedLut[i] = 255 - i;

  let nextId = 1;
  const allocObj = () => nextId++;

  const pagesId = allocObj();
  const metadataId = allocObj();
  const infoId = allocObj();
  const catalogId = allocObj();
  const pageId = allocObj();
  const contentsId = allocObj();
  const defaultCmykId = allocObj();
  const iccStreamId = allocObj();
  const extGStateId = allocObj();

  const spotObjIds = spots.map(() => ({
    csIndexedId: allocObj(),
    calRgbId: allocObj(),
    tintFuncId: allocObj(),
    separationId: allocObj(),
    lutId: allocObj(),
    imXObjId: allocObj()
  }));

  const smaskId = allocObj();
  const mainImId = allocObj();
  const piecePrivateId = allocObj();
  const compositeImId = allocObj();
  const imgResId = allocObj();
  const stdDataId = allocObj();
  const spotDictId = allocObj();

  const contentsBuilder = new BinaryBuilder();
  contentsBuilder.pushAscii('/MultiChannelImage <</MainChannel /CMYKColorMode /Spot [');
  for (let i = 0; i < N; i++) {
    contentsBuilder.pushBytes(encodeUtf16BePdfLiteral(spots[i].channel.name));
  }
  contentsBuilder.pushAscii(']>>BDC \n/SeparationImages BMC \n');

  for (let i = 0; i < N; i++) {
    contentsBuilder.pushAscii('/SpotImage <</Ink ');
    contentsBuilder.pushBytes(encodeUtf16BePdfLiteral(spots[i].channel.name));
    contentsBuilder.pushAscii('>>BDC \nq\n/GS0 gs\n/RelativeColorimetric ri\n');
    contentsBuilder.pushAscii(`${ptW} 0 0 ${ptH} 0 0 cm\n/Im${i} Do\nQ\nEMC \n`);
  }

  contentsBuilder.pushAscii('/MainChannelImage BMC \nq\n/GS0 gs\n/RelativeColorimetric ri\n');
  contentsBuilder.pushAscii(`${ptW} 0 0 ${ptH} 0 0 cm\n/Im${N} Do\nQ\nEMC \nEMC \nEMC \n`);
  const contentsBytes = contentsBuilder.toUint8Array();

  const xmpXml = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 9.1-c001">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:xmpTPg="http://ns.adobe.com/xap/1.0/t/pg/"
    xmlns:stDim="http://ns.adobe.com/xap/1.0/sType/Dimensions#"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(docTitle)}</rdf:li></rdf:Alt></dc:title>
   <xmpTPg:NPages>1</xmpTPg:NPages>
   <xmpTPg:PlateNames>
    <rdf:Seq>
     <rdf:li>Cyan</rdf:li>
     <rdf:li>Magenta</rdf:li>
     <rdf:li>Yellow</rdf:li>
     <rdf:li>Black</rdf:li>
     ${spots.map(s => `<rdf:li>${escapeXml(s.channel.name)}</rdf:li>`).join('\n     ')}
    </rdf:Seq>
   </xmpTPg:PlateNames>
   <pdf:Producer>Adobe Photoshop for Windows -- Image Conversion Plug-in</pdf:Producer>
   <photoshop:ColorMode>4</photoshop:ColorMode>
   <photoshop:ICCProfile>Japan Web Coated (Ad)</photoshop:ICCProfile>
   <tiff:XResolution>${dpi * 10000}/10000</tiff:XResolution>
   <tiff:YResolution>${dpi * 10000}/10000</tiff:YResolution>
   <tiff:ResolutionUnit>2</tiff:ResolutionUnit>
   <exif:PixelXDimension>${w}</exif:PixelXDimension>
   <exif:PixelYDimension>${h}</exif:PixelYDimension>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const xmpBytes = new TextEncoder().encode(xmpXml);

  const pdf = new BinaryBuilder();
  const offsets = new Map();

  const startObj = (id) => {
    offsets.set(id, pdf.length);
    pdf.pushAscii(`${id} 0 obj\r`);
  };
  const endObj = () => {
    pdf.pushAscii(`\rendobj\r`);
  };
  const writeStreamObj = (id, dictStr, streamBytes) => {
    startObj(id);
    pdf.pushAscii(`${dictStr}stream\r\n`);
    pdf.pushBytes(streamBytes);
    pdf.pushAscii(`\r\nendstream`);
    endObj();
  };

  pdf.pushBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x36, 0x0d, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0d, 0x0a]));

  startObj(pagesId);
  pdf.pushAscii(`<</Count 1/Kids[${pageId} 0 R]/Type/Pages>>`);
  endObj();

  writeStreamObj(metadataId, `<</Length ${xmpBytes.length}/Subtype/XML/Type/Metadata>>`, xmpBytes);

  const safeTitle = docTitle.replace(/([()\\])/g, '\\$1');
  startObj(infoId);
  pdf.pushAscii(`<</Creator(Adobe Illustrator 28.0 \\(Windows\\))/Producer(Adobe Photoshop for Windows -- Image Conversion Plug-in)/Title(${safeTitle})>>`);
  endObj();

  startObj(catalogId);
  pdf.pushAscii(`<</Metadata ${metadataId} 0 R/Pages ${pagesId} 0 R/Type/Catalog>>`);
  endObj();

  const csEntries = spotObjIds.map((so, i) => `/CS${i} ${so.csIndexedId} 0 R`).join('') + `/DefaultCMYK ${defaultCmykId} 0 R`;
  const xobjEntries = spotObjIds.map((so, i) => `/Im${i} ${so.imXObjId} 0 R`).join('') + `/Im${N} ${mainImId} 0 R`;
  startObj(pageId);
  pdf.pushAscii(
    `<</ArtBox[0.0 0.0 ${ptWBox} ${ptHBox}]/Contents ${contentsId} 0 R/CropBox[0.0 0.0 ${ptWBox} ${ptHBox}]/MediaBox[0.0 0.0 ${ptWBox} ${ptHBox}]/Parent ${pagesId} 0 R` +
    `/Resources<</ColorSpace<<${csEntries}>>/ExtGState<</GS0 ${extGStateId} 0 R>>/ProcSet[/PDF/ImageC/ImageI]/XObject<<${xobjEntries}>>>>` +
    `/Rotate 0/Type/Page/PieceInfo<</AdobePhotoshop<</LastModified(D:20261021122108-03'00')/Private ${piecePrivateId} 0 R>>>>>>`
  );
  endObj();

  writeStreamObj(contentsId, `<</Length ${contentsBytes.length}>>`, contentsBytes);

  startObj(defaultCmykId);
  pdf.pushAscii(`[/ICCBased ${iccStreamId} 0 R]`);
  endObj();

  writeStreamObj(iccStreamId, `<</Filter/FlateDecode/Length ${iccFlatedBytes.length}/N 4>>`, iccFlatedBytes);

  startObj(extGStateId);
  pdf.pushAscii(`<</Type/ExtGState/op true>>`);
  endObj();

  for (let i = 0; i < N; i++) {
    const so = spotObjIds[i];
    const sp = spots[i];

    startObj(so.csIndexedId);
    pdf.pushAscii(`[/Indexed ${so.separationId} 0 R 255 ${so.lutId} 0 R]`);
    endObj();

    startObj(so.calRgbId);
    pdf.pushAscii(`[/CalRGB<</BlackPoint[0.0 0.0 0.0]/Gamma[2.19922 2.19922 2.19922]/Matrix[0.576675 0.297348 0.0270386 0.185562 0.627365 0.070694 0.188232 0.0752869 0.991318]/WhitePoint[0.950455 1.0 1.08905]>>]`);
    endObj();

    const psFuncStr = buildTintTransformPostScript(sp.channel.color);
    const psFuncBytes = new TextEncoder().encode(psFuncStr);
    writeStreamObj(so.tintFuncId, `<</Domain[0.0 1.0]/FunctionType 4/Length ${psFuncBytes.length}/Range[0.0 1.0 0.0 1.0 0.0 1.0]>>`, psFuncBytes);

    startObj(so.separationId);
    pdf.pushAscii(`[/Separation${pdfNameEscape(sp.channel.name)} ${so.calRgbId} 0 R ${so.tintFuncId} 0 R]`);
    endObj();

    writeStreamObj(so.lutId, `<</Length 256>>`, invertedLut);

    writeStreamObj(
      so.imXObjId,
      `<</BitsPerComponent 8/ColorSpace ${so.csIndexedId} 0 R/DecodeParms<</BitsPerComponent 8/Colors 1/Columns ${w}/Predictor 2>>/Filter/FlateDecode/Height ${h}/Length ${compressedSpots[i].length}/Name/X/Subtype/Image/Type/XObject/Width ${w}>>`,
      compressedSpots[i]
    );
  }

  writeStreamObj(
    smaskId,
    `<</BitsPerComponent 8/ColorSpace/DeviceGray/DecodeParms<</BitsPerComponent 8/Colors 1/Columns ${w}/Predictor 2>>/Filter/FlateDecode/Height ${h}/Length ${compressedAlpha.length}/Matte[0.0 0.0 0.0 0.0]/Name/X/Subtype/Image/Type/XObject/Width ${w}>>`,
    compressedAlpha
  );

  writeStreamObj(
    mainImId,
    `<</BitsPerComponent 8/ColorSpace/DeviceCMYK/DecodeParms<</BitsPerComponent 8/Colors 4/Columns ${w}/Predictor 2>>/Filter/FlateDecode/Height ${h}/Intent/Perceptual/Length ${compressedCmyk.length}/Name/X/SMask ${smaskId} 0 R/Subtype/Image/Type/XObject/Width ${w}>>`,
    compressedCmyk
  );

  writeStreamObj(
    compositeImId,
    `<</BitsPerComponent 8/ColorSpace ${defaultCmykId} 0 R/DecodeParms<</BitsPerComponent 8/Colors 4/Columns ${w}/Predictor 2>>/Filter/FlateDecode/Height ${h}/Length ${compressedCmyk.length}/Matte[0.0 0.0 0.0 0.0]/Name/X/SMask ${smaskId} 0 R/Subtype/Image/Type/XObject/Width ${w}>>`,
    compressedCmyk
  );

  writeStreamObj(imgResId, `<</Filter/FlateDecode/Length ${compressed8BIM.length}>>`, compressed8BIM);
  writeStreamObj(stdDataId, `<</Filter/FlateDecode/Length ${compressedLayrData.length}>>`, compressedLayrData);

  const spotDictEntries = spotObjIds.map((so, i) => `/Im${i + 1} ${so.imXObjId} 0 R`).join('');
  startObj(spotDictId);
  pdf.pushAscii(`<<${spotDictEntries}>>`);
  endObj();

  startObj(piecePrivateId);
  pdf.pushAscii(
    `<</CompositeImage ${compositeImId} 0 R/EmbedFonts true/ExportCrispy true/ImageResources ${imgResId} 0 R/RoundTrip true/SaveTransparency true` +
    `/SpotChannels<</N ${N}/XObject ${spotDictId} 0 R>>/StandardImageFileData ${stdDataId} 0 R/StandardImageFileLength ${rawLayrData.length}/UseTextOutlines false>>`
  );
  endObj();

  const totalObjs = nextId;
  const xrefOffset = pdf.length;
  pdf.pushAscii(`xref\r\n0 ${totalObjs}\r\n0000000000 65535 f \r\n`);
  for (let id = 1; id < totalObjs; id++) {
    const off = String(offsets.get(id) || 0).padStart(10, '0');
    pdf.pushAscii(`${off} 00000 n \r\n`);
  }
  pdf.pushAscii(`trailer\r\n<</Size ${totalObjs}/Root ${catalogId} 0 R/Info ${infoId} 0 R>>\r\nstartxref\r\n${xrefOffset}\r\n%%EOF\r\n`);

  return pdf.toUint8Array();
}

function triggerBlobDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const dlUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = dlUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(dlUrl), 8000);
}

async function exportPdfFile() {
  if (!state.cmykBuffer || !state.alphaBuffer) return;

  const hdrInput = document.getElementById('exportFileNameInput');
  const rawName = (hdrInput && hdrInput.value.trim()) ? hdrInput.value.trim() : state.fileName;
  const cleanTitle = rawName.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_') || 'Archivo_DTF';

  const btn = document.getElementById('btnExportPdf');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generando PDF...';

  try {
    const pdfBytes = await generatePdfBytesFromBuffers(
      state.widthPx,
      state.heightPx,
      state.dpi,
      cleanTitle,
      state.cmykBuffer,
      state.alphaBuffer,
      state.spotBuffers
    );
    triggerBlobDownload(pdfBytes, `${cleanTitle}.pdf`);
  } catch (err) {
    console.error(err);
    alert('Error al generar el PDF: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

function buildAiDesignPdfData(d, activeChannels) {
  const rendered = window.AiParser.renderDesignToBuffers(
    d,
    state.dpi,
    state.paddingPx,
    state.rotate90,
    state.stripSvgBgRect
  );
  const processed = applyFullBackgroundPipeline(
    rendered.rgba,
    rendered.cmyk,
    rendered.alpha,
    rendered.widthPx,
    rendered.heightPx
  );

  const spots = activeChannels.map(ch => {
    const res = computeSpotChannelMask(processed.alpha, processed.widthPx, processed.heightPx, ch.offsetPx, state.clampToAlphaBBox);
    return { channel: ch, inkMask: res.inkMask, pdfIndexed: res.pdfIndexed };
  });

  return {
    widthPx: processed.widthPx,
    heightPx: processed.heightPx,
    cmyk: processed.cmyk,
    alpha: processed.alpha,
    spots
  };
}

async function exportSingleAiDesignByIndex(idx, btnEl) {
  if (!state.aiDoc || !state.aiDoc.designs[idx]) return;
  const d = state.aiDoc.designs[idx];
  const activeChannels = state.spotChannels.filter(c => c.enabled);

  const origText = btnEl ? btnEl.textContent : '';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '⏳';
  }

  try {
    await new Promise(r => setTimeout(r, 20));
    const cleanTitle = (d.name || `Diseño_${idx + 1}`).replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_');
    const data = buildAiDesignPdfData(d, activeChannels);
    const pdfBytes = await generatePdfBytesFromBuffers(
      data.widthPx,
      data.heightPx,
      state.dpi,
      cleanTitle,
      data.cmyk,
      data.alpha,
      data.spots
    );
    triggerBlobDownload(pdfBytes, `${cleanTitle}.pdf`);
  } catch (err) {
    console.error(err);
    alert('Error al exportar el diseño: ' + err.message);
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = origText;
    }
  }
}

async function exportBatchAiPdfs() {
  if (!state.aiDoc) return;
  const selected = state.aiDoc.designs.filter(d => d.selected);
  if (selected.length === 0) {
    alert('Marca al menos un diseño con el checkbox para exportar.');
    return;
  }

  const activeChannels = state.spotChannels.filter(c => c.enabled);
  try {
    for (let i = 0; i < selected.length; i++) {
      const d = selected[i];
      showLoading(
        `Exportando PDF ${i + 1} de ${selected.length}...`,
        `${d.name} (${d.widthMm} × ${d.heightMm} mm @ ${state.dpi} PPP)`
      );
      await new Promise(r => setTimeout(r, 40));

      const data = buildAiDesignPdfData(d, activeChannels);
      const cleanTitle = (d.name || `Diseño_${i + 1}`).replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_');
      const pdfBytes = await generatePdfBytesFromBuffers(
        data.widthPx,
        data.heightPx,
        state.dpi,
        cleanTitle,
        data.cmyk,
        data.alpha,
        data.spots
      );
      triggerBlobDownload(pdfBytes, `${cleanTitle}.pdf`);
      await new Promise(r => setTimeout(r, 250));
    }
  } catch (err) {
    console.error(err);
    alert('Error en exportación por lote: ' + err.message);
  } finally {
    hideLoading();
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXml(str) {
  return escapeHtml(str).replace(/'/g, '&apos;');
}
