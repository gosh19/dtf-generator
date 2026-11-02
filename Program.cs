using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace GeneradorDTF
{
    static class Program
    {
        private const int PreferredPort = 41789;
        private static HttpListener listener;
        private static int port = PreferredPort;
        private static string rootDir;
        private static NotifyIcon trayIcon;
        private static Process browserProc;
        private static Mutex singleInstanceMutex;

        [STAThread]
        static void Main()
        {
            bool createdNew;
            singleInstanceMutex = new Mutex(true, "GeneradorDTF_SingleInstance_Mutex", out createdNew);
            if (!createdNew)
            {
                // Otra instancia ya está ejecutándose: abrir ventana en el navegador y salir
                try
                {
                    Process.Start("http://127.0.0.1:" + PreferredPort + "/index.html");
                }
                catch { }
                return;
            }

            rootDir = AppDomain.CurrentDomain.BaseDirectory;

            StartServer();
            SetupTrayIcon();
            OpenAppWindow();

            Application.ApplicationExit += (s, e) => Cleanup();
            Application.Run();
        }

        private static void StartServer()
        {
            try
            {
                // Intentar usar siempre el puerto preferido fijo para mantener origen y sesión estables
                port = PreferredPort;
                bool portOk = false;

                try
                {
                    TcpListener tcpTest = new TcpListener(IPAddress.Loopback, port);
                    tcpTest.Start();
                    tcpTest.Stop();
                    portOk = true;
                }
                catch
                {
                    // Si el puerto fijo estuviese en uso, buscar uno libre dinámico
                    try
                    {
                        TcpListener tcpDynamic = new TcpListener(IPAddress.Loopback, 0);
                        tcpDynamic.Start();
                        port = ((IPEndPoint)tcpDynamic.LocalEndpoint).Port;
                        tcpDynamic.Stop();
                        portOk = true;
                    }
                    catch { }
                }

                if (!portOk)
                {
                    port = PreferredPort;
                }

                listener = new HttpListener();
                listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
                listener.Start();

                Thread serverThread = new Thread(ListenLoop)
                {
                    IsBackground = true
                };
                serverThread.Start();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error iniciando el servidor local: " + ex.Message, "Generador DTF", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.Exit(1);
            }
        }

        private static void ListenLoop()
        {
            while (listener != null && listener.IsListening)
            {
                try
                {
                    HttpListenerContext context = listener.GetContext();
                    ThreadPool.QueueUserWorkItem(ctx =>
                    {
                        try
                        {
                            HandleRequest((HttpListenerContext)ctx);
                        }
                        catch { }
                    }, context);
                }
                catch
                {
                    break;
                }
            }
        }

        private static void HandleRequest(HttpListenerContext context)
        {
            try
            {
                string urlPath = context.Request.Url.AbsolutePath.TrimStart('/');
                urlPath = Uri.UnescapeDataString(urlPath);
                if (string.IsNullOrEmpty(urlPath))
                {
                    urlPath = "index.html";
                }

                string filePath = Path.Combine(rootDir, urlPath.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(filePath))
                {
                    context.Response.StatusCode = 404;
                    byte[] notFoundBytes = System.Text.Encoding.UTF8.GetBytes("<!DOCTYPE html><html><body><h1>404 No Encontrado</h1></body></html>");
                    context.Response.ContentType = "text/html; charset=utf-8";
                    context.Response.ContentLength64 = notFoundBytes.Length;
                    context.Response.OutputStream.Write(notFoundBytes, 0, notFoundBytes.Length);
                    context.Response.Close();
                    return;
                }

                string ext = Path.GetExtension(filePath).ToLowerInvariant();
                switch (ext)
                {
                    case ".html":
                        context.Response.ContentType = "text/html; charset=utf-8";
                        context.Response.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate");
                        break;
                    case ".js":
                        context.Response.ContentType = "application/javascript; charset=utf-8";
                        break;
                    case ".css":
                        context.Response.ContentType = "text/css; charset=utf-8";
                        break;
                    case ".svg":
                        context.Response.ContentType = "image/svg+xml";
                        break;
                    case ".pdf":
                        context.Response.ContentType = "application/pdf";
                        break;
                    case ".png":
                        context.Response.ContentType = "image/png";
                        break;
                    case ".jpg":
                    case ".jpeg":
                        context.Response.ContentType = "image/jpeg";
                        break;
                    case ".ico":
                        context.Response.ContentType = "image/x-icon";
                        break;
                    case ".json":
                        context.Response.ContentType = "application/json; charset=utf-8";
                        break;
                    default:
                        context.Response.ContentType = "application/octet-stream";
                        break;
                }

                byte[] buffer = File.ReadAllBytes(filePath);
                context.Response.ContentLength64 = buffer.Length;
                context.Response.OutputStream.Write(buffer, 0, buffer.Length);
                context.Response.Close();
            }
            catch
            {
                try
                {
                    context.Response.StatusCode = 500;
                    context.Response.Close();
                }
                catch { }
            }
        }

        private static void OpenAppWindow()
        {
            string url = "http://127.0.0.1:" + port + "/index.html";
            string[] browsers = new string[]
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
            };

            string browserPath = null;
            foreach (string p in browsers)
            {
                if (File.Exists(p))
                {
                    browserPath = p;
                    break;
                }
            }

            if (browserPath != null)
            {
                try
                {
                    string profileDir = Path.Combine(Path.GetTempPath(), "DTFGenerator_Profile");
                    CleanProfileSession(profileDir);

                    string args = "--user-data-dir=\"" + profileDir + "\" " +
                                  "--app=" + url + " " +
                                  "--window-size=1400,900 " +
                                  "--no-first-run " +
                                  "--no-default-browser-check " +
                                  "--disable-session-crashed-bubble " +
                                  "--disable-restore-session-state " +
                                  "--disable-background-mode";

                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = browserPath,
                        Arguments = args,
                        UseShellExecute = false
                    };

                    browserProc = Process.Start(psi);
                    if (browserProc != null)
                    {
                        browserProc.EnableRaisingEvents = true;
                        browserProc.Exited += (s, e) =>
                        {
                            Application.Exit();
                        };
                    }
                    return;
                }
                catch { }
            }

            // Fallback a navegador predeterminado
            try
            {
                Process.Start(url);
            }
            catch (Exception ex)
            {
                MessageBox.Show("No se pudo abrir el navegador: " + ex.Message, "Generador DTF", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void CleanProfileSession(string profileDir)
        {
            try
            {
                string sessionsDir = Path.Combine(profileDir, "Default", "Sessions");
                if (Directory.Exists(sessionsDir))
                {
                    string[] files = Directory.GetFiles(sessionsDir);
                    foreach (string f in files)
                    {
                        try { File.Delete(f); } catch { }
                    }
                }
            }
            catch { }

            try
            {
                string prefsPath = Path.Combine(profileDir, "Default", "Preferences");
                if (File.Exists(prefsPath))
                {
                    string content = File.ReadAllText(prefsPath);
                    bool changed = false;
                    if (content.Contains("\"exit_type\":\"Crashed\""))
                    {
                        content = content.Replace("\"exit_type\":\"Crashed\"", "\"exit_type\":\"Normal\"");
                        changed = true;
                    }
                    if (content.Contains("\"exited_cleanly\":false"))
                    {
                        content = content.Replace("\"exited_cleanly\":false", "\"exited_cleanly\":true");
                        changed = true;
                    }
                    if (changed)
                    {
                        File.WriteAllText(prefsPath, content);
                    }
                }
            }
            catch { }
        }

        private static void SetupTrayIcon()
        {
            try
            {
                ContextMenu menu = new ContextMenu();
                menu.MenuItems.Add("Abrir Generador DTF", (s, e) => OpenAppWindow());
                menu.MenuItems.Add("-");
                menu.MenuItems.Add("Cerrar", (s, e) => Application.Exit());

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
                if (appIcon == null)
                {
                    appIcon = SystemIcons.Application;
                }

                trayIcon = new NotifyIcon
                {
                    Icon = appIcon,
                    ContextMenu = menu,
                    Text = "Generador DTF",
                    Visible = true
                };

                trayIcon.DoubleClick += (s, e) => OpenAppWindow();
            }
            catch { }
        }

        private static void Cleanup()
        {
            try
            {
                if (trayIcon != null)
                {
                    trayIcon.Visible = false;
                    trayIcon.Dispose();
                    trayIcon = null;
                }
            }
            catch { }

            try
            {
                if (listener != null && listener.IsListening)
                {
                    listener.Stop();
                    listener.Close();
                    listener = null;
                }
            }
            catch { }

            try
            {
                if (singleInstanceMutex != null)
                {
                    singleInstanceMutex.ReleaseMutex();
                    singleInstanceMutex.Dispose();
                    singleInstanceMutex = null;
                }
            }
            catch { }
        }
    }
}
