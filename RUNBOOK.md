# DTF Generator — Guía de Ejecución y Bitácora de Cambios

Este documento contiene la guía definitiva para levantar, ejecutar y recompilar el proyecto de forma ágil y confiable en este entorno (Windows), así como el registro continuo de cambios clave en la arquitectura y funcionalidad.

---

## 1. Cómo Levantar el Proyecto Efectivamente

> [!NOTE]
> Este proyecto **no depende de Node.js ni de Python**. Cuenta con un ejecutable ligero y nativo en C# (`GeneradorDTF.exe`) que levanta un servidor HTTP local y abre la interfaz web en una ventana dedicada de la aplicación.

### Método 1: Inicializador con Auto-Actualización (Recomendado para todas las PC)

Ejecuta `IniciarDTF.exe` para verificar automáticamente si hay cambios nuevos en Git / GitHub, descargarlos si existen y luego iniciar `GeneradorDTF.exe`:

```powershell
# Desde PowerShell o doble clic en IniciarDTF.exe:
Start-Process ".\IniciarDTF.exe"
```

* **Con Git instalado (repo clonado)**: Ejecuta `git fetch` + `git pull --ff-only` (seguro frente a cambios locales sin guardar).
* **Sin Git instalado (PC de producción)**: Consulta la API de GitHub (`gosh19/dtf-generator`) y descarga/extrae el paquete actualizado automáticamente.
* **Sin conexión a internet**: Omite la descarga y abre la versión local instalada.

### Método 1B: Ejecutable Directo (Sin buscar actualizaciones)

Inicia directamente el servidor HTTP interno en el puerto fijo `41789` y abre la aplicación en modo ventana (Edge/Chrome `--app`):

```powershell
# Desde PowerShell o la terminal de Windows:
Start-Process ".\GeneradorDTF.exe"
```

* **URL de acceso directo**: [`http://127.0.0.1:41789/index.html`](http://127.0.0.1:41789/index.html)
* **Comportamiento Multi-instancia**: Si el proceso ya se encuentra en ejecución en segundo plano (icono en la bandeja del sistema / System Tray), volver a ejecutarlo simplemente abrirá una nueva pestaña/ventana en el navegador sin crear conflictos de puertos.

### Método 2: Abrir Navegador si el Servidor ya está Activo

Si `GeneradorDTF.exe` ya está corriendo en segundo plano:

```powershell
Start-Process "http://127.0.0.1:41789/index.html"
```

Para verificar si el proceso está corriendo:
```powershell
Get-Process GeneradorDTF -ErrorAction SilentlyContinue
```

### Método 3: Recompilar los Ejecutables (Solo si se modifica `Program.cs` o `Launcher.cs`)

Los ejecutables se compilan usando el compilador estándar de C# incluido de fábrica en Windows (`csc.exe` de .NET Framework), sin requerir herramientas externas:

```powershell
# Recompilar GeneradorDTF.exe:
& "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:winexe /win32icon:app.ico /out:GeneradorDTF.exe Program.cs

# Recompilar IniciarDTF.exe (inicializador con auto-actualización):
& "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:winexe /win32icon:app.ico /reference:System.IO.Compression.FileSystem.dll /out:IniciarDTF.exe Launcher.cs
```

---

## 2. Puntos Técnicos Clave para Desarrollar con Eficiencia

1. **Evitar abrir directo con `file:///`**:
   Los navegadores bloquean o restringen ciertas APIs (Web Workers, lectura de blobs, perfiles ICC en `icc_data.js` o compresión de zstd) bajo el protocolo `file://`. Siempre acceder mediante `http://127.0.0.1:41789/index.html`.

2. **Refresco y Caché en Desarrollo**:
   Al modificar `app.js` o `styles.css`, refrescar el navegador con `Ctrl + F5` o `Ctrl + Shift + R` para forzar la recarga de scripts sin caché.

3. **Arquitectura del Front-end**:
   * `index.html`: Estructura principal y maquetado de controles.
   * `styles.css`: Estilos visuales en modo oscuro y layout responsivo del viewport.
   * `app.js`: Lógica principal del canvas, carga de imágenes, zoom, pan, generación de spot white y exportación a PDF.
   * `ai_parser.js`: Parser de capas y vectores de archivos Adobe Illustrator (`.ai`).
   * `icc_data.js`: Perfiles de color integrados para conversión precisa.
   * `Program.cs`: Servidor web local `HttpListener`, bandeja del sistema y lanzador de app para Windows.

---

## 3. Historial de Cambios Clave

Cada vez que se introduzcan mejoras, correcciones o cambios de arquitectura, se deben registrar a continuación para mantener el historial transparente y ejecutable:

| Fecha | Archivos Afectados | Resumen del Cambio | Impacto / Beneficio |
| :--- | :--- | :--- | :--- |
| **25/11/2026** | `app.js`, `index.html` | **Ajuste de valor predeterminado de Spot 3 y Spot 4 a `+1px`**:<br>- Se cambió `offsetPx` inicial y del preset de 4 canales (`presetExample4`) de `+2` a `+1` para Spot 3 y Spot 4, actualizando también el tooltip en `index.html`. | Reduce la expansión por defecto de los canales Spot 3 y 4 a `1px` sin tener que ajustarlo manualmente en cada archivo. |
| **25/11/2026** | `Launcher.cs`, `IniciarDTF.exe`, `Program.cs`, `GeneradorDTF.exe`, `.gitignore`, `RUNBOOK.md` | **Inicializador con Auto-Actualización (`IniciarDTF.exe`) y Prevención de Caché**:<br>- Nuevo ejecutable `IniciarDTF.exe` (compilado desde `Launcher.cs` con `app.ico` y ventana de estado oscura) que verifica y descarga cambios nuevos antes de iniciar `GeneradorDTF.exe`.<br>- **Modo Git nativo**: En PCs con repo clonado y `git` instalado, ejecuta `git fetch` y `git pull --ff-only` (protegiendo cambios locales sin guardar y soportando auto-actualización del propio inicializador).<br>- **Modo GitHub directo (fallback sin Git)**: En PCs sin Git instalado, consulta la API de GitHub (`gosh19/dtf-generator`), compara el SHA en `.dtf_version` y descarga/extrae el paquete actualizado automáticamente.<br>- **Modo offline seguro**: Si no hay internet, omite la actualización sin bloquear y abre la versión local.<br>- **No-cache en `Program.cs`**: Se agregó `Cache-Control: no-cache, no-store, must-revalidate` para `.js` y `.css` en el servidor local. | Elimina la necesidad de actualizar manualmente con pendrive en múltiples PCs y asegura que tras cada actualización los scripts y estilos nuevos se carguen inmediatamente sin requerir `Ctrl + F5`. |
| **06/11/2026** | `ai_parser.js` | **Inclusión de Objetos Hermanos Fuera de la Máscara de Corte y Posicionamiento Fiel de Rasters**:<br>- **Cálculo de BBox Inclusivo (`recalcElemBBox`)**: Calcula la caja delimitadora real de un grupo o elemento como la unión íntegra de sus componentes visibles (la porción visible del raster con su clip + todos los trazados y textos vectoriales que no forman parte de la máscara).<br>- **Desacople de la Máscara de Corte a Nivel de Elemento**: Se eliminó el truncamiento forzado de la caja global del grupo a la máscara de recorte, garantizando que textos u objetos hermanos (como "I+D AGRO" junto a la ilustración de la mano con planta) no sean cortados ni excluidos.<br>- **Posicionamiento 1:1 de Rasters Recortados**: Se preservan las coordenadas físicas originales del raster (`origMinX..origMaxX`) en `drawRasterElementOnCanvas`, colocando la imagen en su escala y posición real bajo `ctx.clip()` sin comprimirla ni deformarla.<br>- **Enrutamiento Mixto en `renderDesignToBuffers`**: Solo utiliza el muestreo directo de bytes de raster cuando el diseño es un raster puro sin máscara y sin formas vectoriales; si incluye máscaras o trazados vectoriales asociados, pasa por el pipeline Canvas 2D asegurando que todos los elementos y textos se rendericen.<br>- **Asociación retroactiva de clip**: Vincula la máscara `W n` al raster o shapes precedentes dentro del mismo bloque `q..Q`. | Corrige la pérdida de textos o detalles ubicados fuera de la máscara de corte en archivos complejos (ej. "Prod LEDFISHCORP... (2).ai"), asegurando que logos completos como "I+D AGRO" se capturen, seleccionen y rendericen al 100%. |
| **06/11/2026** | `ai_parser.js`, `app.js` | **Soporte de Máscaras de Corte (.AI) y Selección con Mouse sin Deformación**:<br>- **Corrección de Máscaras de Corte en PostScript**: Limpieza de `curSubpaths` en operadores `n`/`N`, soporte de operadores de clip (`W`, `W*`), pila de estados gráficos `q`/`Q` y soporte de operadores de relleno `Bb`/`bb`.<br>- **Prevención de Contaminación Cruzada**: Evita que los trazados de recorte unan diseños adyacentes en megabloques.<br>- **Recorte Proporcional en Muestreo Raster**: Muestreo proporcional sub-rectangular que evita estirar/deformar imágenes al seleccionarlas con el mouse.<br>- **Auto-Snap Inteligente en Selección con Mouse**: Al arrastrar con el mouse para encerrar diseños, se ajusta a los límites geométricos reales de los elementos manteniendo 100% sus proporciones originales.<br>- **Selección Precisa por Clic**: Al hacer clic en el mapa de la zona gris, selecciona el diseño más específico (menor área) en vez de recuadros superpuestos gigantes.<br>- **Soporte de tecla Shift**: Mantiene relación de aspecto 1:1 al arrastrar con el mouse. | Resuelve la imposibilidad de seleccionar diseños con máscara de corte y elimina la deformación visual y dimensional al usar el mouse. |
| **05/11/2026** | `app.js`, `styles.css` | **Pan con botón central y Zoom centrado bajo cursor**:<br>- Navegación panorámica (`is-panning`) arrastrando con la rueda del mouse presionada (botón central).<br>- Zoom con `Ctrl + Scroll` enfocado de forma precisa en las coordenadas del cursor del mouse.<br>- Centrado de canvas flexible con `margin: auto` en wrapper. | Facilita la inspección de detalles finos y curvas en diseños grandes sin desorientar al usuario. |
| **04/11/2026** | `app.js`, `styles.css` | Mejoras en controles de nivelación de producción y modos de vista. | Visualización más fiel del canal de tinta blanca / spot plate. |
| **02/11/2026** | `Program.cs`, `app.ico`, `GeneradorDTF.exe` | **Icono oficial embebido y mejoras del launcher**:<br>- Embebido de `app.ico` en el binario WinExe.<br>- Soporte para bandeja del sistema (System Tray) y detección de instancia única vía Mutex. | Presentación profesional como app de escritorio independiente. |
| **02/11/2026** | `app.js`, `index.html` | Estado inicial limpio: controles deshabilitados e inputs vacíos hasta que se carga un archivo válido. | Previene errores por interactuar con herramientas sin documento activo. |
