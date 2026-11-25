using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace GeneradorDTFLauncher
{
    static class Launcher
    {
        private const string GitHubOwner = "gosh19";
        private const string GitHubRepo = "dtf-generator";
        private const string DefaultBranch = "main";
        private const string TargetExeName = "GeneradorDTF.exe";
        private const string VersionFileName = ".dtf_version";

        private static string rootDir;
        private static string selfExePath;
        private static SplashForm splash;

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Habilitar TLS 1.2 para conexiones HTTPS a GitHub en .NET Framework 4.x
            try
            {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | SecurityProtocolType.Tls;
            }
            catch { }

            rootDir = AppDomain.CurrentDomain.BaseDirectory;
            selfExePath = Assembly.GetExecutingAssembly().Location;

            CleanupOldSelfBinary();

            bool skipUpdate = false;
            if (args != null)
            {
                foreach (string a in args)
                {
                    if (string.Equals(a, "--skip-update", StringComparison.OrdinalIgnoreCase))
                    {
                        skipUpdate = true;
                        break;
                    }
                }
            }

            if (skipUpdate)
            {
                LaunchMainApp();
                return;
            }

            splash = new SplashForm(rootDir);
            splash.Shown += (s, e) =>
            {
                Thread worker = new Thread(RunUpdateAndLaunch)
                {
                    IsBackground = true
                };
                worker.Start();
            };

            Application.Run(splash);
        }

        private static void CleanupOldSelfBinary()
        {
            try
            {
                string oldPath = selfExePath + ".old";
                if (File.Exists(oldPath))
                {
                    File.Delete(oldPath);
                }
            }
            catch { }
        }

        private static void SetStatus(string status, string detail, string versionTag, int? progressPercent, bool isSuccess)
        {
            if (splash != null && !splash.IsDisposed)
            {
                try
                {
                    splash.BeginInvoke((Action)(() => splash.UpdateState(status, detail, versionTag, progressPercent, isSuccess)));
                }
                catch { }
            }
        }

        private static void CloseSplash()
        {
            if (splash != null && !splash.IsDisposed)
            {
                try
                {
                    splash.BeginInvoke((Action)(() => splash.Close()));
                }
                catch { }
            }
        }

        private static void RunUpdateAndLaunch()
        {
            bool relaunchDeferred = false;

            try
            {
                SetStatus("Verificando actualizaciones...", "Conectando con el repositorio...", null, null, false);

                bool hasGitDir = Directory.Exists(Path.Combine(rootDir, ".git"));
                bool hasGitCli = hasGitDir && IsGitAvailable();

                if (hasGitDir && hasGitCli)
                {
                    relaunchDeferred = TryUpdateViaGit();
                }
                else
                {
                    TryUpdateViaGitHubZip();
                }
            }
            catch (Exception ex)
            {
                SetStatus("Iniciando versión local...", "No se pudo verificar actualizaciones", null, 100, false);
                LogError("Error general en actualizador: " + ex.Message);
                Thread.Sleep(700);
            }

            if (!relaunchDeferred)
            {
                SetStatus("Iniciando Generador DTF...", "Abriendo aplicación de escritorio", null, 100, true);
                LaunchMainApp();
                Thread.Sleep(650);
            }

            CloseSplash();
        }

        private static bool IsGitAvailable()
        {
            try
            {
                CommandResult res = RunProcess("git", "--version", rootDir, 5000);
                return res.ExitCode == 0;
            }
            catch
            {
                return false;
            }
        }

        private static bool TryUpdateViaGit()
        {
            string branch = DefaultBranch;
            CommandResult branchRes = RunProcess("git", "rev-parse --abbrev-ref HEAD", rootDir, 5000);
            if (branchRes.ExitCode == 0 && !string.IsNullOrWhiteSpace(branchRes.StdOut))
            {
                string detected = branchRes.StdOut.Trim();
                if (detected != "HEAD")
                {
                    branch = detected;
                }
            }

            string shortSha = "";
            CommandResult shaRes = RunProcess("git", "rev-parse --short HEAD", rootDir, 5000);
            if (shaRes.ExitCode == 0 && !string.IsNullOrWhiteSpace(shaRes.StdOut))
            {
                shortSha = "v" + shaRes.StdOut.Trim();
            }

            SetStatus("Verificando actualizaciones...", "Git · rama " + branch, shortSha, null, false);
            CommandResult fetchRes = RunProcess("git", "fetch origin " + branch, rootDir, 15000);
            if (fetchRes.TimedOut || fetchRes.ExitCode != 0)
            {
                SetStatus("Modo sin conexión", "No se pudo contactar al servidor · usando versión local", shortSha, 100, false);
                Thread.Sleep(700);
                return false;
            }

            CommandResult countRes = RunProcess("git", "rev-list --count HEAD..origin/" + branch, rootDir, 5000);
            int behindCount = 0;
            if (countRes.ExitCode == 0)
            {
                int.TryParse(countRes.StdOut.Trim(), out behindCount);
            }

            if (behindCount <= 0)
            {
                SetStatus("Todo al día", "Git · rama " + branch + " actualizada", shortSha, 100, true);
                Thread.Sleep(550);
                return false;
            }

            SetStatus(
                "Descargando " + behindCount + (behindCount == 1 ? " actualización..." : " actualizaciones..."),
                "Sincronizando cambios desde Git (" + branch + ")",
                shortSha,
                null,
                false
            );

            CloseRunningTargetApp();

            string selfName = Path.GetFileName(selfExePath);
            CommandResult diffRes = RunProcess("git", "diff --name-only HEAD..origin/" + branch, rootDir, 5000);
            bool selfChanged = false;
            if (diffRes.ExitCode == 0 && !string.IsNullOrEmpty(diffRes.StdOut))
            {
                string[] lines = diffRes.StdOut.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                foreach (string line in lines)
                {
                    if (string.Equals(line.Trim(), selfName, StringComparison.OrdinalIgnoreCase))
                    {
                        selfChanged = true;
                        break;
                    }
                }
            }

            if (selfChanged)
            {
                SetStatus("Actualizando inicializador...", "Reiniciando para aplicar cambios", shortSha, 85, false);
                Thread.Sleep(450);
                RunDeferredGitSelfUpdate(branch, selfName);
                return true;
            }

            CommandResult pullRes = RunProcess("git", "pull --ff-only origin " + branch, rootDir, 30000);
            if (pullRes.ExitCode == 0)
            {
                CommandResult newShaRes = RunProcess("git", "rev-parse --short HEAD", rootDir, 5000);
                string newSha = (newShaRes.ExitCode == 0 && !string.IsNullOrWhiteSpace(newShaRes.StdOut)) ? "v" + newShaRes.StdOut.Trim() : shortSha;
                SetStatus("Actualización completada", "Nueva versión lista para usar", newSha, 100, true);
                Thread.Sleep(600);
                return false;
            }

            LogError("git pull falló: " + pullRes.StdErr + " " + pullRes.StdOut);
            SetStatus("Cambios locales detectados", "Se iniciará la versión local actual", shortSha, 100, false);

            if (splash != null && !splash.IsDisposed)
            {
                splash.Invoke((Action)(() =>
                {
                    MessageBox.Show(
                        splash,
                        "Se encontraron actualizaciones en Git, pero no se pudieron aplicar automáticamente porque hay cambios locales sin guardar en esta carpeta.\n\nSe iniciará la versión local actual.",
                        "Generador DTF — Actualizador",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                }));
            }

            return false;
        }

        private static void RunDeferredGitSelfUpdate(string branch, string selfName)
        {
            string cmdArgs = "/c ping 127.0.0.1 -n 2 >nul & git pull --ff-only origin " + branch + " & start \"\" \"" + selfName + "\" --skip-update";
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = cmdArgs,
                WorkingDirectory = rootDir,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(psi);
        }

        private static void TryUpdateViaGitHubZip()
        {
            string versionFilePath = Path.Combine(rootDir, VersionFileName);
            string localSha = File.Exists(versionFilePath) ? File.ReadAllText(versionFilePath).Trim() : "";
            string localTag = localSha.Length >= 7 ? "v" + localSha.Substring(0, 7) : "";

            SetStatus("Verificando actualizaciones...", "GitHub · " + GitHubOwner + "/" + GitHubRepo, localTag, null, false);

            string remoteSha = FetchLatestGitHubCommitSha();
            if (string.IsNullOrEmpty(remoteSha))
            {
                SetStatus("Modo sin conexión", "Usando versión local instalada", localTag, 100, false);
                Thread.Sleep(700);
                return;
            }

            string remoteTag = "v" + remoteSha.Substring(0, 7);
            string targetExePath = Path.Combine(rootDir, TargetExeName);

            if (string.Equals(localSha, remoteSha, StringComparison.OrdinalIgnoreCase) && File.Exists(targetExePath))
            {
                SetStatus("Todo al día", "GitHub · última versión instalada", remoteTag, 100, true);
                Thread.Sleep(550);
                return;
            }

            SetStatus("Descargando nueva versión...", "Obteniendo archivos desde GitHub", remoteTag, null, false);
            CloseRunningTargetApp();

            string tempId = Guid.NewGuid().ToString("N");
            string zipPath = Path.Combine(Path.GetTempPath(), "dtf_update_" + tempId + ".zip");
            string extractDir = Path.Combine(Path.GetTempPath(), "dtf_update_" + tempId);

            try
            {
                string zipUrl = "https://github.com/" + GitHubOwner + "/" + GitHubRepo + "/archive/refs/heads/" + DefaultBranch + ".zip";
                using (WebClient wc = new TimeoutWebClient(30000))
                {
                    wc.Headers.Add("User-Agent", "GeneradorDTF-Updater");
                    wc.DownloadFile(zipUrl, zipPath);
                }

                SetStatus("Instalando actualización...", "Extrayendo archivos nuevos", remoteTag, 75, false);
                ZipFile.ExtractToDirectory(zipPath, extractDir);

                string[] topDirs = Directory.GetDirectories(extractDir);
                string sourceRoot = topDirs.Length == 1 ? topDirs[0] : extractDir;

                CopyDirectoryContents(sourceRoot, rootDir);
                File.WriteAllText(versionFilePath, remoteSha);

                SetStatus("Actualización completada", "Nueva versión instalada correctamente", remoteTag, 100, true);
                Thread.Sleep(600);
            }
            catch (Exception ex)
            {
                LogError("Error descargando actualización desde GitHub: " + ex.Message);
                SetStatus("Error al descargar actualización", "Iniciando versión local...", localTag, 100, false);
                Thread.Sleep(800);
            }
            finally
            {
                try { if (File.Exists(zipPath)) File.Delete(zipPath); } catch { }
                try { if (Directory.Exists(extractDir)) Directory.Delete(extractDir, true); } catch { }
            }
        }

        private static string FetchLatestGitHubCommitSha()
        {
            try
            {
                string apiUrl = "https://api.github.com/repos/" + GitHubOwner + "/" + GitHubRepo + "/commits/" + DefaultBranch;
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(apiUrl);
                req.UserAgent = "GeneradorDTF-Updater";
                req.Accept = "application/vnd.github.v3+json";
                req.Timeout = 8000;
                req.ReadWriteTimeout = 8000;

                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string json = reader.ReadToEnd();
                    Match m = Regex.Match(json, "\"sha\"\\s*:\\s*\"([0-9a-fA-F]{40})\"");
                    if (m.Success)
                    {
                        return m.Groups[1].Value;
                    }
                }
            }
            catch (Exception ex)
            {
                LogError("Error consultando API de GitHub: " + ex.Message);
            }

            return null;
        }

        private static void CopyDirectoryContents(string sourceDir, string destDir)
        {
            foreach (string dirPath in Directory.GetDirectories(sourceDir, "*", SearchOption.AllDirectories))
            {
                string rel = dirPath.Substring(sourceDir.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (rel.StartsWith(".git", StringComparison.OrdinalIgnoreCase)) continue;
                string targetSubDir = Path.Combine(destDir, rel);
                if (!Directory.Exists(targetSubDir))
                {
                    Directory.CreateDirectory(targetSubDir);
                }
            }

            foreach (string filePath in Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories))
            {
                string rel = filePath.Substring(sourceDir.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (rel.StartsWith(".git", StringComparison.OrdinalIgnoreCase)) continue;

                string destFile = Path.Combine(destDir, rel);
                string destFolder = Path.GetDirectoryName(destFile);
                if (!string.IsNullOrEmpty(destFolder) && !Directory.Exists(destFolder))
                {
                    Directory.CreateDirectory(destFolder);
                }

                if (string.Equals(Path.GetFullPath(destFile), Path.GetFullPath(selfExePath), StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        string oldPath = selfExePath + ".old";
                        if (File.Exists(oldPath)) File.Delete(oldPath);
                        File.Move(selfExePath, oldPath);
                        File.Copy(filePath, destFile, true);
                    }
                    catch { }
                    continue;
                }

                try
                {
                    File.Copy(filePath, destFile, true);
                }
                catch (Exception ex)
                {
                    LogError("No se pudo copiar " + rel + ": " + ex.Message);
                }
            }
        }

        private static void CloseRunningTargetApp()
        {
            try
            {
                string procName = Path.GetFileNameWithoutExtension(TargetExeName);
                Process[] procs = Process.GetProcessesByName(procName);
                foreach (Process p in procs)
                {
                    try
                    {
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                    catch { }
                }
            }
            catch { }
        }

        private static void LaunchMainApp()
        {
            string targetExe = Path.Combine(rootDir, TargetExeName);
            if (!File.Exists(targetExe))
            {
                MessageBox.Show(
                    "No se encontró " + TargetExeName + " en la carpeta:\n" + rootDir + "\n\nVerificá tu conexión a internet e intentá nuevamente.",
                    "Generador DTF",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = targetExe,
                    WorkingDirectory = rootDir,
                    UseShellExecute = true
                };
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error al iniciar " + TargetExeName + ": " + ex.Message, "Generador DTF", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static CommandResult RunProcess(string fileName, string arguments, string workingDir, int timeoutMs)
        {
            CommandResult result = new CommandResult();
            StringBuilder outSb = new StringBuilder();
            StringBuilder errSb = new StringBuilder();

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                WorkingDirectory = workingDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            psi.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";

            using (Process proc = new Process { StartInfo = psi })
            {
                proc.OutputDataReceived += (s, e) => { if (e.Data != null) outSb.AppendLine(e.Data); };
                proc.ErrorDataReceived += (s, e) => { if (e.Data != null) errSb.AppendLine(e.Data); };

                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                if (!proc.WaitForExit(timeoutMs))
                {
                    result.TimedOut = true;
                    result.ExitCode = -1;
                    try { proc.Kill(); } catch { }
                }
                else
                {
                    proc.WaitForExit();
                    result.ExitCode = proc.ExitCode;
                }
            }

            result.StdOut = outSb.ToString();
            result.StdErr = errSb.ToString();
            return result;
        }

        private static void LogError(string message)
        {
            try
            {
                string logPath = Path.Combine(rootDir, "updater.log");
                File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " | " + message + Environment.NewLine);
            }
            catch { }
        }

        private class CommandResult
        {
            public int ExitCode;
            public string StdOut = "";
            public string StdErr = "";
            public bool TimedOut;
        }

        private class TimeoutWebClient : WebClient
        {
            private readonly int timeoutMs;
            public TimeoutWebClient(int timeoutMs) { this.timeoutMs = timeoutMs; }

            protected override WebRequest GetWebRequest(Uri address)
            {
                WebRequest req = base.GetWebRequest(address);
                if (req != null)
                {
                    req.Timeout = timeoutMs;
                }
                return req;
            }
        }
    }

    class SplashForm : Form
    {
        private readonly Image logoImage;
        private readonly System.Windows.Forms.Timer animTimer;
        private string statusText = "Verificando actualizaciones...";
        private string detailText = "Iniciando verificador";
        private string versionText = "";
        private int? progressPercent = null;
        private bool isSuccess = false;
        private float animOffset = 0f;

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
                return cp;
            }
        }

        public SplashForm(string rootDir)
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(460, 250);
            BackColor = Color.FromArgb(15, 23, 42);
            DoubleBuffered = true;
            ShowInTaskbar = true;
            Text = "Generador DTF";

            Icon appIcon = null;
            string icoPath = Path.Combine(rootDir, "app.ico");
            if (File.Exists(icoPath))
            {
                try { appIcon = new Icon(icoPath); } catch { }
            }
            if (appIcon == null)
            {
                try { appIcon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
            }
            if (appIcon != null)
            {
                Icon = appIcon;
            }

            string pngPath = Path.Combine(rootDir, "app_icon.png");
            if (File.Exists(pngPath))
            {
                try
                {
                    using (Image tmp = Image.FromFile(pngPath))
                    {
                        logoImage = new Bitmap(tmp);
                    }
                }
                catch { }
            }
            if (logoImage == null && appIcon != null)
            {
                try { logoImage = appIcon.ToBitmap(); } catch { }
            }

            animTimer = new System.Windows.Forms.Timer { Interval = 16 };
            animTimer.Tick += (s, e) =>
            {
                animOffset += 0.025f;
                if (animOffset > 1.35f) animOffset = -0.35f;
                Invalidate();
            };
            animTimer.Start();

            FormClosed += (s, e) =>
            {
                animTimer.Stop();
                animTimer.Dispose();
                if (logoImage != null) logoImage.Dispose();
            };
        }

        public void UpdateState(string status, string detail, string versionTag, int? percent, bool success)
        {
            if (status != null) statusText = status;
            if (detail != null) detailText = detail;
            if (versionTag != null) versionText = versionTag;
            progressPercent = percent;
            isSuccess = success;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            // Fondo con degradado sutil oscuro
            using (LinearGradientBrush bgBrush = new LinearGradientBrush(
                ClientRectangle,
                Color.FromArgb(18, 26, 46),
                Color.FromArgb(11, 17, 32),
                LinearGradientMode.Vertical))
            {
                g.FillRectangle(bgBrush, ClientRectangle);
            }

            // Franja superior de acento
            using (LinearGradientBrush accentBrush = new LinearGradientBrush(
                new Rectangle(0, 0, Width, 3),
                Color.FromArgb(56, 189, 248),
                Color.FromArgb(99, 102, 241),
                LinearGradientMode.Horizontal))
            {
                g.FillRectangle(accentBrush, 0, 0, Width, 3);
            }

            // Borde elegante
            using (Pen borderPen = new Pen(Color.FromArgb(51, 65, 85), 1))
            {
                g.DrawRectangle(borderPen, 0, 0, Width - 1, Height - 1);
            }

            // Logo centrado arriba
            if (logoImage != null)
            {
                int logoSize = 64;
                int logoX = (Width - logoSize) / 2;
                int logoY = 26;
                g.DrawImage(logoImage, new Rectangle(logoX, logoY, logoSize, logoSize));
            }

            // Título y subtítulo centrados
            using (Font titleFont = new Font("Segoe UI", 15.5f, FontStyle.Bold))
            using (Font subFont = new Font("Segoe UI", 9f, FontStyle.Regular))
            using (SolidBrush whiteBrush = new SolidBrush(Color.FromArgb(248, 250, 252)))
            using (SolidBrush mutedBrush = new SolidBrush(Color.FromArgb(148, 163, 184)))
            using (StringFormat centerFmt = new StringFormat { Alignment = StringAlignment.Center })
            {
                g.DrawString("Generador DTF", titleFont, whiteBrush, new RectangleF(0, 98, Width, 28), centerFmt);
                g.DrawString("Aplicación de Escritorio · Canales Spot PDF", subFont, mutedBrush, new RectangleF(0, 126, Width, 20), centerFmt);
            }

            // Texto de estado actual
            int barX = 36;
            int barW = Width - 72;
            int barY = 186;
            int barH = 8;

            using (Font statusFont = new Font("Segoe UI Semibold", 9.5f, FontStyle.Regular))
            using (SolidBrush statusBrush = new SolidBrush(isSuccess ? Color.FromArgb(52, 211, 153) : Color.FromArgb(226, 232, 240)))
            {
                g.DrawString(statusText, statusFont, statusBrush, barX, 160);
            }

            // Barra de progreso custom redondeada
            using (GraphicsPath trackPath = RoundedRect(new Rectangle(barX, barY, barW, barH), 4))
            using (SolidBrush trackBrush = new SolidBrush(Color.FromArgb(30, 41, 59)))
            {
                g.FillPath(trackBrush, trackPath);
                g.SetClip(trackPath);

                if (progressPercent.HasValue)
                {
                    int pct = Math.Max(0, Math.Min(100, progressPercent.Value));
                    int fillW = (int)(barW * (pct / 100f));
                    if (fillW > 0)
                    {
                        Color c1 = isSuccess ? Color.FromArgb(16, 185, 129) : Color.FromArgb(56, 189, 248);
                        Color c2 = isSuccess ? Color.FromArgb(52, 211, 153) : Color.FromArgb(99, 102, 241);
                        using (LinearGradientBrush fillBrush = new LinearGradientBrush(new Rectangle(barX, barY, Math.Max(1, fillW), barH), c1, c2, LinearGradientMode.Horizontal))
                        {
                            g.FillRectangle(fillBrush, barX, barY, fillW, barH);
                        }
                    }
                }
                else
                {
                    int segW = (int)(barW * 0.32f);
                    int segX = barX + (int)(barW * animOffset);
                    using (LinearGradientBrush animBrush = new LinearGradientBrush(
                        new Rectangle(segX, barY, segW, barH),
                        Color.FromArgb(56, 189, 248),
                        Color.FromArgb(99, 102, 241),
                        LinearGradientMode.Horizontal))
                    {
                        g.FillRectangle(animBrush, segX, barY, segW, barH);
                    }
                }

                g.ResetClip();
            }

            // Pie: detalle a la izquierda y versión a la derecha
            using (Font footerFont = new Font("Segoe UI", 8.5f, FontStyle.Regular))
            using (SolidBrush footerBrush = new SolidBrush(Color.FromArgb(100, 116, 139)))
            using (StringFormat rightFmt = new StringFormat { Alignment = StringAlignment.Far })
            {
                g.DrawString(detailText, footerFont, footerBrush, new RectangleF(barX, 206, barW - 70, 20));
                if (!string.IsNullOrEmpty(versionText))
                {
                    g.DrawString(versionText, footerFont, footerBrush, new RectangleF(barX, 206, barW, 20), rightFmt);
                }
            }
        }

        private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
        {
            int d = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
