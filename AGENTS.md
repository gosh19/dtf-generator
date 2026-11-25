# Reglas del Proyecto DTF Generator para Antigravity

Este archivo define las reglas e instrucciones obligatorias para el asistente de IA en este espacio de trabajo.

## 1. Protocolo para Levantar el Proyecto

Siempre que el usuario solicite **"levantar el proyecto"**, **"iniciar la app"**, **"correr"**, **"probar"** o comandos equivalentes:

1. **Consultar y seguir los pasos de [RUNBOOK.md](./RUNBOOK.md)**.
2. **Verificar si el proceso ya está activo**:
   Ejecutar en PowerShell:
   ```powershell
   Get-Process GeneradorDTF -ErrorAction SilentlyContinue
   ```
3. **Acción a tomar**:
   * **Si NO está corriendo**:
     Iniciar el servidor nativo ejecutando:
     ```powershell
     Start-Process ".\GeneradorDTF.exe"
     ```
   * **Si YA está corriendo**:
     Lanzar o enfocar la pestaña del navegador:
     ```powershell
     Start-Process "http://127.0.0.1:41789/index.html"
     ```
   * **Si se realizaron cambios en `Program.cs`**:
     Recompilar primero antes de iniciar:
     ```powershell
     & "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:winexe /win32icon:app.ico /out:GeneradorDTF.exe Program.cs
     ```
4. Responder al usuario indicando el estado del servicio y el enlace local accesible: [`http://127.0.0.1:41789/index.html`](http://127.0.0.1:41789/index.html).

---

## 2. Registro Continuo de Cambios Clave (Bitácora)

Cada vez que se complete una modificación funcional, corrección de errores relevante o cambio de arquitectura en el código (`app.js`, `styles.css`, `index.html`, `Program.cs`, etc.):

1. **Editar [RUNBOOK.md](./RUNBOOK.md)** e incorporar una nueva entrada en la tabla **`3. Historial de Cambios Clave`**.
2. Incluir:
   * **Fecha**: Día de la modificación.
   * **Archivos Afectados**: Lista de archivos tocados.
   * **Resumen del Cambio**: Breve descripción técnica de qué se agregó o modificó.
   * **Impacto / Beneficio**: Por qué se hizo y qué mejora aporta a la ejecución o experiencia de uso.
