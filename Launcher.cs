using System;
using System.Diagnostics;
using System.Drawing;
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

        private static void SetStatus(string status, string detail)
        {
            if (splash != null && !splash.IsDisposed)
            {
                try
                {
                    splash.BeginInvoke((Action)(() => splash.UpdateStatus(status, detail)));
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
                SetStatus("Buscando actualizaciones...", "Verificando repositorio remoto");

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
                SetStatus("Iniciando versión local...", "No se pudo verificar actualizaciones");
                LogError("Error general en actualizador: " + ex.Message);
                Thread.Sleep(700);
            }

            if (!relaunchDeferred)
            {
                SetStatus("Iniciando Generador DTF...", "Abriendo aplicación");
                Thread.Sleep(250);
                LaunchMainApp();
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

            SetStatus("Buscando actualizaciones...", "Consultando Git (rama " + branch + ")");
            CommandResult fetchRes = RunProcess("git", "fetch origin " + branch, rootDir, 15000);
            if (fetchRes.TimedOut || fetchRes.ExitCode != 0)
            {
                SetStatus("Sin conexión al servidor Git", "Iniciando versión local...");
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
                SetStatus("Aplicación actualizada", "No hay cambios nuevos");
                Thread.Sleep(350);
                return false;
            }

            SetStatus("Descargando cambios nuevos...", behindCount + (behindCount == 1 ? " actualización pendiente" : " actualizaciones pendientes"));

            // Cerrar GeneradorDTF.exe si está corriendo para evitar bloqueo de archivo
            CloseRunningTargetApp();

            // Verificar si el propio inicializador cambió en los nuevos commits
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
                SetStatus("Actualizando inicializador...", "Reiniciando para aplicar cambios");
                Thread.Sleep(400);
                RunDeferredGitSelfUpdate(branch, selfName);
                return true;
            }

            CommandResult pullRes = RunProcess("git", "pull --ff-only origin " + branch, rootDir, 30000);
            if (pullRes.ExitCode == 0)
            {
                SetStatus("Actualización completada", "Iniciando nueva versión...");
                Thread.Sleep(500);
                return false;
            }

            // Si git pull falló (por ejemplo, cambios locales sin commitear en esta PC)
            LogError("git pull falló: " + pullRes.StdErr + " " + pullRes.StdOut);
            SetStatus("No se pudo actualizar automáticamente", "Hay cambios locales sin guardar");

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
            SetStatus("Buscando actualizaciones...", "Consultando GitHub (" + GitHubOwner + "/" + GitHubRepo + ")");

            string remoteSha = FetchLatestGitHubCommitSha();
            if (string.IsNullOrEmpty(remoteSha))
            {
                SetStatus("Sin conexión a GitHub", "Iniciando versión local...");
                Thread.Sleep(700);
                return;
            }

            string versionFilePath = Path.Combine(rootDir, VersionFileName);
            string localSha = File.Exists(versionFilePath) ? File.ReadAllText(versionFilePath).Trim() : "";
            string targetExePath = Path.Combine(rootDir, TargetExeName);

            if (string.Equals(localSha, remoteSha, StringComparison.OrdinalIgnoreCase) && File.Exists(targetExePath))
            {
                SetStatus("Aplicación actualizada", "Versión " + remoteSha.Substring(0, 7));
                Thread.Sleep(350);
                return;
            }

            SetStatus("Descargando nueva versión...", "Obteniendo archivos desde GitHub (" + remoteSha.Substring(0, 7) + ")");
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

                SetStatus("Instalando actualización...", "Extrayendo archivos nuevos");
                ZipFile.ExtractToDirectory(zipPath, extractDir);

                string[] topDirs = Directory.GetDirectories(extractDir);
                string sourceRoot = topDirs.Length == 1 ? topDirs[0] : extractDir;

                CopyDirectoryContents(sourceRoot, rootDir);
                File.WriteAllText(versionFilePath, remoteSha);

                SetStatus("Actualización completada", "Versión " + remoteSha.Substring(0, 7) + " instalada");
                Thread.Sleep(500);
            }
            catch (Exception ex)
            {
                LogError("Error descargando actualización desde GitHub: " + ex.Message);
                SetStatus("Error al descargar actualización", "Iniciando versión local...");
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
            string selfName = Path.GetFileName(selfExePath);

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

                // Si se va a sobrescribir el propio inicializador en ejecución, renombrarlo primero
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
        private readonly Label lblStatus;
        private readonly Label lblDetail;

        public SplashForm(string rootDir)
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(420, 148);
            BackColor = Color.FromArgb(20, 24, 33);
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

            Paint += (s, e) =>
            {
                using (Pen borderPen = new Pen(Color.FromArgb(48, 58, 78), 1))
                {
                    e.Graphics.DrawRectangle(borderPen, 0, 0, Width - 1, Height - 1);
                }
            };

            PictureBox pic = new PictureBox
            {
                Size = new Size(44, 44),
                Location = new Point(22, 24),
                SizeMode = PictureBoxSizeMode.Zoom,
                BackColor = Color.Transparent
            };
            if (appIcon != null)
            {
                try { pic.Image = appIcon.ToBitmap(); } catch { }
            }
            Controls.Add(pic);

            Label lblTitle = new Label
            {
                Text = "Generador DTF",
                ForeColor = Color.FromArgb(241, 245, 249),
                Font = new Font("Segoe UI", 13F, FontStyle.Bold),
                Location = new Point(78, 22),
                AutoSize = true
            };
            Controls.Add(lblTitle);

            lblStatus = new Label
            {
                Text = "Buscando actualizaciones...",
                ForeColor = Color.FromArgb(148, 163, 184),
                Font = new Font("Segoe UI", 9.5F, FontStyle.Regular),
                Location = new Point(79, 49),
                Size = new Size(320, 22)
            };
            Controls.Add(lblStatus);

            lblDetail = new Label
            {
                Text = "Iniciando verificador",
                ForeColor = Color.FromArgb(100, 116, 139),
                Font = new Font("Segoe UI", 8.5F, FontStyle.Regular),
                Location = new Point(22, 114),
                Size = new Size(376, 18)
            };
            Controls.Add(lblDetail);

            ProgressBar progress = new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 28,
                Location = new Point(22, 92),
                Size = new Size(376, 12)
            };
            Controls.Add(progress);
        }

        public void UpdateStatus(string status, string detail)
        {
            lblStatus.Text = status ?? "";
            lblDetail.Text = detail ?? "";
        }
    }
}
