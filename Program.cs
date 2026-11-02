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
        private static HttpListener listener;
        private static int port;
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
                // Otra instancia ya está ejecutándose
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
                TcpListener tcp = new TcpListener(IPAddress.Loopback, 0);
                tcp.Start();
                port = ((IPEndPoint)tcp.LocalEndpoint).Port;
                tcp.Stop();

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
                    context.Response.Close();
                    return;
                }

                string ext = Path.GetExtension(filePath).ToLowerInvariant();
                switch (ext)
                {
                    case ".html":
                        context.Response.ContentType = "text/html; charset=utf-8";
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
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = browserPath,
                        Arguments = "--user-data-dir=\"" + profileDir + "\" --app=" + url + " --window-size=1400,900",
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

        private static void SetupTrayIcon()
        {
            try
            {
                ContextMenu menu = new ContextMenu();
                menu.MenuItems.Add("Abrir Generador DTF", (s, e) => OpenAppWindow());
                menu.MenuItems.Add("-");
                menu.MenuItems.Add("Cerrar", (s, e) => Application.Exit());

                trayIcon = new NotifyIcon
                {
                    Icon = SystemIcons.Application,
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
