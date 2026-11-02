// ============================================================================
// Lector y Separador Nativo de Archivos Adobe Illustrator (.ai)
// Soporta objetos fuera de la mesa de trabajo (Zona Gris / Pasteboard),
// compresión %AI24_ZStandard_Data y %AI12_CompressedData (Zlib),
// grupos vectoriales CMYK y mapas de bits incrustados (%AI5_BeginRaster).
// ============================================================================

window.AiParser = {
  /**
   * Parsea un ArrayBuffer de un archivo .ai y devuelve:
   * - elements: todos los objetos de nivel superior en la zona gris/mesa
   * - designs: lista de diseños individuales listos para separar/exportar
   * - bbox: caja delimitadora total de la zona gris
   */
  async parseAiBuffer(arrayBuffer, fileName) {
    const bytes = new Uint8Array(arrayBuffer);
    const psBytes = await this.extractAndDecompressAiPostScript(bytes);
    if (!psBytes) {
      throw new Error('No se encontraron bloques AIPrivateData en el archivo .ai.');
    }
    return this.parsePostScriptLayer(psBytes, fileName);
  },

  async extractAndDecompressAiPostScript(fileBytes) {
    // Buscar en el contenedor PDF del .ai el diccionario /AIPrivateData1 .. /AIPrivateDataN
    // Escaneamos cabeceras "X 0 obj" rápidamente en ASCII Latin1 por tramos
    const objMap = new Map(); // objId -> { start, length }
    const privOrder = [];     // [{ index, objId }]

    const len = fileBytes.length;
    let pos = 0;

    // Función auxiliar para leer ASCII de un rango pequeño
    const asciiSlice = (start, end) => {
      let s = '';
      const lim = Math.min(len, end);
      for (let i = start; i < lim; i++) s += String.fromCharCode(fileBytes[i]);
      return s;
    };

    // Encontrar todos los "N 0 obj" en el archivo
    while (pos < len - 16) {
      // Buscar 'o', 'b', 'j'
      if (
        fileBytes[pos] === 0x6f &&     // 'o'
        fileBytes[pos + 1] === 0x62 && // 'b'
        fileBytes[pos + 2] === 0x6a && // 'j'
        (fileBytes[pos + 3] === 0x0d || fileBytes[pos + 3] === 0x0a || fileBytes[pos + 3] === 0x3c || fileBytes[pos + 3] === 0x20)
      ) {
        // Retroceder hasta 24 bytes para leer "<id> 0 obj"
        const lookBack = Math.max(0, pos - 24);
        const prefix = asciiSlice(lookBack, pos + 3);
        const m = prefix.match(/(?:^|[\r\n\s])(\d+)\s+0\s+obj$/);
        if (m) {
          const objId = parseInt(m[1], 10);
          const headerSlice = asciiSlice(pos + 3, pos + 5500);

          // Verificar si contiene /AIPrivateData
          if (headerSlice.includes('/AIPrivateData')) {
            const endObjIdx = headerSlice.indexOf('endobj');
            const dictText = endObjIdx > 0 ? headerSlice.slice(0, endObjIdx) : asciiSlice(pos + 3, pos + 20000);
            const rePriv = /\/AIPrivateData(\d+)\s+(\d+)\s+0\s+R/g;
            let pm;
            while ((pm = rePriv.exec(dictText)) !== null) {
              privOrder.push({ index: parseInt(pm[1], 10), objId: parseInt(pm[2], 10) });
            }
          }

          // Verificar si tiene /Length <num>...>>stream
          const sm = headerSlice.match(/^[\r\n\s]*<<[^>]*?\/Length\s+(\d+)[^>]*?>>stream(\r?\n)/);
          if (sm) {
            const streamLen = parseInt(sm[1], 10);
            const streamStart = pos + 3 + sm[0].length;
            objMap.set(objId, { start: streamStart, length: streamLen });
            pos = streamStart + streamLen;
            continue;
          }
        }
      }
      pos++;
    }

    if (privOrder.length === 0) {
      return null;
    }

    privOrder.sort((a, b) => a.index - b.index);

    // Calcular tamaño total concatenado
    let totalConcatLen = 0;
    for (const item of privOrder) {
      const info = objMap.get(item.objId);
      if (info) totalConcatLen += info.length;
    }

    const concat = new Uint8Array(totalConcatLen);
    let offset = 0;
    for (const item of privOrder) {
      const info = objMap.get(item.objId);
      if (info) {
        concat.set(fileBytes.subarray(info.start, info.start + info.length), offset);
        offset += info.length;
      }
    }

    // Detectar cabecera de compresión:
    // Caso 1: %AI24_ZStandard_Data (20 bytes) seguido de magic Zstd (28 B5 2F FD)
    const headStr = String.fromCharCode(...concat.subarray(0, Math.min(64, concat.length)));
    if (headStr.startsWith('%AI24_ZStandard_Data')) {
      const zstData = concat.subarray(20);
      if (typeof fzstd === 'undefined' || !fzstd.decompress) {
        throw new Error('No se encontró la librería fzstd para descomprimir AI24_ZStandard_Data.');
      }
      return fzstd.decompress(zstData);
    }

    // Caso 2: %AI12_CompressedData o Zlib directo (0x78 0x9C / 0x78 0xDA / 0x78 0x01)
    let zlibStart = -1;
    for (let i = 0; i < Math.min(256, concat.length - 2); i++) {
      if (
        concat[i] === 0x78 &&
        (concat[i + 1] === 0x9c || concat[i + 1] === 0xda || concat[i + 1] === 0x01 || concat[i + 1] === 0x5e)
      ) {
        zlibStart = i;
        break;
      }
    }

    if (zlibStart >= 0 && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(concat.subarray(zlibStart));
      writer.close();
      const resp = new Response(ds.readable);
      const ab = await resp.arrayBuffer();
      return new Uint8Array(ab);
    }

    // Caso 3: PostScript sin comprimir
    return concat;
  },

  findBytesAscii(buf, pattern, startPos = 0, endPos = buf.length) {
    const pLen = pattern.length;
    const first = pattern.charCodeAt(0);
    const limit = Math.min(buf.length, endPos) - pLen;
    for (let i = startPos; i <= limit; i++) {
      if (buf[i] === first) {
        let match = true;
        for (let j = 1; j < pLen; j++) {
          if (buf[i + j] !== pattern.charCodeAt(j)) {
            match = false;
            break;
          }
        }
        if (match) return i;
      }
    }
    return -1;
  },

  asciiFromBuf(buf, start, end) {
    let out = '';
    const chunk = 8192;
    for (let i = start; i < end; i += chunk) {
      const sub = buf.subarray(i, Math.min(end, i + chunk));
      out += String.fromCharCode.apply(null, sub);
    }
    return out;
  },

  parsePostScriptLayer(psBytes, fileName) {
    // 1. Encontrar %AI5_BeginLayer y %AI5_EndLayer--
    let layerStart = this.findBytesAscii(psBytes, '%AI5_BeginLayer', 0);
    if (layerStart < 0) {
      throw new Error('No se encontró %AI5_BeginLayer en los datos internos del .ai.');
    }

    // 2. Extraer definiciones de degradados (%AI5_BeginGradient .. %AI5_EndGradient) en todo el archivo
    const gradients = this.parseGradientsInSetup(psBytes, psBytes.length);

    // 3. Recorrer todas las capas (%AI5_BeginLayer .. %AI5_EndLayer--)
    const elements = [];
    let pos = layerStart;

    let uDepth = 0;
    let starUDepth = 0;
    let curElem = null;

    // Estado gráfico actual de PostScript
    let fillColor = { c: 0, m: 0, y: 0, k: 1 };
    let strokeColor = { c: 0, m: 0, y: 0, k: 1 };
    let strokeWidth = 1;
    let fillRule = 'nonzero'; // 0 XR = nonzero, 1 XR = evenodd
    let curSubpaths = [];
    let curPts = [];
    let compoundPaths = null;
    let activeGradient = null;

    const ensureTopElement = (type, defaultName) => {
      if (!curElem) {
        curElem = {
          id: elements.length,
          type,
          name: defaultName,
          minX: Infinity,
          minY: Infinity,
          maxX: -Infinity,
          maxY: -Infinity,
          shapes: [], // { subpaths, fillColor, strokeColor, strokeWidth, fillRule, doFill, doStroke, gradient }
          raster: null,
          isBgRect: false
        };
      }
    };

    const addCoordToElemBBox = (el, x, y) => {
      if (x < el.minX) el.minX = x;
      if (x > el.maxX) el.maxX = x;
      if (y < el.minY) el.minY = y;
      if (y > el.maxY) el.maxY = y;
    };

    const flushTopElementIfRoot = () => {
      if (uDepth === 0 && starUDepth === 0 && curElem) {
        if (curElem.minX <= curElem.maxX && (curElem.shapes.length > 0 || curElem.raster)) {
          curElem.widthPt = curElem.maxX - curElem.minX;
          curElem.heightPt = curElem.maxY - curElem.minY;
          curElem.widthMm = +(curElem.widthPt * 25.4 / 72).toFixed(2);
          curElem.heightMm = +(curElem.heightPt * 25.4 / 72).toFixed(2);
          // Detectar si es una placa/hoja de fondo simple (un único trazado grande > 100mm x 100mm)
          if (
            curElem.type === 'Path' &&
            curElem.shapes.length === 1 &&
            curElem.widthMm >= 100 &&
            curElem.heightMm >= 100
          ) {
            curElem.isBgRect = true;
            curElem.name = `Fondo / Hoja (${curElem.widthMm}×${curElem.heightMm} mm)`;
          }
          elements.push(curElem);
        }
        curElem = null;
      }
    };

    const totalLen = psBytes.length;

    while (pos < totalLen) {
      // ¿Estamos en %AI5_BeginRaster?
      if (
        psBytes[pos] === 0x25 && // '%'
        pos + 16 < totalLen &&
        psBytes[pos + 1] === 0x41 && // 'A'
        psBytes[pos + 4] === 0x5f && // '_'
        psBytes[pos + 10] === 0x52 && // 'R'
        this.asciiFromBuf(psBytes, pos, pos + 16) === '%AI5_BeginRaster'
      ) {
        const endRasterPos = this.findBytesAscii(psBytes, '%AI5_EndRaster', pos + 16);
        if (endRasterPos < 0) break;

        // Buscar marcador "\nXI" o "\rXI"
        let xiPos = this.findBytesAscii(psBytes, 'XI', pos + 16, Math.min(endRasterPos, pos + 2048));
        if (xiPos > 0) {
          const hdrStr = this.asciiFromBuf(psBytes, pos, xiPos);
          // Avanzar después de XI y su salto de línea (\r\n)
          let dataStart = xiPos + 2;
          while (dataStart < endRasterPos && (psBytes[dataStart] === 0x0d || psBytes[dataStart] === 0x0a)) {
            dataStart++;
          }

          // Parsear nombre del archivo y matriz [ a b c d tx ty ] w h 0 Xh
          let rName = 'Imagen Incrustada';
          const p1 = hdrStr.indexOf('(');
          const p2 = hdrStr.lastIndexOf(') 0 XG');
          if (p1 >= 0 && p2 > p1) {
            const rawPath = hdrStr.slice(p1 + 1, p2).replace(/\\\\/g, '\\');
            const parts = rawPath.split(/[\\/]/);
            rName = parts[parts.length - 1].replace(/\.[a-z0-9]+$/i, '');
          }

          // Buscar línea con parámetros de XI: [ a b c d tx ty ] 0 0 w h w h bpc channels alpha ...
          const mMatch = hdrStr.match(/\[\s*([^\]]+)\]\s+0\s+0\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+(\d+)\s+(\d+)\s+(\d+)/);
          if (mMatch) {
            const mtx = mMatch[1].trim().split(/\s+/).map(Number);
            const rw = parseInt(mMatch[2], 10);
            const rh = parseInt(mMatch[3], 10);
            const bpc = parseInt(mMatch[4], 10);
            const numCh = parseInt(mMatch[5], 10);
            const alphaCh = parseInt(mMatch[6], 10);

            const a = mtx[0], b = mtx[1], c = mtx[2], d = mtx[3], tx = mtx[4], ty = mtx[5];
            const minX = Math.min(tx, tx + a * rw);
            const maxX = Math.max(tx, tx + a * rw);
            const minY = Math.min(ty - Math.abs(d) * rh, ty);
            const maxY = Math.max(ty - Math.abs(d) * rh, ty);

            ensureTopElement('Raster', rName);
            addCoordToElemBBox(curElem, minX, minY);
            addCoordToElemBBox(curElem, maxX, maxY);
            curElem.name = rName;
            curElem.raster = {
              psBytes,
              dataStart,
              width: rw,
              height: rh,
              bpc,
              numCh,
              alphaCh,
              matrix: { a, b, c, d, tx, ty },
              minX, minY, maxX, maxY
            };
            flushTopElementIfRoot();
          }
        }

        pos = endRasterPos + 14;
        continue;
      }

      // Leer una línea de texto PostScript
      let lineEnd = pos;
      while (lineEnd < totalLen && psBytes[lineEnd] !== 0x0a && psBytes[lineEnd] !== 0x0d) {
        lineEnd++;
      }
      const lineLen = lineEnd - pos;
      const firstByte = psBytes[pos];

      // Avanzar puntero pos al inicio de la siguiente línea
      const lineStart = pos;
      pos = lineEnd;
      while (pos < totalLen && (psBytes[pos] === 0x0a || psBytes[pos] === 0x0d)) {
        pos++;
      }

      // Ignorar líneas vacías o comentarios '%' (excepto %AI5_EndLayer--)
      if (lineLen === 0) continue;
      if (firstByte === 0x25) { // '%'
        if (lineLen >= 15 && this.asciiFromBuf(psBytes, lineStart, lineStart + 15) === '%AI5_EndLayer--') {
          break;
        }
        continue;
      }

      const line = this.asciiFromBuf(psBytes, lineStart, lineEnd).trim();
      if (!line) continue;

      if (line === 'u') {
        if (uDepth === 0 && starUDepth === 0) {
          ensureTopElement('Group', `Diseño Vectorial #${elements.length + 1}`);
        }
        uDepth++;
        continue;
      }
      if (line === 'U') {
        uDepth = Math.max(0, uDepth - 1);
        flushTopElementIfRoot();
        continue;
      }
      if (line === '*u') {
        if (uDepth === 0 && starUDepth === 0) {
          ensureTopElement('Compound', `Forma #${elements.length + 1}`);
        }
        starUDepth++;
        compoundPaths = [];
        continue;
      }
      if (line === '*U') {
        starUDepth = Math.max(0, starUDepth - 1);
        if (starUDepth === 0 && compoundPaths && compoundPaths.length > 0 && curElem) {
          const lastShape = compoundPaths[compoundPaths.length - 1];
          const allSubpaths = [];
          for (const cp of compoundPaths) {
            for (const sp of cp.subpaths) allSubpaths.push(sp);
          }
          curElem.shapes.push({
            subpaths: allSubpaths,
            fillColor: { ...lastShape.fillColor },
            strokeColor: { ...lastShape.strokeColor },
            strokeWidth: lastShape.strokeWidth,
            fillRule: lastShape.fillRule,
            doFill: lastShape.doFill,
            doStroke: lastShape.doStroke,
            gradient: lastShape.gradient
          });
        }
        compoundPaths = null;
        flushTopElementIfRoot();
        continue;
      }

      const tokens = line.split(/\s+/);
      const op = tokens[tokens.length - 1];

      if (op === 'm' && tokens.length >= 3) {
        const x = parseFloat(tokens[0]);
        const y = parseFloat(tokens[1]);
        if (!isNaN(x) && !isNaN(y)) {
          if (uDepth === 0 && starUDepth === 0 && !curElem) {
            ensureTopElement('Path', `Trazado #${elements.length + 1}`);
          }
          if (curPts.length > 0) {
            curSubpaths.push({ pts: curPts, closed: false });
          }
          curPts = [{ cmd: 'M', x, y }];
          if (curElem) addCoordToElemBBox(curElem, x, y);
        }
      } else if ((op === 'l' || op === 'L') && tokens.length >= 3) {
        const x = parseFloat(tokens[0]);
        const y = parseFloat(tokens[1]);
        if (!isNaN(x) && !isNaN(y)) {
          curPts.push({ cmd: 'L', x, y });
          if (curElem) addCoordToElemBBox(curElem, x, y);
        }
      } else if ((op === 'c' || op === 'C') && tokens.length >= 7) {
        const x1 = parseFloat(tokens[0]), y1 = parseFloat(tokens[1]);
        const x2 = parseFloat(tokens[2]), y2 = parseFloat(tokens[3]);
        const x = parseFloat(tokens[4]), y = parseFloat(tokens[5]);
        if (!isNaN(x) && !isNaN(y)) {
          curPts.push({ cmd: 'C', x1, y1, x2, y2, x, y });
          if (curElem) {
            addCoordToElemBBox(curElem, x1, y1);
            addCoordToElemBBox(curElem, x2, y2);
            addCoordToElemBBox(curElem, x, y);
          }
        }
      } else if ((op === 'v' || op === 'V') && tokens.length >= 5) {
        const prev = curPts.length > 0 ? curPts[curPts.length - 1] : { x: 0, y: 0 };
        const x2 = parseFloat(tokens[0]), y2 = parseFloat(tokens[1]);
        const x = parseFloat(tokens[2]), y = parseFloat(tokens[3]);
        curPts.push({ cmd: 'C', x1: prev.x, y1: prev.y, x2, y2, x, y });
        if (curElem) addCoordToElemBBox(curElem, x, y);
      } else if ((op === 'y' || op === 'Y') && tokens.length >= 5) {
        const x1 = parseFloat(tokens[0]), y1 = parseFloat(tokens[1]);
        const x = parseFloat(tokens[2]), y = parseFloat(tokens[3]);
        curPts.push({ cmd: 'C', x1, y1, x2: x, y2: y, x, y });
        if (curElem) addCoordToElemBBox(curElem, x, y);
      } else if ((op === 'k' || op === 'x') && tokens.length >= 5) {
        fillColor = {
          c: Math.max(0, Math.min(1, parseFloat(tokens[0]) || 0)),
          m: Math.max(0, Math.min(1, parseFloat(tokens[1]) || 0)),
          y: Math.max(0, Math.min(1, parseFloat(tokens[2]) || 0)),
          k: Math.max(0, Math.min(1, parseFloat(tokens[3]) || 0))
        };
        activeGradient = null;
      } else if ((op === 'K' || op === 'X') && tokens.length >= 5) {
        strokeColor = {
          c: Math.max(0, Math.min(1, parseFloat(tokens[0]) || 0)),
          m: Math.max(0, Math.min(1, parseFloat(tokens[1]) || 0)),
          y: Math.max(0, Math.min(1, parseFloat(tokens[2]) || 0)),
          k: Math.max(0, Math.min(1, parseFloat(tokens[3]) || 0))
        };
      } else if (op === 'g' && tokens.length >= 2) {
        const gray = Math.max(0, Math.min(1, parseFloat(tokens[0]) || 0));
        fillColor = { c: 0, m: 0, y: 0, k: 1 - gray };
        activeGradient = null;
      } else if (op === 'G' && tokens.length >= 2) {
        const gray = Math.max(0, Math.min(1, parseFloat(tokens[0]) || 0));
        strokeColor = { c: 0, m: 0, y: 0, k: 1 - gray };
      } else if (op === 'Xa' && tokens.length >= 4) {
        const r = parseFloat(tokens[0]) || 0;
        const g = parseFloat(tokens[1]) || 0;
        const b = parseFloat(tokens[2]) || 0;
        const k = 1 - Math.max(r, g, b);
        fillColor = k >= 0.9999
          ? { c: 0, m: 0, y: 0, k: 1 }
          : { c: (1 - r - k) / (1 - k), m: (1 - g - k) / (1 - k), y: (1 - b - k) / (1 - k), k };
        activeGradient = null;
      } else if (op === 'XA' && tokens.length >= 4) {
        const r = parseFloat(tokens[0]) || 0;
        const g = parseFloat(tokens[1]) || 0;
        const b = parseFloat(tokens[2]) || 0;
        const k = 1 - Math.max(r, g, b);
        strokeColor = k >= 0.9999
          ? { c: 0, m: 0, y: 0, k: 1 }
          : { c: (1 - r - k) / (1 - k), m: (1 - g - k) / (1 - k), y: (1 - b - k) / (1 - k), k };
      } else if ((op === 'Xx' || op === 'Xk') && tokens.length >= 6) {
        // Custom spot color tint in AI: c m y k (Name) tint ka Xx
        const c = parseFloat(tokens[0]) || 0;
        const m = parseFloat(tokens[1]) || 0;
        const y = parseFloat(tokens[2]) || 0;
        const k = parseFloat(tokens[3]) || 0;
        const tint = 1 - (parseFloat(tokens[tokens.length - 3]) || 0);
        fillColor = { c: c * tint, m: m * tint, y: y * tint, k: k * tint };
        activeGradient = null;
      } else if ((op === 'XX' || op === 'XK') && tokens.length >= 6) {
        const c = parseFloat(tokens[0]) || 0;
        const m = parseFloat(tokens[1]) || 0;
        const y = parseFloat(tokens[2]) || 0;
        const k = parseFloat(tokens[3]) || 0;
        const tint = 1 - (parseFloat(tokens[tokens.length - 3]) || 0);
        strokeColor = { c: c * tint, m: m * tint, y: y * tint, k: k * tint };
      } else if (op === 'XR' && tokens.length >= 2) {
        fillRule = tokens[0] === '1' ? 'evenodd' : 'nonzero';
      } else if (op === 'w' && tokens.length >= 2) {
        strokeWidth = parseFloat(tokens[0]) || 1;
      } else if (op === 'Bg') {
        // [tipo] (Nombre Degradado) xOrigin yOrigin angle length a b c d tx ty flag Bg
        const gm = line.match(/\(([^)]+)\)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)/);
        if (gm) {
          const gName = gm[1];
          const gradDef = gradients.get(gName) || gradients.get(gName.toLowerCase()) || gradients.get(gName.trim());
          if (gradDef) {
            activeGradient = {
              def: gradDef,
              xOrigin: parseFloat(gm[2]) || 0,
              yOrigin: parseFloat(gm[3]) || 0,
              angle: parseFloat(gm[4]) || 0,
              length: parseFloat(gm[5]) || 100,
              matrix: null
            };
            fillColor = { ...gradDef.avgColor };
          }
        }
      } else if (op === 'Bm' && activeGradient && tokens.length >= 7) {
        activeGradient.matrix = [
          parseFloat(tokens[0]), parseFloat(tokens[1]),
          parseFloat(tokens[2]), parseFloat(tokens[3]),
          parseFloat(tokens[4]), parseFloat(tokens[5])
        ];
      } else if (op === 'f' || op === 'F' || op === 's' || op === 'S' || op === 'b' || op === 'B' || op === 'n' || op === 'N') {
        const isClosed = (op === 'f' || op === 's' || op === 'b' || op === 'n');
        if (curPts.length > 0) {
          curSubpaths.push({ pts: curPts, closed: isClosed });
          curPts = [];
        }
        if (op !== 'n' && op !== 'N') {
          if (curSubpaths.length > 0 && curElem) {
            const shapeObj = {
              subpaths: curSubpaths,
              fillColor: { ...fillColor },
              strokeColor: { ...strokeColor },
              strokeWidth,
              fillRule,
              doFill: (op === 'f' || op === 'F' || op === 'b' || op === 'B'),
              doStroke: (op === 's' || op === 'S' || op === 'b' || op === 'B'),
              gradient: activeGradient ? { ...activeGradient } : null
            };
            if (starUDepth > 0 && compoundPaths) {
              compoundPaths.push(shapeObj);
            } else {
              curElem.shapes.push(shapeObj);
            }
          }
          curSubpaths = [];
          if (uDepth === 0 && starUDepth === 0 && op !== 'f') {
            flushTopElementIfRoot();
          } else if (uDepth === 0 && starUDepth === 0 && op === 'f' && !activeGradient) {
            flushTopElementIfRoot();
          }
        }
      } else if (op === 'BB') {
        activeGradient = null;
        if (uDepth === 0 && starUDepth === 0) {
          flushTopElementIfRoot();
        }
      }
    }

    // Calcular caja delimitadora global de todos los elementos
    let globalMinX = Infinity, globalMinY = Infinity, globalMaxX = -Infinity, globalMaxY = -Infinity;
    for (const el of elements) {
      if (el.minX < globalMinX) globalMinX = el.minX;
      if (el.maxX > globalMaxX) globalMaxX = el.maxX;
      if (el.minY < globalMinY) globalMinY = el.minY;
      if (el.maxY > globalMaxY) globalMaxY = el.maxY;
    }

    // Construir lista de diseños candidatos para separar automáticamente
    const designs = this.buildSeparatedDesigns(elements, 4.0);

    return {
      fileName,
      elements,
      designs,
      bbox: {
        minX: globalMinX,
        minY: globalMinY,
        maxX: globalMaxX,
        maxY: globalMaxY
      }
    };
  },

  parseGradientsInSetup(psBytes, searchEnd = psBytes.length) {
    const gradients = new Map();
    let pos = 0;
    const limit = Math.min(psBytes.length, searchEnd);
    while (pos < limit) {
      let gStart = this.findBytesAscii(psBytes, '%AI5_BeginGradient:', pos, limit);
      if (gStart < 0) {
        gStart = this.findBytesAscii(psBytes, 'BeginGradient:', pos, limit);
      }
      if (gStart < 0) break;

      let gEnd = this.findBytesAscii(psBytes, '%AI5_EndGradient', gStart, limit);
      if (gEnd < 0) {
        gEnd = this.findBytesAscii(psBytes, 'EndGradient', gStart, limit);
      }
      if (gEnd < 0) break;

      const block = this.asciiFromBuf(psBytes, gStart, gEnd);
      const nameMatch = block.match(/\(([^)]+)\)\s+(\d+)\s+\d+\s+Bd/);
      if (nameMatch) {
        const gName = nameMatch[1];
        const gType = parseInt(nameMatch[2], 10); // 0 = linear, 1 = radial
        const stops = [];
        const lines = block.split(/\r?\n/);
        for (const l of lines) {
          const tl = l.trim();
          if (tl.endsWith('%_BS') || tl.endsWith('_BS')) {
            const rawTokens = tl.split(/\s+/);
            const nums = [];
            for (let i = 0; i < rawTokens.length - 1; i++) {
              const v = parseFloat(rawTokens[i]);
              if (!isNaN(v)) nums.push(v);
            }
            if (nums.length >= 5) {
              const rawOffset = nums[nums.length - 1];
              const offset = Math.max(0, Math.min(1, rawOffset > 1 ? rawOffset / 100 : rawOffset));
              let stopCmyk = { c: 0, m: 0, y: 0, k: 0 };
              if (nums.length >= 8) {
                // CMYK: c m y k midpoint ramp-flag color-type ramp-pos
                stopCmyk = {
                  c: Math.max(0, Math.min(1, nums[0] || 0)),
                  m: Math.max(0, Math.min(1, nums[1] || 0)),
                  y: Math.max(0, Math.min(1, nums[2] || 0)),
                  k: Math.max(0, Math.min(1, nums[3] || 0))
                };
              } else if (nums.length >= 7) {
                // RGB: r g b midpoint ramp-flag color-type ramp-pos
                const r = nums[0] || 0, g = nums[1] || 0, b = nums[2] || 0;
                const k = 1 - Math.max(r, g, b);
                stopCmyk = k >= 0.9999
                  ? { c: 0, m: 0, y: 0, k: 1 }
                  : { c: (1 - r - k) / (1 - k), m: (1 - g - k) / (1 - k), y: (1 - b - k) / (1 - k), k };
              } else if (nums.length >= 5) {
                // Grayscale: gray midpoint ramp-flag color-type ramp-pos
                const gray = nums[0] || 0;
                stopCmyk = { c: 0, m: 0, y: 0, k: Math.max(0, Math.min(1, 1 - gray)) };
              }
              stops.push({ ...stopCmyk, offset });
            }
          }
        }
        stops.sort((a, b) => a.offset - b.offset);
        let avgColor = { c: 0, m: 0, y: 0, k: 0.1 };
        if (stops.length > 0) {
          let sumC = 0, sumM = 0, sumY = 0, sumK = 0;
          for (const s of stops) {
            sumC += s.c; sumM += s.m; sumY += s.y; sumK += s.k;
          }
          avgColor = {
            c: sumC / stops.length,
            m: sumM / stops.length,
            y: sumY / stops.length,
            k: sumK / stops.length
          };
        }
        const gradObj = { name: gName, type: gType, stops, avgColor };
        gradients.set(gName, gradObj);
        gradients.set(gName.toLowerCase(), gradObj);
      }
      pos = gEnd + 16;
    }
    return gradients;
  },

  /**
   * Agrupa o separa automáticamente los diseños encontrados en la zona gris,
   * ignorando las placas/hojas grandes de fondo (isBgRect).
   */
  buildSeparatedDesigns(elements, mergeDistMm = 3.0) {
    // Incluir todas las piezas (incluso letras finas como 'I', 'l', puntos de 'i', tildes o guiones < 1.5mm)
    // para que se agrupen con su diseño y no desaparezcan al separar.
    const fgElements = elements.filter(el => !el.isBgRect && (el.widthPt > 0.05 || el.heightPt > 0.05));
    const mergeDistPt = (mergeDistMm * 72) / 25.4;

    const clusters = fgElements.map(el => ({
      minX: el.minX,
      minY: el.minY,
      maxX: el.maxX,
      maxY: el.maxY,
      elements: [el],
      name: el.name
    }));

    // Unir clusters que se solapen o estén a menos de mergeDistPt
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const a = clusters[i];
          const b = clusters[j];
          const overlapX = !(a.maxX + mergeDistPt < b.minX || b.maxX + mergeDistPt < a.minX);
          const overlapY = !(a.maxY + mergeDistPt < b.minY || b.maxY + mergeDistPt < a.minY);
          if (overlapX && overlapY) {
            a.minX = Math.min(a.minX, b.minX);
            a.minY = Math.min(a.minY, b.minY);
            a.maxX = Math.max(a.maxX, b.maxX);
            a.maxY = Math.max(a.maxY, b.maxY);
            for (const el of b.elements) a.elements.push(el);
            if (b.elements.some(e => e.type === 'Raster')) {
              a.name = b.name;
            }
            clusters.splice(j, 1);
            merged = true;
            break;
          }
        }
        if (merged) break;
      }
    }

    // Descartar únicamente puntos huérfanos aislados diminutos (< 0.8 mm en total) y mantener el orden de capas (el.id)
    const validClusters = clusters.filter(cl => {
      const wMm = ((cl.maxX - cl.minX) * 25.4) / 72;
      const hMm = ((cl.maxY - cl.minY) * 25.4) / 72;
      return wMm >= 0.8 || hMm >= 0.8;
    });

    return validClusters.map((cl, idx) => {
      // Ordenar los elementos por su ID original de PostScript para respetar qué capa va debajo y cuál encima
      cl.elements.sort((e1, e2) => e1.id - e2.id);

      const widthPt = cl.maxX - cl.minX;
      const heightPt = cl.maxY - cl.minY;
      const widthMm = +(widthPt * 25.4 / 72).toFixed(2);
      const heightMm = +(heightPt * 25.4 / 72).toFixed(2);
      const hasRaster = cl.elements.some(e => e.type === 'Raster');
      const label = hasRaster
        ? cl.name
        : `Diseño #${idx + 1} (${widthMm} × ${heightMm} mm)`;
      return {
        id: idx,
        selected: true,
        name: label,
        minX: cl.minX,
        minY: cl.minY,
        maxX: cl.maxX,
        maxY: cl.maxY,
        widthPt,
        heightPt,
        widthMm,
        heightMm,
        elements: cl.elements
      };
    });
  },

  getShapeBBox(sh) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (sh && sh.subpaths) {
      for (const sp of sh.subpaths) {
        for (const pt of sp.pts) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
        }
      }
    }
    if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0, widthPt: 0, heightPt: 0 };
    return { minX, minY, maxX, maxY, widthPt: maxX - minX, heightPt: maxY - minY };
  },

  isVectorBgShape(sh, refWidthPt, refHeightPt) {
    if (!sh || !sh.doFill || !sh.subpaths || sh.subpaths.length !== 1) return false;
    const pts = sh.subpaths[0].pts;
    if (!pts || pts.length < 4 || pts.length > 16) return false;
    const sb = this.getShapeBBox(sh);
    return sb.widthPt >= refWidthPt * 0.80 && sb.heightPt >= refHeightPt * 0.80;
  },

  hasVectorBgPlate(design) {
    if (!design || !design.elements || design.elements.length === 0) return false;
    let totalItems = 0;
    for (const el of design.elements) {
      if (el.raster) totalItems++;
      if (el.shapes) totalItems += el.shapes.length;
    }
    if (totalItems <= 1) return false;
    const firstEl = design.elements[0];
    if (!firstEl || firstEl.raster || !firstEl.shapes || firstEl.shapes.length === 0) return false;
    return this.isVectorBgShape(firstEl.shapes[0], design.widthPt, design.heightPt);
  },

  /**
   * Renderiza cualquier Diseño o Recorte de la zona gris directamente a buffers
   * CMYK (4 canales), Alpha (1 canal) y RGBA a la resolución indicada (ej. 300 PPP).
   */
  renderDesignToBuffers(design, dpi = 300, paddingPx = 0, rotate90 = false, stripVectorBg = false) {
    const baseW = Math.max(1, Math.round((design.widthPt / 72) * dpi));
    const baseH = Math.max(1, Math.round((design.heightPt / 72) * dpi));
    const unrotW = baseW + paddingPx * 2;
    const unrotH = baseH + paddingPx * 2;

    const scale = dpi / 72;

    // Si el diseño es un único Raster incrustado con datos CMYK+Alfa nativos,
    // muestrear directamente los bytes CMYK+Alfa originales de Illustrator para máxima fidelidad!
    if (design.elements.length === 1 && design.elements[0].raster) {
      const r = design.elements[0].raster;
      const cmykUnrot = new Uint8Array(unrotW * unrotH * 4);
      const alphaUnrot = new Uint8Array(unrotW * unrotH);
      const rgbaUnrot = new Uint8ClampedArray(unrotW * unrotH * 4);

      const srcW = r.width;
      const srcH = r.height;
      const cmykStart = r.dataStart;
      const alphaStart = r.dataStart + srcW * srcH * r.numCh;
      const ps = r.psBytes;

      for (let y = 0; y < baseH; y++) {
        const sy = Math.min(srcH - 1, Math.max(0, Math.floor((y / baseH) * srcH)));
        for (let x = 0; x < baseW; x++) {
          const sx = Math.min(srcW - 1, Math.max(0, Math.floor((x / baseW) * srcW)));
          const srcIdx = sy * srcW + sx;
          const dstIdx = (y + paddingPx) * unrotW + (x + paddingPx);

          const a = r.alphaCh > 0 ? ps[alphaStart + srcIdx] : 255;
          alphaUnrot[dstIdx] = a;
          if (a === 0) continue;

          const c = ps[cmykStart + srcIdx * 4];
          const m = ps[cmykStart + srcIdx * 4 + 1];
          const yv = ps[cmykStart + srcIdx * 4 + 2];
          const k = ps[cmykStart + srcIdx * 4 + 3];

          cmykUnrot[dstIdx * 4] = c;
          cmykUnrot[dstIdx * 4 + 1] = m;
          cmykUnrot[dstIdx * 4 + 2] = yv;
          cmykUnrot[dstIdx * 4 + 3] = k;

          const cf = c / 255, mf = m / 255, yf = yv / 255, kf = k / 255;
          rgbaUnrot[dstIdx * 4] = Math.round(255 * (1 - cf) * (1 - kf));
          rgbaUnrot[dstIdx * 4 + 1] = Math.round(255 * (1 - mf) * (1 - kf));
          rgbaUnrot[dstIdx * 4 + 2] = Math.round(255 * (1 - yf) * (1 - kf));
          rgbaUnrot[dstIdx * 4 + 3] = a;
        }
      }

      if (rotate90) {
        return this.rotateBuffers90CW(unrotW, unrotH, cmykUnrot, alphaUnrot, rgbaUnrot);
      }
      return { widthPx: unrotW, heightPx: unrotH, cmyk: cmykUnrot, alpha: alphaUnrot, rgba: rgbaUnrot };
    }

    // Para diseños vectoriales (o mixtos): renderizar en Canvas 2D de alta resolución
    const canvas = document.createElement('canvas');
    canvas.width = unrotW;
    canvas.height = unrotH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, unrotW, unrotH);

    // Transformar de coordenadas PostScript (minX..maxX, minY..maxY con Y hacia arriba) a píxeles
    const tx = (x) => paddingPx + (x - design.minX) * scale;
    const ty = (y) => paddingPx + (design.maxY - y) * scale;

    const skipFirstBgShape = stripVectorBg && this.hasVectorBgPlate(design);

    for (let elIdx = 0; elIdx < design.elements.length; elIdx++) {
      const el = design.elements[elIdx];
      if (el.raster) {
        this.drawRasterElementOnCanvas(ctx, el.raster, tx, ty, scale);
      }
      for (let shIdx = 0; shIdx < el.shapes.length; shIdx++) {
        if (skipFirstBgShape && elIdx === 0 && shIdx === 0) continue;
        this.drawVectorShapeOnCanvas(ctx, el.shapes[shIdx], tx, ty, scale);
      }
    }

    const imgData = ctx.getImageData(0, 0, unrotW, unrotH);
    const rgbaUnrot = imgData.data;
    const numPixels = unrotW * unrotH;
    const cmykUnrot = new Uint8Array(numPixels * 4);
    const alphaUnrot = new Uint8Array(numPixels);

    for (let i = 0; i < numPixels; i++) {
      const r = rgbaUnrot[i * 4];
      const g = rgbaUnrot[i * 4 + 1];
      const b = rgbaUnrot[i * 4 + 2];
      const a = rgbaUnrot[i * 4 + 3];
      alphaUnrot[i] = a;
      if (a === 0) continue;

      const rf = r / 255, gf = g / 255, bf = b / 255;
      const maxRgb = Math.max(rf, gf, bf);
      const minRgb = Math.min(rf, gf, bf);
      const k = 1 - maxRgb;

      if (k >= 0.9999) {
        cmykUnrot[i * 4 + 3] = 255;
      } else if (maxRgb >= 0.88 && minRgb < 0.02) {
        cmykUnrot[i * 4] = Math.round((1 - rf) * 255);
        cmykUnrot[i * 4 + 1] = Math.round((1 - gf) * 255);
        cmykUnrot[i * 4 + 2] = Math.round((1 - bf) * 255);
        cmykUnrot[i * 4 + 3] = 0;
      } else {
        cmykUnrot[i * 4] = Math.round(((1 - rf - k) / (1 - k)) * 255);
        cmykUnrot[i * 4 + 1] = Math.round(((1 - gf - k) / (1 - k)) * 255);
        cmykUnrot[i * 4 + 2] = Math.round(((1 - bf - k) / (1 - k)) * 255);
        cmykUnrot[i * 4 + 3] = Math.round(k * 255);
      }
    }

    if (rotate90) {
      return this.rotateBuffers90CW(unrotW, unrotH, cmykUnrot, alphaUnrot, rgbaUnrot);
    }
    return { widthPx: unrotW, heightPx: unrotH, cmyk: cmykUnrot, alpha: alphaUnrot, rgba: rgbaUnrot };
  },

  rotateBuffers90CW(w, h, cmyk, alpha, rgba) {
    const newW = h;
    const newH = w;
    const newCmyk = new Uint8Array(newW * newH * 4);
    const newAlpha = new Uint8Array(newW * newH);
    const newRgba = new Uint8ClampedArray(newW * newH * 4);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = y * w + x;
        const dstX = h - 1 - y;
        const dstY = x;
        const dstIdx = dstY * newW + dstX;

        newAlpha[dstIdx] = alpha[srcIdx];
        for (let c = 0; c < 4; c++) {
          newCmyk[dstIdx * 4 + c] = cmyk[srcIdx * 4 + c];
          newRgba[dstIdx * 4 + c] = rgba[srcIdx * 4 + c];
        }
      }
    }
    return { widthPx: newW, heightPx: newH, cmyk: newCmyk, alpha: newAlpha, rgba: newRgba };
  },

  cmykToCssRgb(col) {
    if (!col) return 'rgb(0,0,0)';
    if (col.r !== undefined && col.g !== undefined && col.b !== undefined) {
      return `rgb(${Math.round(col.r)},${Math.round(col.g)},${Math.round(col.b)})`;
    }
    const c = Math.max(0, Math.min(1, col.c || 0));
    const m = Math.max(0, Math.min(1, col.m || 0));
    const y = Math.max(0, Math.min(1, col.y || 0));
    const k = Math.max(0, Math.min(1, col.k || 0));
    const r = Math.round(255 * (1 - c) * (1 - k));
    const g = Math.round(255 * (1 - m) * (1 - k));
    const b = Math.round(255 * (1 - y) * (1 - k));
    return `rgb(${r},${g},${b})`;
  },

  drawVectorShapeOnCanvas(ctx, sh, tx, ty, scale) {
    ctx.beginPath();
    for (const sp of sh.subpaths) {
      for (const pt of sp.pts) {
        if (pt.cmd === 'M') {
          ctx.moveTo(tx(pt.x), ty(pt.y));
        } else if (pt.cmd === 'L') {
          ctx.lineTo(tx(pt.x), ty(pt.y));
        } else if (pt.cmd === 'C') {
          ctx.bezierCurveTo(tx(pt.x1), ty(pt.y1), tx(pt.x2), ty(pt.y2), tx(pt.x), ty(pt.y));
        }
      }
      if (sp.closed) ctx.closePath();
    }

    if (sh.doFill) {
      if (sh.gradient && sh.gradient.def && sh.gradient.def.stops && sh.gradient.def.stops.length > 0) {
        const g = sh.gradient;
        const rad = (g.angle * Math.PI) / 180;
        const len = Math.max(0.001, g.length || 1);

        let psX0, psY0, psX1, psY1;
        if (g.matrix && g.matrix.length >= 6) {
          const a = g.matrix[0], b = g.matrix[1], c = g.matrix[2], d = g.matrix[3], txM = g.matrix[4], tyM = g.matrix[5];
          const u0 = g.xOrigin || 0;
          const v0 = g.yOrigin || 0;
          const u1 = u0 + Math.cos(rad) * len;
          const v1 = v0 + Math.sin(rad) * len;

          psX0 = txM + a * u0 + c * v0;
          psY0 = tyM + b * u0 + d * v0;
          psX1 = txM + a * u1 + c * v1;
          psY1 = tyM + b * u1 + d * v1;
        } else {
          psX0 = g.xOrigin || 0;
          psY0 = g.yOrigin || 0;
          psX1 = psX0 + Math.cos(rad) * len;
          psY1 = psY0 + Math.sin(rad) * len;
        }

        const x0 = tx(psX0);
        const y0 = ty(psY0);
        let x1 = tx(psX1);
        let y1 = ty(psY1);

        if (Math.abs(x1 - x0) < 0.01 && Math.abs(y1 - y0) < 0.01) {
          x1 = x0 + 1;
        }

        let grad;
        if (g.def.type === 1) {
          // Radial
          const r = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
          grad = ctx.createRadialGradient(x0, y0, 0, x0, y0, r);
        } else {
          // Linear
          grad = ctx.createLinearGradient(x0, y0, x1, y1);
        }

        for (const st of g.def.stops) {
          const off = Math.max(0, Math.min(1, st.offset));
          grad.addColorStop(off, this.cmykToCssRgb(st));
        }
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = this.cmykToCssRgb(sh.fillColor);
      }
      ctx.fill(sh.fillRule || 'nonzero');
    }
    if (sh.doStroke) {
      ctx.strokeStyle = this.cmykToCssRgb(sh.strokeColor);
      ctx.lineWidth = Math.max(0.5, sh.strokeWidth * scale);
      ctx.stroke();
    }
  },

  drawRasterElementOnCanvas(ctx, r, tx, ty, scale) {
    if (!r._cachedCanvas) {
      // Decodificar raster una sola vez a un canvas temporal
      const rc = document.createElement('canvas');
      rc.width = r.width;
      rc.height = r.height;
      const rctx = rc.getContext('2d');
      const img = rctx.createImageData(r.width, r.height);
      const dst = img.data;
      const numPx = r.width * r.height;
      const cmykStart = r.dataStart;
      const alphaStart = r.dataStart + numPx * r.numCh;
      const ps = r.psBytes;

      for (let i = 0; i < numPx; i++) {
        const a = r.alphaCh > 0 ? ps[alphaStart + i] : 255;
        if (a === 0) continue;
        const c = ps[cmykStart + i * 4] / 255;
        const m = ps[cmykStart + i * 4 + 1] / 255;
        const y = ps[cmykStart + i * 4 + 2] / 255;
        const k = ps[cmykStart + i * 4 + 3] / 255;
        dst[i * 4] = Math.round(255 * (1 - c) * (1 - k));
        dst[i * 4 + 1] = Math.round(255 * (1 - m) * (1 - k));
        dst[i * 4 + 2] = Math.round(255 * (1 - y) * (1 - k));
        dst[i * 4 + 3] = a;
      }
      rctx.putImageData(img, 0, 0);
      r._cachedCanvas = rc;
    }

    const x = tx(r.minX);
    const y = ty(r.maxY);
    const w = (r.maxX - r.minX) * scale;
    const h = (r.maxY - r.minY) * scale;
    ctx.drawImage(r._cachedCanvas, x, y, w, h);
  }
};
