using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace GeneradorDTF
{
    static class Program
    {
        private const int PreferredPort = 41789;
        private static HttpListener listener;
        private static int port = PreferredPort;
        private static string rootDir;
        private static Mutex singleInstanceMutex;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        private const int SW_RESTORE = 9;

        [STAThread]
        static void Main()
        {
            bool createdNew;
            singleInstanceMutex = new Mutex(true, "GeneradorDTF_SingleInstance_Mutex", out createdNew);
            if (!createdNew)
            {
                // Otra instancia ya está abierta: traer su ventana al frente
                try
                {
                    IntPtr hWnd = FindWindow(null, "Generador DTF");
                    if (hWnd != IntPtr.Zero)
                    {
                        ShowWindow(hWnd, SW_RESTORE);
                        SetForegroundWindow(hWnd);
                        return;
                    }
                }
                catch { }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            rootDir = AppDomain.CurrentDomain.BaseDirectory;
            StartServer();

            try
            {
                string appUrl = "http://127.0.0.1:" + port + "/index.html";
                MainWindow mainForm = new MainWindow(rootDir, appUrl);
                Application.ApplicationExit += (s, e) => Cleanup();
                Application.Run(mainForm);
            }
            finally
            {
                Cleanup();
            }
        }

        private static void StartServer()
        {
            try
            {
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
                    if (!string.Equals(context.Request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase))
                    {
                        context.Response.OutputStream.Write(notFoundBytes, 0, notFoundBytes.Length);
                    }
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
                        context.Response.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate");
                        break;
                    case ".css":
                        context.Response.ContentType = "text/css; charset=utf-8";
                        context.Response.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate");
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
                if (!string.Equals(context.Request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase))
                {
                    context.Response.OutputStream.Write(buffer, 0, buffer.Length);
                }
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

        private static void Cleanup()
        {
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

    class MainWindow : Form
    {
        private readonly string rootDir;
        private readonly string appUrl;
        private WebView2 webView;

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        private const int DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1 = 19;
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

        public MainWindow(string rootDir, string appUrl)
        {
            this.rootDir = rootDir;
            this.appUrl = appUrl;

            Text = "Generador DTF";
            BackColor = Color.FromArgb(15, 23, 42);
            MinimumSize = new Size(1024, 680);
            StartPosition = FormStartPosition.CenterScreen;

            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            if (wa.Width <= 1460 || wa.Height <= 920)
            {
                Size = new Size(Math.Min(1360, wa.Width - 40), Math.Min(860, wa.Height - 40));
                WindowState = FormWindowState.Maximized;
            }
            else
            {
                Size = new Size(1440, 900);
            }

            Icon appIcon = LoadAppIcon();
            if (appIcon != null)
            {
                Icon = appIcon;
            }

            webView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(15, 23, 42)
            };
            Controls.Add(webView);

            HandleCreated += (s, e) => EnableDarkTitleBar();
            Load += MainWindow_Load;
        }

        private Icon LoadAppIcon()
        {
            string icoPath = Path.Combine(rootDir, "app.ico");
            if (File.Exists(icoPath))
            {
                try { return new Icon(icoPath); } catch { }
            }
            try { return Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
            return null;
        }

        private void EnableDarkTitleBar()
        {
            try
            {
                int useDark = 1;
                if (DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref useDark, sizeof(int)) != 0)
                {
                    DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1, ref useDark, sizeof(int));
                }
            }
            catch { }
        }

        private async void MainWindow_Load(object sender, EventArgs e)
        {
            try
            {
                string userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "GeneradorDTF",
                    "WebView2Data"
                );
                Directory.CreateDirectory(userDataFolder);

                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await webView.EnsureCoreWebView2Async(env);

                CoreWebView2Settings settings = webView.CoreWebView2.Settings;
                settings.AreDefaultContextMenusEnabled = false;
                settings.AreDevToolsEnabled = false;
                settings.IsStatusBarEnabled = false;
                settings.IsZoomControlEnabled = false;
                settings.AreDefaultScriptDialogsEnabled = true;

                webView.CoreWebView2.NewWindowRequested += (s, args) =>
                {
                    args.Handled = true;
                };

                webView.CoreWebView2.Navigate(appUrl);
            }
            catch (Exception ex)
            {
                // Fallback seguro si el equipo no tiene WebView2 Runtime instalado
                DialogResult res = MessageBox.Show(
                    "No se pudo iniciar el motor de escritorio WebView2 (" + ex.Message + ").\n\n¿Deseás abrir Generador DTF en tu navegador predeterminado?",
                    "Generador DTF",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning
                );

                if (res == DialogResult.Yes)
                {
                    try { Process.Start(appUrl); } catch { }
                }
            }
        }
    }
}
